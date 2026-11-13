import { docxToPdf, convertedPdfKey } from "./convert";
import { acceptAllTrackedChangesInBody } from "./docxTrackedChanges";
import { removeDocxHighlights } from "./docxHighlights";
import { reflowFramedDocx, type DocxReflowResult } from "./docxLayout";
import { buildDownloadUrl } from "./downloadTokens";
import {
    describeSupabaseError,
    insertDocumentVersionCompat,
    loadActiveVersion,
} from "./documentVersions";
import { createServerSupabase } from "./supabase";
import {
    layoutQaVersionValues,
    verifyDerivedArtifact,
} from "./documentLayoutGate";
import {
    deleteFile,
    downloadFile,
    storageKey,
    uploadFile,
} from "./storage";

type Supa = ReturnType<typeof createServerSupabase>;

const DOCX_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

export function normalizeCleanDocumentFilename(input: string): string {
    const raw = input.trim();
    if (!raw) throw new Error("new_filename is required.");
    if (/[\\/]/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) {
        throw new Error("new_filename cannot include path separators or control characters.");
    }

    const stem = /\.docx$/i.test(raw)
        ? raw.slice(0, -".docx".length)
        : raw.replace(/\.[^./\\]+$/, "");
    const normalizedStem = stem.trim().slice(0, 195).trim();
    if (!normalizedStem || normalizedStem === ".") {
        throw new Error("new_filename must include a filename stem.");
    }
    return `${normalizedStem}.docx`;
}

export async function prepareCleanDocumentCopyBytes(
    bytes: Buffer,
): Promise<{
    bytes: Buffer;
    changed: boolean;
    resolvedCount: number;
    removedHighlightCount: number;
    reflowMetadata: DocxReflowResult["metadata"];
}> {
    const reflowed = await reflowFramedDocx(bytes);
    const accepted = await acceptAllTrackedChangesInBody(reflowed.bytes);
    const unhighlighted = await removeDocxHighlights(accepted.bytes, [], {
        all: true,
    });
    return {
        bytes: unhighlighted.bytes,
        changed: accepted.changed || unhighlighted.removed_count > 0,
        resolvedCount: accepted.resolvedCount,
        removedHighlightCount: unhighlighted.removed_count,
        reflowMetadata: reflowed.metadata,
    };
}

export async function createCleanDocumentCopy(params: {
    db: Supa;
    userId: string;
    projectId: string;
    sourceDocumentId: string;
    sourceFilename: string;
    newFilename: string;
}): Promise<{
    filename: string;
    document_id: string;
    version_id: string;
    version_number: number;
    storage_path: string;
    download_url: string;
    accepted_tracked_changes: number;
    removed_highlight_count: number;
}> {
    const filename = normalizeCleanDocumentFilename(params.newFilename);
    const active = await loadActiveVersion(params.sourceDocumentId, params.db);
    if (!active) throw new Error("Source document has no active version.");

    const raw = await downloadFile(active.storage_path);
    if (!raw) throw new Error("Could not read source document bytes from storage.");
    const clean = await prepareCleanDocumentCopyBytes(Buffer.from(raw));
    const pdfBuf = await docxToPdf(clean.bytes);
    const qaReport = await verifyDerivedArtifact({
        bytes: clean.bytes,
        fileType: "docx",
        pdfRenditionBytes: pdfBuf,
        trackedViews: false,
    });
    if (!qaReport) {
        throw new Error("Clean document layout verification returned no result.");
    }

    const { data: orphanRow } = await params.db
        .from("documents")
        .select("id")
        .eq("project_id", params.projectId)
        .eq("user_id", params.userId)
        .eq("filename", filename)
        .is("current_version_id", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    let createdNewDocument = false;
    let docRow: { id: string } | null = orphanRow as { id: string } | null;
    if (!docRow) {
        const inserted = await params.db
            .from("documents")
            .insert({
                project_id: params.projectId,
                user_id: params.userId,
                filename,
                file_type: "docx",
                size_bytes: clean.bytes.byteLength,
                status: "ready",
            })
            .select("id")
            .single();
        if (inserted.error || !inserted.data) {
            throw new Error(
                `Failed to record clean document. ${describeSupabaseError(inserted.error)}`,
            );
        }
        docRow = inserted.data as { id: string };
        createdNewDocument = true;
    }

    const documentId = String(docRow.id);
    const cleanStoragePath = storageKey(params.userId, documentId, filename);
    let pdfStoragePath: string | null = null;

    try {
        await uploadFile(
            cleanStoragePath,
            bufferToArrayBuffer(clean.bytes),
            DOCX_CONTENT_TYPE,
        );

        const pdfKey = convertedPdfKey(params.userId, documentId);
        await uploadFile(pdfKey, bufferToArrayBuffer(pdfBuf), "application/pdf");
        pdfStoragePath = pdfKey;

        const versionRow = await insertDocumentVersionCompat({
            db: params.db,
            fallbackSource: "generated",
            errorMessage: "Failed to record clean document version.",
            values: {
                document_id: documentId,
                storage_path: cleanStoragePath,
                pdf_storage_path: pdfStoragePath,
                source: "clean_final",
                version_number: 1,
                display_name: filename,
                created_by_user_id: params.userId,
                metadata: {
                    source_document_id: params.sourceDocumentId,
                    source_version_id: active.id,
                    source_filename: params.sourceFilename,
                    derivation_kind: "clean_final",
                    accepted_body_tracked_changes: clean.resolvedCount,
                    removed_highlight_count: clean.removedHighlightCount,
                    scope: "document_body_w_ins_w_del",
                    ...clean.reflowMetadata,
                    layout_qa: {
                        status: "passed",
                        schema_version: qaReport.schema_version,
                        checked_at: qaReport.checked_at,
                    },
                },
                ...layoutQaVersionValues(qaReport),
            },
        });

        const { error: updateErr } = await params.db
            .from("documents")
            .update({
                current_version_id: versionRow.id,
                size_bytes: clean.bytes.byteLength,
                status: "ready",
                updated_at: new Date().toISOString(),
            })
            .eq("id", documentId);
        if (updateErr) {
            throw new Error(
                `Failed to activate clean document version. ${describeSupabaseError(updateErr)}`,
            );
        }

        return {
            filename,
            document_id: documentId,
            version_id: versionRow.id,
            version_number: 1,
            storage_path: cleanStoragePath,
            download_url: buildDownloadUrl(cleanStoragePath, filename),
            accepted_tracked_changes: clean.resolvedCount,
            removed_highlight_count: clean.removedHighlightCount,
        };
    } catch (err) {
        await deleteFile(cleanStoragePath).catch(() => {});
        if (pdfStoragePath) await deleteFile(pdfStoragePath).catch(() => {});
        if (createdNewDocument) {
            await params.db.from("documents").delete().eq("id", documentId);
        }
        throw err;
    }
}
