// backend/src/lib/email/send.ts
//
// The single "send a pending email now" path, shared by the human approval
// route (POST /email/:id/approve) and the autonomous auto-reply orchestrator.
// It sends IN-THREAD when the row carries provider_thread_id / in_reply_to,
// marks the row sent (or failed), and reconciles the agent_operations audit
// row. Idempotent: a no-op (returns the row) when it is not pending_approval.

import type { createServerSupabase } from "../supabase";
import {
    getEmail,
    claimEmailForSending,
    markEmailApproved,
    markEmailSent,
    markEmailFailed,
    updatePendingEmailAttachments,
    type EmailMessage,
    type EmailAttachmentRef,
} from "./store";
import { updateAgentOperation } from "../operations";
import { getEmailConnector } from "../connectors/registry";
import {
    ConnectorNotConfiguredError,
    type EmailAttachment,
    type EmailConnector,
} from "../connectors/types";
import {
    renderBrandedEmail,
    type BrandMode,
    type InlineImage,
} from "./branding";
import { assertBetaDataPolicy } from "../betaPolicy";
import { recordAuditEvent } from "../audit";
import { loadCanonicalAttachment } from "./attachments";

type Db = ReturnType<typeof createServerSupabase>;

/** Guess a MIME type from a filename extension. */
export function guessContentType(filename: string): string {
    const dot = filename.lastIndexOf(".");
    const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
    switch (ext) {
        case "pdf":
            return "application/pdf";
        case "docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "doc":
            return "application/msword";
        case "txt":
            return "text/plain";
        case "html":
        case "htm":
            return "text/html";
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "webp":
            return "image/webp";
        case "gif":
            return "image/gif";
        case "csv":
            return "text/csv";
        case "xlsx":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        default:
            return "application/octet-stream";
    }
}

/**
 * Branding mode for an email: replies (rows carrying an in_reply_to or a
 * provider thread id) get LIGHT branding so they read naturally inside the
 * thread; new / standalone emails get the FULL branded shell. Pure — hermetic.
 */
export function selectBrandMode(email: {
    in_reply_to: string | null;
    provider_thread_id: string | null;
}): BrandMode {
    return email.in_reply_to || email.provider_thread_id ? "light" : "full";
}

/**
 * Expand stored attachment refs into connector attachments. Outbound images
 * deliberately remain ordinary downloadable attachments: correct MIME and
 * filename metadata lets Gmail preview them without duplicating the image in
 * the body. Missing bytes are a hard failure at the send preflight, so this
 * helper only skips when directly exercised with a nullable test loader.
 */
export async function expandAttachments(
    refs: EmailAttachmentRef[],
    loadBytes: (
        documentId: string,
        versionId: string | null | undefined,
    ) => Promise<Buffer | null>,
): Promise<{ attachments: EmailAttachment[]; inlineImages: InlineImage[] }> {
    const attachments: EmailAttachment[] = [];
    const inlineImages: InlineImage[] = [];
    for (const ref of refs) {
        const content = await loadBytes(ref.document_id, ref.version_id);
        if (!content) continue;
        const contentType = ref.content_type ?? guessContentType(ref.filename);
        attachments.push({ filename: ref.filename, contentType, content });
    }
    return { attachments, inlineImages };
}

/**
 * Send a pending_approval email via the connector, threading the reply when the
 * row carries provider_thread_id / in_reply_to. Marks the row sent (or failed)
 * and reconciles the operation. Throws on send failure (after marking failed) so
 * the caller can map ConnectorNotConfiguredError → 503, etc. Idempotent: returns
 * the row unchanged when it is not pending_approval.
 */
export async function sendEmailNow(
    db: Db,
    emailId: string,
    opts: {
        approvedBy: string;
        approvedByEmail?: string | null;
        connector?: EmailConnector;
    },
): Promise<EmailMessage> {
    const email = await getEmail(db, emailId);
    if (!email) throw new Error("Email not found");
    if (email.status !== "pending_approval") return email; // fast-path no-op

    // Ordinary outbound email is intentionally not recipient-allowlisted.
    // Controlled-beta still requires the organization-level data-use
    // acknowledgement, but an authenticated user may address their own draft
    // to any valid recipient they choose.
    await assertBetaDataPolicy(db, {
        orgId: email.org_id,
        projectId: email.project_id,
        userId: email.user_id,
    });

    // Resolve every source again under the approving user's CURRENT export
    // access and load every byte before claiming the send. This both lazily
    // repairs legacy UUID/octet-stream refs and guarantees we never send an
    // email that silently omitted an attachment it promised.
    const loadedAttachments = await Promise.all(
        email.attachments.map((ref) =>
            loadCanonicalAttachment({
                db,
                userId: opts.approvedBy,
                userEmail: opts.approvedByEmail,
                ref,
            }),
        ),
    );
    const canonicalRefs = loadedAttachments.map((loaded) => loaded.ref);
    const repairedCount = canonicalRefs.reduce((count, ref, index) => {
        const original = email.attachments[index];
        return count +
            (original &&
            original.filename === ref.filename &&
            original.content_type === ref.content_type &&
            original.version_id === ref.version_id &&
            (original.source_kind ?? "document") === ref.source_kind
                ? 0
                : 1);
    }, 0);
    console.info("[email-attachments] preflight", {
        attachmentCount: canonicalRefs.length,
        imageCount: canonicalRefs.filter((ref) =>
            ref.content_type?.startsWith("image/"),
        ).length,
        repairedCount,
    });
    if (canonicalRefs.length > 0) {
        await updatePendingEmailAttachments(db, email.id, canonicalRefs);
    }

    // Atomically claim the send (pending_approval → sending) so two concurrent
    // approvals can't both dispatch. If we lost the claim, another sender already
    // has it — return the current row without re-sending (idempotent).
    const claimed = await claimEmailForSending(db, email.id);
    if (!claimed) return (await getEmail(db, emailId)) ?? email;

    const contentBySourceId = new Map(
        loadedAttachments.map((loaded) => [
            loaded.ref.document_id,
            loaded.content,
        ]),
    );
    const { attachments, inlineImages } = await expandAttachments(
        canonicalRefs,
        async (sourceId) => contentBySourceId.get(sourceId) ?? null,
    );

    // Brand every outbound email: the full shell for new mail, a light touch for
    // threaded replies. `text` stays the untouched plain-text fallback; `html`
    // is the branded body (with any inline image embedded by cid).
    const { text, html } = await renderBrandedEmail({
        bodyText: email.body_text,
        bodyHtml: email.body_html,
        mode: selectBrandMode(email),
        inlineImages,
    });

    const connector = opts.connector ?? getEmailConnector();
    try {
        const result = await connector.send({
            to: email.to_addresses,
            cc: email.cc_addresses,
            subject: email.subject,
            text,
            html,
            attachments,
            // Thread the reply when this row is a reply (set by the auto-reply
            // orchestrator). New emails leave these undefined → new thread.
            threadId: email.provider_thread_id ?? undefined,
            inReplyTo: email.in_reply_to ?? undefined,
            // Honor a stored Reply-To (e.g. automation acknowledgements answer
            // the correspondent's preferred address). Null → header omitted,
            // exactly the pre-023 behavior.
            replyTo: email.reply_to_address ?? undefined,
        });
        await markEmailApproved(db, email.id, opts.approvedBy);
        const sent = await markEmailSent(db, email.id, {
            providerMessageId: result.messageId,
            providerThreadId: result.threadId,
        });
        await updateAgentOperation(db, email.agent_operation_id, {
            status: "succeeded",
            approvalStatus: "approved",
            approvedByUserId: opts.approvedBy,
            completed: true,
            metadata: { provider_message_id: result.messageId },
        });
        await recordAuditEvent(db, { orgId: email.org_id, projectId: email.project_id, actorUserId: opts.approvedBy, eventType: "email.sent", targetType: "email_message", targetId: email.id });
        return sent ?? email;
    } catch (sendErr) {
        const message =
            sendErr instanceof Error ? sendErr.message : "Failed to send email";
        await markEmailFailed(db, email.id, message);
        // Mirror the prior approve-route behavior: a not-configured connector
        // marks the email failed but does not mark the operation failed.
        if (!(sendErr instanceof ConnectorNotConfiguredError)) {
            await updateAgentOperation(db, email.agent_operation_id, {
                status: "failed",
                completed: true,
                errors: [{ message }],
            });
        }
        throw sendErr;
    }
}
