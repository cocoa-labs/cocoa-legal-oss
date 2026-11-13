import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { buildContentDisposition, downloadFile } from "../lib/storage";
import { verifyDownload } from "../lib/downloadTokens";
import { ensureDocAccess } from "../lib/access";
import { createAgentOperation } from "../lib/operations";
import { ensureVersionExportable } from "../lib/documentLayoutGate";
import { layoutQaHttpError } from "../lib/documentLayoutQa";

export const downloadsRouter = Router();

function contentTypeFor(filename: string): string {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".docx"))
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".xlsx"))
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return "application/octet-stream";
}

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const info = verifyDownload(req.params.token);
    if (!info)
        return void res.status(404).json({ detail: "Invalid link" });

    const db = createServerSupabase();
    let version:
        | {
              id: string;
              document_id: string;
          }
        | null = null;

    const { data: byStoragePath } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", info.path)
        .maybeSingle();
    if (byStoragePath) {
        version = byStoragePath as { id: string; document_id: string };
    }

    if (!version)
        return void res.status(404).json({ detail: "File not found" });

    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id, file_type")
        .eq("id", version.document_id)
        .single();
    if (!doc)
        return void res.status(404).json({ detail: "File not found" });

    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

    try {
        await ensureVersionExportable({
            db,
            documentId: version.document_id,
            versionId: version.id,
            fileType: (doc.file_type as string | null) ?? null,
        });
    } catch (error) {
        const qa = layoutQaHttpError(error);
        return void res.status(qa?.status ?? 503).json({
            detail:
                qa?.detail ??
                "Document layout verification is unavailable. Nothing was downloaded.",
            code: qa?.code ?? "DOCUMENT_QA_UNAVAILABLE",
            layout_qa: qa?.report ?? null,
        });
    }

    const raw = await downloadFile(info.path);
    if (!raw)
        return void res.status(404).json({ detail: "File not found" });

    void createAgentOperation({
        db,
        userId,
        projectId:
            typeof (doc as { project_id?: unknown }).project_id === "string"
                ? ((doc as { project_id: string }).project_id)
                : null,
        toolName: "download_document",
        actionType: "download",
        status: "succeeded",
        mutating: false,
        requiresApproval: false,
        sourceDocumentId: version.document_id,
        sourceVersionId: version.id,
        arguments: {
            filename: info.filename,
            storage_path_hash: crypto
                .createHash("sha256")
                .update(info.path)
                .digest("hex"),
        },
        metadata: {
            content_type: contentTypeFor(info.filename),
        },
    }).catch((err) => {
        console.warn("[download] failed to record operation", {
            error: err instanceof Error ? err.message : String(err),
        });
    });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    res.send(Buffer.from(raw));
});
