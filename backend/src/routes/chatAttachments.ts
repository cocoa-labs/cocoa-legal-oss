import crypto from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { checkProjectAccess } from "../lib/access";
import { createServerSupabase } from "../lib/supabase";
import { singleFileUpload } from "../lib/upload";
import {
  buildContentDisposition,
  deleteFile,
  downloadFile,
  normalizeDownloadFilename,
  uploadFile,
} from "../lib/storage";
import { isAllowedImageMime, MAX_IMAGE_BYTES } from "../lib/uploadTypes";
import {
  canonicalAttachmentFilename,
  sniffRasterImageMime,
} from "../lib/email/attachments";

export const chatAttachmentsRouter = Router();

function extensionForMime(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".png";
}

function safeImageFilename(filename: string, mime: string): string {
  const normalized = normalizeDownloadFilename(filename || "image");
  return canonicalAttachmentFilename(normalized, mime);
}

async function canAccessAttachment(args: {
  rowUserId: string;
  rowProjectId: string | null;
  userId: string;
  userEmail: string | undefined;
  db: ReturnType<typeof createServerSupabase>;
}): Promise<boolean> {
  if (args.rowProjectId) {
    const access = await checkProjectAccess(
      args.rowProjectId,
      args.userId,
      args.userEmail,
      args.db,
    );
    return access.ok;
  }
  return args.rowUserId === args.userId;
}

chatAttachmentsRouter.post(
  "/images",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const file = req.file;
    if (!file) return void res.status(400).json({ detail: "file is required" });

    const mime = sniffRasterImageMime(Buffer.from(file.buffer));
    if (!mime || !isAllowedImageMime(mime)) {
      return void res.status(400).json({
        detail: "Unsupported or invalid image type. Allowed: PNG, JPEG, WebP, or GIF.",
      });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return void res.status(413).json({
        detail: "Image too large. Maximum size is 20 MB.",
      });
    }

    const projectId =
      typeof req.body?.project_id === "string" && req.body.project_id.trim()
        ? req.body.project_id.trim()
        : null;
    const db = createServerSupabase();

    if (projectId) {
      const access = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
        "mutate",
      );
      if (!access.ok)
        return void res.status(404).json({ detail: "Project not found" });
    }

    const id = crypto.randomUUID();
    const filename = safeImageFilename(file.originalname, mime);
    const storagePath = `chat-attachments/${userId}/${id}/source${extensionForMime(mime)}`;

    try {
      await uploadFile(
        storagePath,
        file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer,
        mime,
      );

      const { data, error } = await db
        .from("chat_attachments")
        .insert({
          id,
          user_id: userId,
          project_id: projectId,
          kind: "image",
          filename,
          mime_type: mime,
          size_bytes: file.size,
          storage_path: storagePath,
        })
        .select("id, filename, mime_type, size_bytes")
        .single();

      if (error || !data) {
        await deleteFile(storagePath).catch(() => {});
        return void res
          .status(500)
          .json({ detail: "Failed to save image attachment." });
      }

      res.status(201).json(data);
    } catch (err) {
      console.error("[chat-attachments/upload] failed", err);
      await deleteFile(storagePath).catch(() => {});
      res.status(500).json({ detail: "Failed to upload image attachment." });
    }
  },
);

chatAttachmentsRouter.get("/:attachmentId/image", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { attachmentId } = req.params;
  const db = createServerSupabase();

  const { data: row, error } = await db
    .from("chat_attachments")
    .select("id, user_id, project_id, filename, mime_type, storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  if (error || !row) return void res.status(404).json({ detail: "Not found" });

  const canAccess = await canAccessAttachment({
    rowUserId: row.user_id as string,
    rowProjectId: (row.project_id as string | null) ?? null,
    userId,
    userEmail,
    db,
  });
  if (!canAccess) return void res.status(404).json({ detail: "Not found" });

  const bytes = await downloadFile(row.storage_path as string);
  if (!bytes)
    return void res.status(404).json({ detail: "Attachment bytes not found" });

  res.setHeader("Content-Type", row.mime_type as string);
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("inline", row.filename as string),
  );
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(bytes));
});
