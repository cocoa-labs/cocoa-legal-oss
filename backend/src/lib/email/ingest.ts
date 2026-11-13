// backend/src/lib/email/ingest.ts
//
// Inbound email ingestion. Pulls recent messages from the configured email
// connector, dedupes against already-ingested provider message ids, persists
// each attachment as a first-class in-app document (best-effort), threads the
// message onto an existing outbound email / signature envelope when possible,
// and records an inbound `email_messages` row.
//
// Two listing modes (ingestInbound):
//   - query mode (the v1 behavior, and what ingestRecentInbound still does):
//     `in:inbox newer_than:2d` scan;
//   - cursor mode ({ useCursor: true }, used by the automation scheduler):
//     incremental Gmail history walk from the cursor persisted in
//     automation_state, re-seeded from the query path when the cursor is
//     absent or Gmail reports it expired. Cursor reads/writes are best-effort
//     so a database without migration 023 degrades to the query scan.
//
// v1 simplifications (documented follow-ups):
//   - The owning user for an inbound row is resolved from
//     GMAIL_AGENT_OWNER_USER_ID when set; otherwise we fall back to the agent
//     address string so the row is still captured. Mapping recipients to real
//     Coco Legal users is a later improvement.

import { persistDocumentUpload } from "../documentUpload";
import { validateEmailAttachmentBytes } from "../upload";
import { reconcileEmailAttachments } from "./inboundAttachments";

import { createServerSupabase } from "../supabase";
import { getEmailConnector } from "../connectors/registry";
import type { ParsedEmail } from "../connectors/types";
import {
    createInboundEmail,
    findEmailByProviderMessageId,
    getThreadLink,
    type EmailAttachmentRef,
} from "./store";
import { maybeAutoReply, maybeAutoDraft, autoDraftEnabled } from "./autoReply";
import { maybeEnqueueAutomation } from "../automation/enqueue";
import { getAutomationState, setAutomationState } from "../automation/runsStore";

type Db = ReturnType<typeof createServerSupabase>;

// Lazy: this was the only module-scope createServerSupabase() call in the
// codebase (everywhere else creates per request), and it made a bare dev
// boot — no .env at all — throw during import of index.ts. Nothing can
// reach these ingest paths without Supabase env, so defer to first use.
let dbInstance: Db | undefined;
function getDb(): Db {
    dbInstance ??= createServerSupabase();
    return dbInstance;
}

/** Shared entry point retained for rehearsal fixtures. */
export async function persistInboundAttachment(ownerUserId: string, projectId: string | null,
    filename: string, bytes: Buffer, contentType: string): Promise<EmailAttachmentRef | null> {
    await validateEmailAttachmentBytes(bytes, filename);
    const doc = await persistDocumentUpload({ db: getDb(), userId: ownerUserId, projectId,
        filename, content: bytes, allowImages: true });
    return { document_id: doc.id, version_id: doc.version_id, filename,
        content_type: contentType, size: bytes.length };
}

/**
 * Try to thread an inbound message onto an existing conversation by its
 * provider thread id: look up the most recent stored email in the same thread
 * and inherit its signature envelope + project association. Returns nulls when
 * nothing matches.
 */
async function resolveThread(
    providerThreadId: string,
): Promise<{ envelopeId: string | null; projectId: string | null }> {
    if (!providerThreadId) return { envelopeId: null, projectId: null };
    try {
        const db = getDb();
        const { data, error } = await db
            .from("email_messages")
            .select("signature_envelope_id, project_id")
            .eq("provider_thread_id", providerThreadId)
            .order("created_at", { ascending: false })
            .limit(1);
        if (error || !data || data.length === 0) {
            return { envelopeId: null, projectId: null };
        }
        const row = data[0] as {
            signature_envelope_id: string | null;
            project_id: string | null;
        };
        return {
            envelopeId: row.signature_envelope_id ?? null,
            projectId: row.project_id ?? null,
        };
    } catch {
        return { envelopeId: null, projectId: null };
    }
}

/** Ingest a single message. Returns true when a new row was created. */
async function ingestOne(
    msg: ParsedEmail,
    ownerUserId: string,
): Promise<boolean> {
    const db = getDb();
    // Dedupe: skip messages we've already stored.
    const existing = await findEmailByProviderMessageId(db, msg.id);
    if (existing) {
        await reconcileEmailAttachments(db, existing, msg);
        return false;
    }

    // Thread onto an existing conversation if we can.
    const { envelopeId, projectId } = await resolveThread(msg.threadId);
    // Resolve the originating chat + owner when this is a reply on a thread
    // Counsel started — used to rejoin the chat and gate the auto-reply.
    const link = await getThreadLink(db, msg.threadId);

    const connector = getEmailConnector();
    const resolvedOwner = link?.userId ?? ownerUserId;
    let orgId: string | null = null;
    if (projectId) {
        const { data } = await db.from("projects").select("org_id").eq("id", projectId).maybeSingle();
        orgId = data?.org_id ?? null;
    }
    // Persist the parent before attempting files. The manifest survives failures.
    const created = await createInboundEmail(db, {
        userId: resolvedOwner,
        orgId,
        projectId,
        chatId: link?.chatId ?? null,
        fromAddress: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        bodyText: msg.bodyText,
        bodyHtml: msg.bodyHtml,
        attachments: [],
        providerMessageId: msg.id,
        providerThreadId: msg.threadId,
        inReplyTo: msg.inReplyTo,
        signatureEnvelopeId: envelopeId,
    });

    if (!created) throw new Error("Inbound email could not be saved");
    await reconcileEmailAttachments(db, created, msg);

    // Mark processed in the provider (best-effort).
    try {
        await connector.markProcessed(msg.id);
    } catch {
        // Non-fatal: the dedupe check protects us on the next run.
    }

    // Two-way email: if this is a reply on a thread Counsel started, hand off to
    // the auto-responder (fire-and-forget — its own safety gate decides whether
    // to act). Prefer "auto-draft, you approve" (park a reply for approval) when
    // enabled; otherwise fall back to autonomous auto-send. Never blocks ingest.
    if (created && link) {
        const inbound = {
            id: created.id,
            fromAddress: msg.from,
            subject: msg.subject,
            bodyText: msg.bodyText,
            bodyHtml: msg.bodyHtml,
            threadId: msg.threadId,
            messageIdHeader: msg.messageIdHeader,
            autoSubmitted: msg.autoSubmitted ?? null,
            precedence: msg.precedence ?? null,
            listId: msg.listId ?? null,
            listUnsubscribe: msg.listUnsubscribe ?? null,
        };
        if (autoDraftEnabled()) {
            void maybeAutoDraft(db, { inbound, link }).catch(() => {});
        } else {
            void maybeAutoReply(db, { inbound, link }).catch(() => {});
        }
    }

    // Cold inbound (not a reply on an agent-initiated thread): hand the email
    // to the automation pipeline seam. Fire-and-forget, gated inside on
    // AUTOMATION_ENABLED, deduped by the unique automation_runs.email_id
    // index — and best-effort in the same style as the auto-responder above:
    // ingest must never fail because enqueue failed (e.g. migration 023 not
    // applied yet). 4b's classifier marks non-PI mail `skipped`.
    if (created && !link) {
        void maybeEnqueueAutomation(db, {
            id: created.id,
            userId: created.user_id,
        }).catch(() => {});
    }

    return true;
}

/** automation_state key holding the Gmail history cursor for incremental sync. */
export const GMAIL_HISTORY_CURSOR_KEY = "gmail_history_cursor";

/** The v1 query-mode scan window (unchanged — pinned by ingestRecentInbound). */
const RECENT_INBOX_QUERY = "in:inbox newer_than:2d";

/**
 * Gmail reports an expired/invalid startHistoryId as an HTTP 404 on
 * users.history.list; the connector propagates the googleapis (Gaxios) error
 * raw, so check the status everywhere Gaxios versions have carried it.
 */
function isHistoryExpiredError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as {
        status?: unknown;
        code?: unknown;
        response?: { status?: unknown };
    };
    return (
        e.status === 404 ||
        e.code === 404 ||
        e.code === "404" ||
        e.response?.status === 404
    );
}

/**
 * Pull inbound messages and ingest any that are new. Returns the number of
 * newly-ingested messages. Never throws for a single bad message — each is
 * wrapped so one failure cannot abort the batch.
 *
 * With `useCursor` (the automation scheduler's mode) the listing is an
 * incremental Gmail history walk from the cursor persisted in
 * automation_state, falling back to the query scan — and re-seeding the
 * cursor — when the cursor is absent or expired. Cursor reads/writes are
 * best-effort: a database without migration 023 degrades to the query scan.
 * Without it (the default) this is byte-for-byte the v1 query behavior and
 * never touches automation_state.
 */
export async function ingestInbound(opts?: {
    useCursor?: boolean;
}): Promise<{ ingested: number }> {
    const connector = getEmailConnector();
    if (!connector.isConfigured()) return { ingested: 0 };

    // Resolve the owning user for inbound rows. v1: env override, else the
    // agent address string (documented simplification above).
    const ownerUserId =
        process.env.GMAIL_AGENT_OWNER_USER_ID ||
        process.env.GMAIL_AGENT_ADDRESS ||
        "gmail-agent";

    const useCursor = opts?.useCursor === true;

    let cursor: string | null = null;
    if (useCursor) {
        try {
            const value = await getAutomationState(
                getDb(),
                GMAIL_HISTORY_CURSOR_KEY,
            );
            cursor = typeof value === "string" && value ? value : null;
        } catch {
            // automation_state unreachable (023 unapplied) → query mode.
            cursor = null;
        }
    }

    let refs: { id: string; threadId: string }[];
    let latestHistoryId: string | null = null;
    try {
        if (cursor) {
            try {
                const result = await connector.listSince({
                    startHistoryId: cursor,
                });
                refs = result.messages;
                latestHistoryId = result.latestHistoryId;
            } catch (err) {
                // Expired/invalid cursor (404): fall back to the query scan
                // and re-seed the cursor from that call's latest history id.
                // Any other failure keeps the existing "skip this run" shape.
                if (!isHistoryExpiredError(err)) throw err;
                const result = await connector.listSince({
                    query: RECENT_INBOX_QUERY,
                });
                refs = result.messages;
                latestHistoryId = result.latestHistoryId;
            }
        } else {
            const result = await connector.listSince({
                query: RECENT_INBOX_QUERY,
            });
            refs = result.messages;
            latestHistoryId = result.latestHistoryId;
        }
    } catch {
        return { ingested: 0 };
    }

    let ingested = 0;
    let batchFailed = false;
    for (const ref of refs) {
        try {
            const msg = await connector.getMessage(ref.id);
            const didIngest = await ingestOne(msg, ownerUserId);
            if (didIngest) ingested += 1;
        } catch {
            batchFailed = true;
            // Keep the history cursor so this message is retried next tick.
        }
    }

    // Advance the cursor only AFTER the batch, so a crash mid-loop re-walks
    // from the previous cursor next run (the provider_message_id dedupe makes
    // re-walking safe). Best-effort: automation_state may not exist yet.
    if (useCursor && latestHistoryId && !batchFailed) {
        try {
            await setAutomationState(
                getDb(),
                GMAIL_HISTORY_CURSOR_KEY,
                latestHistoryId,
            );
        } catch {
            // Non-fatal: the next tick re-reads a stale (or absent) cursor.
        }
    }

    return { ingested };
}

/**
 * The original on-demand ingest entrypoint, used by POST /email/inbound/refresh
 * and the /email-inbound webhook + poll routes. A thin wrapper that preserves
 * today's exact behavior: query-mode scan, no history cursor, no
 * automation_state access.
 */
export async function ingestRecentInbound(): Promise<{ ingested: number }> {
    return ingestInbound({ useCursor: false });
}
