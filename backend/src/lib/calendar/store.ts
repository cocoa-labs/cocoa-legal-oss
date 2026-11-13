// backend/src/lib/calendar/store.ts
//
// All DB access for the app-side calendar tables (migration 026). Google owns
// event content; this persists the drafted-mutation rows the approval + undo
// flow needs, the event↔matter/recording links + deadline metadata, and the
// firm calendar id / worker lease. Mirrors email/store.ts: serializers,
// tolerateMissingSchema graceful degradation, and conditional-UPDATE-as-mutex
// status transitions.
import type { createServerSupabase } from "../supabase";
import { isLeaseClaimable } from "../recordings/store";
import type { CalendarEvent, EventInput } from "../connectors/types";
import type {
    CalendarEventMeta,
    CalendarWrite,
    CalendarWriteOpKind,
    CalendarWriteStatus,
    DeadlineType,
    SendUpdatesMode,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

interface CalendarWriteRow {
    id: string;
    user_id: string;
    org_id: string | null;
    matter_id: string | null;
    project_id: string | null;
    chat_id: string | null;
    agent_operation_id: string | null;
    calendar_id: string;
    op_kind: string;
    target_event_id: string | null;
    requires_approval: boolean | null;
    status: string;
    event_input: Partial<EventInput> | null;
    prior_snapshot: CalendarEvent | null;
    result_event_id: string | null;
    send_updates: string | null;
    error: string | null;
    applied_at: string | null;
    created_at: string;
    updated_at: string;
}

function serializeWrite(row: CalendarWriteRow): CalendarWrite {
    return {
        id: row.id,
        user_id: row.user_id,
        org_id: row.org_id ?? null,
        matter_id: row.matter_id ?? null,
        project_id: row.project_id ?? null,
        chat_id: row.chat_id ?? null,
        agent_operation_id: row.agent_operation_id ?? null,
        calendar_id: row.calendar_id,
        op_kind: row.op_kind as CalendarWriteOpKind,
        target_event_id: row.target_event_id ?? null,
        requires_approval: Boolean(row.requires_approval),
        status: row.status as CalendarWriteStatus,
        event_input: row.event_input ?? {},
        prior_snapshot: row.prior_snapshot ?? null,
        result_event_id: row.result_event_id ?? null,
        send_updates: (row.send_updates as SendUpdatesMode) ?? "none",
        error: row.error ?? null,
        applied_at: row.applied_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

interface CalendarEventMetaRow {
    id: string;
    calendar_id: string;
    google_event_id: string;
    matter_id: string | null;
    project_id: string | null;
    recording_id: string | null;
    deadline_type: string | null;
    deadline_at: string | null;
    reminder_lead_days: number | null;
    reminder_sent_at: string | null;
    created_by_user_id: string;
    created_at: string;
    updated_at: string;
}

function serializeMeta(row: CalendarEventMetaRow): CalendarEventMeta {
    return {
        id: row.id,
        calendar_id: row.calendar_id,
        google_event_id: row.google_event_id,
        matter_id: row.matter_id ?? null,
        project_id: row.project_id ?? null,
        recording_id: row.recording_id ?? null,
        deadline_type: (row.deadline_type as DeadlineType | null) ?? null,
        deadline_at: row.deadline_at ?? null,
        reminder_lead_days: row.reminder_lead_days ?? null,
        reminder_sent_at: row.reminder_sent_at ?? null,
        created_by_user_id: row.created_by_user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

const MISSING_SCHEMA_CODES = new Set(["42P01", "PGRST205", "PGRST204", "42703"]);

/** True when the error means migration 026 has not been applied yet. */
export function isMissingCalendarSchema(error: unknown): boolean {
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
        if (isMissingCalendarSchema(error)) {
            if (process.env.NODE_ENV !== "production") {
                console.warn(
                    `[calendar] ${label}: schema missing, returning fallback`,
                    error,
                );
            }
            return fallback;
        }
        throw error;
    }
}

export async function createCalendarWrite(
    db: Db,
    input: {
        userId: string;
        orgId?: string | null;
        matterId?: string | null;
        projectId?: string | null;
        chatId?: string | null;
        agentOperationId?: string | null;
        calendarId: string;
        opKind: CalendarWriteOpKind;
        targetEventId?: string | null;
        requiresApproval: boolean;
        status: CalendarWriteStatus;
        eventInput: Partial<EventInput>;
        priorSnapshot?: CalendarEvent | null;
        sendUpdates: SendUpdatesMode;
    },
): Promise<CalendarWrite | null> {
    return tolerateMissingSchema("createCalendarWrite", null, async () => {
        const { data, error } = await db
            .from("calendar_writes")
            .insert({
                user_id: input.userId,
                org_id: input.orgId ?? null,
                matter_id: input.matterId ?? null,
                project_id: input.projectId ?? null,
                chat_id: input.chatId ?? null,
                agent_operation_id: input.agentOperationId ?? null,
                calendar_id: input.calendarId,
                op_kind: input.opKind,
                target_event_id: input.targetEventId ?? null,
                requires_approval: input.requiresApproval,
                status: input.status,
                event_input: input.eventInput,
                prior_snapshot: input.priorSnapshot ?? null,
                send_updates: input.sendUpdates,
            })
            .select("*")
            .single();
        if (error) throw error;
        return serializeWrite(data as CalendarWriteRow);
    });
}

export async function getCalendarWrite(
    db: Db,
    id: string,
): Promise<CalendarWrite | null> {
    return tolerateMissingSchema("getCalendarWrite", null, async () => {
        const { data, error } = await db
            .from("calendar_writes")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        return serializeWrite(data as CalendarWriteRow);
    });
}

/**
 * The calendar write drafted for a given agent operation, if any. Used by the
 * operations approval route to apply when a reloaded calendar card is approved
 * via /operations/:id/approve (the card persists an operation_created event, so
 * approval comes back keyed by operation id, not write id).
 */
export async function getCalendarWriteByOperationId(
    db: Db,
    operationId: string,
): Promise<CalendarWrite | null> {
    if (!operationId) return null;
    return tolerateMissingSchema(
        "getCalendarWriteByOperationId",
        null,
        async () => {
            const { data, error } = await db
                .from("calendar_writes")
                .select("*")
                .eq("agent_operation_id", operationId)
                .order("created_at", { ascending: false })
                .limit(1);
            if (error) throw error;
            const row = (data as CalendarWriteRow[] | null)?.[0];
            return row ? serializeWrite(row) : null;
        },
    );
}

export async function listCalendarWrites(
    db: Db,
    filters: { userId: string; limit?: number },
): Promise<CalendarWrite[]> {
    return tolerateMissingSchema("listCalendarWrites", [], async () => {
        const { data, error } = await db
            .from("calendar_writes")
            .select("*")
            .eq("user_id", filters.userId)
            .order("created_at", { ascending: false })
            .limit(Math.min(filters.limit ?? 50, 100));
        if (error) throw error;
        return ((data as CalendarWriteRow[] | null) ?? []).map(serializeWrite);
    });
}

/**
 * Atomically claim a pending write for applying: flip pending_approval →
 * applying ONLY if it is still pending_approval, and report whether THIS call
 * won the claim (the claimed row) or lost it (null). The single conditional
 * UPDATE is the mutex that stops two concurrent approvals from both applying the
 * same write to Google. Tolerates a missing schema (returns null → caller
 * no-ops).
 */
export async function claimCalendarWriteForApply(
    db: Db,
    id: string,
): Promise<CalendarWrite | null> {
    return tolerateMissingSchema("claimCalendarWriteForApply", null, async () => {
        const { data, error } = await db
            .from("calendar_writes")
            .update({ status: "applying" })
            .eq("id", id)
            .eq("status", "pending_approval")
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeWrite(data as CalendarWriteRow) : null;
    });
}

export async function markCalendarWriteApplied(
    db: Db,
    id: string,
    result: { resultEventId: string | null },
): Promise<CalendarWrite | null> {
    return tolerateMissingSchema("markCalendarWriteApplied", null, async () => {
        const { data, error } = await db
            .from("calendar_writes")
            .update({
                status: "applied",
                result_event_id: result.resultEventId,
                applied_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select("*")
            .single();
        if (error) throw error;
        return serializeWrite(data as CalendarWriteRow);
    });
}

export async function markCalendarWriteFailed(
    db: Db,
    id: string,
    error: string,
): Promise<void> {
    await tolerateMissingSchema("markCalendarWriteFailed", undefined, async () => {
        const { error: dbError } = await db
            .from("calendar_writes")
            .update({ status: "failed", error })
            .eq("id", id);
        if (dbError) throw dbError;
    });
}

export async function markCalendarWriteUndone(
    db: Db,
    id: string,
): Promise<void> {
    await tolerateMissingSchema("markCalendarWriteUndone", undefined, async () => {
        const { error: dbError } = await db
            .from("calendar_writes")
            .update({ status: "undone" })
            .eq("id", id);
        if (dbError) throw dbError;
    });
}

/**
 * Cancel a write ONLY while it is still pending_approval — the same
 * conditional-UPDATE-as-mutex shape as claimCalendarWriteForApply. Returns the
 * cancelled row, or null when the write was not pending (already applying,
 * applied, failed, cancelled, or undone) — in which case NOTHING is mutated, so
 * an applied write can never be clobbered to `cancelled`.
 */
export async function cancelPendingCalendarWrite(
    db: Db,
    id: string,
): Promise<CalendarWrite | null> {
    return tolerateMissingSchema("cancelPendingCalendarWrite", null, async () => {
        const { data, error } = await db
            .from("calendar_writes")
            .update({ status: "cancelled" })
            .eq("id", id)
            .eq("status", "pending_approval")
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeWrite(data as CalendarWriteRow) : null;
    });
}

// ---------------------------------------------------------------------------
// calendar_sync_state — firm calendar id + worker cursors/lease.
// ---------------------------------------------------------------------------

const FIRM_CALENDAR_KEY = "firm_calendar_id";

export async function getFirmCalendarId(db: Db): Promise<string | null> {
    return tolerateMissingSchema("getFirmCalendarId", null, async () => {
        const { data, error } = await db
            .from("calendar_sync_state")
            .select("value")
            .eq("key", FIRM_CALENDAR_KEY)
            .maybeSingle();
        if (error) throw error;
        const value = (data as { value?: { calendar_id?: string } } | null)
            ?.value;
        return value?.calendar_id ?? null;
    });
}

export async function setFirmCalendarId(
    db: Db,
    calendarId: string,
): Promise<void> {
    await tolerateMissingSchema("setFirmCalendarId", undefined, async () => {
        const { error } = await db.from("calendar_sync_state").upsert(
            {
                key: FIRM_CALENDAR_KEY,
                value: { calendar_id: calendarId },
                updated_at: new Date().toISOString(),
            },
            { onConflict: "key" },
        );
        if (error) throw error;
    });
}

// ---------------------------------------------------------------------------
// calendar_event_meta — event↔matter/recording links + deadline semantics
// (mostly Phase B; the upsert/get are here so apply can attach links).
// ---------------------------------------------------------------------------

export async function upsertEventMeta(
    db: Db,
    input: {
        calendarId: string;
        googleEventId: string;
        createdByUserId: string;
        matterId?: string | null;
        projectId?: string | null;
        recordingId?: string | null;
        deadlineType?: DeadlineType | null;
        deadlineAt?: string | null;
        reminderLeadDays?: number | null;
    },
): Promise<CalendarEventMeta | null> {
    return tolerateMissingSchema("upsertEventMeta", null, async () => {
        const { data, error } = await db
            .from("calendar_event_meta")
            .upsert(
                {
                    calendar_id: input.calendarId,
                    google_event_id: input.googleEventId,
                    created_by_user_id: input.createdByUserId,
                    matter_id: input.matterId ?? null,
                    project_id: input.projectId ?? null,
                    recording_id: input.recordingId ?? null,
                    deadline_type: input.deadlineType ?? null,
                    deadline_at: input.deadlineAt ?? null,
                    reminder_lead_days: input.reminderLeadDays ?? null,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: "calendar_id,google_event_id" },
            )
            .select("*")
            .single();
        if (error) throw error;
        return serializeMeta(data as CalendarEventMetaRow);
    });
}

// ---------------------------------------------------------------------------
// Reminder worker: singleton lease + due-deadline sweep.
// ---------------------------------------------------------------------------

const REMINDER_LEASE_KEY = "reminder_scheduler_lease";
/** Ignore deadlines already more than this far past when reminding. */
const OVERDUE_GRACE_MS = 30 * 86_400_000;

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    if ((error as { code?: string }).code === "23505") return true;
    return /duplicate key|unique constraint/i.test(
        (error as { message?: string }).message ?? "",
    );
}

/**
 * Take (or renew) the singleton reminder-scheduler lease on calendar_sync_state
 * for ttlMs, so exactly one instance sweeps reminders however many are deployed.
 * Same two-step CAS shape as acquireRecordingsLease. Tolerates a missing schema
 * (returns false → the tick is skipped).
 */
export async function acquireCalendarReminderLease(
    db: Db,
    instanceId: string,
    ttlMs: number,
): Promise<boolean> {
    return tolerateMissingSchema("acquireCalendarReminderLease", false, async () => {
        const nowMs = Date.now();
        const { data, error } = await db
            .from("calendar_sync_state")
            .select("claimed_by, claimed_until, updated_at")
            .eq("key", REMINDER_LEASE_KEY)
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
                .from("calendar_sync_state")
                .insert({
                    key: REMINDER_LEASE_KEY,
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
            .from("calendar_sync_state")
            .update({
                claimed_by: instanceId,
                claimed_until: claimedUntil,
                updated_at: new Date(nowMs).toISOString(),
            })
            .eq("key", REMINDER_LEASE_KEY)
            .eq("updated_at", row.updated_at)
            .select("key")
            .maybeSingle();
        if (updateError) throw updateError;
        return claimed != null;
    });
}

/**
 * Deadlines whose lead-time reminder is due and not yet sent: reminder_sent_at
 * is null, deadline_at is set, and now is within [deadline_at - leadDays,
 * deadline_at + grace]. The lead-time comparison is done in JS (Supabase can't
 * express deadline_at - interval*column in a filter). Tolerates a missing schema.
 */
export async function listDueDeadlines(
    db: Db,
    opts: { now?: Date; limit?: number },
): Promise<CalendarEventMeta[]> {
    const nowMs = (opts.now ?? new Date()).getTime();
    return tolerateMissingSchema("listDueDeadlines", [], async () => {
        const { data, error } = await db
            .from("calendar_event_meta")
            .select("*")
            .is("reminder_sent_at", null)
            .not("deadline_at", "is", null)
            .order("deadline_at", { ascending: true })
            .limit(Math.min(opts.limit ?? 50, 200));
        if (error) throw error;
        return ((data as CalendarEventMetaRow[] | null) ?? [])
            .map(serializeMeta)
            .filter((m) => {
                if (!m.deadline_at) return false;
                const dueMs = Date.parse(m.deadline_at);
                if (!Number.isFinite(dueMs)) return false;
                const leadMs = (m.reminder_lead_days ?? 0) * 86_400_000;
                // Due when we've reached the lead window, and the deadline is
                // not ancient (so a long-forgotten deadline doesn't spam).
                return nowMs >= dueMs - leadMs && dueMs >= nowMs - OVERDUE_GRACE_MS;
            });
    });
}

/** Mark a deadline's reminder as sent so it is not reminded again. */
export async function markReminderSent(db: Db, id: string): Promise<void> {
    await tolerateMissingSchema("markReminderSent", undefined, async () => {
        const { error } = await db
            .from("calendar_event_meta")
            .update({ reminder_sent_at: new Date().toISOString() })
            .eq("id", id);
        if (error) throw error;
    });
}

export async function getEventMeta(
    db: Db,
    calendarId: string,
    googleEventId: string,
): Promise<CalendarEventMeta | null> {
    return tolerateMissingSchema("getEventMeta", null, async () => {
        const { data, error } = await db
            .from("calendar_event_meta")
            .select("*")
            .eq("calendar_id", calendarId)
            .eq("google_event_id", googleEventId)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        return serializeMeta(data as CalendarEventMetaRow);
    });
}

/**
 * Batch-fetch the metadata rows for a set of events on one calendar, keyed by
 * google_event_id, so the events listing can enrich each event (matter/recording
 * link, deadline) in a single query rather than N. Tolerates a missing schema
 * (returns an empty map → events render with no metadata, no crash).
 */
export async function getEventMetaMap(
    db: Db,
    calendarId: string,
    googleEventIds: string[],
): Promise<Map<string, CalendarEventMeta>> {
    if (googleEventIds.length === 0) return new Map();
    return tolerateMissingSchema("getEventMetaMap", new Map(), async () => {
        const { data, error } = await db
            .from("calendar_event_meta")
            .select("*")
            .eq("calendar_id", calendarId)
            .in("google_event_id", googleEventIds);
        if (error) throw error;
        const map = new Map<string, CalendarEventMeta>();
        for (const row of (data as CalendarEventMetaRow[] | null) ?? []) {
            map.set(row.google_event_id, serializeMeta(row));
        }
        return map;
    });
}

/** The event metadata linked to a recording, if any — powers the reciprocal
 * "linked meeting" link on the recording detail page. */
export async function getEventMetaByRecording(
    db: Db,
    recordingId: string,
): Promise<CalendarEventMeta | null> {
    if (!recordingId) return null;
    return tolerateMissingSchema("getEventMetaByRecording", null, async () => {
        const { data, error } = await db
            .from("calendar_event_meta")
            .select("*")
            .eq("recording_id", recordingId)
            .limit(1);
        if (error) throw error;
        const row = (data as CalendarEventMetaRow[] | null)?.[0];
        return row ? serializeMeta(row) : null;
    });
}

/** Meta rows linked to a matter (either directly or via a project), newest
 * deadline first — powers the matter's upcoming-events agenda. */
export async function listEventMetaByMatter(
    db: Db,
    matterId: string,
): Promise<CalendarEventMeta[]> {
    return tolerateMissingSchema("listEventMetaByMatter", [], async () => {
        const { data, error } = await db
            .from("calendar_event_meta")
            .select("*")
            .eq("matter_id", matterId);
        if (error) throw error;
        return ((data as CalendarEventMetaRow[] | null) ?? []).map(serializeMeta);
    });
}
