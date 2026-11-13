import type { createServerSupabase } from "../supabase";
import { checkProjectAccess, ensureDocAccess } from "../access";
import { loadActiveVersion } from "../documentVersions";
import { downloadFile, normalizeDownloadFilename } from "../storage";
import {
    extractExtension,
    mimeForExtension,
    sniffRasterImageMime,
} from "../uploadTypes";
import type { EmailAttachmentRef } from "./store";
import { ensureVersionExportable } from "../documentLayoutGate";
import { layoutQaHttpError } from "../documentLayoutQa";

type Db = ReturnType<typeof createServerSupabase>;

export type EmailAttachmentErrorCode =
    | "EMAIL_ATTACHMENT_UNAVAILABLE"
    | "EMAIL_ATTACHMENT_FORBIDDEN";

export class EmailAttachmentError extends Error {
    constructor(
        public readonly code: EmailAttachmentErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "EmailAttachmentError";
    }
}

export type OutboundAttachmentCandidate =
    | {
          sourceKind: "document";
          sourceId: string;
          versionId?: string | null;
      }
    | {
          sourceKind: "chat_attachment";
          sourceId: string;
      };

export type LoadedEmailAttachment = {
    ref: EmailAttachmentRef;
    content: Buffer;
};

const RASTER_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
]);

export function isRasterImageMime(value: string | null | undefined): boolean {
    return Boolean(value && RASTER_IMAGE_MIMES.has(value.toLowerCase()));
}

export { sniffRasterImageMime };

function preferredExtension(mime: string): string | null {
    if (mime === "image/png") return "png";
    if (mime === "image/jpeg") return "jpg";
    if (mime === "image/webp") return "webp";
    if (mime === "image/gif") return "gif";
    return null;
}

function extensionMatchesMime(extension: string, mime: string): boolean {
    if (mime === "image/jpeg") return extension === "jpg" || extension === "jpeg";
    return mimeForExtension(extension) === mime;
}

export function canonicalAttachmentFilename(
    filename: string,
    contentType: string,
): string {
    const normalized = normalizeDownloadFilename(filename || "attachment");
    const expected = preferredExtension(contentType);
    if (!expected) return normalized;
    const current = extractExtension(normalized);
    if (current && extensionMatchesMime(current, contentType)) return normalized;
    const base = current
        ? normalized.slice(0, -(current.length + 1))
        : normalized;
    return `${base || "image"}.${expected}`;
}

function documentContentType(fileType: string | null, filename: string): string {
    const fromType = fileType ? mimeForExtension(fileType) : null;
    return (
        fromType ??
        mimeForExtension(extractExtension(filename)) ??
        "application/octet-stream"
    );
}

async function canAccessChatAttachment(params: {
    rowUserId: string;
    rowProjectId: string | null;
    userId: string;
    userEmail?: string | null;
    db: Db;
}): Promise<boolean> {
    if (!params.rowProjectId) return params.rowUserId === params.userId;
    return (
        await checkProjectAccess(
            params.rowProjectId,
            params.userId,
            params.userEmail,
            params.db,
            "export",
        )
    ).ok;
}

async function resolveDocumentCandidate(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    sourceId: string;
    versionId?: string | null;
}): Promise<EmailAttachmentRef> {
    const { data: doc } = await params.db
        .from("documents")
        .select(
            "id, user_id, project_id, matter_id, lifecycle_status, status, filename, file_type, size_bytes",
        )
        .eq("id", params.sourceId)
        .maybeSingle();
    if (!doc || doc.status !== "ready") {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_UNAVAILABLE",
            "That attachment is unavailable or is not ready yet.",
        );
    }
    const access = await ensureDocAccess(
        doc,
        params.userId,
        params.userEmail,
        params.db,
        "export",
    );
    if (!access.ok) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_FORBIDDEN",
            "You no longer have permission to email that attachment.",
        );
    }
    const active = await loadActiveVersion(
        params.sourceId,
        params.db,
        params.versionId ?? null,
    );
    if (!active) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_UNAVAILABLE",
            "That attachment has no available file version.",
        );
    }
    try {
        await ensureVersionExportable({
            db: params.db,
            documentId: params.sourceId,
            versionId: active.id,
            fileType: (doc.file_type as string | null) ?? null,
        });
    } catch (error) {
        const qa = layoutQaHttpError(error);
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_UNAVAILABLE",
            qa?.code === "DOCUMENT_LAYOUT_QA_FAILED"
                ? "That document failed layout verification and was not attached. Nothing was sent."
                : "That document could not be layout-verified, so it was not attached. Nothing was sent.",
        );
    }
    const contentType = documentContentType(
        (doc.file_type as string | null) ?? null,
        String(doc.filename ?? active.display_name ?? "attachment"),
    );
    const filename = canonicalAttachmentFilename(
        String(doc.filename ?? active.display_name ?? "attachment"),
        contentType,
    );
    return {
        source_kind: "document",
        document_id: params.sourceId,
        version_id: active.id,
        filename,
        content_type: contentType,
        size: typeof doc.size_bytes === "number" ? doc.size_bytes : null,
        inline: false,
        content_id: null,
    };
}

async function resolveChatAttachmentCandidate(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    sourceId: string;
    allowedChatAttachmentIds?: ReadonlySet<string>;
}): Promise<EmailAttachmentRef> {
    if (
        params.allowedChatAttachmentIds &&
        !params.allowedChatAttachmentIds.has(params.sourceId)
    ) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_FORBIDDEN",
            "That image is not attached to this saved conversation.",
        );
    }
    const { data: row } = await params.db
        .from("chat_attachments")
        .select(
            "id, user_id, project_id, kind, filename, mime_type, size_bytes, storage_path",
        )
        .eq("id", params.sourceId)
        .maybeSingle();
    if (!row || row.kind !== "image" || !row.storage_path) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_UNAVAILABLE",
            "That uploaded image is unavailable.",
        );
    }
    if (
        !(await canAccessChatAttachment({
            rowUserId: String(row.user_id),
            rowProjectId: (row.project_id as string | null) ?? null,
            userId: params.userId,
            userEmail: params.userEmail,
            db: params.db,
        }))
    ) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_FORBIDDEN",
            "You no longer have permission to email that uploaded image.",
        );
    }
    const contentType = String(row.mime_type ?? "").toLowerCase();
    if (!isRasterImageMime(contentType)) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_UNAVAILABLE",
            "That chat attachment is not a supported image.",
        );
    }
    return {
        source_kind: "chat_attachment",
        document_id: params.sourceId,
        chat_attachment_id: params.sourceId,
        version_id: null,
        filename: canonicalAttachmentFilename(
            String(row.filename ?? "image"),
            contentType,
        ),
        content_type: contentType,
        size:
            typeof row.size_bytes === "number" ? row.size_bytes : null,
        inline: false,
        content_id: null,
    };
}

export async function resolveOutboundAttachmentCandidates(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    candidates: OutboundAttachmentCandidate[];
    allowedChatAttachmentIds?: ReadonlySet<string>;
}): Promise<EmailAttachmentRef[]> {
    const refs: EmailAttachmentRef[] = [];
    const seen = new Set<string>();
    for (const candidate of params.candidates) {
        const key = `${candidate.sourceKind}:${candidate.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(
            candidate.sourceKind === "chat_attachment"
                ? await resolveChatAttachmentCandidate({
                      ...params,
                      sourceId: candidate.sourceId,
                  })
                : await resolveDocumentCandidate({
                      ...params,
                      sourceId: candidate.sourceId,
                      versionId: candidate.versionId,
                  }),
        );
    }
    return refs;
}

export function candidateFromStoredRef(
    ref: EmailAttachmentRef,
): OutboundAttachmentCandidate {
    const chatAttachmentId = ref.chat_attachment_id ?? null;
    if (ref.source_kind === "chat_attachment" || chatAttachmentId) {
        return {
            sourceKind: "chat_attachment",
            sourceId: chatAttachmentId || ref.document_id,
        };
    }
    return {
        sourceKind: "document",
        sourceId: ref.document_id,
        versionId: ref.version_id ?? null,
    };
}

export async function canonicalizeStoredAttachmentRefs(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    refs: EmailAttachmentRef[];
}): Promise<EmailAttachmentRef[]> {
    const refs: EmailAttachmentRef[] = [];
    // Stored arrays are positional: the manifest/content API uses their index.
    // Resolve one at a time so legacy duplicates do not collapse and shift a
    // later attachment's authenticated content URL.
    for (const ref of params.refs) {
        const [canonical] = await resolveOutboundAttachmentCandidates({
            db: params.db,
            userId: params.userId,
            userEmail: params.userEmail,
            candidates: [candidateFromStoredRef(ref)],
        });
        if (!canonical) {
            throw new EmailAttachmentError(
                "EMAIL_ATTACHMENT_UNAVAILABLE",
                "An email attachment could not be resolved.",
            );
        }
        refs.push(canonical);
    }
    return refs;
}

export async function loadCanonicalAttachment(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    ref: EmailAttachmentRef;
}): Promise<LoadedEmailAttachment> {
    const [canonical] = await canonicalizeStoredAttachmentRefs({
        db: params.db,
        userId: params.userId,
        userEmail: params.userEmail,
        refs: [params.ref],
    });
    let bytes: ArrayBuffer | null = null;
    if (canonical.source_kind === "chat_attachment") {
        const { data: row } = await params.db
            .from("chat_attachments")
            .select("storage_path")
            .eq("id", canonical.chat_attachment_id ?? canonical.document_id)
            .maybeSingle();
        if (row?.storage_path) bytes = await downloadFile(String(row.storage_path));
    } else {
        const active = await loadActiveVersion(
            canonical.document_id,
            params.db,
            canonical.version_id ?? null,
        );
        if (active?.storage_path) bytes = await downloadFile(active.storage_path);
    }
    if (!bytes) {
        throw new EmailAttachmentError(
            "EMAIL_ATTACHMENT_UNAVAILABLE",
            "An email attachment could not be loaded. Nothing was sent.",
        );
    }
    const content = Buffer.from(bytes);
    if (isRasterImageMime(canonical.content_type)) {
        const detected = sniffRasterImageMime(content);
        if (!detected) {
            throw new EmailAttachmentError(
                "EMAIL_ATTACHMENT_UNAVAILABLE",
                "An image attachment is invalid or unsupported. Nothing was sent.",
            );
        }
        canonical.content_type = detected;
        canonical.filename = canonicalAttachmentFilename(
            canonical.filename,
            detected,
        );
        canonical.size = content.byteLength;
    }
    return { ref: canonical, content };
}
