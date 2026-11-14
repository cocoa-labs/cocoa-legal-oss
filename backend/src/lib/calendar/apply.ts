// backend/src/lib/calendar/apply.ts
//
// The calendar analogue of email/send.ts's sendEmailNow: the single path that
// commits a drafted calendar_writes row to Google. Outward-facing writes (an
// event WITH attendees → invitations) are drafted first, approved via the
// agent-operations rails, then applied here; internal (no-attendee) writes are
// drafted + applied in one call. Every applied write records enough to be
// undone. Idempotent: applyCalendarWriteNow is a no-op (returns the row) when it
// is not pending_approval, and the conditional-UPDATE claim stops two concurrent
// approvals from both writing to Google.
import type { createServerSupabase } from "../supabase";
import {
    createAgentOperation,
    failAgentOperation,
    updateAgentOperation,
    type AgentOperation,
    type OperationInverse,
} from "../operations";
import { getCalendarConnector } from "../connectors/registry";
import {
    ConnectorNotConfiguredError,
    type CalendarConnector,
    type CalendarEvent,
    type EventInput,
} from "../connectors/types";
import {
    cancelPendingCalendarWrite,
    claimCalendarWriteForApply,
    createCalendarWrite,
    getCalendarWrite,
    getFirmCalendarId,
    getEventMeta,
    markCalendarWriteApplied,
    markCalendarWriteFailed,
    markCalendarWriteUndone,
    setFirmCalendarId,
    upsertEventMeta,
} from "./store";
import type {
    CalendarWrite,
    CalendarWriteOpKind,
    SendUpdatesMode,
} from "./types";
import { assertBetaRecipientsAllowed } from "../betaPolicy";
import { recordAuditEvent } from "../audit";

type Db = ReturnType<typeof createServerSupabase>;

export type CalendarSource = "primary" | "firm";

/**
 * Resolve a "primary" | "firm" source to a real Google calendar id. The firm
 * calendar is find-or-created under the agent mailbox on first use and its id
 * cached in calendar_sync_state. Shared by the routes and the agent tools so the
 * client-facing "primary"/"firm" discriminator never leaks a raw calendar id.
 */
export async function resolveCalendarId(
    db: Db,
    source: CalendarSource,
    opts: { connector?: CalendarConnector } = {},
): Promise<string> {
    if (source === "primary") return "primary";
    const connector = opts.connector ?? getCalendarConnector();
    let id = await getFirmCalendarId(db);
    if (!id) {
        id = await connector.ensureFirmCalendar(
            process.env.CALENDAR_FIRM_NAME || "Cocoa Legal",
        );
        if (id) await setFirmCalendarId(db, id);
    }
    return id || "primary";
}

/** Tool name recorded on the agent_operation for a given op kind. */
function toolNameFor(opKind: CalendarWriteOpKind): string {
    return opKind === "create"
        ? "create_event"
        : opKind === "update"
          ? "update_event"
          : "delete_event";
}

/** The undo/inverse operation for a given op kind. */
function inverseFor(opKind: CalendarWriteOpKind): OperationInverse {
    return opKind === "create"
        ? "cancel_calendar_event"
        : "restore_calendar_event";
}

/** Rebuild an EventInput from a captured snapshot (used to restore on undo). */
function snapshotToInput(e: CalendarEvent): EventInput {
    return {
        summary: e.summary,
        description: e.description ?? undefined,
        location: e.location ?? undefined,
        start: e.start,
        end: e.end,
        attendees: e.attendees.map((a) => ({
            email: a.email,
            optional: a.optional,
        })),
        recurrence: e.recurrence,
        timeZone: e.start.timeZone ?? undefined,
    };
}

/**
 * Draft a calendar mutation: capture a pre-change snapshot (for update/delete),
 * open the audit operation, and persist the pending calendar_writes row. Shared
 * by the outward-facing path (requiresApproval:true — the client approves later)
 * and the internal path (requiresApproval:false — applied immediately). The row
 * is always created status `pending_approval` so applyCalendarWriteNow's claim
 * mutex governs both.
 */
export async function draftCalendarWrite(
    db: Db,
    input: {
        userId: string;
        orgId?: string | null;
        matterId?: string | null;
        projectId?: string | null;
        chatId?: string | null;
        chatMessageId?: string | null;
        calendarId: string;
        opKind: CalendarWriteOpKind;
        targetEventId?: string | null;
        eventInput: Partial<EventInput>;
        sendUpdates: SendUpdatesMode;
        requiresApproval: boolean;
    },
    opts: { connector?: CalendarConnector } = {},
): Promise<{ write: CalendarWrite | null; operation: AgentOperation | null }> {
    const connector = opts.connector ?? getCalendarConnector();

    // Capture the pre-change event so update/delete can be undone. Best-effort:
    // if the connector is unconfigured or the event is gone, proceed without a
    // snapshot (undo of that write just won't be available).
    let priorSnapshot: CalendarEvent | null = null;
    if (
        (input.opKind === "update" || input.opKind === "delete") &&
        input.targetEventId
    ) {
        try {
            priorSnapshot = await connector.getEvent(
                input.calendarId,
                input.targetEventId,
            );
        } catch {
            priorSnapshot = null;
        }
    }

    const operation = await createAgentOperation({
        db,
        userId: input.userId,
        orgId: input.orgId ?? null,
        matterId: input.matterId ?? null,
        projectId: input.projectId ?? null,
        chatId: input.chatId ?? null,
        chatMessageId: input.chatMessageId ?? null,
        toolName: toolNameFor(input.opKind),
        actionType: input.opKind,
        mutating: true,
        requiresApproval: input.requiresApproval,
        arguments: {
            calendar_id: input.calendarId,
            op_kind: input.opKind,
            target_event_id: input.targetEventId ?? null,
            event_input: input.eventInput,
        },
        inverseOperation: inverseFor(input.opKind),
    });

    const write = await createCalendarWrite(db, {
        userId: input.userId,
        orgId: input.orgId ?? null,
        matterId: input.matterId ?? null,
        projectId: input.projectId ?? null,
        chatId: input.chatId ?? null,
        agentOperationId: operation?.id ?? null,
        calendarId: input.calendarId,
        opKind: input.opKind,
        targetEventId: input.targetEventId ?? null,
        requiresApproval: input.requiresApproval,
        status: "pending_approval",
        eventInput: input.eventInput,
        priorSnapshot,
        sendUpdates: input.sendUpdates,
    });

    return { write, operation };
}

/**
 * Apply a pending calendar write to Google, threading the row's sendUpdates
 * (invitations/cancellations) and reconciling the operation. Marks the write
 * applied (or failed) and returns it. Throws on failure (after marking failed)
 * so the caller can map ConnectorNotConfiguredError → 503. Idempotent: returns
 * the row unchanged when it is not pending_approval.
 */
export async function applyCalendarWriteNow(
    db: Db,
    writeId: string,
    opts: { approvedBy: string; connector?: CalendarConnector },
): Promise<CalendarWrite> {
    const write = await getCalendarWrite(db, writeId);
    if (!write) throw new Error("Calendar write not found");
    if (write.status !== "pending_approval") return write; // fast-path no-op

    if (write.send_updates !== "none") {
        await assertBetaRecipientsAllowed(db, {
            orgId: write.org_id,
            projectId: write.project_id,
            userId: write.user_id,
            recipients: (write.event_input.attendees ?? []).map(
                (attendee) => attendee.email,
            ),
        });
    }

    // Atomically claim (pending_approval → applying) so two concurrent approvals
    // can't both write to Google. Lost the claim → another applier has it.
    const claimed = await claimCalendarWriteForApply(db, write.id);
    if (!claimed) return (await getCalendarWrite(db, writeId)) ?? write;

    const connector = opts.connector ?? getCalendarConnector();
    try {
        let resultEventId: string | null = null;
        if (write.op_kind === "create") {
            const created = await connector.createEvent(
                write.calendar_id,
                write.event_input as EventInput,
                { sendUpdates: write.send_updates },
            );
            resultEventId = created.id;
        } else if (write.op_kind === "update") {
            if (!write.target_event_id)
                throw new Error("Update is missing the target event id.");
            const updated = await connector.updateEvent(
                write.calendar_id,
                write.target_event_id,
                write.event_input,
                { sendUpdates: write.send_updates },
            );
            resultEventId = updated.id || write.target_event_id;
        } else {
            if (!write.target_event_id)
                throw new Error("Delete is missing the target event id.");
            await connector.deleteEvent(write.calendar_id, write.target_event_id, {
                sendUpdates: write.send_updates,
            });
            resultEventId = null;
        }

        const applied = await markCalendarWriteApplied(db, write.id, {
            resultEventId,
        });
        if (resultEventId && write.project_id) {
            const existingMeta = await getEventMeta(
                db,
                write.calendar_id,
                resultEventId,
            );
            if (!existingMeta) {
                await upsertEventMeta(db, {
                    calendarId: write.calendar_id,
                    googleEventId: resultEventId,
                    createdByUserId: opts.approvedBy,
                    matterId: write.matter_id,
                    projectId: write.project_id,
                });
            }
        }
        await updateAgentOperation(db, write.agent_operation_id, {
            status: "succeeded",
            approvalStatus: "approved",
            approvedByUserId: opts.approvedBy,
            completed: true,
            metadata: { event_id: resultEventId, calendar_id: write.calendar_id },
        });
        await recordAuditEvent(db, {
            orgId: write.org_id,
            matterId: write.matter_id,
            projectId: write.project_id,
            actorUserId: opts.approvedBy,
            eventType: `calendar.${write.op_kind}_applied`,
            targetType: "calendar_write",
            targetId: write.id,
        });
        return applied ?? { ...write, status: "applied", result_event_id: resultEventId };
    } catch (err) {
        const message =
            err instanceof Error ? err.message : "Failed to apply calendar change";
        await markCalendarWriteFailed(db, write.id, message);
        // Mirror sendEmailNow: a not-configured connector marks the write failed
        // but does NOT mark the operation failed (it's a config gap, not a real
        // failure — the caller maps it to 503).
        if (!(err instanceof ConnectorNotConfiguredError)) {
            await updateAgentOperation(db, write.agent_operation_id, {
                status: "failed",
                completed: true,
                errors: [{ message }],
            });
        }
        throw err;
    }
}

/**
 * Draft + immediately apply a no-attendee (internal) calendar write, returning
 * the applied row and the resulting event. sendUpdates is forced to "none" — a
 * private event never emails anyone.
 */
export async function executeInternalCalendarWrite(
    db: Db,
    input: {
        userId: string;
        orgId?: string | null;
        matterId?: string | null;
        projectId?: string | null;
        chatId?: string | null;
        chatMessageId?: string | null;
        calendarId: string;
        opKind: CalendarWriteOpKind;
        targetEventId?: string | null;
        eventInput: Partial<EventInput>;
    },
    opts: { connector?: CalendarConnector } = {},
): Promise<{ write: CalendarWrite | null; event: CalendarEvent | null }> {
    const connector = opts.connector ?? getCalendarConnector();
    const { write } = await draftCalendarWrite(
        db,
        { ...input, sendUpdates: "none", requiresApproval: false },
        { connector },
    );
    if (!write) return { write: null, event: null };

    const applied = await applyCalendarWriteNow(db, write.id, {
        approvedBy: input.userId,
        connector,
    });
    const event = applied.result_event_id
        ? await connector.getEvent(input.calendarId, applied.result_event_id)
        : null;
    return { write: applied, event };
}

/**
 * Reverse an applied calendar write: delete a created event, or restore the
 * captured pre-change snapshot for an update/delete. Records a child undo
 * operation for the audit trail and marks the original write `undone`.
 */
export async function undoCalendarWriteNow(
    db: Db,
    writeId: string,
    opts: { userId: string; connector?: CalendarConnector },
): Promise<CalendarWrite> {
    const write = await getCalendarWrite(db, writeId);
    if (!write) throw new Error("Calendar write not found");
    if (write.status !== "applied") return write; // only an applied write can be undone

    const connector = opts.connector ?? getCalendarConnector();
    const sendUpdates = write.send_updates;

    const undoOp = await createAgentOperation({
        db,
        userId: opts.userId,
        orgId: write.org_id,
        matterId: write.matter_id,
        projectId: write.project_id,
        chatId: write.chat_id,
        toolName: "undo_calendar_event",
        actionType: "undo",
        status: "running",
        approvalStatus: "approved",
        mutating: true,
        requiresApproval: false,
        arguments: { calendar_write_id: write.id },
        metadata: { inverse_of: write.agent_operation_id },
        parentOperationId: write.agent_operation_id,
    });

    try {
        if (write.op_kind === "create") {
            if (!write.result_event_id)
                throw new Error("Nothing to undo — the event was never created.");
            await connector.deleteEvent(write.calendar_id, write.result_event_id, {
                sendUpdates,
            });
        } else if (write.op_kind === "update") {
            if (!write.prior_snapshot || !write.target_event_id)
                throw new Error("This update cannot be undone — no prior state was captured.");
            await connector.updateEvent(
                write.calendar_id,
                write.target_event_id,
                snapshotToInput(write.prior_snapshot),
                { sendUpdates },
            );
        } else {
            if (!write.prior_snapshot)
                throw new Error("This deletion cannot be undone — no prior state was captured.");
            await connector.createEvent(
                write.calendar_id,
                snapshotToInput(write.prior_snapshot),
                { sendUpdates },
            );
        }

        await markCalendarWriteUndone(db, write.id);
        await updateAgentOperation(db, undoOp?.id, {
            status: "succeeded",
            completed: true,
        });
        return (await getCalendarWrite(db, write.id)) ?? {
            ...write,
            status: "undone",
        };
    } catch (err) {
        await failAgentOperation(db, undoOp?.id, err).catch(() => {});
        throw err;
    }
}

/**
 * Cancel a still-pending calendar write (before it is applied). Reconciles the
 * operation to cancelled. Returns the cancelled write, or null when it was not
 * pending (already applied/failed/cancelled) — nothing is mutated.
 */
export async function cancelCalendarWriteNow(
    db: Db,
    writeId: string,
): Promise<CalendarWrite | null> {
    const cancelled = await cancelPendingCalendarWrite(db, writeId);
    if (cancelled) {
        await updateAgentOperation(db, cancelled.agent_operation_id, {
            status: "cancelled",
            approvalStatus: "rejected",
            completed: true,
        });
    }
    return cancelled;
}
