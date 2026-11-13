// backend/src/lib/recordings/store.ts
//
// Typed store for `recordings` + `recordings_state` (see
// migrations/025_recordings.sql) — the state machine the transcription worker
// drives (queued → transcribing → summarizing → ready, with a failed exit and
// next_attempt_at backoff). Narrow functions over the service-role Supabase
// client, mirroring lib/automation/runsStore.ts and lib/email/store.ts.
//
// Concurrency model (no transactions through the Supabase client):
// - claimRecordingStep is a single conditional UPDATE (id + status=from), the
//   same atomic-claim shape as claimRunStep — the WHERE clause is the mutex
//   that stops two scheduler ticks from both processing one recording.
// - acquireRecordingsLease keeps a single lease row in recordings_state and
//   takes it over only via a CAS on updated_at, so exactly one instance runs
//   the recordings tick at a time (mirror of acquireSchedulerLease).
//
// Missing-schema policy (mirror of lib/email/store.ts): every db call is
// wrapped in tolerateMissingSchema so an unapplied migration 025 degrades to a
// null/empty/0 fallback instead of 500-ing — but ONLY for genuine
// missing-table/column errors; a real outage still throws. isMissingRecordings-
// Schema is exported for the routes/scheduler to make the same distinction.

import type { createServerSupabase } from "../supabase";
import { checkProjectAccess } from "../access";
import {
    parseActionItems,
    parseUtterances,
    type Recording,
    type RecordingSource,
    type RecordingStatus,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/** recordings_state key of the single recordings-scheduler lease row. */
export const RECORDINGS_LEASE_KEY = "recordings_scheduler_lease";

/**
 * Non-terminal statuses a worker holds while actively processing. Rows stuck in
 * one of these (the process died mid-step) are what markStalledRecordingsQueued
 * sweeps back to 'queued'. 'queued' is the waiting state, 'ready'/'failed' are
 * terminal — none of those are "stalled".
 */
export const WORKING_RECORDING_STATUSES: readonly RecordingStatus[] = [
    "transcribing",
    "summarizing",
];

/** Statuses a scheduler tick may claim: they wait on external/backoff time.
 * 'summarizing' is a single in-process step entered from 'transcribing', not a
 * time-gated wait, so it is deliberately NOT due-claimable. */
export const DUE_RECORDING_STATUSES: readonly RecordingStatus[] = [
    "queued",
    "transcribing",
];

interface RecordingRow {
    id: string;
    user_id: string;
    project_id: string | null;
    chat_id: string | null;
    chat_message_id: string | null;
    title: string | null;
    source: string | null;
    status: string;
    audio_storage_key: string;
    audio_mime: string;
    audio_size_bytes: number | null;
    duration_seconds: number | null;
    consent_ack_at: string;
    assemblyai_transcript_id: string | null;
    utterances: unknown;
    transcript_text: string | null;
    summary_md: string | null;
    action_items: unknown;
    transcript_document_id: string | null;
    voice_briefing_document_id: string | null;
    timeline_image_document_id: string | null;
    email_id: string | null;
    error: string | null;
    retry_count: number | null;
    next_attempt_at: string;
    created_at: string;
    updated_at: string;
}

function serializeRecording(row: RecordingRow): Recording {
    return {
        id: row.id,
        user_id: row.user_id,
        project_id: row.project_id ?? null,
        chat_id: row.chat_id ?? null,
        chat_message_id: row.chat_message_id ?? null,
        title: row.title ?? "Untitled recording",
        source: (row.source ?? "mic") as RecordingSource,
        status: row.status as RecordingStatus,
        audio_storage_key: row.audio_storage_key,
        audio_mime: row.audio_mime,
        audio_size_bytes: row.audio_size_bytes ?? 0,
        duration_seconds: row.duration_seconds ?? null,
        consent_ack_at: row.consent_ack_at,
        assemblyai_transcript_id: row.assemblyai_transcript_id ?? null,
        utterances: parseUtterances(row.utterances),
        transcript_text: row.transcript_text ?? null,
        summary_md: row.summary_md ?? null,
        action_items: parseActionItems(row.action_items),
        transcript_document_id: row.transcript_document_id ?? null,
        voice_briefing_document_id: row.voice_briefing_document_id ?? null,
        timeline_image_document_id: row.timeline_image_document_id ?? null,
        email_id: row.email_id ?? null,
        error: row.error ?? null,
        retry_count: row.retry_count ?? 0,
        next_attempt_at: row.next_attempt_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// Missing-table / missing-column signatures, mirroring lib/email/store.ts:
// 42P01 undefined_table, 42703 undefined_column, PGRST205/PGRST204 PostgREST
// schema-cache misses.
const MISSING_SCHEMA_CODES = new Set(["42P01", "PGRST205", "PGRST204", "42703"]);

/**
 * Is this error "the 025 recordings tables are not applied yet"? The store uses
 * it to degrade to null/empty/0 instead of throwing — but ONLY for genuine
 * missing-schema errors; a real outage must still surface.
 */
export function isMissingRecordingsSchema(error: unknown): boolean {
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
        if (isMissingRecordingsSchema(error)) {
            if (process.env.NODE_ENV !== "production") {
                console.warn(
                    `[recordings] ${label}: schema missing, returning fallback`,
                    error,
                );
            }
            return fallback;
        }
        throw error;
    }
}

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    if ((error as { code?: string }).code === "23505") return true;
    return /duplicate key|unique constraint/i.test(
        (error as { message?: string }).message ?? "",
    );
}

/**
 * Enqueue one captured audio: insert in the 'queued' state with next_attempt_at
 * seeded to now so the very next scheduler tick claims it. Tolerates a missing
 * schema (returns null → the route surfaces "recordings not enabled").
 */
export async function createRecording(
    db: Db,
    input: {
        userId: string;
        projectId?: string | null;
        chatId?: string | null;
        chatMessageId?: string | null;
        title?: string | null;
        source: RecordingSource;
        audioStorageKey: string;
        audioMime: string;
        audioSizeBytes: number;
        durationSeconds?: number | null;
        consentAckAt: string;
    },
): Promise<Recording | null> {
    return tolerateMissingSchema("createRecording", null, async () => {
        const insert: Record<string, unknown> = {
            user_id: input.userId,
            project_id: input.projectId ?? null,
            chat_id: input.chatId ?? null,
            chat_message_id: input.chatMessageId ?? null,
            source: input.source,
            status: "queued",
            audio_storage_key: input.audioStorageKey,
            audio_mime: input.audioMime,
            audio_size_bytes: input.audioSizeBytes,
            duration_seconds: input.durationSeconds ?? null,
            consent_ack_at: input.consentAckAt,
            next_attempt_at: new Date().toISOString(),
        };
        // Omit title when absent so the DDL default ('Untitled recording') is
        // the single source for it.
        if (input.title != null) insert.title = input.title;

        const { data, error } = await db
            .from("recordings")
            .insert(insert)
            .select("*")
            .single();
        if (error) throw error;
        return serializeRecording(data as RecordingRow);
    });
}

/**
 * Tenancy-scoped single fetch. Standalone rows remain creator-private;
 * project rows follow current matter membership so creator access disappears
 * immediately on removal and collaborators can use shared recordings.
 */
export async function getRecording(
    db: Db,
    id: string,
    userId: string,
    userEmail?: string | null,
): Promise<Recording | null> {
    return tolerateMissingSchema("getRecording", null, async () => {
        const { data, error } = await db
            .from("recordings")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const recording = serializeRecording(data as RecordingRow);
        if (!recording.project_id)
            return recording.user_id === userId ? recording : null;
        const access = await checkProjectAccess(
            recording.project_id,
            userId,
            userEmail,
            db,
        );
        return access.ok ? recording : null;
    });
}

/**
 * Unscoped single fetch — for the worker, which owns no user context (it acts
 * on rows it claimed off the due queue, across all tenants).
 */
export async function getRecordingAny(
    db: Db,
    id: string,
): Promise<Recording | null> {
    return tolerateMissingSchema("getRecordingAny", null, async () => {
        const { data, error } = await db
            .from("recordings")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        return data ? serializeRecording(data as RecordingRow) : null;
    });
}

/** A user's recordings, newest first — backs the /recordings library. */
export async function listRecordings(
    db: Db,
    userId: string,
    opts?: {
        projectId?: string;
        includeProjectMembers?: boolean;
        limit?: number;
        offset?: number;
    },
): Promise<Recording[]> {
    return tolerateMissingSchema("listRecordings", [], async () => {
        const limit = Math.min(opts?.limit ?? 50, 100);
        const offset = Math.max(0, opts?.offset ?? 0);
        let query = db
            .from("recordings")
            .select("*")
            .order("created_at", { ascending: false })
            .range(offset, offset + limit - 1);
        if (!opts?.includeProjectMembers) query = query.eq("user_id", userId);
        if (opts?.projectId) query = query.eq("project_id", opts.projectId);
        const { data, error } = await query;
        if (error) throw error;
        return ((data as RecordingRow[] | null) ?? []).map(serializeRecording);
    });
}

/**
 * A snake_case column patch. The pipeline writes DB columns directly (status,
 * assemblyai_transcript_id, utterances, summary_md, *_document_id, …); id /
 * user_id / created_at are immutable and updated_at is always machine-set, so
 * they are omitted.
 */
export type RecordingPatch = Partial<
    Omit<Recording, "id" | "user_id" | "created_at" | "updated_at">
>;

/**
 * Partial update by column patch. ALWAYS bumps updated_at — that timestamp
 * doubles as the worker heartbeat the stall sweeper reads. Returns the updated
 * row (null when the id was absent or the schema is missing).
 */
export async function updateRecording(
    db: Db,
    id: string,
    patch: RecordingPatch,
): Promise<Recording | null> {
    return tolerateMissingSchema("updateRecording", null, async () => {
        const update: Record<string, unknown> = {
            ...patch,
            updated_at: new Date().toISOString(),
        };
        const { data, error } = await db
            .from("recordings")
            .update(update)
            .eq("id", id)
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeRecording(data as RecordingRow) : null;
    });
}

/**
 * Atomically claim a recording's next step: flip status from → to ONLY if it is
 * still `from`, and return the claimed row (null when this call lost the claim).
 * The single conditional UPDATE is the mutex that stops two scheduler ticks from
 * both processing the same recording (mirror of claimRunStep). Always bumps
 * updated_at — the heartbeat the stall detector reads.
 */
export async function claimRecordingStep(
    db: Db,
    id: string,
    from: RecordingStatus,
    to: RecordingStatus,
): Promise<Recording | null> {
    return tolerateMissingSchema("claimRecordingStep", null, async () => {
        const { data, error } = await db
            .from("recordings")
            .update({ status: to, updated_at: new Date().toISOString() })
            .eq("id", id)
            .eq("status", from)
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeRecording(data as RecordingRow) : null;
    });
}

/**
 * Recordings ready for a scheduler tick: status queued or transcribing, and
 * either never scheduled (next_attempt_at null) or their backoff has elapsed.
 * Oldest next_attempt_at first so the most-overdue work runs first.
 * (summarizing is intentionally excluded — it is an in-process step, not a
 * time-gated wait; ready/failed are terminal.)
 */
export async function listDueRecordings(
    db: Db,
    opts: { limit: number },
): Promise<Recording[]> {
    return tolerateMissingSchema("listDueRecordings", [], async () => {
        const nowIso = new Date().toISOString();
        const { data, error } = await db
            .from("recordings")
            .select("*")
            .in("status", [...DUE_RECORDING_STATUSES])
            .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
            .order("next_attempt_at", { ascending: true })
            .limit(Math.max(1, Math.min(opts.limit, 100)));
        if (error) throw error;
        return ((data as RecordingRow[] | null) ?? []).map(serializeRecording);
    });
}

/**
 * Record a step failure with backoff. Increments retry_count; when that would
 * exceed maxRetries the recording moves to terminal 'failed' with the error
 * stored, otherwise the current status is KEPT and next_attempt_at is pushed
 * delayMs into the future (so listDueRecordings re-claims it later). Returns the
 * updated row (null when the recording was absent / the schema is missing). The
 * read degrades via getRecordingAny, so a missing row short-circuits the write.
 */
export async function scheduleRetry(
    db: Db,
    id: string,
    input: { error: string; delayMs: number; maxRetries: number },
): Promise<Recording | null> {
    const current = await getRecordingAny(db, id);
    if (!current) return null;
    const retryCount = current.retry_count + 1;
    if (retryCount > input.maxRetries) {
        return updateRecording(db, id, {
            status: "failed",
            error: input.error,
            retry_count: retryCount,
        });
    }
    return updateRecording(db, id, {
        error: input.error,
        retry_count: retryCount,
        next_attempt_at: new Date(Date.now() + input.delayMs).toISOString(),
    });
}

/**
 * Recovery sweep: any recording sitting in a working status (transcribing /
 * summarizing) whose updated_at is older than the cutoff was abandoned by a
 * dead worker (every live step bumps updated_at) — put it back to 'queued', due
 * now. Does NOT touch retry_count: a crash is not a failed attempt. Returns how
 * many rows were recovered.
 */
export async function markStalledRecordingsQueued(
    db: Db,
    opts: { olderThanMs: number },
): Promise<number> {
    return tolerateMissingSchema("markStalledRecordingsQueued", 0, async () => {
        const nowIso = new Date().toISOString();
        const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
        const { data, error } = await db
            .from("recordings")
            .update({
                status: "queued",
                next_attempt_at: nowIso,
                updated_at: nowIso,
            })
            .in("status", [...WORKING_RECORDING_STATUSES])
            .lt("updated_at", cutoff)
            .select("id");
        if (error) throw error;
        return ((data as { id: string }[] | null) ?? []).length;
    });
}

/**
 * Pure decision under acquireRecordingsLease: is the lease row takeable by
 * `instanceId` at `nowMs`? Own lease → always renewable; foreign lease → only
 * once expired. A missing/unparseable expiry counts as free so a malformed row
 * can never wedge the scheduler forever.
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
 * Take (or renew) the singleton recordings-scheduler lease for ttlMs. Returns
 * false when another live instance holds it. Two-step without transactions:
 * 1. No lease row yet → insert; losing the insert race (unique key) → false.
 * 2. Row exists and is claimable → conditional UPDATE guarded by
 *    updated_at-equality (CAS): if anything moved the row between our read and
 *    write, the WHERE matches nothing and we lost.
 * Tolerates a missing schema (returns false → the scheduler skips the tick).
 */
export async function acquireRecordingsLease(
    db: Db,
    instanceId: string,
    ttlMs: number,
): Promise<boolean> {
    return tolerateMissingSchema("acquireRecordingsLease", false, async () => {
        const nowMs = Date.now();
        const { data, error } = await db
            .from("recordings_state")
            .select("claimed_by, claimed_until, updated_at")
            .eq("key", RECORDINGS_LEASE_KEY)
            .maybeSingle();
        if (error) throw error;
        const row = data as {
            claimed_by: string | null;
            claimed_until: string | null;
            updated_at: string;
        } | null;

        const claimedUntil = new Date(nowMs + ttlMs).toISOString();
        if (!row) {
            const { error: insertError } = await db
                .from("recordings_state")
                .insert({
                    key: RECORDINGS_LEASE_KEY,
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
            .from("recordings_state")
            .update({
                claimed_by: instanceId,
                claimed_until: claimedUntil,
                updated_at: new Date(nowMs).toISOString(),
            })
            .eq("key", RECORDINGS_LEASE_KEY)
            .eq("updated_at", row.updated_at)
            .select("key")
            .maybeSingle();
        if (updateError) throw updateError;
        return claimed != null;
    });
}

/**
 * Exponential backoff for a failed pipeline step: 2^retryCount × 5s, capped at
 * 5 minutes. retryCount is clamped to [0, 20] so a negative never underflows
 * and a large value never overflows the shift (mirror of automation's
 * backoffDelayMs, with a shorter base/cap tuned for the transcription poll).
 */
export function backoffDelayMs(retryCount: number): number {
    const capped = Math.min(Math.max(retryCount, 0), 20);
    return Math.min(2 ** capped * 5_000, 5 * 60_000);
}
