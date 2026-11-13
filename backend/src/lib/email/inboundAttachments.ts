import crypto from "node:crypto";
import type { createServerSupabase } from "../supabase";
import type {
  EmailConnector,
  ParsedEmail,
  ParsedEmailAttachment,
} from "../connectors/types";
import { getEmailConnector } from "../connectors/registry";
import { downloadFile, storageKey, uploadFile } from "../storage";
import { loadActiveVersion } from "../documentVersions";
import { persistDocumentUpload } from "../documentUpload";
import { validateEmailAttachmentBytes, MAX_UPLOAD_SIZE_BYTES } from "../upload";
import {
  DOCUMENT_EXTENSIONS,
  extractExtension,
  mimeForExtension,
  sniffRasterImageMime,
} from "../uploadTypes";
import { claimWorkerLease } from "../workers/leases";
import { getEmail, type EmailMessage } from "./store";
import { canUserReadEmail } from "./access";
import { checkProjectAccess } from "../access";

type Db = ReturnType<typeof createServerSupabase>;
export type InboundAttachment = {
  id: string;
  email_id: string;
  provider_part_id: string;
  provider_attachment_id: string | null;
  ordinal: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  inline: boolean;
  content_id: string | null;
  document_id: string | null;
  version_id: string | null;
  raw_storage_path: string | null;
  sha256: string | null;
  read_status?: string | null;
  read_error?: string | null;
  status:
    | "pending"
    | "processing"
    | "ready"
    | "partial"
    | "failed"
    | "unsupported"
    | "blocked"
    | "deleted";
  error_code: string | null;
  retryable: boolean;
  attempts: number;
  next_attempt_at: string;
};
export const ATTACHMENT_ERRORS: Record<string, string> = {
  ATTACHMENT_TOO_LARGE: "The attachment exceeds the 100 MB processing limit.",
  MALWARE_DETECTED: "The attachment was rejected by the malware scanner.",
  UPLOAD_SCAN_UNAVAILABLE:
    "The malware scanner is unavailable; processing will retry.",
  UPLOAD_CONTAINER_INVALID:
    "The attachment is corrupt or does not match its declared format.",
  UNSUPPORTED_ATTACHMENT:
    "This file format is retained but cannot be analyzed yet.",
  ATTACHMENT_DELETED:
    "The original document was deleted. It will not be restored automatically.",
  ATTACHMENT_UNAVAILABLE:
    "The attachment is no longer available in its original scope.",
  PROVIDER_ATTACHMENT_MISSING:
    "The original attachment is no longer available from the mail provider.",
  PDF_CONVERSION_FAILED:
    "The original is saved, but its document conversion failed.",
  ATTACHMENT_PROCESSING_FAILED:
    "Attachment processing failed; it can be retried.",
  ATTACHMENT_SOURCE_CHANGED:
    "The recovered bytes do not match the saved original.",
};
export const attachmentHash = (bytes: Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export function attachmentPartKey(
  part: ParsedEmailAttachment,
  index: number,
): string {
  return part.partId || part.attachmentId || `part-${index}`;
}
export function attachmentFilename(part: ParsedEmailAttachment): string {
  const name = (part.filename || "attachment").replace(/[\\/\x00-\x1f]/g, "_");
  if (extractExtension(name)) return name;
  const ext = [...DOCUMENT_EXTENSIONS, "png", "jpg", "webp", "gif"].find(
    (e) => mimeForExtension(e) === part.contentType,
  );
  return ext ? `${name}.${ext}` : name;
}
export async function listInboundAttachments(
  db: Db,
  emailId: string,
): Promise<InboundAttachment[]> {
  const { data, error } = await db
    .from("inbound_email_attachments")
    .select("*")
    .eq("email_id", emailId)
    .order("ordinal");
  if (error) throw error;
  return (data ?? []) as InboundAttachment[];
}
async function updateAttachment(
  db: Db,
  id: string,
  fields: Record<string, unknown>,
) {
  const { data, error } = await db
    .from("inbound_email_attachments")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .neq("status", "deleted")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("ATTACHMENT_DELETED");
}
export function attachmentManifest(row: InboundAttachment) {
  return {
    attachment_id: row.id,
    index: row.ordinal,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size_bytes,
    document_id: row.document_id,
    version_id: row.version_id,
    inline: row.inline,
    content_id: row.content_id,
    status:
      row.status === "ready" && row.read_status === "partial"
        ? "partial"
        : row.status,
    retryable: row.retryable,
    error_code: row.error_code,
    detail:
      row.read_error ??
      (row.error_code
        ? (ATTACHMENT_ERRORS[row.error_code] ??
          "Attachment processing is incomplete.")
        : null),
    content_url: `/email/${row.email_id}/attachments/${row.id}/content`,
  };
}

/** Seed legacy refs first so numeric URLs retain their original positional identity. */
async function seedLegacy(db: Db, email: EmailMessage) {
  for (const [ordinal, ref] of email.attachments.entries()) {
    const { data: doc, error } = await db
      .from("documents")
      .select("id, lifecycle_status, user_id, filename")
      .eq("id", ref.document_id)
      .maybeSingle();
    if (error) throw error;
    let versionId = ref.version_id;
    if (doc && !versionId) {
      const { data: first, error: firstError } = await db
        .from("document_versions")
        .select("id")
        .eq("document_id", ref.document_id)
        .eq("version_number", 1)
        .maybeSingle();
      if (firstError) throw firstError;
      versionId = first?.id ?? null;
    }
    const version =
      doc && versionId
        ? await loadActiveVersion(ref.document_id, db, versionId)
        : null;
    const removed = !doc || doc.lifecycle_status !== "active";
    const { error: insertError } = await db
      .from("inbound_email_attachments")
      .upsert(
        {
          email_id: email.id,
          provider_part_id: `legacy-${ordinal}`,
          ordinal,
          filename: ref.filename,
          content_type: ref.content_type ?? "application/octet-stream",
          size_bytes: ref.size ?? 0,
          document_id: ref.document_id,
          version_id: version?.id ?? null,
          raw_storage_path:
            version?.storage_path ??
            (doc
              ? storageKey(doc.user_id, ref.document_id, doc.filename)
              : null),
          status: removed ? "deleted" : "pending",
          retryable: !removed,
          error_code: removed ? "ATTACHMENT_DELETED" : null,
        },
        { onConflict: "email_id,provider_part_id", ignoreDuplicates: true },
      );
    if (insertError) throw insertError;
  }
}

/** Discover before downloading. A failed file always has a durable row. Caller authorizes email first. */
export async function reconcileEmailAttachments(
  db: Db,
  email: EmailMessage,
  parsed?: ParsedEmail,
  connector = getEmailConnector(),
  deps: {
    download?: typeof downloadFile;
    process?: typeof processInboundAttachment;
  } = {},
) {
  if (email.direction !== "inbound") return [];
  // Serialize discovery separately from file processing: two reads must not
  // seed both legacy and provider identities for the same original.
  const discoveryKey = `email-attachment-manifest:${email.id}`;
  const discoveryOwner = crypto.randomUUID();
  if (!(await claimWorkerLease(db, discoveryKey, discoveryOwner, 300)))
    return listInboundAttachments(db, email.id);
  let discoveryLeaseLost = false;
  const discoveryHeartbeat = setInterval(() => {
    void claimWorkerLease(db, discoveryKey, discoveryOwner, 300)
      .then((ok) => {
        if (!ok) discoveryLeaseLost = true;
      })
      .catch(() => {
        discoveryLeaseLost = true;
      });
  }, 30_000);
  discoveryHeartbeat.unref();
  let rows: InboundAttachment[];
  try {
    rows = await listInboundAttachments(db, email.id);
    if (!rows.length && email.attachments.length) {
      await seedLegacy(db, email);
      rows = await listInboundAttachments(db, email.id);
    }
    if (
      !parsed &&
      !email.attachments_reconciled_at &&
      email.provider_message_id &&
      connector.isConfigured()
    ) {
      try {
        parsed = await connector.getMessage(email.provider_message_id);
      } catch {
        /* Saved originals remain usable while the provider is unavailable. */
      }
    }
    if (parsed) {
      let discoveredAll = true;
      const usedLegacy = new Set<string>();
      let nextOrdinal = rows.reduce(
        (max, row) => Math.max(max, row.ordinal + 1),
        0,
      );
      for (const [ordinal, part] of parsed.attachments.entries()) {
        const key = attachmentPartKey(part, ordinal);
        if (rows.some((r) => r.provider_part_id === key)) continue;
        // Match legacy files using bytes, not names. Deleted legacy references are
        // conservatively left alone; ambiguous recovery never recreates a file.
        let legacy: InboundAttachment | undefined;
        const candidates = rows.filter(
          (r) =>
            r.provider_part_id.startsWith("legacy-") && !usedLegacy.has(r.id),
        );
        if (candidates.some((r) => r.status === "deleted")) {
          discoveredAll = false;
          continue;
        }
        if (candidates.length) {
          try {
            const bytes =
              part.data !== undefined
                ? Buffer.from(part.data, "base64url")
                : await connector.getAttachment(parsed.id, part.attachmentId);
            const digest = attachmentHash(bytes);
            let unknownOriginal = false;
            for (const candidate of candidates) {
              const raw =
                !candidate.sha256 && candidate.raw_storage_path
                  ? await (deps.download ?? downloadFile)(
                      candidate.raw_storage_path,
                    )
                  : null;
              const knownHash =
                candidate.sha256 ??
                (raw ? attachmentHash(Buffer.from(raw)) : null);
              if (knownHash === digest) {
                legacy = candidate;
                break;
              }
              if (!knownHash) unknownOriginal = true;
            }
            // With exactly one recorded file and one provider part, parent
            // provenance identifies the original even if storage was lost.
            if (
              !legacy &&
              unknownOriginal &&
              rows.length === 1 &&
              parsed.attachments.length === 1
            )
              legacy = candidates[0];
            if (!legacy && unknownOriginal) {
              discoveredAll = false;
              continue;
            }
          } catch {
            discoveredAll = false;
            continue;
          } // Retry discovery; never duplicate an unknown original.
        }
        const metadata = {
          provider_part_id: key,
          provider_attachment_id: part.attachmentId || null,
          filename: attachmentFilename(part),
          content_type: part.contentType,
          size_bytes: part.size,
          inline: part.inline ?? false,
          content_id: part.contentId ?? null,
        };
        if (discoveryLeaseLost)
          throw new Error("Attachment discovery lease expired");
        if (legacy) {
          await updateAttachment(db, legacy.id, metadata);
          usedLegacy.add(legacy.id);
        } else {
          const { error } = await db.from("inbound_email_attachments").upsert(
            { email_id: email.id, ordinal: nextOrdinal++, ...metadata },
            {
              onConflict: "email_id,provider_part_id",
              ignoreDuplicates: true,
            },
          );
          if (error) throw error;
        }
      }
      const { error } = await db
        .from("email_messages")
        .update({
          attachments_reconciled_at: discoveredAll
            ? new Date().toISOString()
            : null,
        })
        .eq("id", email.id);
      if (error) throw error;
    }
  } finally {
    clearInterval(discoveryHeartbeat);
    await db
      .from("worker_leases")
      .delete()
      .eq("lease_key", discoveryKey)
      .eq("owner_id", discoveryOwner);
  }
  rows = await listInboundAttachments(db, email.id);
  for (const row of rows) {
    if (
      row.retryable &&
      new Date(row.next_attempt_at).getTime() <= Date.now()
    ) {
      const part = parsed?.attachments.find(
        (p, i) => attachmentPartKey(p, i) === row.provider_part_id,
      );
      await (deps.process ?? processInboundAttachment)(db, email, row, {
        part,
        connector,
      });
    }
  }
  return listInboundAttachments(db, email.id);
}

export async function processInboundAttachment(
  db: Db,
  email: EmailMessage,
  row: InboundAttachment,
  deps: {
    part?: ParsedEmailAttachment;
    connector?: EmailConnector;
    validate?: typeof validateEmailAttachmentBytes;
    persist?: typeof persistDocumentUpload;
    download?: typeof downloadFile;
    upload?: typeof uploadFile;
  } = {},
) {
  const startedAt = Date.now();
  if (!row.retryable || row.status === "deleted") return;
  const owner = crypto.randomUUID();
  const leaseKey = `email-attachment:${row.id}`;
  if (!(await claimWorkerLease(db, leaseKey, owner, 300))) return;
  let lostLease = false;
  const heartbeat = setInterval(() => {
    void claimWorkerLease(db, leaseKey, owner, 300)
      .then((ok) => {
        if (!ok) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      });
  }, 30_000);
  heartbeat.unref();
  const connector = deps.connector ?? getEmailConnector();
  const download = deps.download ?? downloadFile;
  const upload = deps.upload ?? uploadFile;
  try {
    // Reload after claiming: a competing reader may already have completed it.
    const { data: fresh, error } = await db
      .from("inbound_email_attachments")
      .select("*")
      .eq("id", row.id)
      .single();
    if (error) throw error;
    if (!fresh?.retryable || fresh.status === "deleted") return;
    row = fresh as InboundAttachment;
    if (email.project_id) {
      const { data: project, error: projectError } = await db
        .from("projects")
        .select("lifecycle_status")
        .eq("id", email.project_id)
        .maybeSingle();
      if (projectError) throw projectError;
      if (!project || project.lifecycle_status !== "active")
        throw new Error("ATTACHMENT_UNAVAILABLE");
    }
    let originalOwner = email.user_id;
    if (row.document_id) {
      const { data: doc, error: docError } = await db
        .from("documents")
        .select("lifecycle_status, project_id, user_id")
        .eq("id", row.document_id)
        .maybeSingle();
      if (docError) throw docError;
      if (doc?.user_id) originalOwner = doc.user_id;
      if (
        doc &&
        (doc.lifecycle_status !== "active" ||
          (!row.version_id && doc.project_id !== email.project_id))
      )
        throw new Error("ATTACHMENT_UNAVAILABLE");
      // A received version can have been filed into a matter after delivery.
      // Repair that version in place; never move it back to the email's scope.
      // Reads still require the parent's email grant AND the current matter ACL.
      if (doc?.project_id && doc.project_id !== email.project_id) {
        const { data: project, error: projectError } = await db
          .from("projects")
          .select("lifecycle_status")
          .eq("id", doc.project_id)
          .maybeSingle();
        if (projectError) throw projectError;
        if (!project || project.lifecycle_status !== "active")
          throw new Error("ATTACHMENT_UNAVAILABLE");
      }
      if (!doc && row.version_id) throw new Error("ATTACHMENT_DELETED");
    }
    await updateAttachment(db, row.id, {
      status: "processing",
      attempts: row.attempts + 1,
      next_attempt_at: new Date(Date.now() + 300_000).toISOString(),
    });
    if (row.size_bytes > MAX_UPLOAD_SIZE_BYTES)
      throw new Error("ATTACHMENT_TOO_LARGE");
    let raw = row.raw_storage_path
      ? await download(row.raw_storage_path)
      : null;
    let bytes: Buffer;
    if (raw) bytes = Buffer.from(raw);
    else {
      let part = deps.part;
      if (
        part?.data === undefined &&
        !row.provider_attachment_id &&
        email.provider_message_id
      ) {
        const parsed = await connector.getMessage(email.provider_message_id);
        part = parsed.attachments.find(
          (p, i) => attachmentPartKey(p, i) === row.provider_part_id,
        );
      }
      if (part?.data !== undefined) bytes = Buffer.from(part.data, "base64url");
      else if (
        email.provider_message_id &&
        (part?.attachmentId || row.provider_attachment_id)
      )
        bytes = await connector.getAttachment(
          email.provider_message_id,
          part?.attachmentId || row.provider_attachment_id!,
        );
      else throw new Error("PROVIDER_ATTACHMENT_MISSING");
    }
    const digest = attachmentHash(bytes);
    if (row.sha256 && row.sha256 !== digest)
      throw new Error("ATTACHMENT_SOURCE_CHANGED");
    await (deps.validate ?? validateEmailAttachmentBytes)(bytes, row.filename);
    if (lostLease) throw new Error("ATTACHMENT_PROCESSING_FAILED");
    const documentId = row.document_id ?? crypto.randomUUID();
    const key =
      row.raw_storage_path ??
      storageKey(email.user_id, documentId, row.filename);
    // Reservation and stable object path precede persistence; retries reuse IDs.
    await updateAttachment(db, row.id, {
      document_id: documentId,
      raw_storage_path: key,
      sha256: digest,
      size_bytes: bytes.length,
    });
    const trustedMime =
      sniffRasterImageMime(bytes) ??
      mimeForExtension(extractExtension(row.filename)) ??
      "application/octet-stream";
    await updateAttachment(db, row.id, { content_type: trustedMime });
    await upload(key, Uint8Array.from(bytes).buffer, trustedMime);
    if (
      !DOCUMENT_EXTENSIONS.has(extractExtension(row.filename)) &&
      !sniffRasterImageMime(bytes)
    )
      throw new Error("UNSUPPORTED_ATTACHMENT");
    // Existing received versions stay pinned. Repair missing renditions without
    // overwriting newer versions or changing ownership of legacy originals.
    let doc: Record<string, any>;
    const pinned = row.version_id
      ? await loadActiveVersion(documentId, db, row.version_id)
      : null;
    if (row.version_id && !pinned) throw new Error("ATTACHMENT_DELETED");
    if (
      pinned &&
      (pinned.pdf_storage_path ||
        ["pdf", "png", "jpg", "jpeg", "webp", "gif"].includes(
          extractExtension(row.filename),
        ))
    ) {
      doc = { version_id: pinned.id, conversion_failed: false };
    } else {
      if (row.version_id) {
        const { convertToPdf } = await import("../convert");
        let pdf: Buffer;
        try {
          pdf = await convertToPdf(bytes, extractExtension(row.filename));
        } catch {
          throw new Error("PDF_CONVERSION_FAILED");
        }
        const pdfKey = `${key}.rendition.pdf`;
        await upload(pdfKey, Uint8Array.from(pdf).buffer, "application/pdf");
        const { error } = await db
          .from("document_versions")
          .update({ pdf_storage_path: pdfKey })
          .eq("id", row.version_id)
          .eq("document_id", documentId);
        if (error) throw error;
        doc = { version_id: row.version_id, conversion_failed: false };
      } else
        doc = await (deps.persist ?? persistDocumentUpload)({
          db,
          userId: originalOwner,
          projectId: email.project_id,
          orgId: email.org_id,
          filename: row.filename,
          content: bytes,
          documentId,
          allowImages: true,
        });
    }
    if (!doc?.version_id) throw new Error("ATTACHMENT_PROCESSING_FAILED");
    if (lostLease) throw new Error("ATTACHMENT_PROCESSING_FAILED");
    await updateAttachment(db, row.id, {
      version_id: doc.version_id,
      raw_storage_path: doc.storage_path ?? key,
      status: doc.conversion_failed ? "partial" : "ready",
      retryable: Boolean(doc.conversion_failed),
      next_attempt_at: new Date(
        Date.now() +
          Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7)),
      ).toISOString(),
      error_code: doc.conversion_failed ? "PDF_CONVERSION_FAILED" : null,
    });
    await syncLegacyAttachmentRefs(db, email.id);
    console.info("[email-attachment] processed", {
      attachmentId: row.id,
      status: doc.conversion_failed ? "partial" : "ready",
      attempt: row.attempts + 1,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const providerStatus =
      (error as { response?: { status?: number }; code?: number })?.response
        ?.status ?? (error as { code?: number })?.code;
    const code =
      providerStatus === 404
        ? "PROVIDER_ATTACHMENT_MISSING"
        : ATTACHMENT_ERRORS[message]
          ? message
          : "ATTACHMENT_PROCESSING_FAILED";
    const terminal = [
      "UNSUPPORTED_ATTACHMENT",
      "MALWARE_DETECTED",
      "UPLOAD_CONTAINER_INVALID",
      "ATTACHMENT_TOO_LARGE",
      "ATTACHMENT_DELETED",
      "ATTACHMENT_UNAVAILABLE",
      "ATTACHMENT_SOURCE_CHANGED",
    ].includes(code);
    if (!lostLease)
      await updateAttachment(db, row.id, {
        status:
          code === "UNSUPPORTED_ATTACHMENT"
            ? "unsupported"
            : code === "ATTACHMENT_DELETED"
              ? "deleted"
              : terminal
                ? "blocked"
                : code === "PDF_CONVERSION_FAILED" && row.version_id
                  ? "partial"
                  : "failed",
        error_code: code,
        retryable: !terminal,
        next_attempt_at: new Date(
          Date.now() +
            Math.min(3600_000, 30_000 * 2 ** Math.min(row.attempts, 7)),
        ).toISOString(),
      }).catch((error) => {
        if (!(error instanceof Error) || error.message !== "ATTACHMENT_DELETED")
          throw error;
      });
    console.warn("[email-attachment] processing", {
      attachmentId: row.id,
      code,
      retryable: !terminal,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    clearInterval(heartbeat);
    await db
      .from("worker_leases")
      .delete()
      .eq("lease_key", leaseKey)
      .eq("owner_id", owner);
  }
}

export async function syncLegacyAttachmentRefs(db: Db, emailId: string) {
  const { error } = await db.rpc("refresh_inbound_attachment_refs", {
    p_email_id: emailId,
  });
  if (error) throw error;
}

/** Read-only email grant. It never authorizes edits, exports, or other thread members. */
export async function authorizedInboundAttachment(
  db: Db,
  userId: string,
  emailId: string,
  id: string,
  userEmail?: string | null,
) {
  const email = await getEmail(db, emailId);
  if (!email || !(await canUserReadEmail(db, userId, email, userEmail)))
    return null;
  const rows = await listInboundAttachments(db, email.id);
  const row = /^\d+$/.test(id)
    ? rows.find((r) => r.ordinal === Number(id))
    : rows.find((r) => r.id === id);
  if (!row || ["deleted", "blocked"].includes(row.status)) return null;
  if (row.document_id) {
    const { data: doc, error } = await db
      .from("documents")
      .select("id, project_id, lifecycle_status")
      .eq("id", row.document_id)
      .maybeSingle();
    if (error) throw error;
    if (
      doc &&
      (doc.lifecycle_status !== "active" ||
        (doc.project_id &&
          !(await checkProjectAccess(doc.project_id, userId, userEmail, db))
            .ok))
    )
      return null;
    if (!doc && row.version_id) return null;
  }
  return { email, attachment: row };
}

export async function retryInboundAttachment(
  db: Db,
  userId: string,
  emailId: string,
  id: string,
  userEmail?: string | null,
) {
  const allowed = await authorizedInboundAttachment(
    db,
    userId,
    emailId,
    id,
    userEmail,
  );
  if (!allowed || !allowed.attachment.retryable) return false;
  await updateAttachment(db, allowed.attachment.id, {
    next_attempt_at: new Date().toISOString(),
  });
  await processInboundAttachment(db, allowed.email, allowed.attachment);
  return true;
}
