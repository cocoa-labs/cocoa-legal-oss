// backend/src/lib/calendar/tools.ts
//
// Quill's calendar agent tools. Reads live-proxy the connector; writes route by
// attendee presence exactly like send_email — an event WITH attendees is
// outward-facing (prepares an approval card that sends invitations only on
// approval), a private event executes immediately and is undoable. The delegate
// mirrors runRecordingToolCall: one exported, injectable function that
// chatTools.ts dispatches to. The `calendar_pending` event it returns is what
// the frontend EventApprovalCard renders (approved via /operations/:id/approve
// or /calendar/writes/:id/approve).
import type { OpenAIToolSchema } from "../llm/types";
import type { createServerSupabase } from "../supabase";
import { getCalendarConnector } from "../connectors/registry";
import type {
    CalendarConnector,
    CalendarDateTime,
    EventInput,
} from "../connectors/types";
import {
    draftCalendarWrite,
    executeInternalCalendarWrite,
    resolveCalendarId,
    type CalendarSource,
} from "./apply";
import { classifyDeadline } from "./deadlines";
import { getEventMeta, upsertEventMeta } from "./store";
import { getEmail } from "../email/store";
import type { DeadlineType } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

const DEFAULT_TZ = process.env.CALENDAR_DEFAULT_TIMEZONE || "UTC";

/**
 * An approval-gated calendar mutation, persisted so a reload renders the rich
 * EventApprovalCard. create_event / update_event / delete_event with attendees
 * emit this instead of a generic operation_created; the card owns the status.
 */
export type CalendarPendingEvent = {
    type: "calendar_pending";
    write_id: string;
    operation_id: string | null;
    status?: string | null;
    op_kind: "create" | "update" | "delete";
    calendar: CalendarSource;
    title: string;
    start: string;
    end: string;
    location?: string | null;
    attendees: string[];
    add_meet: boolean;
};

export const CALENDAR_TOOL_NAMES: ReadonlySet<string> = new Set([
    "list_events",
    "get_event",
    "create_event",
    "update_event",
    "delete_event",
    "create_deadline",
    "link_event_to_matter",
    "link_event_to_recording",
    "schedule_from_email",
]);

export const CALENDAR_TOOLS: OpenAIToolSchema[] = [
    {
        type: "function",
        function: {
            name: "list_events",
            description:
                "List upcoming events from Quill's calendars (its own 'primary' calendar and the shared 'Cocoa Legal' firm calendar) within a time window. READ-ONLY: nothing is created, changed, or sent. Use it to answer 'what's on my calendar', 'am I free Tuesday', 'what's coming up on the Smith matter', or to find the event the user means before calling get_event / update_event / delete_event. Returns each event's event_id, title, start/end, which calendar it is on, attendee count, whether it has a Google Meet link, and whether it is all-day.",
            parameters: {
                type: "object",
                properties: {
                    time_min: {
                        type: "string",
                        description:
                            "Start of the window as an ISO 8601 timestamp (e.g. '2026-07-17T00:00:00Z'). Defaults to now when omitted.",
                    },
                    time_max: {
                        type: "string",
                        description:
                            "End of the window as an ISO 8601 timestamp. Defaults to ~30 days out when omitted.",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm", "all"],
                        description:
                            "Which calendar(s) to read: 'primary' (Quill's own), 'firm' (the shared Cocoa Legal calendar for court dates/firm deadlines), or 'all' (both, merged). Defaults to 'all'.",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_event",
            description:
                "Read one calendar event's full detail: title, start/end, timezone, location, description, attendees and their response status, the organizer, any Google Meet link, and recurrence. READ-ONLY. Use it after list_events to inspect a specific event before answering about it or changing it.",
            parameters: {
                type: "object",
                properties: {
                    event_id: {
                        type: "string",
                        description: "The event id (from list_events).",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm"],
                        description:
                            "Which calendar the event is on (from list_events). Defaults to 'primary'.",
                    },
                },
                required: ["event_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_event",
            description:
                "Create a calendar event. If you include attendees, this does NOT create it immediately — it prepares the event and the user must review and approve it before invitations are sent (exactly like send_email). A private event with NO attendees is created directly on Quill's calendar. Use this to schedule calls, meetings, deadlines, or blocks of time. When attendees are present you may set add_meet to attach a Google Meet link. After preparing an event that needs approval, briefly say what you set up and that the user can review/approve it from the card — never claim invitations were already sent, and let the card convey the status.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "The event title. Required.",
                    },
                    start: {
                        type: "string",
                        description:
                            "Start time as an ISO 8601 timestamp (e.g. '2026-07-20T10:00:00-07:00'). For an all-day event pass a date 'YYYY-MM-DD' and set all_day true.",
                    },
                    end: {
                        type: "string",
                        description:
                            "End time as an ISO 8601 timestamp (or the exclusive end date for an all-day event). Required.",
                    },
                    all_day: {
                        type: "boolean",
                        description:
                            "True for an all-day event (start/end are dates, not times). Defaults to false.",
                    },
                    time_zone: {
                        type: "string",
                        description:
                            "IANA timezone for a timed event (e.g. 'America/Los_Angeles'). Defaults to the firm timezone.",
                    },
                    location: {
                        type: "string",
                        description: "Optional location or dial-in note.",
                    },
                    description: {
                        type: "string",
                        description: "Optional event description / agenda.",
                    },
                    attendees: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Optional attendee email addresses. When present, the event is approval-gated and invitations are sent on approval.",
                    },
                    add_meet: {
                        type: "boolean",
                        description:
                            "Attach a Google Meet link (only meaningful with attendees). Defaults to false.",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm"],
                        description:
                            "Which calendar to add the event to: 'primary' (Quill's own) or 'firm' (the shared Cocoa Legal calendar, e.g. a firm-wide court date). Defaults to 'primary'.",
                    },
                },
                required: ["title", "start", "end"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "update_event",
            description:
                "Change an existing event (reschedule, retitle, edit location/description/attendees). If the event has attendees, the change is approval-gated and updated invitations go out only on approval (like send_email); a private event is updated directly. Pass only the fields you want to change plus the event_id.",
            parameters: {
                type: "object",
                properties: {
                    event_id: {
                        type: "string",
                        description: "The event id to update (from list_events).",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm"],
                        description:
                            "Which calendar the event is on. Defaults to 'primary'.",
                    },
                    title: { type: "string", description: "New title." },
                    start: {
                        type: "string",
                        description: "New start (ISO 8601 timestamp or date).",
                    },
                    end: {
                        type: "string",
                        description: "New end (ISO 8601 timestamp or date).",
                    },
                    all_day: { type: "boolean", description: "Whether it is all-day." },
                    time_zone: { type: "string", description: "IANA timezone for timed events." },
                    location: { type: "string", description: "New location." },
                    description: { type: "string", description: "New description." },
                    attendees: {
                        type: "array",
                        items: { type: "string" },
                        description: "Replacement attendee list (emails).",
                    },
                    add_meet: {
                        type: "boolean",
                        description: "Attach a Google Meet link.",
                    },
                },
                required: ["event_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "delete_event",
            description:
                "Cancel/delete a calendar event. If the event has attendees, this is approval-gated and cancellation notices go out only on approval; a private event is removed directly (and can be undone). Use this when the user asks to cancel a meeting or clear a block of time.",
            parameters: {
                type: "object",
                properties: {
                    event_id: {
                        type: "string",
                        description: "The event id to delete (from list_events).",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm"],
                        description:
                            "Which calendar the event is on. Defaults to 'primary'.",
                    },
                },
                required: ["event_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "create_deadline",
            description:
                "Record a legal deadline — a court date, filing deadline, statute of limitations, or other due date — as an all-day event on the shared 'Cocoa Legal' firm calendar, flagged as a deadline with a lead-time reminder. Use this instead of create_event when the user is tracking a DEADLINE (e.g. 'add the SOL for the Doe case on March 3', 'filing deadline next Friday'). Quill classifies the deadline type and picks a sensible reminder lead time from the title unless you pass them explicitly. This is a private firm-calendar entry with no attendees, so it is created directly (and is undoable).",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description:
                            "What the deadline is (e.g. 'Statute of limitations — Doe v. Roe', 'Answer due — Acme'). Required.",
                    },
                    date: {
                        type: "string",
                        description:
                            "The due date as 'YYYY-MM-DD'. Required. The deadline is an all-day entry on this date.",
                    },
                    type: {
                        type: "string",
                        enum: [
                            "court_date",
                            "filing",
                            "statute_of_limitations",
                            "other",
                        ],
                        description:
                            "Optional explicit deadline type. Omit to let Quill classify it from the title.",
                    },
                    lead_days: {
                        type: "integer",
                        description:
                            "Optional days before the due date to remind. Omit to use the type's default (statute 30, filing 10, court date 7, other 3).",
                    },
                    matter_id: {
                        type: "string",
                        description:
                            "Optional matter id to link the deadline to — the matter you are already working in, or the matter_id from list_matters when that tool is available to you. Not a case_id from search_cases.",
                    },
                },
                required: ["title", "date"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "link_event_to_matter",
            description:
                "Associate a calendar event with a matter/case so it appears on that matter's upcoming events and can be filtered in the calendar. Use when the user says an event belongs to a matter (e.g. 'this call is for the Smith case'). Use the matter you are already working in; from the main chat, find its id with list_matters (the matter_id field) when that tool is available to you — a case_id from search_cases is a different record and will not link.",
            parameters: {
                type: "object",
                properties: {
                    event_id: { type: "string", description: "The event id (from list_events)." },
                    matter_id: {
                        type: "string",
                        description: "The matter/case id to link. Pass null/empty to unlink.",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm"],
                        description: "Which calendar the event is on. Defaults to 'primary'.",
                    },
                },
                required: ["event_id", "matter_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "link_event_to_recording",
            description:
                "Associate a calendar event with a recording (e.g. the meeting that was recorded) so the two cross-link. Use when a recorded meeting corresponds to a calendar event.",
            parameters: {
                type: "object",
                properties: {
                    event_id: { type: "string", description: "The event id (from list_events)." },
                    recording_id: {
                        type: "string",
                        description: "The recording id (from list_recordings).",
                    },
                    calendar: {
                        type: "string",
                        enum: ["primary", "firm"],
                        description: "Which calendar the event is on. Defaults to 'primary'.",
                    },
                },
                required: ["event_id", "recording_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "schedule_from_email",
            description:
                "Propose a meeting from an inbound email thread. Given the email's id and the meeting details you extracted from it, this prepares an approval-gated event with the email's sender automatically added as an attendee (plus any others you list), linked to the email's conversation. Because it has attendees, it is an approval card — invitations go out only on approval, exactly like send_email. Use this when a correspondent proposes a call/meeting in an email and the user wants it on the calendar.",
            parameters: {
                type: "object",
                properties: {
                    email_id: {
                        type: "string",
                        description:
                            "The inbound email id (from read_inbox / read_email) the meeting is proposed in.",
                    },
                    title: { type: "string", description: "The meeting title." },
                    start: {
                        type: "string",
                        description: "Start time as an ISO 8601 timestamp.",
                    },
                    end: {
                        type: "string",
                        description: "End time as an ISO 8601 timestamp.",
                    },
                    attendees: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Additional attendee emails beyond the email's sender (who is added automatically).",
                    },
                    add_meet: {
                        type: "boolean",
                        description: "Attach a Google Meet link. Defaults to false.",
                    },
                    location: { type: "string", description: "Optional location." },
                },
                required: ["email_id", "title", "start", "end"],
            },
        },
    },
];

/** Extract the bare address from a From header like '"Jane" <jane@x.com>'. */
function extractEmailAddress(header: string): string | null {
    const angle = header.match(/<([^>]+)>/);
    const candidate = (angle ? angle[1] : header).trim();
    return /.+@.+\..+/.test(candidate) ? candidate : null;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
    return typeof args[key] === "string" && (args[key] as string).trim()
        ? (args[key] as string).trim()
        : undefined;
}

function sourceArg(args: Record<string, unknown>): CalendarSource {
    return args.calendar === "firm" ? "firm" : "primary";
}

function toCalDateTime(
    value: string,
    allDay: boolean,
    tz: string,
): CalendarDateTime {
    if (allDay) return { date: value.slice(0, 10) };
    return { dateTime: value, timeZone: tz };
}

/** The exclusive end date (next day) for a single all-day event on `date`. */
function nextDay(date: string): string {
    const [y, m, d] = date.slice(0, 10).split("-").map((n) => Number.parseInt(n, 10));
    const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + 1));
    return dt.toISOString().slice(0, 10);
}

/** Attendee emails from an args.attendees array (strings). */
function attendeeEmails(args: Record<string, unknown>): string[] {
    const raw = Array.isArray(args.attendees) ? args.attendees : [];
    return raw
        .map((a) => (typeof a === "string" ? a.trim() : ""))
        .filter(Boolean);
}

/** Build the EventInput a create/update tool call describes. */
function buildInput(args: Record<string, unknown>): EventInput {
    const allDay = args.all_day === true;
    const tz = str(args, "time_zone") ?? DEFAULT_TZ;
    const emails = attendeeEmails(args);
    const startRaw = str(args, "start");
    const endRaw = str(args, "end");
    return {
        summary: str(args, "title") ?? "",
        description: str(args, "description"),
        location: str(args, "location"),
        start: startRaw ? toCalDateTime(startRaw, allDay, tz) : {},
        end: endRaw ? toCalDateTime(endRaw, allDay, tz) : {},
        attendees: emails.map((email) => ({ email })),
        addMeet: args.add_meet === true,
        timeZone: tz,
    };
}

function pendingEvent(
    write: { id: string; agent_operation_id: string | null; status: string },
    opKind: "create" | "update" | "delete",
    source: CalendarSource,
    input: EventInput,
    emails: string[],
): CalendarPendingEvent {
    return {
        type: "calendar_pending",
        write_id: write.id,
        operation_id: write.agent_operation_id,
        status: write.status,
        op_kind: opKind,
        calendar: source,
        title: input.summary,
        start: input.start.dateTime ?? input.start.date ?? "",
        end: input.end.dateTime ?? input.end.date ?? "",
        location: input.location ?? null,
        attendees: emails,
        add_meet: Boolean(input.addMeet),
    };
}

/**
 * Returned when an internal write can't be persisted because the calendar tables
 * (migration 026) aren't applied — so Quill reports an honest failure instead of
 * falsely claiming "Done". Mirrors the "calendar is not connected yet"
 * degradation and the attendee path's own not-persisted guard.
 */
const SETUP_INCOMPLETE =
    "Couldn't save the change — Quill's calendar storage isn't finished setting up (migration 026 hasn't been applied). Ask an administrator to apply it, then try again.";

/**
 * Execute one calendar tool call. Reads hit the connector directly; writes
 * compute hasAttendees and either execute immediately (private) or draft an
 * approval-gated operation (attendees), returning a `calendar_pending` event the
 * caller emits + records exactly as send_email's email_pending.
 */
export async function runCalendarToolCall(params: {
    name: string;
    args: Record<string, unknown>;
    db: Db;
    userId: string;
    userEmail?: string | null;
    chatId?: string | null;
    chatMessageId?: string | null;
    projectId?: string | null;
    connector?: CalendarConnector;
}): Promise<{
    toolResult: Record<string, unknown>;
    pendingCalendarWrite?: CalendarPendingEvent;
}> {
    const { name, args, db, userId } = params;
    const connector = params.connector ?? getCalendarConnector();

    if (!connector.isConfigured()) {
        return {
            toolResult: {
                ok: false,
                error: "Quill's calendar is not connected yet. Ask an administrator to finish the Google Calendar setup.",
            },
        };
    }

    try {
        if (name === "list_events") {
            const which =
                args.calendar === "firm"
                    ? (["firm"] as CalendarSource[])
                    : args.calendar === "primary"
                      ? (["primary"] as CalendarSource[])
                      : (["primary", "firm"] as CalendarSource[]);
            // Honor the tool's documented contract: default the window to
            // [now, now + ~30d] when the model omits it, so "what's coming up?"
            // works even before the model has reasoned about the date. Computed
            // once so both calendars share the same window.
            const timeMinIso = str(args, "time_min") ?? new Date().toISOString();
            const baseMs = Date.parse(timeMinIso);
            const timeMaxIso =
                str(args, "time_max") ??
                new Date(
                    (Number.isNaN(baseMs) ? Date.now() : baseMs) +
                        30 * 24 * 60 * 60 * 1000,
                ).toISOString();
            const events: Record<string, unknown>[] = [];
            for (const source of which) {
                const calendarId = await resolveCalendarId(db, source, { connector });
                const res = await connector.listEvents({
                    calendarId,
                    timeMin: timeMinIso,
                    timeMax: timeMaxIso,
                    singleEvents: true,
                });
                for (const e of res.events) {
                    events.push({
                        event_id: e.id,
                        title: e.summary,
                        calendar: source,
                        start: e.start.dateTime ?? e.start.date ?? null,
                        end: e.end.dateTime ?? e.end.date ?? null,
                        all_day: e.allDay,
                        attendee_count: e.attendees.length,
                        has_meet: Boolean(e.conference?.uri ?? e.hangoutLink),
                    });
                }
            }
            return { toolResult: { ok: true, count: events.length, events } };
        }

        if (name === "get_event") {
            const eventId = str(args, "event_id");
            if (!eventId)
                return {
                    toolResult: { ok: false, error: "get_event requires an event_id." },
                };
            const source = sourceArg(args);
            const calendarId = await resolveCalendarId(db, source, { connector });
            const e = await connector.getEvent(calendarId, eventId);
            if (!e)
                return { toolResult: { ok: false, error: "That event was not found." } };
            return {
                toolResult: {
                    ok: true,
                    event: {
                        event_id: e.id,
                        title: e.summary,
                        calendar: source,
                        start: e.start,
                        end: e.end,
                        all_day: e.allDay,
                        location: e.location,
                        description: e.description,
                        attendees: e.attendees.map((a) => ({
                            email: a.email,
                            response: a.responseStatus,
                        })),
                        organizer: e.organizer?.email ?? null,
                        meet_link: e.conference?.uri ?? e.hangoutLink ?? null,
                        recurrence: e.recurrence,
                    },
                },
            };
        }

        if (name === "create_event") {
            const input = buildInput(args);
            if (!input.summary)
                return { toolResult: { ok: false, error: "create_event requires a title." } };
            const source = sourceArg(args);
            const calendarId = await resolveCalendarId(db, source, { connector });
            const emails = attendeeEmails(args);

            if (emails.length > 0) {
                const { write } = await draftCalendarWrite(
                    db,
                    {
                        userId,
                        chatId: params.chatId ?? null,
                        chatMessageId: params.chatMessageId ?? null,
                        projectId: params.projectId ?? null,
                        calendarId,
                        opKind: "create",
                        eventInput: input,
                        sendUpdates: "all",
                        requiresApproval: true,
                    },
                    { connector },
                );
                if (!write)
                    return {
                        toolResult: {
                            ok: false,
                            error: "Could not prepare the event (calendar tables not set up yet).",
                        },
                    };
                return {
                    toolResult: {
                        ok: true,
                        status: "pending_approval",
                        message:
                            "Prepared the event as an approval card. Invitations to the attendees are sent only when the user approves it there. Summarize what you set up and point the user to the card — do NOT claim it is scheduled or that invitations went out; the card owns the status.",
                    },
                    pendingCalendarWrite: pendingEvent(write, "create", source, input, emails),
                };
            }

            const { write, event } = await executeInternalCalendarWrite(
                db,
                {
                    userId,
                    chatId: params.chatId ?? null,
                    projectId: params.projectId ?? null,
                    calendarId,
                    opKind: "create",
                    eventInput: input,
                },
                { connector },
            );
            if (!write)
                return { toolResult: { ok: false, error: SETUP_INCOMPLETE } };
            return {
                toolResult: {
                    ok: true,
                    event_id: event?.id ?? null,
                    message: "Added the event to the calendar (no attendees, so no invitations were sent).",
                },
            };
        }

        if (name === "update_event") {
            const eventId = str(args, "event_id");
            if (!eventId)
                return { toolResult: { ok: false, error: "update_event requires an event_id." } };
            const source = sourceArg(args);
            const calendarId = await resolveCalendarId(db, source, { connector });
            const existing = await connector.getEvent(calendarId, eventId);
            if (!existing)
                return { toolResult: { ok: false, error: "That event was not found." } };
            const input = buildInput({ ...args, title: args.title ?? existing.summary });
            const emails = attendeeEmails(args);
            const hasAttendees = emails.length > 0 || existing.attendees.length > 0;

            if (hasAttendees) {
                const { write } = await draftCalendarWrite(
                    db,
                    {
                        userId,
                        chatId: params.chatId ?? null,
                        chatMessageId: params.chatMessageId ?? null,
                        projectId: params.projectId ?? null,
                        calendarId,
                        opKind: "update",
                        targetEventId: eventId,
                        eventInput: input,
                        sendUpdates: "all",
                        requiresApproval: true,
                    },
                    { connector },
                );
                if (!write)
                    return { toolResult: { ok: false, error: "Could not prepare the change." } };
                return {
                    toolResult: {
                        ok: true,
                        status: "pending_approval",
                        message:
                            "Prepared the change as an approval card. Updated invitations go out only when the user approves it. Do NOT claim it is changed; the card owns the status.",
                    },
                    pendingCalendarWrite: pendingEvent(
                        write,
                        "update",
                        source,
                        input,
                        emails.length > 0 ? emails : existing.attendees.map((a) => a.email),
                    ),
                };
            }

            const { write: updateWrite } = await executeInternalCalendarWrite(
                db,
                {
                    userId,
                    chatId: params.chatId ?? null,
                    projectId: params.projectId ?? null,
                    calendarId,
                    opKind: "update",
                    targetEventId: eventId,
                    eventInput: input,
                },
                { connector },
            );
            if (!updateWrite)
                return { toolResult: { ok: false, error: SETUP_INCOMPLETE } };
            return { toolResult: { ok: true, message: "Updated the event." } };
        }

        if (name === "delete_event") {
            const eventId = str(args, "event_id");
            if (!eventId)
                return { toolResult: { ok: false, error: "delete_event requires an event_id." } };
            const source = sourceArg(args);
            const calendarId = await resolveCalendarId(db, source, { connector });
            const existing = await connector.getEvent(calendarId, eventId);
            if (!existing)
                return { toolResult: { ok: false, error: "That event was not found." } };

            if (existing.attendees.length > 0) {
                const { write } = await draftCalendarWrite(
                    db,
                    {
                        userId,
                        chatId: params.chatId ?? null,
                        chatMessageId: params.chatMessageId ?? null,
                        projectId: params.projectId ?? null,
                        calendarId,
                        opKind: "delete",
                        targetEventId: eventId,
                        eventInput: {},
                        sendUpdates: "all",
                        requiresApproval: true,
                    },
                    { connector },
                );
                if (!write)
                    return { toolResult: { ok: false, error: "Could not prepare the cancellation." } };
                const input: EventInput = {
                    summary: existing.summary,
                    start: existing.start,
                    end: existing.end,
                };
                return {
                    toolResult: {
                        ok: true,
                        status: "pending_approval",
                        message:
                            "Prepared the cancellation as an approval card. Cancellation notices go to attendees only on approval. The card owns the status.",
                    },
                    pendingCalendarWrite: pendingEvent(
                        write,
                        "delete",
                        source,
                        input,
                        existing.attendees.map((a) => a.email),
                    ),
                };
            }

            const { write: deleteWrite } = await executeInternalCalendarWrite(
                db,
                {
                    userId,
                    chatId: params.chatId ?? null,
                    projectId: params.projectId ?? null,
                    calendarId,
                    opKind: "delete",
                    targetEventId: eventId,
                    eventInput: {},
                },
                { connector },
            );
            if (!deleteWrite)
                return { toolResult: { ok: false, error: SETUP_INCOMPLETE } };
            return { toolResult: { ok: true, message: "Removed the event from the calendar." } };
        }

        if (name === "create_deadline") {
            const title = str(args, "title");
            const date = str(args, "date");
            if (!title || !date)
                return {
                    toolResult: {
                        ok: false,
                        error: "create_deadline requires a title and a date (YYYY-MM-DD).",
                    },
                };
            // The UI "matter" is a project; store the link in project_id so it
            // matches recordings + the matter page filter.
            const projectId = str(args, "matter_id") ?? params.projectId ?? undefined;
            const { type, leadDays } = classifyDeadline({
                text: title,
                explicitType:
                    typeof args.type === "string"
                        ? (args.type as DeadlineType)
                        : null,
                explicitLeadDays:
                    typeof args.lead_days === "number" ? args.lead_days : null,
            });
            // Deadlines live on the firm calendar as private all-day entries.
            const source: CalendarSource = "firm";
            const calendarId = await resolveCalendarId(db, source, { connector });
            const dateOnly = date.slice(0, 10);
            const input: EventInput = {
                summary: title,
                start: { date: dateOnly },
                end: { date: nextDay(dateOnly) },
            };
            const { write: deadlineWrite, event } =
                await executeInternalCalendarWrite(
                    db,
                    {
                        userId,
                        chatId: params.chatId ?? null,
                        projectId: projectId ?? null,
                        calendarId,
                        opKind: "create",
                        eventInput: input,
                    },
                    { connector },
                );
            if (!deadlineWrite)
                return { toolResult: { ok: false, error: SETUP_INCOMPLETE } };
            if (event) {
                await upsertEventMeta(db, {
                    calendarId,
                    googleEventId: event.id,
                    createdByUserId: userId,
                    projectId: projectId ?? null,
                    deadlineType: type,
                    deadlineAt: `${dateOnly}T00:00:00Z`,
                    reminderLeadDays: leadDays,
                });
            }
            return {
                toolResult: {
                    ok: true,
                    event_id: event?.id ?? null,
                    deadline_type: type,
                    lead_days: leadDays,
                    message: `Recorded the ${type.replace(/_/g, " ")} on the firm calendar for ${dateOnly}, with a ${leadDays}-day reminder lead time.`,
                },
            };
        }

        if (name === "link_event_to_matter" || name === "link_event_to_recording") {
            const eventId = str(args, "event_id");
            if (!eventId)
                return {
                    toolResult: { ok: false, error: `${name} requires an event_id.` },
                };
            const source = sourceArg(args);
            const calendarId = await resolveCalendarId(db, source, { connector });
            const event = await connector.getEvent(calendarId, eventId);
            if (!event)
                return { toolResult: { ok: false, error: "That event was not found." } };
            // Merge with any existing metadata so linking a matter never wipes
            // an existing recording link (or deadline), and vice versa.
            const existing = await getEventMeta(db, calendarId, eventId);
            await upsertEventMeta(db, {
                calendarId,
                googleEventId: eventId,
                createdByUserId: userId,
                matterId: existing?.matter_id ?? null,
                // The UI "matter" is a project; matter links are stored in
                // project_id so the matter page + agenda filter find them.
                projectId:
                    name === "link_event_to_matter"
                        ? str(args, "matter_id") ?? null
                        : existing?.project_id ?? null,
                recordingId:
                    name === "link_event_to_recording"
                        ? str(args, "recording_id") ?? null
                        : existing?.recording_id ?? null,
                deadlineType: existing?.deadline_type ?? null,
                deadlineAt: existing?.deadline_at ?? null,
                reminderLeadDays: existing?.reminder_lead_days ?? null,
            });
            return {
                toolResult: {
                    ok: true,
                    message:
                        name === "link_event_to_matter"
                            ? "Linked the event to the matter — it now shows on the matter's upcoming events."
                            : "Linked the event to the recording.",
                },
            };
        }

        if (name === "schedule_from_email") {
            const emailId = str(args, "email_id");
            const title = str(args, "title");
            const start = str(args, "start");
            const end = str(args, "end");
            if (!emailId || !title || !start || !end)
                return {
                    toolResult: {
                        ok: false,
                        error: "schedule_from_email requires email_id, title, start, and end.",
                    },
                };
            const email = await getEmail(db, emailId);
            const sender = email?.from_address
                ? extractEmailAddress(email.from_address)
                : null;
            // Sender + any explicit attendees, de-duplicated.
            const attendees = [
                ...new Set(
                    [sender, ...attendeeEmails(args)].filter(
                        (e): e is string => Boolean(e),
                    ),
                ),
            ];
            const input = buildInput({ ...args, attendees });
            const source: CalendarSource = "primary";
            const calendarId = await resolveCalendarId(db, source, { connector });
            // A meeting from an email always has an attendee → approval-gated.
            const { write } = await draftCalendarWrite(
                db,
                {
                    userId,
                    chatId: email?.chat_id ?? params.chatId ?? null,
                    chatMessageId: params.chatMessageId ?? null,
                    projectId: email?.project_id ?? params.projectId ?? null,
                    calendarId,
                    opKind: "create",
                    eventInput: input,
                    sendUpdates: "all",
                    requiresApproval: true,
                },
                { connector },
            );
            if (!write)
                return {
                    toolResult: {
                        ok: false,
                        error: "Could not prepare the meeting (calendar tables not set up yet).",
                    },
                };
            return {
                toolResult: {
                    ok: true,
                    status: "pending_approval",
                    message:
                        "Prepared the meeting as an approval card with the email's sender invited. Invitations go out only when the user approves it. Do NOT claim it is scheduled; the card owns the status.",
                },
                pendingCalendarWrite: pendingEvent(write, "create", source, input, attendees),
            };
        }

        return { toolResult: { ok: false, error: `Unknown calendar tool: ${name}` } };
    } catch (err) {
        return {
            toolResult: {
                ok: false,
                error: `Calendar operation failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            },
        };
    }
}
