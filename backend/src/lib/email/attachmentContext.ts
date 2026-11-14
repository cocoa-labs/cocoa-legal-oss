import type { DocIndex, DocStore } from "../chatTools";
import type { createServerSupabase } from "../supabase";
import { getEmail, type EmailMessage } from "./store";
import { canUserReadEmail } from "./access";
import {
  attachmentManifest,
  authorizedInboundAttachment,
  reconcileEmailAttachments,
} from "./inboundAttachments";
import { loadActiveVersion } from "../documentVersions";
import {
  DOCUMENT_EXTENSIONS,
  mimeForExtension,
  extractExtension,
} from "../uploadTypes";

type Db = ReturnType<typeof createServerSupabase>;
export type EmailAttachmentsLoadedEvent = {
  type: "email_attachments_loaded";
  email_id: string;
  attachments: {
    attachment_id: string;
    document_id: string;
    version_id: string;
  }[];
};
export async function registerEmailAttachments(params: {
  db: Db;
  email: EmailMessage;
  userId: string;
  userEmail?: string | null;
  docIndex: DocIndex;
  docStore: DocStore;
}) {
  const { db, email, userId, userEmail, docIndex, docStore } = params;
  const event: EmailAttachmentsLoadedEvent = {
    type: "email_attachments_loaded",
    email_id: email.id,
    attachments: [],
  };
  if (!(await canUserReadEmail(db, userId, email, userEmail)))
    return { attachments: [], event };
  const rows = await reconcileEmailAttachments(db, email);
  const attachments = [];
  for (const row of rows) {
    const manifest = attachmentManifest(row);
    let label: string | undefined;
    if (
      row.document_id &&
      row.version_id &&
      ["ready", "partial"].includes(row.status)
    ) {
      const grant = await authorizedInboundAttachment(
        db,
        userId,
        email.id,
        row.id,
        userEmail,
      );
      const version = grant
        ? await loadActiveVersion(row.document_id, db, row.version_id)
        : null;
      if (version) {
        // Use a dedicated email handle, even if this version is already open.
        // Its parent-email grant is then checked on every subsequent read.
        label = Object.keys(docIndex).find(
          (k) =>
            docIndex[k].email_attachment?.attachment_id === row.id &&
            docIndex[k].version_id === version.id,
        );
        if (!label) {
          let n = 0;
          while (docIndex[`doc-${n}`] || docStore.has(`doc-${n}`)) n++;
          label = `doc-${n}`;
          // The current document may have a later upload in another format.
          // Received handles keep the MIME/extension of their own original.
          const fileType =
            [...DOCUMENT_EXTENSIONS, "png", "jpg", "webp", "gif"].find(
              (extension) => mimeForExtension(extension) === row.content_type,
            ) ?? extractExtension(row.filename);
          docIndex[label] = {
            document_id: row.document_id,
            version_id: version.id,
            version_number: version.version_number,
            filename: row.filename,
            email_attachment: { email_id: email.id, attachment_id: row.id },
          };
          docStore.set(label, {
            filename: row.filename,
            storage_path: version.storage_path,
            file_type: fileType || "bin",
          });
        }
        event.attachments.push({
          attachment_id: row.id,
          document_id: row.document_id,
          version_id: version.id,
        });
      }
    }
    attachments.push({ ...manifest, doc_id: label ?? null });
  }
  return { attachments, event };
}
export async function restoreEmailAttachmentContext(params: {
  db: Db;
  events: EmailAttachmentsLoadedEvent[];
  userId: string;
  userEmail?: string | null;
  docIndex: DocIndex;
  docStore: DocStore;
}) {
  for (const id of new Set(params.events.map((e) => e.email_id))) {
    const email = await getEmail(params.db, id);
    if (email) await registerEmailAttachments({ ...params, email });
  }
}

export async function restoreChatEmailAttachments(params: {
  db: Db;
  chatId: string;
  userId: string;
  userEmail?: string | null;
  docIndex: DocIndex;
  docStore: DocStore;
}) {
  const { data, error } = await params.db
    .from("chat_messages")
    .select("content")
    .eq("chat_id", params.chatId)
    .eq("role", "assistant");
  if (error) throw error;
  const events = (data ?? [])
    .flatMap((row) => (Array.isArray(row.content) ? row.content : []))
    .filter(
      (event) =>
        event?.type === "email_attachments_loaded" &&
        typeof event.email_id === "string",
    ) as EmailAttachmentsLoadedEvent[];
  await restoreEmailAttachmentContext({ ...params, events });
}
