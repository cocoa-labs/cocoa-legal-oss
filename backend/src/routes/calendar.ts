// backend/src/routes/calendar.ts
//
// HTTP layer for Quill's Google Calendar(s). Mirrors routes/email.ts:
// requireAuth + res.locals.userId, createServerSupabase() per request,
// { detail } errors, ConnectorNotConfiguredError → 503.
//
// Google is the source of truth for event content, so reads live-proxy the
// connector. Writes route by attendee presence: an event WITH attendees is
// outward-facing (it emails real people) and is drafted for approval via the
// agent-operations rails; a private (no-attendee) event executes immediately
// and is undoable. Both flow through lib/calendar/apply.ts.

import { Router } from "express";
import type { Request, Response } from "express";

import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { getCalendarConnector } from "../lib/connectors/registry";
import {
    ConnectorNotConfiguredError,
    type CalendarDateTime,
    type CalendarEvent,
    type EventInput,
} from "../lib/connectors/types";
import {
    getCalendarWrite,
    getEventMeta,
    getEventMetaByRecording,
    getEventMetaMap,
} from "../lib/calendar/store";
import type { CalendarEventMeta } from "../lib/calendar/types";
import {
    applyCalendarWriteNow,
    cancelCalendarWriteNow,
    draftCalendarWrite,
    executeInternalCalendarWrite,
    resolveCalendarId,
    undoCalendarWriteNow,
    type CalendarSource,
} from "../lib/calendar/apply";
import type { CalendarWrite } from "../lib/calendar/types";
import { BetaPolicyError, betaModeEnabled } from "../lib/betaPolicy";
import { checkProjectAccess, listAccessibleProjectIds } from "../lib/access";

const router = Router();
router.use(requireAuth);

const FIRM_NAME = process.env.CALENDAR_FIRM_NAME || "Cocoa Legal";
const DEFAULT_TZ = process.env.CALENDAR_DEFAULT_TIMEZONE || "UTC";

class CalendarScopeError extends Error {
    readonly status = 404;
    readonly code = "CALENDAR_SCOPE_FORBIDDEN";
}

async function requireCalendarProjectScope(
    db: ReturnType<typeof createServerSupabase>,
    projectId: string | null,
    userId: string,
    userEmail: string | undefined,
) {
    if (!projectId) {
        if (betaModeEnabled())
            throw new BetaPolicyError(
                "BETA_DATA_POLICY_REQUIRED",
                "Controlled-beta calendar changes must be linked to an authorized matter.",
            );
        return null;
    }
    const access = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
        "approve",
    );
    if (!access.ok) {
        throw new CalendarScopeError(
            "Calendar matter not found or not editable.",
        );
    }
    return {
        orgId: access.project.org_id,
        matterId: access.project.matter_id,
        projectId,
    };
}

async function canMutateCalendarWrite(
    db: ReturnType<typeof createServerSupabase>,
    write: CalendarWrite,
    userId: string,
    userEmail: string | undefined,
): Promise<boolean> {
    if (!write.project_id) return write.user_id === userId;
    return (
        await checkProjectAccess(
            write.project_id,
            userId,
            userEmail,
            db,
            "approve",
        )
    ).ok;
}

// ---------------------------------------------------------------------------
// API DTO — the camelCase shape the frontend client mirrors 1:1. The client
// never sees raw Google calendar ids; it works in "primary" | "firm".
// ---------------------------------------------------------------------------
interface ApiEvent {
    id: string;
    calendar: CalendarSource;
    title: string;
    description: string | null;
    location: string | null;
    start: CalendarDateTime;
    end: CalendarDateTime;
    allDay: boolean;
    attendees: CalendarEvent["attendees"];
    meetLink: string | null;
    htmlLink: string | null;
    organizer: { email: string } | null;
    recurrence: string[];
    status: string;
    // Enriched from calendar_event_meta (Phase B); null/false when unlinked.
    matterId: string | null;
    projectId: string | null;
    recordingId: string | null;
    isDeadline: boolean;
    deadline: {
        type: string;
        dueAt: string | null;
        leadDays: number | null;
    } | null;
    created: string | null;
    updated: string | null;
}

function toApiEvent(
    source: CalendarSource,
    e: CalendarEvent,
    meta?: CalendarEventMeta | null,
): ApiEvent {
    return {
        id: e.id,
        calendar: source,
        title: e.summary,
        description: e.description,
        location: e.location,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        attendees: e.attendees,
        meetLink: e.conference?.uri ?? e.hangoutLink ?? null,
        htmlLink: e.htmlLink,
        organizer: e.organizer,
        recurrence: e.recurrence,
        status: e.status,
        // The UI "matter" is a project (projects.id), matching how recordings
        // link — so expose the project link as matterId, falling back to the
        // tenancy matter_id if only that is set.
        matterId: meta?.project_id ?? meta?.matter_id ?? null,
        projectId: meta?.project_id ?? null,
        recordingId: meta?.recording_id ?? null,
        isDeadline: Boolean(meta?.deadline_type),
        deadline: meta?.deadline_type
            ? {
                  type: meta.deadline_type,
                  dueAt: meta.deadline_at,
                  leadDays: meta.reminder_lead_days,
              }
            : null,
        created: e.created,
        updated: e.updated,
    };
}

function parseSource(value: unknown): CalendarSource {
    return value === "firm" ? "firm" : "primary";
}

/** Build a connector EventInput + attendee emails from a request body. */
function parseEventInput(body: Record<string, unknown>): {
    input: EventInput;
    attendeeEmails: string[];
} {
    const attendeesRaw = Array.isArray(body.attendees) ? body.attendees : [];
    const attendeeEmails = attendeesRaw
        .map((a) =>
            typeof a === "string"
                ? a
                : a && typeof a === "object" && "email" in a
                  ? String((a as { email: unknown }).email ?? "")
                  : "",
        )
        .map((s) => s.trim())
        .filter(Boolean);

    const start = (body.start ?? {}) as CalendarDateTime;
    const end = (body.end ?? {}) as CalendarDateTime;
    const timeZone =
        typeof body.timeZone === "string" ? body.timeZone : DEFAULT_TZ;

    const input: EventInput = {
        summary:
            typeof body.title === "string"
                ? body.title
                : typeof body.summary === "string"
                  ? body.summary
                  : "",
        description:
            typeof body.description === "string" ? body.description : undefined,
        location: typeof body.location === "string" ? body.location : undefined,
        start,
        end,
        attendees: attendeeEmails.map((email) => ({ email })),
        addMeet: Boolean(body.addMeet),
        timeZone,
        recurrence: Array.isArray(body.recurrence)
            ? (body.recurrence as string[])
            : undefined,
    };
    return { input, attendeeEmails };
}

/** Shape a pending write into the { operation } half of a write result. */
function pendingResult(write: CalendarWrite | null) {
    if (!write) return null;
    return {
        write_id: write.id,
        operation_id: write.agent_operation_id,
        kind: write.op_kind,
        status: write.status,
    };
}

function sendError(res: Response, err: unknown, fallback: string): void {
    if (err instanceof BetaPolicyError) {
        res.status(err.status).json({ code: err.code, detail: err.message });
        return;
    }
    if (err instanceof CalendarScopeError) {
        res.status(err.status).json({ code: err.code, detail: err.message });
        return;
    }
    if (err instanceof ConnectorNotConfiguredError) {
        res.status(503).json({ detail: err.message });
        return;
    }
    res.status(500).json({
        detail: err instanceof Error ? err.message : fallback,
    });
}

// ---------------------------------------------------------------------------
// GET /calendar/events?time_min=&time_max=&calendar=primary|firm|all&page_token=
// ---------------------------------------------------------------------------
router.get("/events", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const connector = getCalendarConnector();
    if (!connector.isConfigured()) {
        return void res
            .status(503)
            .json({ detail: "Calendar connector is not configured." });
    }
    try {
        const timeMin =
            typeof req.query.time_min === "string"
                ? req.query.time_min
                : undefined;
        const timeMax =
            typeof req.query.time_max === "string"
                ? req.query.time_max
                : undefined;
        const which =
            req.query.calendar === "firm"
                ? (["firm"] as CalendarSource[])
                : req.query.calendar === "primary"
                  ? (["primary"] as CalendarSource[])
                  : (["primary", "firm"] as CalendarSource[]);

        const matterId =
            typeof req.query.matter_id === "string"
                ? req.query.matter_id
                : undefined;
        const accessibleProjectIds = betaModeEnabled()
            ? new Set(await listAccessibleProjectIds(userId, userEmail, db))
            : null;
        if (matterId && accessibleProjectIds && !accessibleProjectIds.has(matterId))
            return void res.status(404).json({ detail: "Matter not found" });

        const collected: ApiEvent[] = [];
        for (const source of which) {
            const calendarId = await resolveCalendarId(db, source, { connector });
            const { events } = await connector.listEvents({
                calendarId,
                timeMin,
                timeMax,
                singleEvents: true,
            });
            const metaMap = await getEventMetaMap(
                db,
                calendarId,
                events.map((e) => e.id),
            );
            for (const e of events) {
                const api = toApiEvent(source, e, metaMap.get(e.id));
                if (
                    accessibleProjectIds &&
                    (!api.projectId || !accessibleProjectIds.has(api.projectId))
                )
                    continue;
                // Matter filter (Phase B): keep only events linked to the matter.
                if (matterId && api.matterId !== matterId) continue;
                collected.push(api);
            }
        }
        // Merge + sort ascending by start (all-day date or timed dateTime).
        collected.sort((a, b) => startKey(a).localeCompare(startKey(b)));

        res.json({
            events: collected,
            range: { from: timeMin ?? null, to: timeMax ?? null },
            calendars: which.map((id) => ({
                id,
                name: id === "firm" ? FIRM_NAME : "Quill",
            })),
        });
    } catch (err) {
        sendError(res, err, "Failed to load calendar events");
    }
});

function startKey(e: ApiEvent): string {
    return e.start.dateTime ?? e.start.date ?? "";
}

// GET /calendar/events/:id?calendar=primary|firm
router.get("/events/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const connector = getCalendarConnector();
    if (!connector.isConfigured()) {
        return void res
            .status(503)
            .json({ detail: "Calendar connector is not configured." });
    }
    try {
        const source = parseSource(req.query.calendar);
        const calendarId = await resolveCalendarId(db, source, { connector });
        const event = await connector.getEvent(calendarId, req.params.id);
        if (!event)
            return void res.status(404).json({ detail: "Event not found" });
        const meta = await getEventMeta(db, calendarId, event.id);
        if (
            betaModeEnabled() &&
            (!meta?.project_id ||
                !(await checkProjectAccess(
                    meta.project_id,
                    userId,
                    userEmail,
                    db,
                )).ok)
        )
            return void res.status(404).json({ detail: "Event not found" });
        res.json({ event: toApiEvent(source, event, meta) });
    } catch (err) {
        sendError(res, err, "Failed to load event");
    }
});

// POST /calendar/events — create. Attendees → outward (approval); else internal.
router.post("/events", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const connector = getCalendarConnector();
    if (!connector.isConfigured()) {
        return void res
            .status(503)
            .json({ detail: "Calendar connector is not configured." });
    }
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const source = parseSource(body.calendar);
        const calendarId = await resolveCalendarId(db, source, { connector });
        const { input, attendeeEmails } = parseEventInput(body);
        const requestedProjectId =
            typeof body.project_id === "string"
                ? body.project_id
                : typeof body.matter_id === "string"
                  ? body.matter_id
                  : null;
        const scope = await requireCalendarProjectScope(
            db,
            requestedProjectId,
            userId,
            userEmail,
        );
        if (!input.summary) {
            return void res.status(400).json({ detail: "A title is required." });
        }

        if (attendeeEmails.length > 0) {
            // Outward-facing: draft for approval (invitations sent on approve).
            const { write } = await draftCalendarWrite(
                db,
                {
                    userId,
                    ...(scope ?? {}),
                    calendarId,
                    opKind: "create",
                    eventInput: input,
                    sendUpdates: "all",
                    requiresApproval: true,
                },
                { connector },
            );
            return void res.json({ event: null, operation: pendingResult(write) });
        }

        // Internal: execute immediately, undoable.
        const { write, event } = await executeInternalCalendarWrite(
            db,
            { userId, ...(scope ?? {}), calendarId, opKind: "create", eventInput: input },
            { connector },
        );
        res.json({
            event: event ? toApiEvent(source, event) : null,
            operation: null,
            write_id: write?.id ?? null,
        });
    } catch (err) {
        sendError(res, err, "Failed to create event");
    }
});

// PATCH /calendar/events/:id — update. Outward when the event (old or new) has
// attendees; else internal.
router.patch("/events/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const connector = getCalendarConnector();
    if (!connector.isConfigured()) {
        return void res
            .status(503)
            .json({ detail: "Calendar connector is not configured." });
    }
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const source = parseSource(body.calendar ?? req.query.calendar);
        const calendarId = await resolveCalendarId(db, source, { connector });
        const existing = await connector.getEvent(calendarId, req.params.id);
        if (!existing)
            return void res.status(404).json({ detail: "Event not found" });
        const existingMeta = await getEventMeta(db, calendarId, req.params.id);
        const requestedProjectId =
            typeof body.project_id === "string"
                ? body.project_id
                : typeof body.matter_id === "string"
                  ? body.matter_id
                  : existingMeta?.project_id ?? null;
        const scope = await requireCalendarProjectScope(
            db,
            requestedProjectId,
            userId,
            userEmail,
        );

        const { input, attendeeEmails } = parseEventInput(body);
        const hasAttendees =
            attendeeEmails.length > 0 || existing.attendees.length > 0;

        if (hasAttendees) {
            const { write } = await draftCalendarWrite(
                db,
                {
                    userId,
                    ...(scope ?? {}),
                    calendarId,
                    opKind: "update",
                    targetEventId: req.params.id,
                    eventInput: input,
                    sendUpdates: "all",
                    requiresApproval: true,
                },
                { connector },
            );
            return void res.json({ event: null, operation: pendingResult(write) });
        }

        const { write, event } = await executeInternalCalendarWrite(
            db,
            {
                userId,
                ...(scope ?? {}),
                calendarId,
                opKind: "update",
                targetEventId: req.params.id,
                eventInput: input,
            },
            { connector },
        );
        res.json({
            event: event ? toApiEvent(source, event) : null,
            operation: null,
            write_id: write?.id ?? null,
        });
    } catch (err) {
        sendError(res, err, "Failed to update event");
    }
});

// DELETE /calendar/events/:id?calendar= — outward when the event has attendees.
router.delete("/events/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const connector = getCalendarConnector();
    if (!connector.isConfigured()) {
        return void res
            .status(503)
            .json({ detail: "Calendar connector is not configured." });
    }
    try {
        const source = parseSource(req.query.calendar);
        const calendarId = await resolveCalendarId(db, source, { connector });
        const existing = await connector.getEvent(calendarId, req.params.id);
        if (!existing)
            return void res.status(404).json({ detail: "Event not found" });
        const existingMeta = await getEventMeta(db, calendarId, req.params.id);
        const scope = await requireCalendarProjectScope(
            db,
            existingMeta?.project_id ?? null,
            userId,
            userEmail,
        );

        if (existing.attendees.length > 0) {
            const { write } = await draftCalendarWrite(
                db,
                {
                    userId,
                    ...(scope ?? {}),
                    calendarId,
                    opKind: "delete",
                    targetEventId: req.params.id,
                    eventInput: {},
                    sendUpdates: "all",
                    requiresApproval: true,
                },
                { connector },
            );
            return void res.json({ event: null, operation: pendingResult(write) });
        }

        const { write } = await executeInternalCalendarWrite(
            db,
            {
                userId,
                ...(scope ?? {}),
                calendarId,
                opKind: "delete",
                targetEventId: req.params.id,
                eventInput: {},
            },
            { connector },
        );
        res.json({ event: null, operation: null, write_id: write?.id ?? null });
    } catch (err) {
        sendError(res, err, "Failed to delete event");
    }
});

// GET /calendar/recordings/:recordingId/event — the event linked to a recording
// (reciprocal of the event→recording link), or { event: null }.
router.get(
    "/recordings/:recordingId/event",
    async (req: Request, res: Response) => {
        const db = createServerSupabase();
        const connector = getCalendarConnector();
        if (!connector.isConfigured()) {
            return void res.json({ event: null });
        }
        try {
            const meta = await getEventMetaByRecording(db, req.params.recordingId);
            if (!meta) return void res.json({ event: null });
            const source: CalendarSource =
                meta.calendar_id === "primary" ? "primary" : "firm";
            const event = await connector.getEvent(
                meta.calendar_id,
                meta.google_event_id,
            );
            res.json({ event: event ? toApiEvent(source, event, meta) : null });
        } catch (err) {
            sendError(res, err, "Failed to load linked event");
        }
    },
);

// GET /calendar/calendars — the calendars Quill can see.
router.get("/calendars", async (_req: Request, res: Response) => {
    const connector = getCalendarConnector();
    if (!connector.isConfigured()) {
        return void res
            .status(503)
            .json({ detail: "Calendar connector is not configured." });
    }
    try {
        if (betaModeEnabled()) {
            return void res.json({
                calendars: [
                    { id: "primary", summary: "Quill", primary: true },
                    { id: "firm", summary: FIRM_NAME, primary: false },
                ],
            });
        }
        const calendars = await connector.listCalendars();
        res.json({ calendars });
    } catch (err) {
        sendError(res, err, "Failed to list calendars");
    }
});

// ---------------------------------------------------------------------------
// Write approval / cancel / undo (parity with /email/:id/approve|cancel).
// ---------------------------------------------------------------------------

// POST /calendar/writes/:id/approve — apply a pending outward write to Google.
router.post("/writes/:id/approve", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const write = await getCalendarWrite(db, req.params.id);
        if (!write)
            return void res.status(404).json({ detail: "Calendar change not found" });
        if (!(await canMutateCalendarWrite(db, write, userId, userEmail)))
            return void res.status(403).json({ detail: "Forbidden" });
        if (write.status !== "pending_approval") {
            return void res.json({ write });
        }
        const applied = await applyCalendarWriteNow(db, write.id, {
            approvedBy: userId,
        });
        res.json({ write: applied });
    } catch (err) {
        sendError(res, err, "Failed to apply calendar change");
    }
});

// POST /calendar/writes/:id/cancel — cancel a still-pending write.
router.post("/writes/:id/cancel", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const write = await getCalendarWrite(db, req.params.id);
        if (!write)
            return void res.status(404).json({ detail: "Calendar change not found" });
        if (!(await canMutateCalendarWrite(db, write, userId, userEmail)))
            return void res.status(403).json({ detail: "Forbidden" });
        if (write.status === "cancelled") {
            return void res.json({ write });
        }
        const cancelled = await cancelCalendarWriteNow(db, write.id);
        if (!cancelled) {
            const fresh = (await getCalendarWrite(db, write.id)) ?? write;
            return void res.status(409).json({
                detail: `Calendar change is ${fresh.status}, not pending — it can no longer be cancelled`,
            });
        }
        res.json({ write: cancelled });
    } catch (err) {
        sendError(res, err, "Failed to cancel calendar change");
    }
});

// POST /calendar/writes/:id/undo — reverse an applied write.
router.post("/writes/:id/undo", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const write = await getCalendarWrite(db, req.params.id);
        if (!write)
            return void res.status(404).json({ detail: "Calendar change not found" });
        if (!(await canMutateCalendarWrite(db, write, userId, userEmail)))
            return void res.status(403).json({ detail: "Forbidden" });
        const undone = await undoCalendarWriteNow(db, write.id, { userId });
        res.json({ write: undone });
    } catch (err) {
        sendError(res, err, "Failed to undo calendar change");
    }
});

export { router as calendarRouter };
