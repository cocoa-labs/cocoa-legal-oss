// Shared document-upload handler. Single source of truth for the
// multipart upload pipeline used by both the standalone-document route
// (POST /single-documents) and the project-document route
// (POST /projects/:id/documents). Both previously carried a verbatim
// copy of this ~140-line function; any Tier-2 hardening change had to be
// applied twice or the two silently diverged.
//
// Pipeline: validate extension → insert the documents row (status
// "processing") → store the raw bytes with a trusted server-side MIME →
// for non-PDF formats, convert to a viewable PDF rendition via
// LibreOffice → extract the structure tree (TOC) → create the V1
// document_versions row → flip the document to "ready".

import type { Request, Response } from "express";
import { createServerSupabase } from "./supabase";
import { storageKey, uploadFile } from "./storage";
import { convertToPdf, convertedPdfKey } from "./convert";
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_EXTENSIONS_LIST,
  extractExtension,
  mimeForExtension,
  needsPdfConversion,
  sniffRasterImageMime,
} from "./uploadTypes";
import {
  extractDocumentStructureTree,
  extractDocumentText,
} from "./documentExtraction";
import { insertUploadDocumentVersion } from "./documentVersions";
import { classifyCreDocumentType } from "./creClassifier";
import { classifyPiDocumentType } from "./piClassifier";
import { emptyExtractionReason } from "./creReliability";
import {
  verifyPdfLayout,
  type DocumentLayoutQaReport,
} from "./documentLayoutQa";
import { extractDocxTextView } from "./docxLayout";

export class DocumentIntakeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

/** HTTP uploads and email intake share original storage, conversion and versioning. */
export async function persistDocumentUpload(
  input: {
    db: ReturnType<typeof createServerSupabase>;
    userId: string;
    projectId: string | null;
    filename: string;
    content: Buffer;
    documentId?: string;
    allowImages?: boolean;
    orgId?: string | null;
  },
  deps: { upload?: typeof uploadFile; convert?: typeof convertToPdf } = {},
) {
  const { db, userId, projectId, filename, content } = input;
  const suffix = extractExtension(filename);
  const imageMime = input.allowImages ? sniffRasterImageMime(content) : null;
  if (!DOCUMENT_EXTENSIONS.has(suffix) && !imageMime)
    throw new DocumentIntakeError(
      "UNSUPPORTED_ATTACHMENT",
      `Unsupported file type: ${suffix || "(none)"}.`,
    );
  let orgId: string | null = input.orgId ?? null;
  let matterId: string | null = null;
  if (projectId) {
    const { data: project } = await db
      .from("projects")
      .select("org_id, matter_id")
      .eq("id", projectId)
      .maybeSingle();
    if (!project?.org_id || !project?.matter_id)
      throw new DocumentIntakeError(
        "PROJECT_TENANCY_INCOMPLETE",
        "This project has not finished its tenancy migration.",
        409,
      );
    orgId = String(project.org_id);
    matterId = String(project.matter_id);
  } else if (!orgId && input.orgId === undefined) {
    const { data: membership } = await db
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    orgId = membership?.organization_id
      ? String(membership.organization_id)
      : null;
  }
  let doc: Record<string, any> | null = null;
  if (input.documentId) {
    const { data, error } = await db
      .from("documents")
      .select("*")
      .eq("id", input.documentId)
      .maybeSingle();
    if (error) throw error;
    doc = data;
    if (
      doc &&
      (doc.lifecycle_status !== "active" ||
        doc.user_id !== userId ||
        doc.project_id !== projectId)
    )
      throw new DocumentIntakeError(
        "ATTACHMENT_UNAVAILABLE",
        "The original document is deleted or its scope has changed.",
      );
  }
  if (!doc) {
    const { data, error } = await db
      .from("documents")
      .insert({
        ...(input.documentId ? { id: input.documentId } : {}),
        project_id: projectId,
        org_id: orgId,
        matter_id: matterId,
        user_id: userId,
        filename,
        file_type: imageMime
          ? imageMime.split("/")[1].replace("jpeg", "jpg")
          : suffix,
        size_bytes: content.byteLength,
        status: "processing",
      })
      .select("*")
      .single();
    if (error || !data)
      throw new DocumentIntakeError(
        "DOCUMENT_SAVE_FAILED",
        "Failed to create document record.",
        503,
      );
    doc = data;
  }
  const document = doc!;

  try {
    const docId = document.id as string;
    const key = storageKey(userId, docId, filename);
    // Use the server-side canonical MIME for this extension. Falling
    // back to file.mimetype lets a multipart Content-Type from the
    // client influence the stored object's MIME — the canonical map
    // is the trusted source.
    const contentType =
      imageMime ?? mimeForExtension(suffix) ?? "application/octet-stream";
    await (deps.upload ?? uploadFile)(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const pageCount =
      suffix === "pdf" ? await countPdfPages(rawBuf.slice(0)) : null;

    // PDFs are their own rendition. Every other accepted format goes
    // through LibreOffice (or marked → LibreOffice for Markdown) to
    // produce a PDF rendition for the doc-review viewer.
    let pdfStoragePath: string | null = null;
    let pdfRenditionBuf: ArrayBuffer | null = null;
    let renditionQaReport: DocumentLayoutQaReport | null = null;
    let conversionFailed = false;
    if (needsPdfConversion(suffix)) {
      try {
        const pdfBuf = await (deps.convert ?? convertToPdf)(content, suffix);
        const expectedText =
          suffix === "docx"
            ? await extractDocxTextView(content, "all")
            : undefined;
        renditionQaReport = await verifyPdfLayout(pdfBuf, { expectedText });
        const pdfKey = convertedPdfKey(userId, docId);
        const pdfArrayBuf = pdfBuf.buffer.slice(
          pdfBuf.byteOffset,
          pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer;
        await (deps.upload ?? uploadFile)(
          pdfKey,
          pdfArrayBuf,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
        // Need a fresh slice for the structure-tree extractor — pdfjs
        // detaches the underlying ArrayBuffer when it reads it.
        pdfRenditionBuf = pdfBuf.buffer.slice(
          pdfBuf.byteOffset,
          pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer;
      } catch (err) {
        conversionFailed = true;
        console.error("[upload] PDF conversion failed", {
          code: "PDF_CONVERSION_FAILED",
          error: err instanceof Error ? err.name : "Error",
        });
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Structure tree comes AFTER PDF rendition so Tier 2 docs can use
    // the rendition for outline extraction (the old mammoth-based
    // branch returned null for every non-DOCX format).
    const tree = imageMime
      ? null
      : await extractDocumentStructureTree({
          fileType: suffix,
          rawBuf: rawBuf.slice(0),
          pdfRenditionBuf: pdfRenditionBuf?.slice(0) ?? null,
        });

    // Best-effort document-type classification (deterministic, no LLM):
    // the CRE classifier runs first and its result wins; the PI classifier
    // is the fallback for documents CRE does not recognize. Wrapped so a
    // classification failure NEVER fails the upload — on any error we
    // simply leave document_type null. We extract body text from a FRESH
    // rawBuf slice because pdfjs detaches the ArrayBuffer it reads, and the
    // structure-tree extraction above may already have consumed the shared
    // `rawBuf` for PDFs.
    let documentType: string | null = null;
    // Soft, non-fatal early warning: a scanned/image-only PDF yields
    // near-empty selectable text, which later forces a red flag at
    // extraction time. Surface it now (reusing the same message the
    // extraction guard uses) so the user learns at upload instead.
    let uploadWarning: string | null = null;
    try {
      const classifyBuf = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      const bodyText = imageMime
        ? ""
        : await extractDocumentText({
            fileType: suffix,
            rawBuf: classifyBuf,
            pdfRenditionBuf: pdfRenditionBuf?.slice(0) ?? null,
          });
      documentType =
        classifyCreDocumentType(bodyText, filename) ??
        classifyPiDocumentType(bodyText, filename);
      if (
        suffix === "pdf" &&
        bodyText.replace(/\[Page \d+\]/g, "").trim().length === 0
      ) {
        uploadWarning = emptyExtractionReason(suffix);
      }
    } catch (err) {
      console.error("[upload] document classification failed", {
        code: "DOCUMENT_CLASSIFICATION_FAILED",
        error: err instanceof Error ? err.name : "Error",
      });
      documentType = null;
    }

    // storage_path / pdf_storage_path live on document_versions now —
    // create the V1 "upload" row and point documents.current_version_id
    // at it.
    const { data: priorVersion, error: priorError } = await db
      .from("document_versions")
      .select("id, storage_path")
      .eq("document_id", docId)
      .eq("version_number", 1)
      .maybeSingle();
    if (priorError) throw priorError;
    const versionRow =
      priorVersion ??
      (await insertUploadDocumentVersion({
        db,
        documentId: docId,
        storagePath: key,
        pdfStoragePath,
        filename,
        userId,
        renditionQaReport,
      }));
    if (priorVersion && pdfStoragePath) {
      const { error } = await db
        .from("document_versions")
        .update({ pdf_storage_path: pdfStoragePath })
        .eq("id", priorVersion.id);
      if (error) throw error;
    }

    // Recovery of V1 must never move the current pointer back from a later
    // user-created version or replace that version's metadata.
    const { error: updateError } =
      priorVersion && document.current_version_id
        ? { error: null }
        : await db
            .from("documents")
            .update({
              current_version_id: versionRow.id,
              size_bytes: content.byteLength,
              page_count: pageCount,
              structure_tree: tree ?? null,
              document_type: documentType,
              status: "ready",
              updated_at: new Date().toISOString(),
            })
            .eq("id", docId)
            .eq("lifecycle_status", "active")
            .is("current_version_id", null);
    if (updateError) throw updateError;

    const { data: updated, error: readError } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    if (readError || !updated || updated.lifecycle_status !== "active")
      throw new DocumentIntakeError(
        "ATTACHMENT_UNAVAILABLE",
        "The document is no longer available.",
      );
    // Surface storage paths to the caller for backward compatibility.
    // `warning` is only present when set — omitted entirely otherwise so
    // existing callers see an unchanged response shape.
    const responseDoc = updated
      ? {
          ...updated,
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
          ...(uploadWarning ? { warning: uploadWarning } : {}),
          conversion_failed: conversionFailed,
          version_id: versionRow.id,
        }
      : updated;
    return responseDoc as Record<string, any>;
  } catch (e) {
    if (document.status === "processing")
      await db
        .from("documents")
        .update({ status: "error" })
        .eq("id", document.id)
        .is("current_version_id", null);
    throw e;
  }
}

export async function handleDocumentUpload(
  req: Request,
  res: Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });
  if (!DOCUMENT_EXTENSIONS.has(extractExtension(file.originalname)))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type. Allowed: ${DOCUMENT_EXTENSIONS_LIST.join(", ")}`,
      });
  try {
    const doc = await persistDocumentUpload({
      db,
      userId,
      projectId,
      filename: file.originalname,
      content: file.buffer,
    });
    res.status(201).json(doc);
  } catch (error) {
    res.status(error instanceof DocumentIntakeError ? error.status : 500).json({
      detail:
        error instanceof Error ? error.message : "Document processing failed",
    });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number; destroy(): Promise<void> }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = pdf.numPages;
    await pdf.destroy();
    return pages;
  } catch {
    return null;
  }
}
