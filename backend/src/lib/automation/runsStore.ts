// backend/src/lib/automation/runsStore.ts
//
// Typed store for automation_runs + automation_state (see
// migrations/023_pi_cases_automation.sql) — the state machine the phase-4
// email-automation pipeline drives. Narrow functions over the service-role
// Supabase client, mirroring lib/email/store.ts.
//
// Concurrency model (no transactions available through the Supabase client):
// - enqueueRun leans on the unique index on automation_runs.email_id so an
//   email is enqueued exactly once, no matter how many ingest paths see it.
// - claimRunStep is a single conditional UPDATE (id + status=from), the same
//   atomic-claim shape as claimEmailForSending in lib/email/send.ts — the
//   WHERE clause is the mutex.
// - acquireSchedulerLease keeps a single lease row in automation_state and
//   takes it over only via a CAS on updated_at, so exactly one instance runs
//   the scheduler tick at a time.

import type { createServerSupabase } from "../supabase";
import {
    RUN_STATUSES,
    type AutomationRun,
    type RunStatus,
    type WorkflowKind,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/** automation_state key of the single scheduler lease row. */
export const SCHEDULER_LEASE_KEY = "scheduler_lease";

/**
 * Non-terminal statuses a worker holds while actively processing a run. Rows
 * stuck in one of these (e.g. the process died mid-step) are what
 * markStalledRunsQueued sweeps back to 'queued'. 'staged' is NOT in this
 * list: it is a stable waiting-for-human state, never "stalled".
 */
export const WORKING_RUN_STATUSES: readonly RunStatus[] = [
    "classifying",
    "extracting",
    "matching",
    "staging",
];

interface AutomationRunRow {
    id: string;
    user_id: string;
    email_id: string | null;
    workflow_kind: string | null;
    status: string;
    case_id: string | null;
    match_method: string | null;
    match_confidence: number | null;
    extracted: Record<string, unknown> | null;
    citations: unknown[] | null;
    confidence: number | null;
    verification: Record<string, unknown> | null;
    proposal: Record<string, unknown> | null;
    ack_email_id: string | null;
    operation_ids: string[] | null;
    error: string | null;
    retry_count: number | null;
    next_attempt_at: string | null;
    triage_reason: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
}

function serializeRun(row: AutomationRunRow): AutomationRun {
    return {
        id: row.id,
        user_id: row.user_id,
        email_id: row.email_id ?? null,
        workflow_kind: (row.workflow_kind as WorkflowKind | null) ?? null,
        status: row.status as RunStatus,
        case_id: row.case_id ?? null,
        match_method: row.match_method ?? null,
        match_confidence: row.match_confidence ?? null,
        extracted: row.extracted ?? {},
        citations: row.citations ?? [],
        confidence: row.confidence ?? null,
        verification: row.verification ?? {},
        proposal: row.proposal ?? {},
        ack_email_id: row.ack_email_id ?? null,
        operation_ids: row.operation_ids ?? [],
        error: row.error ?? null,
        retry_count: row.retry_count ?? 0,
        next_attempt_at: row.next_attempt_at ?? null,
        triage_reason: row.triage_reason ?? null,
        reviewed_by: row.reviewed_by ?? null,
        reviewed_at: row.reviewed_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    if ((error as { code?: string }).code === "23505") return true;
    return /duplicate key|unique constraint/i.test(
        (error as { message?: string }).message ?? "",
    );
}

// Missing-table / missing-column signatures, mirroring lib/email/store.ts:
// 42P01 undefined_table, 42703 undefined_column, PGRST205/PGRST204 PostgREST
// schema-cache misses.
const MISSING_SCHEMA_CODES = new Set(["42P01", "PGRST205", "PGRST204", "42703"]);

/**
 * Is this error "the 023 automation tables are not applied yet"? The
 * /automation routes use it to degrade to zeros + a schema_ready:false flag
 * instead of a 500 — but ONLY for genuine missing-schema errors; a real
 * outage must still surface.
 */
export function isMissingAutomationSchema(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    if (code && MISSING_SCHEMA_CODES.has(code)) return true;
    const message = (error as { message?: string }).message ?? "";
    return /relation .* does not exist|could not find the table|schema cache/i.test(
        message,
    );
}

/**
 * Enqueue a run for an inbound email, exactly once per email: plain insert,
 * and when it hits the automation_runs.email_id unique index (this email is
 * already enqueued — by a previous tick or a concurrent ingest) fetch and
 * return the existing run instead. `created` tells the caller whether this
 * call minted the run.
 */
export async function enqueueRun(
    db: Db,
    input: { emailId: string; userId: string },
): Promise<{ id: string; created: boolean }> {
    const { data, error } = await db
        .from("automation_runs")
        .insert({
            user_id: input.userId,
            email_id: input.emailId,
            status: "queued",
        })
        .select("id")
        .single();
    if (!error && data) {
        return { id: (data as { id: string }).id, created: true };
    }
    if (isUniqueViolation(error)) {
        const existing = await getRunByEmailId(db, input.emailId);
        if (existing) return { id: existing.id, created: false };
    }
    throw error ?? new Error("enqueueRun: insert returned no row");
}

/**
 * Atomically claim a run's next step: flip status from → to ONLY if it is
 * still `from`, and report whether THIS call won the claim. The single
 * conditional UPDATE is the mutex that stops two scheduler ticks from both
 * processing the same run (mirror of claimEmailForSending). Always bumps
 * updated_at — that timestamp doubles as the stall detector's heartbeat.
 */
export async function claimRunStep(
    db: Db,
    runId: string,
    from: RunStatus,
    to: RunStatus,
): Promise<boolean> {
    const { data, error } = await db
        .from("automation_runs")
        .update({ status: to, updated_at: new Date().toISOString() })
        .eq("id", runId)
        .eq("status", from)
        .select("id")
        .maybeSingle();
    if (error) throw error;
    return data != null;
}

export interface AutomationRunPatch {
    workflowKind?: WorkflowKind | null;
    status?: RunStatus;
    caseId?: string | null;
    matchMethod?: string | null;
    matchConfidence?: number | null;
    extracted?: Record<string, unknown>;
    citations?: unknown[];
    confidence?: number | null;
    verification?: Record<string, unknown>;
    proposal?: Record<string, unknown>;
    ackEmailId?: string | null;
    operationIds?: string[];
    error?: string | null;
    retryCount?: number;
    nextAttemptAt?: string | null;
    triageReason?: string | null;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
}

export async function updateRun(
    db: Db,
    runId: string,
    patch: AutomationRunPatch,
): Promise<AutomationRun | null> {
    const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (patch.workflowKind !== undefined) update.workflow_kind = patch.workflowKind;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.caseId !== undefined) update.case_id = patch.caseId;
    if (patch.matchMethod !== undefined) update.match_method = patch.matchMethod;
    if (patch.matchConfidence !== undefined)
        update.match_confidence = patch.matchConfidence;
    if (patch.extracted !== undefined) update.extracted = patch.extracted;
    if (patch.citations !== undefined) update.citations = patch.citations;
    if (patch.confidence !== undefined) update.confidence = patch.confidence;
    if (patch.verification !== undefined) update.verification = patch.verification;
    if (patch.proposal !== undefined) update.proposal = patch.proposal;
    if (patch.ackEmailId !== undefined) update.ack_email_id = patch.ackEmailId;
    if (patch.operationIds !== undefined) update.operation_ids = patch.operationIds;
    if (patch.error !== undefined) update.error = patch.error;
    if (patch.retryCount !== undefined) update.retry_count = patch.retryCount;
    if (patch.nextAttemptAt !== undefined)
        update.next_attempt_at = patch.nextAttemptAt;
    if (patch.triageReason !== undefined)
        update.triage_reason = patch.triageReason;
    if (patch.reviewedBy !== undefined) update.reviewed_by = patch.reviewedBy;
    if (patch.reviewedAt !== undefined) update.reviewed_at = patch.reviewedAt;

    const { data, error } = await db
        .from("automation_runs")
        .update(update)
        .eq("id", runId)
        .select("*")
        .maybeSingle();
    if (error) throw error;
    return data ? serializeRun(data as AutomationRunRow) : null;
}

export async function getRun(
    db: Db,
    runId: string,
): Promise<AutomationRun | null> {
    const { data, error } = await db
        .from("automation_runs")
        .select("*")
        .eq("id", runId)
        .maybeSingle();
    if (error) throw error;
    return data ? serializeRun(data as AutomationRunRow) : null;
}

export async function getRunByEmailId(
    db: Db,
    emailId: string,
): Promise<AutomationRun | null> {
    const { data, error } = await db
        .from("automation_runs")
        .select("*")
        .eq("email_id", emailId)
        .maybeSingle();
    if (error) throw error;
    return data ? serializeRun(data as AutomationRunRow) : null;
}

/**
 * Runs ready for a scheduler tick: status 'queued' and either never scheduled
 * (next_attempt_at null) or their retry backoff has elapsed. Oldest first so
 * a burst of inbound mail is processed in arrival order.
 */
export async function listDueRuns(
    db: Db,
    opts: { limit: number },
): Promise<AutomationRun[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await db
        .from("automation_runs")
        .select("*")
        .eq("status", "queued")
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
        .order("created_at", { ascending: true })
        .limit(Math.max(1, Math.min(opts.limit, 100)));
    if (error) throw error;
    return ((data as AutomationRunRow[] | null) ?? []).map(serializeRun);
}

/** A user's runs, newest first — backs the review/API surface. */
export async function listRuns(
    db: Db,
    userId: string,
    opts?: {
        status?: RunStatus;
        caseId?: string;
        limit?: number;
        offset?: number;
    },
): Promise<AutomationRun[]> {
    const limit = Math.min(opts?.limit ?? 50, 100);
    const offset = Math.max(0, opts?.offset ?? 0);
    let query = db
        .from("automation_runs")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    if (opts?.status) query = query.eq("status", opts.status);
    if (opts?.caseId) query = query.eq("case_id", opts.caseId);
    const { data, error } = await query;
    if (error) throw error;
    return ((data as AutomationRunRow[] | null) ?? []).map(serializeRun);
}

/**
 * Exact per-status run counts for one user (GET /automation/status). One
 * head-count per status rather than a row fetch + reduce, so the numbers
 * stay exact past PostgREST's max-rows cap.
 */
export async function countRunsByStatus(
    db: Db,
    userId: string,
): Promise<Record<RunStatus, number>> {
    const entries = await Promise.all(
        RUN_STATUSES.map(async (status) => {
            const { count, error } = await db
                .from("automation_runs")
                .select("id", { count: "exact", head: true })
                .eq("user_id", userId)
                .eq("status", status);
            if (error) throw error;
            return [status, count ?? 0] as const;
        }),
    );
    return Object.fromEntries(entries) as Record<RunStatus, number>;
}

/**
 * Put a failed step back in the queue with backoff: status → 'queued',
 * next_attempt_at ← now + delayMs. retry_count is caller-provided (the
 * pipeline owns the max-retries policy, the store just records it).
 */
export async function scheduleRetry(
    db: Db,
    runId: string,
    input: { error: string; retryCount: number; delayMs: number },
): Promise<void> {
    const { error } = await db
        .from("automation_runs")
        .update({
            status: "queued",
            error: input.error,
            retry_count: input.retryCount,
            next_attempt_at: new Date(Date.now() + input.delayMs).toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    if (error) throw error;
}

/** Statuses an operator may force back to 'queued' via POST /runs/:id/retry. */
export const REQUEUEABLE_RUN_STATUSES: readonly RunStatus[] = [
    "failed",
    "triage",
];

/**
 * Operator-forced retry: put a failed/triaged run back to 'queued' with the
 * backoff, error, and triage reason cleared, via a CAS-style conditional
 * UPDATE (claimRunStep semantics — the WHERE on the current status is the
 * mutex). Returns the requeued run, or null when the run was no longer in an
 * allowed from-status (approved/rejected/already requeued by a concurrent
 * click) — the caller 409s instead of clobbering the newer state.
 * retry_count is deliberately untouched: a forced retry buys exactly one
 * more attempt, not a fresh backoff budget.
 */
export async function requeueRun(
    db: Db,
    runId: string,
    from: readonly RunStatus[] = REQUEUEABLE_RUN_STATUSES,
): Promise<AutomationRun | null> {
    const { data, error } = await db
        .from("automation_runs")
        .update({
            status: "queued",
            next_attempt_at: null,
            error: null,
            triage_reason: null,
            updated_at: new Date().toISOString(),
        })
        .eq("id", runId)
        .in("status", [...from])
        .select("*")
        .maybeSingle();
    if (error) throw error;
    return data ? serializeRun(data as AutomationRunRow) : null;
}

/**
 * Recovery sweep: any run sitting in a WORKING status whose updated_at is
 * older than the cutoff was abandoned by a dead worker (every live step bumps
 * updated_at via claimRunStep/updateRun) — put it back to 'queued'. Does NOT
 * touch retry_count: a crash is not a failed attempt. Returns how many rows
 * were recovered.
 */
export async function markStalledRunsQueued(
    db: Db,
    opts: { olderThanMs: number },
): Promise<number> {
    const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
    const { data, error } = await db
        .from("automation_runs")
        .update({ status: "queued", updated_at: new Date().toISOString() })
        .in("status", [...WORKING_RUN_STATUSES])
        .lt("updated_at", cutoff)
        .select("id");
    if (error) throw error;
    return ((data as { id: string }[] | null) ?? []).length;
}

export async function getAutomationState(
    db: Db,
    key: string,
): Promise<unknown | null> {
    const { data, error } = await db
        .from("automation_state")
        .select("value")
        .eq("key", key)
        .maybeSingle();
    if (error) throw error;
    return (data as { value: unknown } | null)?.value ?? null;
}

export async function setAutomationState(
    db: Db,
    key: string,
    value: unknown,
): Promise<void> {
    const { error } = await db.from("automation_state").upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: "key" },
    );
    if (error) throw error;
}

/**
 * Pure decision under acquireSchedulerLease: is the lease row takeable by
 * `instanceId` at `nowMs`? Own lease → always renewable; foreign lease →
 * only once expired. A missing/unparseable expiry counts as free so a
 * malformed row can never wedge the scheduler forever.
 */
export function isLeaseClaimable(
    row:
        | { claimed_by: string | null; claimed_until: string | null }
        | null
        | undefined,
    instanceId: string,
    nowMs: number,
): boolean {
    if (!row) return true;
    if (row.claimed_by === instanceId) return true;
    if (!row.claimed_until) return true;
    const until = Date.parse(row.claimed_until);
    if (!Number.isFinite(until)) return true;
    return until <= nowMs;
}

/**
 * Take (or renew) the singleton scheduler lease for ttlMs. Returns false when
 * another live instance holds it. Two-step without transactions:
 * 1. No lease row yet → insert; losing the insert race (unique key) → false.
 * 2. Row exists and is claimable → conditional UPDATE guarded by
 *    updated_at-equality (CAS): if anything moved the row between our read
 *    and write, the WHERE matches nothing and we lost.
 */
export async function acquireSchedulerLease(
    db: Db,
    instanceId: string,
    ttlMs: number,
): Promise<boolean> {
    const nowMs = Date.now();
    const { data, error } = await db
        .from("automation_state")
        .select("claimed_by, claimed_until, updated_at")
        .eq("key", SCHEDULER_LEASE_KEY)
        .maybeSingle();
    if (error) throw error;
    const row = data as {
        claimed_by: string | null;
        claimed_until: string | null;
        updated_at: string;
    } | null;

    const claimedUntil = new Date(nowMs + ttlMs).toISOString();
    if (!row) {
        const { error: insertError } = await db.from("automation_state").insert({
            key: SCHEDULER_LEASE_KEY,
            value: {},
            claimed_by: instanceId,
            claimed_until: claimedUntil,
            updated_at: new Date(nowMs).toISOString(),
        });
        if (!insertError) return true;
        if (isUniqueViolation(insertError)) return false;
        throw insertError;
    }

    if (!isLeaseClaimable(row, instanceId, nowMs)) return false;

    const { data: claimed, error: updateError } = await db
        .from("automation_state")
        .update({
            claimed_by: instanceId,
            claimed_until: claimedUntil,
            updated_at: new Date(nowMs).toISOString(),
        })
        .eq("key", SCHEDULER_LEASE_KEY)
        .eq("updated_at", row.updated_at)
        .select("key")
        .maybeSingle();
    if (updateError) throw updateError;
    return claimed != null;
}
