// backend/src/lib/calendar/types.ts
//
// Domain types for the app-side calendar tables (migration 026). Google owns
// event content; these mirror the rows in calendar_writes / calendar_event_meta
// / calendar_sync_state that hold the drafted-mutation + link + deadline
// metadata Google cannot.
import type { CalendarEvent, EventInput } from "../connectors/types";

export type CalendarWriteOpKind = "create" | "update" | "delete";

export type CalendarWriteStatus =
    | "pending_approval"
    | "applying"
    | "applied"
    | "failed"
    | "cancelled"
    | "undone";

export type SendUpdatesMode = "all" | "none";

export type DeadlineType =
    | "court_date"
    | "filing"
    | "statute_of_limitations"
    | "other";

/** A drafted or applied calendar mutation (row in public.calendar_writes). */
export interface CalendarWrite {
    id: string;
    user_id: string;
    org_id: string | null;
    matter_id: string | null;
    project_id: string | null;
    chat_id: string | null;
    agent_operation_id: string | null;
    calendar_id: string;
    op_kind: CalendarWriteOpKind;
    target_event_id: string | null;
    requires_approval: boolean;
    status: CalendarWriteStatus;
    /** The intended EventInput (or a Partial for update). */
    event_input: Partial<EventInput>;
    /** Pre-change event captured for undo of update/delete. */
    prior_snapshot: CalendarEvent | null;
    result_event_id: string | null;
    send_updates: SendUpdatesMode;
    error: string | null;
    applied_at: string | null;
    created_at: string;
    updated_at: string;
}

/** Event ↔ app link + legal-deadline semantics (row in calendar_event_meta). */
export interface CalendarEventMeta {
    id: string;
    calendar_id: string;
    google_event_id: string;
    matter_id: string | null;
    project_id: string | null;
    recording_id: string | null;
    deadline_type: DeadlineType | null;
    deadline_at: string | null;
    reminder_lead_days: number | null;
    reminder_sent_at: string | null;
    created_by_user_id: string;
    created_at: string;
    updated_at: string;
}
