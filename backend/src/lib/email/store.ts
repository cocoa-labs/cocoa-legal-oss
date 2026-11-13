import type { createServerSupabase } from "../supabase";
import { htmlEmailText } from "./body";

type Db = ReturnType<typeof createServerSupabase>;

export type EmailDirection = "outbound" | "inbound";

export type EmailStatus =
    | "pending_approval"
    | "approved"
    | "sending"
    | "sent"
    | "failed"
    | "cancelled"
    | "received";

export interface EmailAttachmentRef {
    /**
     * Backward-compatible source id. For ordinary document attachments this
     * is the document id. Chat-uploaded images also mirror their attachment id
     * here so older event/rendering code still has a stable identifier.
     */
    document_id: string;
    /** Explicit source discriminator. Missing on legacy rows means document. */
    source_kind?: "document" | "chat_attachment";
    /** Present when source_kind is chat_attachment. */
    chat_attachment_id?: string | null;
    version_id?: string | null;
    filename: string;
    content_type?: string | null;
    size?: number | null;
    /** Legacy hint retained for old rows; outbound resolution always clears it. */
    inline?: boolean | null;
    /** Legacy CID retained for old rows; outbound resolution always clears it. */
    content_id?: string | null;
}

export interface EmailMessage {
    id: string;
    user_id: string;
    org_id: string | null;
    matter_id?: string | null;
    project_id: string | null;
    chat_id: string | null;
    agent_operation_id: string | null;
    direction: EmailDirection;
    status: EmailStatus;
    from_address: string | null;
    to_addresses: string[];
    cc_addresses: string[];
    bcc_addresses: string[];
    subject: string;
    body_text: string;
    body_html: string | null;
    attachments: EmailAttachmentRef[];
    attachments_reconciled_at?: string | null;
    signature_envelope_id: string | null;
    provider_message_id: string | null;
    provider_thread_id: string | null;
    in_reply_to: string | null;
    /** Reply-To address (migration 023). Outbound: forwarded as the sent
     * message's Reply-To header. Null on rows predating the column. */
    reply_to_address: string | null;
    error: string | null;
    approved_by: string | null;
    approved_at: string | null;
    sent_at: string | null;
    received_at: string | null;
    created_at: string;
    updated_at: string;
}

interface EmailRow {
    id: string;
    user_id: string;
    org_id: string | null;
    matter_id?: string | null;
    project_id: string | null;
    chat_id: string | null;
    agent_operation_id: string | null;
    direction: string;
    status: string;
    from_address: string | null;
    to_addresses: string[] | null;
    cc_addresses: string[] | null;
    bcc_addresses: string[] | null;
    subject: string;
    body_text: string | null;
    body_html: string | null;
    attachments: EmailAttachmentRef[] | null;
    attachments_reconciled_at?: string | null;
    signature_envelope_id: string | null;
    provider_message_id: string | null;
    provider_thread_id: string | null;
    in_reply_to: string | null;
    /** Optional: absent on databases where migration 023 is not applied. */
    reply_to_address?: string | null;
    error: string | null;
    approved_by: string | null;
    approved_at: string | null;
    sent_at: string | null;
    received_at: string | null;
    created_at: string;
    updated_at: string;
}

function serializeEmail(row: EmailRow): EmailMessage {
    return {
        id: row.id,
        user_id: row.user_id,
        org_id: row.org_id ?? null,
        matter_id: row.matter_id ?? null,
        project_id: row.project_id ?? null,
        chat_id: row.chat_id ?? null,
        agent_operation_id: row.agent_operation_id ?? null,
        direction: row.direction as EmailDirection,
        status: row.status as EmailStatus,
        from_address: row.from_address ?? null,
        to_addresses: row.to_addresses ?? [],
        cc_addresses: row.cc_addresses ?? [],
        bcc_addresses: row.bcc_addresses ?? [],
        subject: row.subject,
        body_text: row.body_text?.trim() ? row.body_text : htmlEmailText(row.body_html ?? ""),
        body_html: row.body_html ?? null,
        attachments: row.attachments ?? [],
        attachments_reconciled_at: row.attachments_reconciled_at ?? null,
        signature_envelope_id: row.signature_envelope_id ?? null,
        provider_message_id: row.provider_message_id ?? null,
        provider_thread_id: row.provider_thread_id ?? null,
        in_reply_to: row.in_reply_to ?? null,
        reply_to_address: row.reply_to_address ?? null,
        error: row.error ?? null,
        approved_by: row.approved_by ?? null,
        approved_at: row.approved_at ?? null,
        sent_at: row.sent_at ?? null,
        received_at: row.received_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

const MISSING_SCHEMA_CODES = new Set(["42P01", "PGRST205", "PGRST204", "42703"]);

function isMissingEmailSchema(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    if (code && MISSING_SCHEMA_CODES.has(code)) return true;
    const message = (error as { message?: string }).message ?? "";
    return /relation .* does not exist|could not find the table|schema cache/i.test(
        message,
    );
}

async function tolerateMissingSchema<T>(
    label: string,
    fallback: T,
    work: () => Promise<T>,
): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (isMissingEmailSchema(error)) {
            if (process.env.NODE_ENV !== "production") {
                console.warn(
                    `[email] ${label}: schema missing, returning fallback`,
                    error,
                );
            }
            return fallback;
        }
        throw error;
    }
}

export async function createPendingEmail(
    db: Db,
    input: {
        userId: string;
        orgId?: string | null;
        projectId?: string | null;
        chatId?: string | null;
        agentOperationId?: string | null;
        fromAddress?: string | null;
        to: string[];
        cc?: string[];
        bcc?: string[];
        subject: string;
        bodyText: string;
        bodyHtml?: string | null;
        attachments: EmailAttachmentRef[];
        signatureEnvelopeId?: string | null;
        providerThreadId?: string | null;
        inReplyTo?: string | null;
        replyToAddress?: string | null;
    },
): Promise<EmailMessage | null> {
    return tolerateMissingSchema("createPendingEmail", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .insert({
                user_id: input.userId,
                org_id: input.orgId ?? null,
                project_id: input.projectId ?? null,
                chat_id: input.chatId ?? null,
                agent_operation_id: input.agentOperationId ?? null,
                direction: "outbound",
                status: "pending_approval",
                from_address: input.fromAddress ?? null,
                to_addresses: input.to,
                cc_addresses: input.cc ?? [],
                bcc_addresses: input.bcc ?? [],
                subject: input.subject,
                body_text: input.bodyText,
                body_html: input.bodyHtml ?? null,
                attachments: input.attachments,
                signature_envelope_id: input.signatureEnvelopeId ?? null,
                provider_thread_id: input.providerThreadId ?? null,
                in_reply_to: input.inReplyTo ?? null,
                // reply_to_address arrived with migration 023; include the key
                // only when a value is actually set so this insert keeps
                // working unchanged on databases where 023 is not applied yet
                // (an unconditional null would trip PGRST204 unknown-column
                // and be swallowed by tolerateMissingSchema into a null row).
                ...(input.replyToAddress
                    ? { reply_to_address: input.replyToAddress }
                    : {}),
            })
            .select("*")
            .single();
        if (error) throw error;
        return serializeEmail(data as EmailRow);
    });
}

export async function getEmail(db: Db, id: string): Promise<EmailMessage | null> {
    return tolerateMissingSchema("getEmail", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        return serializeEmail(data as EmailRow);
    });
}

/** Persist canonicalized attachment metadata on a still-editable draft. */
export async function updatePendingEmailAttachments(
    db: Db,
    id: string,
    attachments: EmailAttachmentRef[],
): Promise<EmailMessage | null> {
    return tolerateMissingSchema(
        "updatePendingEmailAttachments",
        null,
        async () => {
            const { data, error } = await db
                .from("email_messages")
                .update({
                    attachments,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", id)
                .eq("status", "pending_approval")
                .select("*")
                .maybeSingle();
            if (error) throw error;
            return data ? serializeEmail(data as EmailRow) : null;
        },
    );
}

/**
 * The email drafted for a given agent operation, if any. Used by the operations
 * approval route to actually send when a reloaded send_email / reply_to_email
 * card is approved via /operations/:id/approve (the card persists only an
 * operation_created event, so approval comes back keyed by operation id, not
 * email id). Tolerates a missing schema (returns null).
 */
export async function getEmailByOperationId(
    db: Db,
    operationId: string,
): Promise<EmailMessage | null> {
    if (!operationId) return null;
    return tolerateMissingSchema("getEmailByOperationId", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("*")
            .eq("agent_operation_id", operationId)
            .order("created_at", { ascending: false })
            .limit(1);
        if (error) throw error;
        const row = (data as EmailRow[] | null)?.[0];
        return row ? serializeEmail(row) : null;
    });
}

export async function listEmails(
    db: Db,
    filters: {
        userId: string;
        projectId?: string;
        accessibleProjectIds?: string[];
        direction?: EmailDirection;
        limit?: number;
    },
): Promise<EmailMessage[]> {
    return tolerateMissingSchema("listEmails", [], async () => {
        let query = db
            .from("email_messages")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(Math.min(filters.limit ?? 50, 100));
        if (filters.projectId) {
            query = query.eq("project_id", filters.projectId);
        } else if ((filters.accessibleProjectIds?.length ?? 0) > 0) {
            query = query.or(
                `and(user_id.eq.${filters.userId},project_id.is.null),project_id.in.(${filters.accessibleProjectIds!.join(",")})`,
            );
        } else {
            query = query
                .eq("user_id", filters.userId)
                .is("project_id", null);
        }
        if (filters.direction) query = query.eq("direction", filters.direction);
        const { data, error } = await query;
        if (error) throw error;
        return ((data as EmailRow[] | null) ?? []).map(serializeEmail);
    });
}

/**
 * Outbound emails belonging to a chat, newest first. Used by
 * enrichWithPriorEvents to remind the agent on a later turn that it already
 * drafted or sent an email in this conversation — otherwise a bare "thanks"
 * makes it re-draft the same email. Tolerates a missing schema (returns []).
 */
export async function listEmailsByChat(
    db: Db,
    chatId: string,
    opts?: { limit?: number },
): Promise<EmailMessage[]> {
    return tolerateMissingSchema("listEmailsByChat", [], async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("*")
            .eq("chat_id", chatId)
            .eq("direction", "outbound")
            .order("created_at", { ascending: false })
            .limit(Math.min(opts?.limit ?? 20, 50));
        if (error) throw error;
        return ((data as EmailRow[] | null) ?? []).map(serializeEmail);
    });
}

/**
 * Inbound emails belonging to a chat, newest first — replies that arrived on a
 * thread Counsel started. Lets the chat/UI show the other side of the
 * conversation. Tolerates a missing schema (returns []).
 */
export async function listInboundEmailsByChat(
    db: Db,
    chatId: string,
    opts?: { limit?: number },
): Promise<EmailMessage[]> {
    return tolerateMissingSchema("listInboundEmailsByChat", [], async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("*")
            .eq("chat_id", chatId)
            .eq("direction", "inbound")
            .order("created_at", { ascending: false })
            .limit(Math.min(opts?.limit ?? 20, 50));
        if (error) throw error;
        return ((data as EmailRow[] | null) ?? []).map(serializeEmail);
    });
}

/**
 * The user id that owns inbound rows for the shared agent mailbox when a reply
 * is NOT linked to a chat the agent started. Mirrors the resolution in
 * ingest.ts so reads and writes agree on who "owns" agent-mailbox mail.
 */
export function agentMailboxOwnerId(): string {
    return (
        process.env.GMAIL_AGENT_OWNER_USER_ID ||
        process.env.GMAIL_AGENT_ADDRESS ||
        "gmail-agent"
    );
}

// Read authorization moved to email/access.ts (canUserReadEmail /
// filterReadableEmails): the old canReadEmail here treated EVERY inbound
// message as firm-readable, which leaked envelope- and chat-linked mail to
// all authenticated users (audit High, fixed in hardening batch 2).

/**
 * Every message on a Gmail thread, oldest first — the full back-and-forth
 * (outbound + inbound) for a thread / detail view. Tolerates a missing schema.
 */
export async function getEmailThread(
    db: Db,
    providerThreadId: string,
): Promise<EmailMessage[]> {
    if (!providerThreadId) return [];
    return tolerateMissingSchema("getEmailThread", [], async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("*")
            .eq("provider_thread_id", providerThreadId)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return ((data as EmailRow[] | null) ?? []).map(serializeEmail);
    });
}

/**
 * List inbound mail across the WHOLE agent mailbox (newest first), optionally
 * filtered by sender / subject substring. Powers Quill's read_inbox tool — the
 * agent mailbox is a single shared firm inbox, so the QUERY is intentionally
 * not scoped to one chat / matter. User-facing callers MUST pass the result
 * through filterReadableEmails (email/access.ts) so linked mail stays with
 * users who can access the linked resource.
 */
export async function listInboundEmails(
    db: Db,
    filters?: {
        limit?: number;
        fromContains?: string;
        subjectContains?: string;
    },
): Promise<EmailMessage[]> {
    return tolerateMissingSchema("listInboundEmails", [], async () => {
        let query = db
            .from("email_messages")
            .select("*")
            .eq("direction", "inbound")
            .order("received_at", { ascending: false, nullsFirst: false })
            .limit(Math.min(filters?.limit ?? 20, 50));
        if (filters?.fromContains)
            query = query.ilike("from_address", `%${filters.fromContains}%`);
        if (filters?.subjectContains)
            query = query.ilike("subject", `%${filters.subjectContains}%`);
        const { data, error } = await query;
        if (error) throw error;
        return ((data as EmailRow[] | null) ?? []).map(serializeEmail);
    });
}

/**
 * Resolve the chat + owner an inbound reply should rejoin, by matching the
 * Gmail thread to the most recent AGENT-INITIATED outbound email on that thread
 * (an outbound with a chat_id). Returns null when the thread was not started by
 * Counsel — the auto-reply gate treats that as "do not respond".
 */
export async function getThreadLink(
    db: Db,
    providerThreadId: string,
): Promise<{ chatId: string; userId: string; emailId: string } | null> {
    if (!providerThreadId) return null;
    return tolerateMissingSchema("getThreadLink", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("id, chat_id, user_id")
            .eq("provider_thread_id", providerThreadId)
            .eq("direction", "outbound")
            .not("chat_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1);
        if (error) throw error;
        const row = (
            data as
                | { id: string; chat_id: string | null; user_id: string }[]
                | null
        )?.[0];
        if (!row || !row.chat_id) return null;
        return { chatId: row.chat_id, userId: row.user_id, emailId: row.id };
    });
}

/**
 * Count outbound emails on a Gmail thread — used to cap how many times Counsel
 * will auto-reply within one thread (loop / runaway protection).
 */
export async function countOutboundOnThread(
    db: Db,
    providerThreadId: string,
): Promise<number> {
    if (!providerThreadId) return 0;
    return tolerateMissingSchema("countOutboundOnThread", 0, async () => {
        const { count, error } = await db
            .from("email_messages")
            .select("id", { count: "exact", head: true })
            .eq("provider_thread_id", providerThreadId)
            .eq("direction", "outbound");
        if (error) throw error;
        return count ?? 0;
    });
}

/**
 * Idempotency guard for auto-reply: has Counsel already sent an outbound email
 * that quotes this inbound message's RFC822 Message-ID in its In-Reply-To?
 */
export async function findOutboundByInReplyTo(
    db: Db,
    inReplyTo: string,
): Promise<EmailMessage | null> {
    if (!inReplyTo) return null;
    return tolerateMissingSchema("findOutboundByInReplyTo", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .select("*")
            .eq("in_reply_to", inReplyTo)
            .eq("direction", "outbound")
            .limit(1);
        if (error) throw error;
        const row = (data as EmailRow[] | null)?.[0];
        return row ? serializeEmail(row) : null;
    });
}

export async function markEmailApproved(
    db: Db,
    id: string,
    approvedBy: string,
): Promise<EmailMessage | null> {
    return tolerateMissingSchema("markEmailApproved", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .update({
                status: "approved",
                approved_by: approvedBy,
                approved_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select("*")
            .single();
        if (error) throw error;
        return serializeEmail(data as EmailRow);
    });
}

/**
 * Atomically claim a pending email for sending: flip status pending_approval →
 * sending ONLY if it is still pending_approval, and report whether THIS call won
 * the claim (returns the claimed row) or lost it (null). The single conditional
 * UPDATE is the mutex that stops two concurrent approvals from both dispatching
 * the same email. Tolerates a missing schema (returns null → caller no-ops).
 */
export async function claimEmailForSending(
    db: Db,
    id: string,
): Promise<EmailMessage | null> {
    return tolerateMissingSchema("claimEmailForSending", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .update({ status: "sending" })
            .eq("id", id)
            .eq("status", "pending_approval")
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeEmail(data as EmailRow) : null;
    });
}

export async function markEmailSent(
    db: Db,
    id: string,
    ids: { providerMessageId: string; providerThreadId?: string | null },
): Promise<EmailMessage | null> {
    return tolerateMissingSchema("markEmailSent", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .update({
                status: "sent",
                provider_message_id: ids.providerMessageId,
                provider_thread_id: ids.providerThreadId ?? null,
                sent_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select("*")
            .single();
        if (error) throw error;
        return serializeEmail(data as EmailRow);
    });
}

export async function markEmailFailed(
    db: Db,
    id: string,
    error: string,
): Promise<void> {
    await tolerateMissingSchema("markEmailFailed", undefined, async () => {
        const { error: dbError } = await db
            .from("email_messages")
            .update({ status: "failed", error })
            .eq("id", id);
        if (dbError) throw dbError;
    });
}

/**
 * Cancel an email ONLY while it is still pending_approval — the same
 * conditional-UPDATE-as-mutex shape as claimEmailForSending. Returns the
 * cancelled row, or null when the email was not pending (already sent,
 * sending, failed, or cancelled) — in which case NOTHING is mutated. Used
 * by the automation rejectRun path and POST /email/:id/cancel, where
 * clobbering a SENT email's record to `cancelled` would falsify the audit
 * trail. (The unguarded markEmailCancelled predecessor is deleted — any
 * cancel path must come through this guard.)
 */
export async function cancelPendingEmail(
    db: Db,
    id: string,
): Promise<EmailMessage | null> {
    return tolerateMissingSchema("cancelPendingEmail", null, async () => {
        const { data, error } = await db
            .from("email_messages")
            .update({ status: "cancelled" })
            .eq("id", id)
            .eq("status", "pending_approval")
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeEmail(data as EmailRow) : null;
    });
}

export async function findEmailByProviderMessageId(
    db: Db,
    providerMessageId: string,
): Promise<EmailMessage | null> {
    return tolerateMissingSchema(
        "findEmailByProviderMessageId",
        null,
        async () => {
            const { data, error } = await db
                .from("email_messages")
                .select("*")
                .eq("provider_message_id", providerMessageId)
                .maybeSingle();
            if (error) throw error;
            if (!data) return null;
            return serializeEmail(data as EmailRow);
        },
    );
}

export async function createInboundEmail(
    db: Db,
    input: {
        userId: string;
        orgId?: string | null;
        projectId?: string | null;
        chatId?: string | null;
        fromAddress: string;
        to: string[];
        cc?: string[];
        subject: string;
        bodyText: string;
        bodyHtml?: string | null;
        attachments: EmailAttachmentRef[];
        providerMessageId: string;
        providerThreadId: string;
        inReplyTo?: string | null;
        signatureEnvelopeId?: string | null;
    },
): Promise<EmailMessage | null> {
    return tolerateMissingSchema("createInboundEmail", null, async () => {
        const existing = await findEmailByProviderMessageId(
            db,
            input.providerMessageId,
        );
        if (existing) return existing;
        const { data, error } = await db
            .from("email_messages")
            .insert({
                user_id: input.userId,
                org_id: input.orgId ?? null,
                project_id: input.projectId ?? null,
                chat_id: input.chatId ?? null,
                direction: "inbound",
                status: "received",
                from_address: input.fromAddress,
                to_addresses: input.to,
                cc_addresses: input.cc ?? [],
                subject: input.subject,
                body_text: input.bodyText,
                body_html: input.bodyHtml ?? null,
                attachments: input.attachments,
                provider_message_id: input.providerMessageId,
                provider_thread_id: input.providerThreadId,
                in_reply_to: input.inReplyTo ?? null,
                signature_envelope_id: input.signatureEnvelopeId ?? null,
                received_at: new Date().toISOString(),
            })
            .select("*")
            .single();
        if (error) {
            // Unique provider_message_id race: another writer inserted first.
            if (
                (error as { code?: string }).code === "23505" ||
                /duplicate key|unique constraint/i.test(
                    (error as { message?: string }).message ?? "",
                )
            ) {
                return findEmailByProviderMessageId(
                    db,
                    input.providerMessageId,
                );
            }
            throw error;
        }
        return serializeEmail(data as EmailRow);
    });
}
