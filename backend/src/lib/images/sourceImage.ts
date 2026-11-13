// backend/src/lib/images/sourceImage.ts
//
// Resolve the SOURCE image bytes for an image-to-image edit, and find the
// "most recent image in the chat" when the caller doesn't pin one. Two kinds of
// source can be edited (per the feature spec):
//   * a GENERATED image — a first-class `documents` row (our png artifacts);
//   * an UPLOADED image — a `chat_attachments` row (composer attach/paste/drop).
// Both are tenancy-scoped: a source must belong to the user, or live in the
// project the current chat is in. Storage is R2; bytes are read via downloadFile.

import type { createServerSupabase } from "../supabase";
import { downloadFile } from "../storage";
import { loadActiveVersion } from "../documentVersions";

type Db = ReturnType<typeof createServerSupabase>;

/** A reference to an editable source image: exactly one of the two ids. */
export type EditImageSource = {
    document_id?: string | null;
    attachment_id?: string | null;
};

export interface LoadedSourceImage {
    bytes: Buffer;
    mimeType: string;
    filename: string;
}

/** Map a documents.file_type / filename to an image MIME (defaults to png). */
function mimeForImage(fileType: string | null, filename: string): string {
    const ext = (
        fileType || filename.slice(filename.lastIndexOf(".") + 1)
    )
        .trim()
        .toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    return "image/png";
}

function hasProjectAccess(
    rowUserId: string | null,
    rowProjectId: string | null,
    userId: string,
    projectId?: string | null,
): boolean {
    if (rowUserId === userId) return true;
    return Boolean(projectId && rowProjectId && rowProjectId === projectId);
}

/**
 * Load the raw bytes + MIME of a source image referenced by `ref`. Throws a
 * user-facing Error when the id is unknown, not the caller's, or its bytes are
 * unreadable — the image tool surfaces the message to the model.
 */
export async function loadSourceImageBytes(params: {
    db: Db;
    userId: string;
    projectId?: string | null;
    ref: EditImageSource;
}): Promise<LoadedSourceImage> {
    const { db, userId, projectId, ref } = params;

    if (ref.document_id) {
        const { data: doc } = await db
            .from("documents")
            .select("id, user_id, project_id, filename, file_type")
            .eq("id", ref.document_id)
            .single();
        if (!doc) throw new Error("That image could not be found.");
        if (
            !hasProjectAccess(
                (doc.user_id as string) ?? null,
                (doc.project_id as string) ?? null,
                userId,
                projectId,
            )
        ) {
            throw new Error("That image is not available in this chat.");
        }
        const active = await loadActiveVersion(ref.document_id, db);
        if (!active?.storage_path) {
            throw new Error("That image has no stored file to edit.");
        }
        const bytes = await downloadFile(active.storage_path);
        if (!bytes) throw new Error("Could not read that image's file.");
        const filename = (doc.filename as string) || "image.png";
        return {
            bytes: Buffer.from(bytes),
            mimeType: mimeForImage((doc.file_type as string) ?? null, filename),
            filename,
        };
    }

    if (ref.attachment_id) {
        const { data: att } = await db
            .from("chat_attachments")
            .select("id, user_id, project_id, filename, mime_type, storage_path")
            .eq("id", ref.attachment_id)
            .single();
        if (!att) throw new Error("That attached image could not be found.");
        if (
            !hasProjectAccess(
                (att.user_id as string) ?? null,
                (att.project_id as string) ?? null,
                userId,
                projectId,
            )
        ) {
            throw new Error("That attached image is not available in this chat.");
        }
        const bytes = await downloadFile(att.storage_path as string);
        if (!bytes) throw new Error("Could not read that attached image's file.");
        const filename = (att.filename as string) || "image.png";
        return {
            bytes: Buffer.from(bytes),
            mimeType:
                (att.mime_type as string) || mimeForImage(null, filename),
            filename,
        };
    }

    throw new Error("No source image was specified to edit.");
}

/** How far back to scan for the most recent image before giving up. */
const LATEST_IMAGE_SCAN_LIMIT = 60;

/**
 * Find the most recent image in `chatId` (newest-first): a generated image from
 * an assistant `image_generated` event, or an uploaded image from a user
 * message's `files[]`. Returns a ref for `loadSourceImageBytes`, or null when
 * the conversation has no image yet. The current turn's just-generated image is
 * NOT here yet (the assistant row is persisted after the turn) — the model
 * should pass that document_id explicitly.
 */
export async function resolveLatestChatImage(params: {
    db: Db;
    chatId: string;
    userId: string;
}): Promise<EditImageSource | null> {
    const { db, chatId } = params;
    const { data: rows } = await db
        .from("chat_messages")
        .select("role, content, files, created_at")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: false })
        .limit(LATEST_IMAGE_SCAN_LIMIT);
    if (!rows?.length) return null;

    for (const row of rows as {
        role: string;
        content: unknown;
        files: unknown;
    }[]) {
        if (row.role === "assistant" && Array.isArray(row.content)) {
            for (let i = row.content.length - 1; i >= 0; i -= 1) {
                const ev = row.content[i] as {
                    type?: string;
                    document_id?: string;
                };
                if (ev?.type === "image_generated" && ev.document_id) {
                    return { document_id: ev.document_id };
                }
            }
        }
        if (row.role === "user" && Array.isArray(row.files)) {
            for (let i = row.files.length - 1; i >= 0; i -= 1) {
                const f = row.files[i] as {
                    kind?: string;
                    attachment_id?: string;
                };
                if (f?.kind === "image" && f.attachment_id) {
                    return { attachment_id: f.attachment_id };
                }
            }
        }
    }
    return null;
}
