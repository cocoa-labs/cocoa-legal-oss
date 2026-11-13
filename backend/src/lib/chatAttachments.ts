import { downloadFile } from "./storage";
import { createServerSupabase } from "./supabase";

type ChatFileLike = {
  kind?: string;
  filename?: string;
  attachment_id?: string;
  mime_type?: string;
};

type MessageLike = {
  files?: ChatFileLike[] | null;
};

export type LoadedImageAttachment = {
  attachmentId: string;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
};

// Use the centralized image-MIME allowlist so adding a new vision-
// eligible format (or removing one) only requires a change in
// uploadTypes.ts.
import { isVisionImageMime } from "./uploadTypes";

function isSupportedImageMime(
  value: unknown,
): value is LoadedImageAttachment["mimeType"] {
  return typeof value === "string" && isVisionImageMime(value);
}

export async function loadRecentImageAttachments(
  messages: MessageLike[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: { projectId?: string | null; limit?: number },
): Promise<Map<string, LoadedImageAttachment>> {
  const limit = options?.limit ?? 4;
  const ids: string[] = [];
  const seen = new Set<string>();

  for (let i = messages.length - 1; i >= 0 && ids.length < limit; i -= 1) {
    const files = messages[i]?.files ?? [];
    for (let j = files.length - 1; j >= 0 && ids.length < limit; j -= 1) {
      const file = files[j];
      if (file?.kind !== "image" || typeof file.attachment_id !== "string") {
        continue;
      }
      if (seen.has(file.attachment_id)) continue;
      seen.add(file.attachment_id);
      ids.push(file.attachment_id);
    }
  }

  if (ids.length === 0) return new Map();

  const { data: rows, error } = await db
    .from("chat_attachments")
    .select("id, user_id, project_id, filename, mime_type, storage_path")
    .in("id", ids);

  if (error || !rows?.length) return new Map();

  const orderedRows = ids
    .map((id) => rows.find((row) => row.id === id))
    .filter(Boolean) as {
    id: string;
    user_id: string;
    project_id: string | null;
    filename: string;
    mime_type: string;
    storage_path: string;
  }[];

  const loaded = new Map<string, LoadedImageAttachment>();
  for (const row of orderedRows) {
    const sameUser = row.user_id === userId;
    const sameProject =
      !!options?.projectId && row.project_id === options.projectId;
    if (!sameUser && !sameProject) continue;
    if (!isSupportedImageMime(row.mime_type)) continue;

    const bytes = await downloadFile(row.storage_path);
    if (!bytes) continue;

    loaded.set(row.id, {
      attachmentId: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      data: Buffer.from(bytes).toString("base64"),
    });
  }

  return loaded;
}
