import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { convertToPdf } from "../lib/convert";
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_EXTENSIONS_LIST,
  extractExtension,
  mimeForExtension,
  needsPdfConversion,
} from "../lib/uploadTypes";
import { handleDocumentUpload } from "../lib/documentUpload";
import {
  acceptAllTrackedChangesInBody,
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import {
  DocumentReflowError,
  extractDocxTextView,
  reflowFramedDocx,
  type DocxReflowResult,
} from "../lib/docxLayout";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  describeSupabaseError,
  insertDocumentVersionCompat,
  loadActiveVersion,
} from "../lib/documentVersions";
import {
  applyHighlightSetToDocx,
  type HighlightApplyFallbackAnchor,
  updateHighlightStatus,
} from "../lib/documentHighlights";
import { ensureDocAccess, checkProjectAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import {
  approveAgentOperation,
  createAgentOperation,
  failAgentOperation,
  isAssembleKickoff,
} from "../lib/operations";
import { recordAuditEvent } from "../lib/audit";
import {
  ensureVersionExportable,
  ensureVersionPdfRenditionExportable,
  layoutQaVersionValues,
  sourceLayoutQaVersionValues,
  verifyDerivedArtifact,
} from "../lib/documentLayoutGate";
import {
  layoutQaHttpError,
  verifyPdfLayout,
  type DocumentLayoutQaReport,
} from "../lib/documentLayoutQa";

export const documentsRouter = Router();
const VISIBLE_NUMBERED_SOURCES = [
  "upload",
  "user_upload",
  "assistant_edit",
  "assistant_highlight",
  "assistant_undo",
  "generated",
  "authored",
  "clean_final",
];
const DECISION_SOURCES = new Set(["user_accept", "user_reject"]);
type VersionResponseRow = {
  id: string;
  version_number: number | null;
  source: string | null;
  created_at: string | null;
  display_name: string | null;
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function parseFallbackHighlights(value: unknown): HighlightApplyFallbackAnchor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): HighlightApplyFallbackAnchor[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    if (!quote) return [];
    const status =
      row.status === "kept" || row.status === "removed" || row.status === "applied"
        ? row.status
        : "kept";
    return [
      {
        id: typeof row.id === "string" ? row.id : null,
        quote,
        occurrence_index:
          typeof row.occurrence_index === "number" &&
          Number.isFinite(row.occurrence_index)
            ? row.occurrence_index
            : 0,
        status,
      },
    ];
  });
}

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .eq("lifecycle_status", "active")
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db);
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, matter_id, lifecycle_status, legal_hold_until")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  const access = await ensureDocAccess(doc, userId, userEmail, db, "lifecycle");
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });
  if (doc.legal_hold_until && new Date(doc.legal_hold_until).getTime() > Date.now())
    return void res.status(409).json({ code: "LEGAL_HOLD_ACTIVE", detail: "This document cannot be deleted while a legal hold is active." });
  const deletedAt = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.from("documents").update({
    lifecycle_status: "deleted_pending_purge",
    deleted_at: deletedAt,
    retention_until: retentionUntil,
    updated_at: deletedAt,
  }).eq("id", documentId);
  await recordAuditEvent(db, { orgId: doc.org_id, matterId: doc.matter_id, projectId: doc.project_id, actorUserId: userId, actorRole: access.role, eventType: "document.deleted", targetType: "document", targetId: documentId, requestId: String(res.getHeader("x-request-id") ?? "") });
  res.status(204).send();
});

documentsRouter.post("/:documentId/restore", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();
  const { data: doc } = await db.from("documents").select("id, user_id, project_id, org_id, matter_id, lifecycle_status, retention_until").eq("id", documentId).maybeSingle();
  if (!doc) return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db, "lifecycle");
  if (!access.ok) return void res.status(404).json({ detail: "Document not found" });
  if (doc.lifecycle_status !== "deleted_pending_purge" || (doc.retention_until && new Date(doc.retention_until).getTime() <= Date.now()))
    return void res.status(409).json({ code: "DOCUMENT_NOT_RESTORABLE", detail: "This document is not within its recovery window." });
  const { data, error } = await db.from("documents").update({ lifecycle_status: "active", deleted_at: null, retention_until: null, updated_at: new Date().toISOString() }).eq("id", documentId).select("*").single();
  if (error || !data) return void res.status(500).json({ detail: "Failed to restore document" });
  await recordAuditEvent(db, { orgId: doc.org_id, matterId: doc.matter_id, projectId: doc.project_id, actorUserId: userId, actorRole: access.role, eventType: "document.restored", targetType: "document", targetId: documentId, requestId: String(res.getHeader("x-request-id") ?? "") });
  res.json(data);
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id, lifecycle_status")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db, "read", versionIdParam);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = (doc.file_type as string) ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  // Serve the PDF rendition whenever one exists and the file isn't
  // already a native PDF — i.e., for every Tier 2 format (xlsx, pptx,
  // md, html, csv, etc.) and for DOCX/DOC. The viewer-side hook then
  // routes by response Content-Type. The else-branch (raw DOCX) is
  // kept as a last resort for legacy docs whose conversion failed.
  const useRendition =
    fileType !== "pdf" && active.pdf_storage_path !== null;
  const servePath = useRendition
    ? (active.pdf_storage_path as string)
    : active.storage_path;
  let raw: ArrayBuffer | Buffer | null;
  try {
    if (useRendition) {
      raw = (
        await ensureVersionPdfRenditionExportable({
          db,
          documentId,
          versionId: active.id,
          fileType,
        })
      ).bytes;
    } else {
      await ensureVersionExportable({
        db,
        documentId,
        versionId: active.id,
        fileType,
      });
      raw = await downloadFile(servePath);
    }
  } catch (error) {
    const qa = layoutQaHttpError(error);
    return void res.status(qa?.status ?? 503).json({
      detail:
        qa?.detail ??
        "The PDF rendition could not be layout-verified and was not displayed.",
      code: qa?.code ?? "DOCUMENT_QA_UNAVAILABLE",
      layout_qa: qa?.report ?? null,
    });
  }
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });
  const responseBytes = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(new Uint8Array(raw));

  if (fileType === "pdf" || useRendition) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(responseBytes);
  } else if (isDocx) {
    // No PDF rendition available — fall back to raw DOCX (the
    // frontend's docx-preview viewer can render it client-side).
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(responseBytes);
  } else {
    // Tier 2 doc without a PDF rendition — conversion must have failed
    // at upload. Serve the raw bytes with the canonical MIME so the
    // browser at least offers a download.
    res.setHeader(
      "Content-Type",
      mimeForExtension(fileType) ?? "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("attachment", doc.filename as string),
    );
    res.send(responseBytes);
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id, org_id, matter_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
        "export",
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => ({
      doc: x.doc as {
        id: string;
        filename: string;
        file_type: string | null;
        project_id: string | null;
        org_id: string | null;
        matter_id: string | null;
      },
      role: x.access.ok ? x.access.role : null,
    }));
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  try {
    await Promise.all(
      docs.map(async ({ doc }) => {
        const active = await loadActiveVersion(doc.id, db);
        if (!active) throw new Error("Document has no active version.");
        await ensureVersionExportable({
          db,
          documentId: doc.id,
          versionId: active.id,
          fileType: doc.file_type,
        });
        const raw = await downloadFile(active.storage_path);
        if (!raw) throw new Error("Document bytes are unavailable.");
        zip.file(doc.filename, Buffer.from(raw));
      }),
    );
  } catch (error) {
    const qa = layoutQaHttpError(error);
    return void res.status(qa?.status ?? 503).json({
      detail: qa?.detail ?? errorMessage(error, "A document could not be exported."),
      code: qa?.code ?? "DOCUMENT_QA_UNAVAILABLE",
      layout_qa: qa?.report ?? null,
    });
  }

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await Promise.all(
    docs.map(({ doc, role }) =>
      recordAuditEvent(db, {
        orgId: doc.org_id,
        matterId: doc.matter_id,
        projectId: doc.project_id,
        actorUserId: userId,
        actorRole: role,
        eventType: "document.exported",
        targetType: "document",
        targetId: doc.id,
        requestId: String(res.getHeader("x-request-id") ?? ""),
      }),
    ),
  );
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const exportRequested = req.query.purpose === "export";
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id, org_id, matter_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(
    doc,
    userId,
    userEmail,
    db,
    exportRequested ? "export" : "read",
    versionIdParam,
  );
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  try {
    await ensureVersionExportable({
      db,
      documentId,
      versionId: active.id,
      fileType: (doc.file_type as string | null) ?? null,
    });
  } catch (error) {
    const qa = layoutQaHttpError(error);
    return void res.status(qa?.status ?? 503).json({
      detail: qa?.detail ?? "Document layout verification is unavailable.",
      code: qa?.code ?? "DOCUMENT_QA_UNAVAILABLE",
      layout_qa: qa?.report ?? null,
    });
  }

  const downloadFilename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  if (exportRequested) {
    await recordAuditEvent(db, {
      orgId: doc.org_id,
      matterId: doc.matter_id,
      projectId: doc.project_id,
      actorUserId: userId,
      actorRole: access.role,
      eventType: "document.exported",
      targetType: "document",
      targetId: documentId,
      requestId: String(res.getHeader("x-request-id") ?? ""),
      metadata: { version_id: active.id },
    });
  }

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db, "read", versionIdParam);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(
        doc.filename as string,
        active.display_name,
        active.version_number,
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// PATCH /single-documents/:documentId
// File a document into a matter (set documents.project_id). Used by the
// authoring flow's "Open document" → file-into-matter step so a standalone
// draft (project_id null) can be opened in the matter-scoped Doc Review
// interface. Only the document owner may move it, and only into a matter they
// can access. (A bare /:documentId PATCH — the other PATCHes on this router are
// deeper paths, e.g. /:documentId/versions/:versionId, so there is no collision.)
documentsRouter.patch("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const projectId =
    typeof req.body?.project_id === "string" && req.body.project_id.trim()
      ? req.body.project_id.trim()
      : null;
  if (!projectId)
    return void res.status(400).json({ detail: "project_id is required" });

  const db = createServerSupabase();
  const { data: doc } = await db
    .from("documents")
    .select("id, user_id, project_id, filename")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  // The target matter must be one the user can access.
  const projectAccess = await checkProjectAccess(
    projectId,
    userId,
    userEmail,
    db,
    "mutate",
  );
  if (!projectAccess.ok)
    return void res.status(404).json({ detail: "Matter not found" });

  const { data: updated, error } = await db
    .from("documents")
    .update({
      project_id: projectId,
      org_id: projectAccess.project.org_id,
      matter_id: projectAccess.project.matter_id,
    })
    .eq("id", documentId)
    .select("id, project_id, filename")
    .single();
  if (error || !updated)
    return void res.status(500).json({ detail: "Failed to move document" });
  res.json(updated);
});

// PATCH /single-documents/:documentId/highlight-sets/:setId/highlights/:highlightId
documentsRouter.patch(
  "/:documentId/highlight-sets/:setId/highlights/:highlightId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, setId, highlightId } = req.params;
    const status = req.body?.status === "removed" ? "removed" : "kept";
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, filename")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db, "annotate");
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    try {
      const highlight = await updateHighlightStatus({
        db,
        userId,
        documentId,
        setId,
        highlightId,
        status,
      });
      res.json({ highlight });
    } catch (err) {
      res.status(404).json({
        detail: err instanceof Error ? err.message : "Highlight not found",
      });
    }
  },
);

// POST /single-documents/:documentId/highlight-sets/:setId/apply
documentsRouter.post(
  "/:documentId/highlight-sets/:setId/apply",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, setId } = req.params;
    const db = createServerSupabase();

    const fallbackHighlights = parseFallbackHighlights(req.body?.highlights);
    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, filename")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    let operationId: string | null = null;
    try {
      const active = await loadActiveVersion(documentId, db);
      const operation = await createAgentOperation({
        db,
        userId,
        projectId:
          typeof (doc as { project_id?: unknown }).project_id === "string"
            ? ((doc as { project_id: string }).project_id)
            : null,
        toolName: "apply_document_highlights",
        actionType: "apply_highlights_to_docx",
        status: "pending_approval",
        approvalStatus: "required",
        mutating: true,
        requiresApproval: true,
        sourceDocumentId: documentId,
        sourceVersionId: active?.id ?? null,
        arguments: {
          document_id: documentId,
          highlight_set_id: setId,
          fallback_highlights: fallbackHighlights,
        },
        inverseOperation: "restore_source_version",
        idempotencyKey:
          typeof req.headers["idempotency-key"] === "string"
            ? req.headers["idempotency-key"]
            : null,
      });
      operationId = operation?.id ?? null;
      if (!operation) {
        const result = await applyHighlightSetToDocx({
          db,
          userId,
          documentId,
          setId,
          fallbackHighlights,
        });
        return void res.json({ ...result, operation_id: null });
      }

      const approved = await approveAgentOperation({
        db,
        operationId: operation.id,
        userId,
        userEmail,
      });
      // This path only ever approves apply_document_highlights operations, so
      // the assemble-background kickoff shape can't occur here — but narrow it
      // out so the AgentOperation field accesses below are type-safe.
      if (
        !approved ||
        isAssembleKickoff(approved) ||
        approved.status !== "succeeded" ||
        !approved.result_version_id
      ) {
        throw new Error("Highlight operation was not applied.");
      }

      const { data: versionRow } = await db
        .from("document_versions")
        .select("storage_path, version_number")
        .eq("id", approved.result_version_id)
        .single();
      const metadata = approved.metadata as {
        applied_count?: unknown;
        errors?: unknown;
      };
      res.json({
        version_id: approved.result_version_id,
        version_number:
          (versionRow?.version_number as number | null | undefined) ?? null,
        download_url: buildDownloadUrl(
          String(versionRow?.storage_path ?? ""),
          String((doc as { filename?: unknown }).filename ?? "document.docx"),
        ),
        applied_count:
          typeof metadata.applied_count === "number"
            ? metadata.applied_count
            : approved.affected_ranges.length,
        applied_highlight_ids: approved.affected_ranges.filter(
          (id): id is string => typeof id === "string",
        ),
        operation_id: approved.id,
        errors: Array.isArray(metadata.errors) ? metadata.errors : [],
      });
    } catch (err) {
      await failAgentOperation(
        db,
        operationId,
        err,
      ).catch(() => {});
      res.status(400).json({
        detail: errorMessage(err, "Failed to apply highlights"),
      });
    }
  },
);

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

async function nextVisibleVersionNumber(
  db: ReturnType<typeof createServerSupabase>,
  documentId: string,
): Promise<number> {
  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId)
    .in("source", VISIBLE_NUMBERED_SOURCES)
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return ((maxRow?.version_number as number | null) ?? 0) + 1;
}

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const includeDecisions =
    req.query.include_decisions === "true" ||
    req.query.include_decisions === "1";
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select("id, version_number, source, created_at, display_name, metadata, created_by_user_id, layout_qa_status, layout_qa_report, layout_qa_checked_at")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: includeDecisions
      ? (rows ?? [])
      : (rows ?? []).filter((r) => !DECISION_SOURCES.has(r.source as string)),
  });
});

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select("id, filename, file_type, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    // Reject if the uploaded file's extension doesn't match the document's
    // declared type — otherwise every downstream viewer/extractor breaks.
    const suffix = extractExtension(file.originalname);
    if (doc.file_type && suffix && doc.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
      });
    }
    // Defense-in-depth: the type-match guard above is short-circuited
    // when either doc.file_type or suffix is falsy (legacy rows, files
    // without extensions). Without this gate, an extensionless file or
    // a brand-new file_type could land in storage with no rendition.
    if (!DOCUMENT_EXTENSIONS.has(suffix)) {
      return void res.status(400).json({
        detail: `Unsupported file type: ${suffix || "(none)"}. Allowed: ${DOCUMENT_EXTENSIONS_LIST.join(", ")}`,
      });
    }

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );
    // Prefer the server-side canonical MIME for this extension — only
    // fall back to file.mimetype if we somehow don't have one. The
    // canonical MIME is from a trusted server table, not browser input.
    const contentType =
      mimeForExtension(suffix) ?? (file.mimetype || "application/octet-stream");
    try {
      await uploadFile(
        key,
        file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer,
        contentType,
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    // Render this version's bytes to PDF up front so /display can show
    // historical versions without on-demand conversion. Same logic as the
    // initial-upload pipeline; failures don't block the version row.
    // Version uploads are type-locked to the original doc's file_type, so
    // the conversion branch we hit here matches what the document
    // originally needed.
    let pdfStoragePath: string | null = null;
    let renditionQaReport: DocumentLayoutQaReport | null = null;
    if (needsPdfConversion(suffix)) {
      try {
        const pdfBuf = await convertToPdf(file.buffer, suffix);
        const expectedText =
          suffix === "docx"
            ? await extractDocxTextView(file.buffer, "all")
            : undefined;
        renditionQaReport = await verifyPdfLayout(pdfBuf, { expectedText });
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error("[versions/upload] PDF conversion failed", {
          code: "PDF_CONVERSION_FAILED",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (suffix === "pdf") {
      // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
      pdfStoragePath = key;
    }

    const nextVersionNumber = await nextVisibleVersionNumber(db, documentId);

    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;

    let versionRow: VersionResponseRow;
    try {
      const inserted = await insertDocumentVersionCompat({
        db,
        fallbackSource: "upload",
        errorMessage: "Failed to record new version.",
        values: {
          document_id: documentId,
          storage_path: key,
          pdf_storage_path: pdfStoragePath,
          source: "user_upload",
          version_number: nextVersionNumber,
          display_name: defaultDisplayName,
          created_by_user_id: userId,
          ...sourceLayoutQaVersionValues(),
          layout_qa_report: renditionQaReport,
          layout_qa_checked_at: renditionQaReport?.checked_at ?? null,
        },
      });
      const { data: selected, error: selectErr } = await db
        .from("document_versions")
        .select("id, version_number, source, created_at, display_name")
        .eq("id", inserted.id)
        .single();
      if (selectErr || !selected) {
        throw new Error(
          `Failed to load new version. ${describeSupabaseError(selectErr)}`,
        );
      }
      versionRow = selected as VersionResponseRow;
    } catch (verErr) {
      console.error("[versions/upload] insert failed", verErr);
      return void res.status(500).json({
        detail:
          verErr instanceof Error
            ? verErr.message
            : `Failed to record new version. ${describeSupabaseError(verErr)}`,
      });
    }

    // Also propagate the user-provided display_name to the parent document's
    // filename so the document's display name stays in sync across the UI.
    // Preserve a sensible extension: if the display_name has none, append
    // the uploaded file's extension (fallback: the existing doc's extension).
    const documentsUpdate: Record<string, unknown> = {
      current_version_id: versionRow.id,
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = (doc.filename as string | null)?.match(
        /\.[a-z0-9]{1,6}$/i,
      )?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    await db
      .from("documents")
      .update(documentsUpdate)
      .eq("id", documentId);

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ display_name: displayName })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .select("id, version_number, source, created_at, display_name, metadata, created_by_user_id")
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db, "read", versionIdParam);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

async function createDecisionSnapshot(params: {
  db: ReturnType<typeof createServerSupabase>;
  userId: string;
  documentId: string;
  filename: string;
  parentVersionId: string;
  resolvedBytes: Buffer;
  editId: string;
  mode: "accept" | "reject";
  found: boolean;
  remainingPending: number;
  reflowMetadata: DocxReflowResult["metadata"];
}): Promise<
  | {
      ok: true;
      versionId: string;
      storagePath: string;
      downloadUrl: string;
    }
  | { ok: false; status: number; detail: string; code?: string }
> {
  const {
    db,
    userId,
    documentId,
    filename,
    parentVersionId,
    resolvedBytes,
    editId,
    mode,
    found,
    remainingPending,
    reflowMetadata,
  } = params;
  let qaReport;
  try {
    qaReport = await verifyDerivedArtifact({
      bytes: resolvedBytes,
      fileType: "docx",
    });
    if (!qaReport) throw new Error("Decision layout QA returned no result.");
  } catch (error) {
    const qa = layoutQaHttpError(error);
    return {
      ok: false,
      status: qa?.status ?? 503,
      detail: qa?.detail ?? "Document layout verification is unavailable.",
      code: qa?.code ?? "DOCUMENT_QA_UNAVAILABLE",
    };
  }
  const versionSlug = crypto.randomUUID().replace(/-/g, "");
  const decisionFilename = `${mode}-${editId}.docx`;
  const storagePath = versionStorageKey(
    userId,
    documentId,
    versionSlug,
    decisionFilename,
  );
  await uploadFile(
    storagePath,
    bufferToArrayBuffer(resolvedBytes),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  let versionId: string;
  try {
    const versionRow = await insertDocumentVersionCompat({
      db,
      fallbackSource: "assistant_edit",
      errorMessage: "Failed to record decision version.",
      values: {
        document_id: documentId,
        storage_path: storagePath,
        pdf_storage_path: null,
        source: mode === "accept" ? "user_accept" : "user_reject",
        version_number: null,
        display_name: null,
        created_by_user_id: userId,
        metadata: {
          parent_version_id: parentVersionId,
          resolved_edit_id: editId,
          resolution: mode,
          found,
          remaining_pending: remainingPending,
          ...reflowMetadata,
          layout_qa: {
            status: "passed",
            schema_version: qaReport.schema_version,
            checked_at: qaReport.checked_at,
          },
        },
        ...layoutQaVersionValues(qaReport),
      },
    });
    versionId = versionRow.id;
  } catch (versionErr) {
    await deleteFile(storagePath).catch(() => {});
    return {
      ok: false,
      status: 500,
      detail:
        versionErr instanceof Error
          ? versionErr.message
          : `Failed to record decision version. ${describeSupabaseError(versionErr)}`,
    };
  }

  const { data: updatedDoc, error: updateErr } = await db
    .from("documents")
    .update({
      current_version_id: versionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .eq("current_version_id", parentVersionId)
    .select("id")
    .maybeSingle();
  if (updateErr || !updatedDoc) {
    await db.from("document_versions").delete().eq("id", versionId);
    await deleteFile(storagePath).catch(() => {});
    return {
      ok: false,
      status: 409,
      detail:
        "Document changed while resolving this edit. Refresh the document and try again.",
    };
  }

  return {
    ok: true,
    versionId,
    storagePath,
    downloadUrl: buildDownloadUrl(storagePath, filename),
  };
}

// Bake a document's current tracked-changes into a visible, numbered
// `clean_final` version and make it current. Shared by the `finalize-clean`
// endpoint and the accept/reject path (auto-finalize once all changes are
// resolved). `active` is the parent version to build from; the current_version
// swap is conditional on it to guard concurrent changes.
async function createCleanFinalVersion(params: {
  db: ReturnType<typeof createServerSupabase>;
  userId: string;
  documentId: string;
  docFilename: string;
  active: {
    id: string;
    storage_path: string;
    version_number: number | null;
    display_name: string | null;
  };
  displayName?: string | null;
}): Promise<
  | { ok: true; versionRow: VersionResponseRow; storagePath: string; downloadUrl: string }
  | { ok: false; status: number; detail: string; code?: string }
> {
  const { db, userId, documentId, docFilename, active } = params;
  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return { ok: false, status: 404, detail: "Document bytes not available" };

  let reflowed: DocxReflowResult;
  try {
    reflowed = await reflowFramedDocx(Buffer.from(raw));
  } catch (err) {
    if (err instanceof DocumentReflowError) {
      return {
        ok: false,
        status: 422,
        code: err.code,
        detail: err.message,
      };
    }
    throw err;
  }
  const clean = await acceptAllTrackedChangesInBody(reflowed.bytes);
  const versionSlug = crypto.randomUUID().replace(/-/g, "");
  const displayName =
    typeof params.displayName === "string" && params.displayName.trim()
      ? params.displayName.trim().slice(0, 200)
      : "Clean Final";
  const cleanStoragePath = versionStorageKey(
    userId,
    documentId,
    versionSlug,
    resolveDownloadFilename(docFilename, displayName, null),
  );

  let pdfStoragePath: string;
  let pdfBuf: Buffer;
  let qaReport;
  try {
    pdfBuf = await convertToPdf(clean.bytes, "docx");
    qaReport = await verifyDerivedArtifact({
      bytes: clean.bytes,
      fileType: "docx",
      pdfRenditionBytes: pdfBuf,
      trackedViews: false,
    });
    if (!qaReport) throw new Error("Clean-final layout QA returned no result.");
    await uploadFile(
      cleanStoragePath,
      bufferToArrayBuffer(clean.bytes),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    pdfStoragePath = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
    await uploadFile(
      pdfStoragePath,
      bufferToArrayBuffer(pdfBuf),
      "application/pdf",
    );
  } catch (err) {
    await deleteFile(cleanStoragePath).catch(() => {});
    console.error("[clean-final] failed to write clean final", err);
    const qa = layoutQaHttpError(err);
    return {
      ok: false,
      status: qa?.status ?? 500,
      detail: qa?.detail ?? "Failed to create clean final document.",
      code: qa?.code,
    };
  }

  const nextVersionNumber = await nextVisibleVersionNumber(db, documentId);
  let versionRow: VersionResponseRow;
  try {
    const inserted = await insertDocumentVersionCompat({
      db,
      fallbackSource: "generated",
      errorMessage: "Failed to record clean final version.",
      values: {
        document_id: documentId,
        storage_path: cleanStoragePath,
        pdf_storage_path: pdfStoragePath,
        source: "clean_final",
        version_number: nextVersionNumber,
        display_name: displayName,
        created_by_user_id: userId,
        metadata: {
          parent_version_id: active.id,
          accepted_body_tracked_changes: clean.resolvedCount,
          scope: "document_body_w_ins_w_del",
          ...reflowed.metadata,
          layout_qa: {
            status: "passed",
            schema_version: qaReport.schema_version,
            checked_at: qaReport.checked_at,
          },
        },
        ...layoutQaVersionValues(qaReport),
      },
    });
    const { data: selected, error: selectErr } = await db
      .from("document_versions")
      .select("id, version_number, source, created_at, display_name")
      .eq("id", inserted.id)
      .single();
    if (selectErr || !selected) {
      throw new Error(
        `Failed to load clean final version. ${describeSupabaseError(selectErr)}`,
      );
    }
    versionRow = selected as VersionResponseRow;
  } catch (versionErr) {
    await deleteFile(cleanStoragePath).catch(() => {});
    await deleteFile(pdfStoragePath).catch(() => {});
    return {
      ok: false,
      status: 500,
      detail:
        versionErr instanceof Error
          ? versionErr.message
          : `Failed to record clean final version. ${describeSupabaseError(versionErr)}`,
    };
  }

  const { data: updatedDoc, error: updateErr } = await db
    .from("documents")
    .update({
      current_version_id: versionRow.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .eq("current_version_id", active.id)
    .select("id")
    .maybeSingle();
  if (updateErr || !updatedDoc) {
    await db.from("document_versions").delete().eq("id", versionRow.id);
    await deleteFile(cleanStoragePath).catch(() => {});
    await deleteFile(pdfStoragePath).catch(() => {});
    return {
      ok: false,
      status: 409,
      detail:
        "Document changed while creating the clean final. Refresh the document and try again.",
    };
  }

  return {
    ok: true,
    versionRow,
    storagePath: cleanStoragePath,
    downloadUrl: buildDownloadUrl(cleanStoragePath, docFilename),
  };
}

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;
  const db = createServerSupabase();

  console.log(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  console.log(`[edit-resolution] fetched edit row`, { edit, editErr });
  if (!edit) {
    console.log(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    console.log(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, filename, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      console.log(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
    if (!accessResolved.ok) {
      console.log(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            (doc.filename as string) ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  console.log(`[edit-resolution] fetched doc`, { doc, docErr });
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  const parentVersionId = active?.id ?? null;
  console.log(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath || !parentVersionId)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  console.log(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  let reflowed: DocxReflowResult;
  try {
    reflowed = await reflowFramedDocx(Buffer.from(raw));
  } catch (err) {
    if (err instanceof DocumentReflowError) {
      return void res.status(422).json({
        detail: err.message,
        code: err.code,
      });
    }
    throw err;
  }

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    reflowed.bytes,
    wIds,
    mode,
  );
  console.log(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  const { count: remainingPendingAfterDecision } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending")
    .neq("id", editId);

  const snapshot = await createDecisionSnapshot({
    db,
    userId,
    documentId,
    filename: (doc.filename as string) ?? "document.docx",
    parentVersionId,
    resolvedBytes,
    editId,
    mode,
    found,
    remainingPending: remainingPendingAfterDecision ?? 0,
    reflowMetadata: reflowed.metadata,
  });
  if (!snapshot.ok) {
    return void res.status(snapshot.status).json({
      detail: snapshot.detail,
      ...(snapshot.code ? { code: snapshot.code } : {}),
    });
  }

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  console.log(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
    statusErr,
  });

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  console.log(`[edit-resolution] remaining pending count`, { remainingPending });

  // When the last pending change is resolved, promote the result to a visible,
  // numbered clean_final version so the accepted document appears in the
  // version history (the per-edit decision snapshots stay hidden). Best-effort:
  // if finalizing fails, fall back to returning the decision snapshot.
  let finalVersionId: string = snapshot.versionId;
  let finalVersionNumber: number | null = null;
  let finalDownloadUrl: string | null = snapshot.downloadUrl;
  let finalized = false;
  if ((remainingPending ?? 0) === 0) {
    const terminalActive = await loadActiveVersion(documentId, db);
    if (terminalActive) {
      const clean = await createCleanFinalVersion({
        db,
        userId,
        documentId,
        docFilename: (doc.filename as string) ?? "document.docx",
        active: terminalActive,
      });
      if (clean.ok) {
        finalVersionId = clean.versionRow.id as string;
        finalVersionNumber =
          (clean.versionRow.version_number as number | null) ?? null;
        finalDownloadUrl = clean.downloadUrl;
        finalized = true;
      } else {
        console.error("[edit-resolution] auto clean-final failed", clean);
      }
    }
  }

  const payload = {
    ok: true,
    version_id: finalVersionId,
    version_number: finalVersionNumber,
    download_url: finalDownloadUrl,
    remaining_pending: remainingPending ?? 0,
    finalized,
  };
  console.log(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

documentsRouter.post("/:documentId/finalize-clean", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db, "mutate");
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const fileType = (doc.file_type as string | null) ?? "";
  if (fileType !== "docx") {
    return void res.status(400).json({
      detail: "Clean finalization currently supports DOCX files only.",
    });
  }

  const active = await loadActiveVersion(documentId, db);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const { count: pendingCount } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  if ((pendingCount ?? 0) > 0) {
    return void res.status(409).json({
      detail: "Resolve all pending tracked changes before creating a clean final version.",
      pending_count: pendingCount ?? 0,
    });
  }

  if (active.source === "clean_final") {
    return void res.json({
      ok: true,
      already_final: true,
      document_id: documentId,
      version_id: active.id,
      version_number: active.version_number,
      filename: resolveDownloadFilename(
        doc.filename as string,
        active.display_name,
        active.version_number,
      ),
      download_url: buildDownloadUrl(
        active.storage_path,
        (doc.filename as string) ?? "document.docx",
      ),
      remaining_pending: 0,
    });
  }

  const result = await createCleanFinalVersion({
    db,
    userId,
    documentId,
    docFilename: doc.filename as string,
    active,
    displayName:
      typeof req.body?.display_name === "string"
        ? req.body.display_name
        : null,
  });
  if (!result.ok)
    return void res.status(result.status).json({
      detail: result.detail,
      ...(result.code ? { code: result.code } : {}),
    });

  res.status(201).json({
    ok: true,
    document_id: documentId,
    version_id: result.versionRow.id,
    version_number: result.versionRow.version_number,
    version: result.versionRow,
    filename: resolveDownloadFilename(
      doc.filename as string,
      result.versionRow.display_name as string | null,
      result.versionRow.version_number as number | null,
    ),
    download_url: result.downloadUrl,
    remaining_pending: 0,
  });
});
