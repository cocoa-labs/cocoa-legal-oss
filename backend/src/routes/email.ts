import { reconcileEmailAttachments, listInboundAttachments, attachmentManifest, authorizedInboundAttachment, retryInboundAttachment } from "../lib/email/inboundAttachments";
import { downloadFile } from "../lib/storage";
// backend/src/routes/email.ts
//
// HTTP layer for the email capability. Two routers:
//   emailRouter   — authenticated email actions (list / approve / cancel)
//   inboundRouter — public inbound webhook + poll (shared-secret gated)
//
// Mirrors the route/auth pattern in routes/operations.ts: requireAuth +
// res.locals.userId, createServerSupabase() per request, { detail } errors.

import { Router } from "express";
import type { Request, Response } from "express";

import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    cancelPendingEmail,
    getEmail,
    getEmailThread,
    listEmails,
    updatePendingEmailAttachments,
    type EmailDirection,
} from "../lib/email/store";
import { canUserReadEmail, filterReadableEmails } from "../lib/email/access";
import { sendEmailNow } from "../lib/email/send";
import { updateAgentOperation } from "../lib/operations";
import { ConnectorNotConfiguredError } from "../lib/connectors/types";
import {
    BetaPolicyError,
    ensurePersonalBetaPolicyOrganization,
    getBetaPolicyState,
} from "../lib/betaPolicy";
import { ingestRecentInbound } from "../lib/email/ingest";
import { checkProjectAccess, listAccessibleProjectIds } from "../lib/access";
import { recordAuditEvent } from "../lib/audit";
import { authorize } from "../lib/authorization";
import {
    canonicalizeStoredAttachmentRefs,
    EmailAttachmentError,
    isRasterImageMime,
    loadCanonicalAttachment,
} from "../lib/email/attachments";
import { buildContentDisposition } from "../lib/storage";

const router = Router();
router.use(requireAuth);

const inboundRouter = Router();

async function canApproveEmail(
    db: ReturnType<typeof createServerSupabase>,
    email: Awaited<ReturnType<typeof getEmail>> & {},
    userId: string,
    userEmail: string | undefined,
): Promise<boolean> {
    // The person who created a draft can approve it with ordinary read access
    // to its matter; higher project roles do not restrict whom they may email.
    // A removed member cannot send a stale project draft or its attachments.
    if (email.user_id === userId) {
        if (!email.project_id) return true;
        return (
            await checkProjectAccess(
                email.project_id,
                userId,
                userEmail,
                db,
                "read",
            )
        ).ok;
    }
    if (!email.project_id) return email.user_id === userId;
    return (
        await checkProjectAccess(
            email.project_id,
            userId,
            userEmail,
            db,
            "approve",
        )
    ).ok;
}

type StoredEmail = NonNullable<Awaited<ReturnType<typeof getEmail>>>;

function outboundRecipients(email: StoredEmail): string[] {
    return [
        ...new Set(
            [
                ...email.to_addresses,
                ...email.cc_addresses,
                ...email.bcc_addresses,
            ]
                .map((recipient) => recipient.trim().toLowerCase())
                .filter(Boolean),
        ),
    ];
}

async function canManageEmailBetaPolicy(
    db: ReturnType<typeof createServerSupabase>,
    email: StoredEmail,
    organizationId: string | null,
    userId: string,
    userEmail: string | undefined,
): Promise<boolean> {
    if (email.project_id) {
        return (
            await checkProjectAccess(
                email.project_id,
                userId,
                userEmail,
                db,
                "admin",
            )
        ).ok;
    }
    if (!organizationId) {
        // The explicit update action may create a first personal workspace for
        // a standalone draft. It is still limited to the draft's owner.
        return email.user_id === userId;
    }
    return (
        await authorize({
            db,
            userId,
            userEmail,
            action: "matter:admin",
            resource: { orgId: organizationId },
        })
    ).ok;
}

async function emailBetaPolicyReadiness(
    db: ReturnType<typeof createServerSupabase>,
    email: StoredEmail,
    userId: string,
    userEmail: string | undefined,
) {
    const policy = await getBetaPolicyState(db, {
        orgId: email.org_id,
        projectId: email.project_id,
        userId: email.user_id,
    });
    const recipients = outboundRecipients(email);
    return {
        ...policy,
        available: Boolean(policy.organization_id),
        can_manage: policy.enabled
            ? await canManageEmailBetaPolicy(
                  db,
                  email,
                  policy.organization_id,
                  userId,
                  userEmail,
              )
            : false,
        recipients,
    };
}

// ---------------------------------------------------------------------------
// emailRouter (mounted at /email, authenticated)
// ---------------------------------------------------------------------------

// GET /email?direction=&limit=
router.get("/", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const direction =
            req.query.direction === "inbound" ||
            req.query.direction === "outbound"
                ? (req.query.direction as EmailDirection)
                : undefined;
        const limit =
            typeof req.query.limit === "string"
                ? Number.parseInt(req.query.limit, 10)
                : undefined;
        const projectId =
            typeof req.query.project_id === "string"
                ? req.query.project_id
                : undefined;
        if (
            projectId &&
            !(await checkProjectAccess(projectId, userId, userEmail, db)).ok
        ) {
            return void res.status(404).json({ detail: "Project not found" });
        }
        const accessibleProjectIds = projectId
            ? undefined
            : await listAccessibleProjectIds(userId, userEmail, db);
        const emails = await listEmails(db, {
            userId,
            projectId,
            accessibleProjectIds,
            direction,
            limit,
        });
        // This remains a second defensive policy boundary: every row must be
        // independently readable even if a future storage query widens.
        const readable = await filterReadableEmails(
            db,
            userId,
            emails,
            userEmail,
        );
        const decorated = await Promise.all(readable.map(async email => ({ ...email,
            attachment_manifest: email.direction === "inbound" ? (await listInboundAttachments(db, email.id)).map(attachmentManifest) : undefined,
        })));
        res.json({ emails: decorated });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to load emails",
        });
    }
});

// GET /email/:id — a single email plus its thread (read view / deep-link).
// Read scoping (audit High fix): the focal email must pass canUserReadEmail,
// and each thread member is then authorized on its OWN merits — unreadable
// members are omitted from the response rather than riding the focal grant.
// (A Gmail thread can mix an unlinked cold inbound with another user's
// chat-linked outbound; a thread-level grant would leak the latter.) Each
// message carries its own attachments, so attachments ride this per-message
// decision. Approve / cancel below stay owner-only.
router.get("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const email = await getEmail(db, req.params.id);
        if (!email)
            return void res.status(404).json({ detail: "Email not found" });
        if (!(await canUserReadEmail(db, userId, email, userEmail)))
            return void res.status(403).json({ detail: "Forbidden" });
        const messages = email.provider_thread_id
            ? await filterReadableEmails(
                  db,
                  userId,
                  await getEmailThread(db, email.provider_thread_id),
                  userEmail,
              )
            : [email];
        const decorated = await Promise.all(messages.map(async message => ({
            ...message,
            attachment_manifest: message.direction === "inbound"
                ? (await reconcileEmailAttachments(db, message)).map(attachmentManifest) : undefined,
        })));
        res.json({
            email: decorated.find(message => message.id === email.id) ?? email,
            thread: {
                provider_thread_id: email.provider_thread_id,
                messages: decorated,
            },
        });
    } catch (err) {
        res.status(500).json({
            detail: err instanceof Error ? err.message : "Failed to load email",
        });
    }
});

// Canonical attachment manifest for the approval card. Resolving here repairs
// legacy UUID/octet-stream refs and means live/reloaded cards show the same
// human filename and previewability before the user approves the send.
router.get("/:id/attachments", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const email = await getEmail(db, req.params.id);
        if (!email)
            return void res.status(404).json({ detail: "Email not found" });
        if (!(await canUserReadEmail(db, userId, email, userEmail))) {
            return void res.status(403).json({ detail: "Forbidden" });
        }
        if (email.direction === "inbound") {
            const rows = await reconcileEmailAttachments(db, email);
            return void res.json({ attachments: rows.map(attachmentManifest) });
        }
        const refs = await canonicalizeStoredAttachmentRefs({
            db,
            userId,
            userEmail,
            refs: email.attachments,
        });
        if (email.status === "pending_approval" && refs.length > 0) {
            await updatePendingEmailAttachments(db, email.id, refs);
        }
        res.json({
            attachments: refs.map((ref, index) => ({
                index,
                source_kind: ref.source_kind ?? "document",
                source_id: ref.chat_attachment_id ?? ref.document_id,
                document_id: ref.document_id,
                chat_attachment_id: ref.chat_attachment_id ?? null,
                version_id: ref.version_id ?? null,
                filename: ref.filename,
                content_type: ref.content_type ?? "application/octet-stream",
                size: ref.size ?? null,
                previewable: isRasterImageMime(ref.content_type),
                content_url: `/email/${email.id}/attachments/${index}/content`,
            })),
        });
    } catch (error) {
        if (error instanceof EmailAttachmentError) {
            return void res
                .status(error.code === "EMAIL_ATTACHMENT_FORBIDDEN" ? 403 : 422)
                .json({ code: error.code, detail: error.message });
        }
        res.status(500).json({ detail: "Failed to load email attachments" });
    }
});

router.get("/:id/attachments/:index/content", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const email = await getEmail(db, req.params.id);
        if (!email)
            return void res.status(404).json({ detail: "Email not found" });
        if (!(await canUserReadEmail(db, userId, email, userEmail))) {
            return void res.status(403).json({ detail: "Forbidden" });
        }
        if (email.direction === "inbound") {
            await reconcileEmailAttachments(db, email);
            const allowed = await authorizedInboundAttachment(db, userId, email.id, req.params.index, userEmail);
            if (!allowed) return void res.status(404).json({ detail: "Attachment not found or no longer accessible" });
            const attachment = allowed.attachment;
            if (!attachment.raw_storage_path || !["ready", "partial", "unsupported"].includes(attachment.status))
                return void res.status(422).json({ code: attachment.error_code, detail: attachmentManifest(attachment).detail ?? "Attachment is still processing" });
            const bytes = await downloadFile(attachment.raw_storage_path);
            if (!bytes) return void res.status(422).json({ detail: "The original attachment could not be loaded." });
            res.setHeader("Content-Type", attachment.content_type);
            res.setHeader("Content-Disposition", buildContentDisposition("attachment", attachment.filename));
            res.setHeader("Cache-Control", "private, no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            return void res.send(Buffer.from(bytes));
        }
        const index = Number.parseInt(req.params.index, 10);
        if (!Number.isInteger(index) || index < 0 || index >= email.attachments.length) {
            return void res.status(404).json({ detail: "Attachment not found" });
        }
        const loaded = await loadCanonicalAttachment({
            db,
            userId,
            userEmail,
            ref: email.attachments[index],
        });
        res.setHeader(
            "Content-Type",
            loaded.ref.content_type ?? "application/octet-stream",
        );
        res.setHeader("Content-Length", String(loaded.content.byteLength));
        res.setHeader(
            "Content-Disposition",
            buildContentDisposition("inline", loaded.ref.filename),
        );
        res.setHeader("Cache-Control", "private, no-store");
        res.send(loaded.content);
    } catch (error) {
        if (error instanceof EmailAttachmentError) {
            return void res
                .status(error.code === "EMAIL_ATTACHMENT_FORBIDDEN" ? 403 : 422)
                .json({ code: error.code, detail: error.message });
        }
        res.status(500).json({ detail: "Failed to load email attachment" });
    }
});

router.post("/:id/attachments/:attachmentId/retry", async (req: Request, res: Response) => {
    const db = createServerSupabase();
    const ok = await retryInboundAttachment(db, res.locals.userId, req.params.id, req.params.attachmentId, res.locals.userEmail);
    res.status(ok ? 200 : 404).json({ ok, ...(ok ? {} : { detail: "Attachment is not accessible or cannot be retried." }) });
});

// GET /email/:id/beta-policy — preflight the exact data-policy scope that
// sendEmailNow will enforce. Email recipients themselves are unrestricted.
router.get("/:id/beta-policy", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const email = await getEmail(db, req.params.id);
    if (!email) return void res.status(404).json({ detail: "Email not found" });
    if (!(await canApproveEmail(db, email, userId, userEmail)))
        return void res.status(403).json({ detail: "Forbidden" });
    try {
        res.json(await emailBetaPolicyReadiness(db, email, userId, userEmail));
    } catch (error) {
        console.error("[email/beta-policy] preflight failed", {
            emailId: email.id,
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({
            code: "BETA_POLICY_UNAVAILABLE",
            detail: "The controlled-beta safeguards are temporarily unavailable.",
        });
    }
});

// PATCH /email/:id/beta-policy — accept the data-use safeguard from the draft
// that exposed it. This never sends the draft and never restricts recipients.
router.patch("/:id/beta-policy", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const email = await getEmail(db, req.params.id);
    if (!email) return void res.status(404).json({ detail: "Email not found" });
    if (!(await canApproveEmail(db, email, userId, userEmail)))
        return void res.status(403).json({ detail: "Forbidden" });

    const acceptPolicy = req.body?.accept_data_policy === true;
    if (!acceptPolicy) {
        return void res.status(400).json({
            code: "BETA_POLICY_ACTION_REQUIRED",
            detail: "Choose the controlled-beta data policy to accept.",
        });
    }
    if (acceptPolicy && req.body?.policy_acknowledged !== true) {
        return void res.status(400).json({
            code: "BETA_POLICY_ACKNOWLEDGEMENT_REQUIRED",
            detail: "Confirm that you understand the controlled-beta data restrictions.",
        });
    }
    try {
        let policy = await getBetaPolicyState(db, {
            orgId: email.org_id,
            projectId: email.project_id,
            userId: email.user_id,
        });
        if (
            !(await canManageEmailBetaPolicy(
                db,
                email,
                policy.organization_id,
                userId,
                userEmail,
            ))
        ) {
            return void res.status(403).json({
                code: "ORGANIZATION_ADMIN_REQUIRED",
                detail: "An organization owner or admin must complete these safeguards.",
            });
        }

        const organizationId =
            policy.organization_id ??
            (await ensurePersonalBetaPolicyOrganization(db, {
                userId,
                userEmail,
            }));
        if (!policy.organization_id) {
            policy = await getBetaPolicyState(db, {
                orgId: organizationId,
                userId,
            });
        }

        const updates: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
        };
        if (acceptPolicy) {
            updates.data_policy_accepted_at = new Date().toISOString();
            updates.data_policy_accepted_by_user_id = userId;
        }
        const { error } = await db
            .from("organization_beta_policies")
            .upsert(
                { organization_id: organizationId, ...updates },
                { onConflict: "organization_id" },
            );
        if (error) throw error;
        await recordAuditEvent(db, {
            orgId: organizationId,
            projectId: email.project_id,
            actorUserId: userId,
            eventType: "beta_policy.updated",
            targetType: "organization",
            targetId: organizationId,
            requestId: String(res.getHeader("x-request-id") ?? ""),
            metadata: {
                source: "email_approval",
                accepted_policy: acceptPolicy,
            },
        });
        res.json(await emailBetaPolicyReadiness(db, email, userId, userEmail));
    } catch (error) {
        console.error("[email/beta-policy] update failed", {
            emailId: email.id,
            error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({
            code: "BETA_POLICY_UPDATE_FAILED",
            detail: "Could not update the controlled-beta safeguards.",
        });
    }
});

// POST /email/:id/approve — send a pending_approval email via the connector.
router.post("/:id/approve", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const email = await getEmail(db, req.params.id);
        if (!email)
            return void res.status(404).json({ detail: "Email not found" });
        if (!(await canApproveEmail(db, email, userId, userEmail)))
            return void res.status(403).json({ detail: "Forbidden" });
        if (email.status !== "pending_approval") {
            return void res.json({ email });
        }

        try {
            const sent = await sendEmailNow(db, email.id, {
                approvedBy: userId,
                approvedByEmail: userEmail,
            });
            res.json({ email: sent });
        } catch (sendErr) {
            if (sendErr instanceof EmailAttachmentError) {
                return void res
                    .status(
                        sendErr.code === "EMAIL_ATTACHMENT_FORBIDDEN"
                            ? 403
                            : 422,
                    )
                    .json({ code: sendErr.code, detail: sendErr.message });
            }
            if (sendErr instanceof BetaPolicyError) {
                return void res.status(sendErr.status).json({
                    code: sendErr.code,
                    detail: sendErr.message,
                });
            }
            if (sendErr instanceof ConnectorNotConfiguredError) {
                return void res.status(503).json({ detail: sendErr.message });
            }
            res.status(500).json({
                detail:
                    sendErr instanceof Error
                        ? sendErr.message
                        : "Failed to send email",
            });
        }
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to approve email",
        });
    }
});

// POST /email/:id/cancel — cancel a STILL-PENDING email. Status-guarded via
// cancelPendingEmail (the conditional UPDATE is the mutex): an email that
// already left pending_approval — sent, sending, or failed — 409s with its
// record untouched, so a cancel click racing a send can never falsify a sent
// email's audit trail (the same clobber class fixed in the automation
// pipeline). Only a genuine cancel also cancels the linked operation.
router.post("/:id/cancel", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const email = await getEmail(db, req.params.id);
        if (!email)
            return void res.status(404).json({ detail: "Email not found" });
        if (!(await canApproveEmail(db, email, userId, userEmail)))
            return void res.status(403).json({ detail: "Forbidden" });
        if (email.status === "cancelled") {
            // Idempotent no-op: a double-click on cancel is not a conflict.
            return void res.json({ email });
        }
        const cancelled = await cancelPendingEmail(db, email.id);
        if (!cancelled) {
            // The email moved past pending_approval between our read and the
            // guarded update (or was never pending) — nothing was mutated.
            const fresh = (await getEmail(db, email.id)) ?? email;
            return void res.status(409).json({
                detail: `Email is ${fresh.status}, not pending — it can no longer be cancelled`,
            });
        }
        await updateAgentOperation(db, email.agent_operation_id, {
            status: "cancelled",
        });
        await recordAuditEvent(db, {
            orgId: email.org_id,
            matterId: email.matter_id,
            projectId: email.project_id,
            actorUserId: userId,
            eventType: "email.cancelled",
            targetType: "email_message",
            targetId: email.id,
        });
        res.json({ email: cancelled });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to cancel email",
        });
    }
});

// POST /email/inbound/refresh — authed, on-demand inbound ingest from the app.
// No shared secret is needed because the route is behind requireAuth; the
// secret-gated inboundRouter (/email-inbound/webhook, /poll) stays separate.
router.post("/inbound/refresh", async (_req: Request, res: Response) => {
    try {
        const result = await ingestRecentInbound();
        res.json({ ok: true, ingested: result.ingested });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to ingest inbound",
        });
    }
});

// ---------------------------------------------------------------------------
// inboundRouter (mounted at /email-inbound, PUBLIC — shared-secret gated)
// ---------------------------------------------------------------------------

/** Verify the inbound shared secret header. Returns true when authorized. */
function inboundAuthorized(req: Request): boolean {
    const secret = process.env.GMAIL_INBOUND_WEBHOOK_SECRET;
    if (!secret) return false;
    return req.header("x-coco-inbound-secret") === secret;
}

// POST /email-inbound/webhook — fire-and-forget trigger, responds fast.
inboundRouter.post("/webhook", (req: Request, res: Response) => {
    if (!process.env.GMAIL_INBOUND_WEBHOOK_SECRET) {
        return void res
            .status(503)
            .json({ detail: "Inbound webhook is not configured" });
    }
    if (!inboundAuthorized(req)) {
        return void res.status(401).json({ detail: "Unauthorized" });
    }
    // Fire-and-forget; don't block the provider's webhook on ingestion.
    void ingestRecentInbound().catch(() => {});
    res.status(200).json({ ok: true });
});

// POST /email-inbound/poll — synchronous ingest, returns the count.
inboundRouter.post("/poll", async (req: Request, res: Response) => {
    if (!process.env.GMAIL_INBOUND_WEBHOOK_SECRET) {
        return void res
            .status(503)
            .json({ detail: "Inbound webhook is not configured" });
    }
    if (!inboundAuthorized(req)) {
        return void res.status(401).json({ detail: "Unauthorized" });
    }
    try {
        const { ingested } = await ingestRecentInbound();
        res.json({ ok: true, ingested });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to ingest inbound",
        });
    }
});

export { router as emailRouter, inboundRouter };
