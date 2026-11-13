// backend/src/lib/memory.ts
//
// Per-user (and, from Phase 2, per-firm) durable memory that Quill carries
// ACROSS conversations. This is a third context axis alongside the playbook
// (`{{playbook:key}}` substitution) and the per-turn appended blocks
// (userEmail, currentDateLine). Like those blocks it is APPENDED to the system
// message by buildMessages — never routed through buildSystemPrompt — so the
// byte-stable empty-ctx invariant (systemPrompt/index.test.ts,
// firmContext.test.ts) is preserved by construction.
//
// Tiers, most-specific-wins: personal (per user_id) over firm (shared). There
// is no `default-shared` tier for memory (no shipped default memories).
//
// Mirrors playbooks.ts: stays batched (no per-key queries), throws on read
// errors rather than swallowing them.
import { createHash } from "node:crypto";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type MemoryKind = "preference" | "fact" | "working_style" | "note";

const MEMORY_KINDS: readonly MemoryKind[] = [
    "preference",
    "fact",
    "working_style",
    "note",
];

export function isMemoryKind(v: unknown): v is MemoryKind {
    return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
}

export interface MemoryEntry {
    id: string;
    user_id?: string;
    firm_id?: string;
    kind: MemoryKind;
    key: string | null;
    content: string;
    value_json: unknown;
    is_active: boolean;
    priority: number;
    updated_at: string;
}

// Default per-turn injection guardrails. Small on purpose: a dozen users have
// little memory, and the system prompt token budget is shared with documents.
export const MEMORY_INJECTION_CHAR_BUDGET = 3000;
export const MEMORY_MAX_ENTRIES = 40;

// Higher weight = kept first under budget. Durable preferences/style beat
// ad-hoc facts, which beat free-text notes.
const KIND_WEIGHT: Record<MemoryKind, number> = {
    preference: 3,
    working_style: 3,
    fact: 2,
    note: 1,
};

// --------------------------------------------------------------------------
// Personal memory (per user_id) — direct read/write, no approval.
// --------------------------------------------------------------------------

export interface SetMemoryArgs {
    kind: MemoryKind;
    key?: string | null;
    content: string;
    value_json?: unknown;
}

/**
 * Upsert (keyed) or insert (free-text note) a personal memory entry. A keyed
 * entry updates in place via the (user_id, key) partial unique index so
 * "update my preferred citation style" overwrites rather than duplicating;
 * a null-key note always inserts a new row. Re-setting a keyed entry also
 * reactivates it (is_active=true), so "remember X again" undoes a prior forget.
 */
export async function setPersonalMemoryEntry(
    db: Db,
    userId: string,
    args: SetMemoryArgs,
): Promise<void> {
    const base = {
        user_id: userId,
        kind: args.kind,
        content: args.content,
        value_json: args.value_json ?? {},
        is_active: true,
        created_by: userId,
        updated_by: userId,
    };
    if (args.key) {
        const { error } = await db.from("personal_memory_entries").upsert(
            { ...base, key: args.key },
            { onConflict: "user_id,key" },
        );
        if (error) {
            throw new Error(
                `Failed to upsert personal memory entry: ${error.message}`,
            );
        }
        return;
    }
    const { error } = await db
        .from("personal_memory_entries")
        .insert({ ...base, key: null });
    if (error) {
        throw new Error(
            `Failed to insert personal memory note: ${error.message}`,
        );
    }
}

/**
 * Soft-delete ("forget") a personal memory entry by id or key. Scoped to the
 * calling user so one user's forget can never disable another's row that
 * happens to share a key.
 */
export async function disablePersonalMemoryEntry(
    db: Db,
    userId: string,
    sel: { id?: string; key?: string },
): Promise<void> {
    let q = db
        .from("personal_memory_entries")
        .update({ is_active: false, updated_by: userId })
        .eq("user_id", userId);
    if (sel.id) q = q.eq("id", sel.id);
    else if (sel.key) q = q.eq("key", sel.key);
    else throw new Error("disablePersonalMemoryEntry requires an id or key");
    const { error } = await q;
    if (error) {
        throw new Error(
            `Failed to disable personal memory entry: ${error.message}`,
        );
    }
}

/** Active personal memory for a user, newest first. One batched read. */
export async function listPersonalMemory(
    db: Db,
    userId: string,
): Promise<MemoryEntry[]> {
    const { data, error } = await db
        .from("personal_memory_entries")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false });
    if (error) {
        throw new Error(`Failed to list personal memory: ${error.message}`);
    }
    return normalizeRows(data);
}

// --------------------------------------------------------------------------
// Selection / merge / formatting — pure, unit-testable, no DB.
// --------------------------------------------------------------------------

export interface MemorySelection {
    personal: MemoryEntry[];
    firm: MemoryEntry[];
    truncated: boolean;
}

function orderForInjection(entries: MemoryEntry[]): MemoryEntry[] {
    return [...entries].sort((a, b) => {
        const w = KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind];
        if (w !== 0) return w;
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.updated_at.localeCompare(a.updated_at);
    });
}

/**
 * Merge personal over firm and size-bound the result for one turn. Personal
 * entries suppress firm entries sharing the same non-null key (personal wins);
 * null-key notes never suppress. Entries are ordered by kind weight → priority
 * → recency, then accumulated (personal first, since it has precedence) until
 * the char/entry budget is hit — anything beyond is dropped and `truncated` is
 * set so the caller can note the omission.
 */
export function selectMemoryForTurn(
    personal: MemoryEntry[],
    firm: MemoryEntry[],
    opts: { charBudget?: number; maxEntries?: number } = {},
): MemorySelection {
    const charBudget = opts.charBudget ?? MEMORY_INJECTION_CHAR_BUDGET;
    const maxEntries = opts.maxEntries ?? MEMORY_MAX_ENTRIES;

    const personalKeys = new Set(
        personal.map((e) => e.key).filter((k): k is string => !!k),
    );
    const firmVisible = firm.filter((e) => !(e.key && personalKeys.has(e.key)));

    const orderedPersonal = orderForInjection(personal);
    const orderedFirm = orderForInjection(firmVisible);

    const keptPersonal: MemoryEntry[] = [];
    const keptFirm: MemoryEntry[] = [];
    let chars = 0;
    let count = 0;
    let truncated = false;

    // Personal has precedence, so it consumes the budget first.
    for (const [bucket, source] of [
        [keptPersonal, orderedPersonal],
        [keptFirm, orderedFirm],
    ] as const) {
        for (const e of source) {
            if (count >= maxEntries || chars + e.content.length > charBudget) {
                truncated = true;
                continue;
            }
            bucket.push(e);
            chars += e.content.length;
            count += 1;
        }
    }

    return { personal: keptPersonal, firm: keptFirm, truncated };
}

/** Render entries as bullet lines from their natural-language `content`. */
export function formatMemoryLines(entries: MemoryEntry[]): string {
    return entries.map((e) => `- ${e.content}`).join("\n");
}

function normalizeRows(data: unknown): MemoryEntry[] {
    const rows = (data as Partial<MemoryEntry>[] | null) ?? [];
    return rows.map((r) => ({
        id: String(r.id ?? ""),
        user_id: r.user_id,
        firm_id: r.firm_id,
        kind: isMemoryKind(r.kind) ? r.kind : "note",
        key: (r.key as string | null) ?? null,
        content: String(r.content ?? ""),
        value_json: r.value_json ?? {},
        is_active: r.is_active ?? true,
        priority: typeof r.priority === "number" ? r.priority : 0,
        updated_at: String(r.updated_at ?? ""),
    }));
}

// --------------------------------------------------------------------------
// Firm memory (shared across the firm) + suggest-then-approve queue.
//
// Quill never writes firm memory directly: it PROPOSES a candidate, and a firm
// admin (authorize() weight >= 3) approves it. Only approved entries are read
// into a turn — pending candidates are never injected. Every approval snapshots
// the active set into firm_memory_versions for auditability.
// --------------------------------------------------------------------------

export type FirmCandidateStatus =
    | "pending"
    | "approved"
    | "rejected"
    | "superseded";

export interface FirmMemoryCandidate {
    id: string;
    firm_id: string;
    status: FirmCandidateStatus;
    kind: MemoryKind;
    proposed_key: string | null;
    proposed_content: string;
    proposed_value_json: unknown;
    rationale: string;
    origin: "tool" | "distiller";
    proposed_by_user_id: string;
    source_chat_id: string | null;
    source_message_id: string | null;
    source_matter_id: string | null;
    private_fact_flags: string[];
    dedup_hash: string;
    reviewed_by_user_id: string | null;
    reviewed_at: string | null;
    review_note: string | null;
    resulting_firm_memory_id: string | null;
    created_at: string;
    updated_at: string;
}

const MISSING_SCHEMA_CODES = new Set(["42P01", "PGRST205", "PGRST204", "42703"]);

/**
 * True when the error means migration 030 has not been applied yet. Mirrors
 * isMissingCalendarSchema (calendar/store.ts) so the firm-memory reads behave
 * like every other optional subsystem: absent tables degrade to "no firm
 * memory" instead of 500-ing the /firm-memory routes. Genuine errors still
 * propagate.
 */
export function isMissingMemorySchema(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    if (code && MISSING_SCHEMA_CODES.has(code)) return true;
    const message = (error as { message?: string }).message ?? "";
    return /relation .* does not exist|could not find the table|schema cache/i.test(
        message,
    );
}

/** Active shared firm memory, newest first. One batched read. */
export async function listFirmMemory(
    db: Db,
    firmId: string,
): Promise<MemoryEntry[]> {
    const { data, error } = await db
        .from("firm_memory_entries")
        .select("*")
        .eq("firm_id", firmId)
        .eq("is_active", true)
        .order("updated_at", { ascending: false });
    if (error) {
        if (isMissingMemorySchema(error)) return [];
        throw new Error(`Failed to list firm memory: ${error.message}`);
    }
    return normalizeRows(data);
}

/** Write an approved firm-memory entry (keyed upsert / note insert). */
export async function setFirmMemoryEntry(
    db: Db,
    firmId: string,
    args: SetMemoryArgs & { approvedFromCandidateId?: string | null },
    updatedBy: string,
): Promise<void> {
    const base = {
        firm_id: firmId,
        kind: args.kind,
        content: args.content,
        value_json: args.value_json ?? {},
        is_active: true,
        approved_from_candidate_id: args.approvedFromCandidateId ?? null,
        created_by: updatedBy,
        updated_by: updatedBy,
    };
    if (args.key) {
        const { error } = await db
            .from("firm_memory_entries")
            .upsert({ ...base, key: args.key }, { onConflict: "firm_id,key" });
        if (error) {
            throw new Error(
                `Failed to upsert firm memory entry: ${error.message}`,
            );
        }
        return;
    }
    const { error } = await db
        .from("firm_memory_entries")
        .insert({ ...base, key: null });
    if (error) {
        throw new Error(`Failed to insert firm memory note: ${error.message}`);
    }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b/;
const MONEY_RE = /\$\s?\d[\d,]*/;

/**
 * Heuristic tripwire for firm-memory proposals: flags obvious client/matter
 * specifics that must NOT be generalized into shared memory (emails, phone
 * numbers, dollar amounts). This is a hint surfaced to the human reviewer, not
 * a hard block — the mandatory approval gate is the real backstop.
 */
export function detectPrivateFactSignals(content: string): string[] {
    const flags: string[] = [];
    if (EMAIL_RE.test(content)) flags.push("contains an email address");
    if (PHONE_RE.test(content)) flags.push("contains a phone number");
    if (MONEY_RE.test(content)) flags.push("contains a dollar amount");
    return flags;
}

export interface ProposeFirmMemoryArgs {
    firmId: string;
    proposedByUserId: string;
    kind: MemoryKind;
    proposedKey?: string | null;
    proposedContent: string;
    rationale: string;
    origin?: "tool" | "distiller";
    sourceChatId?: string | null;
    sourceMessageId?: string | null;
    sourceMatterId?: string | null;
}

/**
 * Propose a firm-wide learning. Creates a PENDING candidate — never writes
 * firm memory. Returns null when an identical still-pending proposal already
 * exists (deduped by hash; also backed by the partial unique index).
 */
export async function proposeFirmMemoryCandidate(
    db: Db,
    args: ProposeFirmMemoryArgs,
): Promise<FirmMemoryCandidate | null> {
    const proposedKey = args.proposedKey?.trim() || null;
    const dedupHash = createHash("sha1")
        .update(`${args.firmId}|${proposedKey ?? args.proposedContent.trim()}`)
        .digest("hex");

    const { data: dup, error: dupErr } = await db
        .from("firm_memory_candidates")
        .select("id")
        .eq("firm_id", args.firmId)
        .eq("dedup_hash", dedupHash)
        .eq("status", "pending")
        .maybeSingle();
    if (dupErr) {
        throw new Error(
            `Failed to check firm memory candidate dedup: ${dupErr.message}`,
        );
    }
    if (dup) return null;

    const { data, error } = await db
        .from("firm_memory_candidates")
        .insert({
            firm_id: args.firmId,
            status: "pending",
            kind: args.kind,
            proposed_key: proposedKey,
            proposed_content: args.proposedContent,
            proposed_value_json: {},
            rationale: args.rationale ?? "",
            origin: args.origin ?? "tool",
            proposed_by_user_id: args.proposedByUserId,
            source_chat_id: args.sourceChatId ?? null,
            source_message_id: args.sourceMessageId ?? null,
            source_matter_id: args.sourceMatterId ?? null,
            private_fact_flags: detectPrivateFactSignals(args.proposedContent),
            dedup_hash: dedupHash,
        })
        .select()
        .single();
    if (error) {
        throw new Error(
            `Failed to insert firm memory candidate: ${error.message}`,
        );
    }
    return normalizeCandidate(data);
}

/** List firm-memory candidates, optionally filtered by status, newest first. */
export async function listFirmMemoryCandidates(
    db: Db,
    firmId: string,
    status?: FirmCandidateStatus,
): Promise<FirmMemoryCandidate[]> {
    let q = db
        .from("firm_memory_candidates")
        .select("*")
        .eq("firm_id", firmId);
    if (status) q = q.eq("status", status);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) {
        if (isMissingMemorySchema(error)) return [];
        throw new Error(
            `Failed to list firm memory candidates: ${error.message}`,
        );
    }
    return ((data as Record<string, unknown>[] | null) ?? []).map(
        normalizeCandidate,
    );
}

export interface FirmApprovalResult {
    ok: boolean;
    reason?: string;
    version?: number;
    candidate?: FirmMemoryCandidate;
}

/**
 * Approve a pending candidate: status-guarded claim (concurrency-safe — a
 * second approve is a no-op), then write the firm-memory entry and snapshot a
 * new version. The caller (route) logs the approval to the agent-operations
 * ledger and passes the resolved reviewer.
 */
export async function approveFirmMemoryCandidate(
    db: Db,
    params: { firmId: string; candidateId: string; reviewerUserId: string },
): Promise<FirmApprovalResult> {
    const nowIso = new Date().toISOString();
    const { data: claimedRows, error: claimErr } = await db
        .from("firm_memory_candidates")
        .update({
            status: "approved",
            reviewed_by_user_id: params.reviewerUserId,
            reviewed_at: nowIso,
            updated_at: nowIso,
        })
        .eq("id", params.candidateId)
        .eq("firm_id", params.firmId)
        .eq("status", "pending")
        .select();
    if (claimErr) {
        throw new Error(
            `Failed to claim firm memory candidate: ${claimErr.message}`,
        );
    }
    const claimed = ((claimedRows as Record<string, unknown>[] | null) ?? [])[0];
    if (!claimed) return { ok: false, reason: "already_handled" };
    const cand = normalizeCandidate(claimed);

    await setFirmMemoryEntry(
        db,
        params.firmId,
        {
            kind: cand.kind,
            key: cand.proposed_key ?? undefined,
            content: cand.proposed_content,
            value_json: cand.proposed_value_json,
            approvedFromCandidateId: cand.id,
        },
        params.reviewerUserId,
    );

    const version = await writeFirmMemoryVersion(
        db,
        params.firmId,
        params.reviewerUserId,
    );

    return { ok: true, version, candidate: cand };
}

/** Reject a pending candidate (status-guarded). Never writes firm memory. */
export async function rejectFirmMemoryCandidate(
    db: Db,
    params: {
        firmId: string;
        candidateId: string;
        reviewerUserId: string;
        note?: string;
    },
): Promise<{ ok: boolean; reason?: string }> {
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await db
        .from("firm_memory_candidates")
        .update({
            status: "rejected",
            reviewed_by_user_id: params.reviewerUserId,
            reviewed_at: nowIso,
            review_note: params.note ?? "",
            updated_at: nowIso,
        })
        .eq("id", params.candidateId)
        .eq("firm_id", params.firmId)
        .eq("status", "pending")
        .select();
    if (error) {
        throw new Error(
            `Failed to reject firm memory candidate: ${error.message}`,
        );
    }
    const claimed = ((rows as Record<string, unknown>[] | null) ?? [])[0];
    if (!claimed) return { ok: false, reason: "already_handled" };
    return { ok: true };
}

async function writeFirmMemoryVersion(
    db: Db,
    firmId: string,
    createdBy: string,
): Promise<number> {
    const active = await listFirmMemory(db, firmId);
    // next version = max(existing)+1; the unique (firm_id, version) index
    // catches a concurrent allocation → retry.
    for (let attempt = 0; attempt < 3; attempt++) {
        const { data: existing, error: readErr } = await db
            .from("firm_memory_versions")
            .select("version")
            .eq("firm_id", firmId);
        if (readErr) {
            throw new Error(
                `Failed to read firm memory versions: ${readErr.message}`,
            );
        }
        const max = (
            (existing as { version?: number }[] | null) ?? []
        ).reduce((m, r) => Math.max(m, r.version ?? 0), 0);
        const next = max + 1;
        const { error: insErr } = await db
            .from("firm_memory_versions")
            .insert({
                firm_id: firmId,
                version: next,
                snapshot_json: active,
                created_by: createdBy,
            });
        if (!insErr) return next;
        // unique violation → another approval took `next`; loop to retry.
    }
    throw new Error("Failed to allocate firm memory version after retries");
}

function normalizeCandidate(row: unknown): FirmMemoryCandidate {
    const r = (row ?? {}) as Partial<FirmMemoryCandidate>;
    return {
        id: String(r.id ?? ""),
        firm_id: String(r.firm_id ?? ""),
        status: (r.status as FirmCandidateStatus) ?? "pending",
        kind: isMemoryKind(r.kind) ? r.kind : "note",
        proposed_key: (r.proposed_key as string | null) ?? null,
        proposed_content: String(r.proposed_content ?? ""),
        proposed_value_json: r.proposed_value_json ?? {},
        rationale: String(r.rationale ?? ""),
        origin: (r.origin as "tool" | "distiller") ?? "tool",
        proposed_by_user_id: String(r.proposed_by_user_id ?? ""),
        source_chat_id: (r.source_chat_id as string | null) ?? null,
        source_message_id: (r.source_message_id as string | null) ?? null,
        source_matter_id: (r.source_matter_id as string | null) ?? null,
        private_fact_flags: Array.isArray(r.private_fact_flags)
            ? (r.private_fact_flags as string[])
            : [],
        dedup_hash: String(r.dedup_hash ?? ""),
        reviewed_by_user_id: (r.reviewed_by_user_id as string | null) ?? null,
        reviewed_at: (r.reviewed_at as string | null) ?? null,
        review_note: (r.review_note as string | null) ?? null,
        resulting_firm_memory_id:
            (r.resulting_firm_memory_id as string | null) ?? null,
        created_at: String(r.created_at ?? ""),
        updated_at: String(r.updated_at ?? ""),
    };
}
