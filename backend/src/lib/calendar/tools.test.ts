// backend/src/lib/calendar/tools.test.ts
//
// The load-bearing safety property of the calendar agent tools: writes route by
// attendee presence. create_event WITH attendees returns a `calendar_pending`
// approval event and does NOT touch Google (invitations wait for approval);
// WITHOUT attendees it executes immediately with sendUpdates "none" (a private
// event emails no one). Also: reads summarize, and an unconfigured connector
// degrades to ok:false rather than throwing. Fake connector + scripted Supabase
// stub.
import assert from "node:assert/strict";
import { runCalendarToolCall } from "./tools";
import type { CalendarConnector, CalendarEvent } from "../connectors/types";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

function makeDb(script: { data?: unknown; error?: unknown }[]) {
    let next = 0;
    const makeChain = (result: { data?: unknown; error?: unknown }) => {
        const c: Record<string, unknown> = {};
        const passthrough = () => c;
        for (const m of [
            "insert", "update", "upsert", "delete", "select", "eq", "neq",
            "in", "is", "or", "not", "ilike", "lt", "lte", "gt", "gte",
            "order", "limit", "range",
        ]) {
            c[m] = passthrough;
        }
        const resolved = { data: result.data ?? null, error: result.error ?? null };
        c.single = () => Promise.resolve(resolved);
        c.maybeSingle = () => Promise.resolve(resolved);
        c.then = (resolve: (v: unknown) => void) => resolve(resolved);
        return c;
    };
    return { from: () => makeChain(script[next++] ?? {}) } as never;
}

interface FakeCall {
    m: string;
    calendarId?: string;
    opts?: { sendUpdates?: string };
}

function makeFakeConnector(overrides: {
    configured?: boolean;
    listEvents?: CalendarEvent[];
    getEvent?: CalendarEvent | null;
}) {
    const calls: FakeCall[] = [];
    const connector: CalendarConnector = {
        isConfigured: () => overrides.configured ?? true,
        listEvents: async (o) => {
            calls.push({ m: "listEvents", calendarId: o.calendarId });
            return {
                events: overrides.listEvents ?? [],
                nextPageToken: null,
                nextSyncToken: null,
            };
        },
        getEvent: async () => overrides.getEvent ?? null,
        createEvent: async (calendarId, _input, opts) => {
            calls.push({ m: "createEvent", calendarId, opts });
            return { id: "evt-new", calendarId } as CalendarEvent;
        },
        updateEvent: async (calendarId, eventId) =>
            ({ id: eventId, calendarId }) as CalendarEvent,
        deleteEvent: async (calendarId) => {
            calls.push({ m: "deleteEvent", calendarId });
        },
        listCalendars: async () => [],
        ensureFirmCalendar: async () => "firmcal",
    };
    return { connector, calls };
}

const sampleEvent = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: "evt-1",
    calendarId: "primary",
    status: "confirmed",
    summary: "Call",
    description: null,
    location: null,
    start: { dateTime: "2026-07-20T10:00:00Z" },
    end: { dateTime: "2026-07-20T10:30:00Z" },
    allDay: false,
    attendees: [],
    organizer: null,
    recurrence: [],
    recurringEventId: null,
    conference: null,
    htmlLink: null,
    hangoutLink: null,
    created: null,
    updated: null,
    ...over,
});

async function main(): Promise<void> {
    console.log("calendar/tools.test.ts");

    await test("create_event WITH attendees → approval-gated, Google untouched", async () => {
        const db = makeDb([
            { data: { id: "op-1" } }, // createAgentOperation
            {
                data: {
                    id: "cw-1",
                    user_id: "u1",
                    calendar_id: "primary",
                    op_kind: "create",
                    status: "pending_approval",
                    agent_operation_id: "op-1",
                    requires_approval: true,
                    event_input: {},
                    send_updates: "all",
                    created_at: "",
                    updated_at: "",
                },
            }, // createCalendarWrite
        ]);
        const { connector, calls } = makeFakeConnector({});
        const res = await runCalendarToolCall({
            name: "create_event",
            args: {
                title: "Call — opposing counsel",
                start: "2026-07-20T10:00:00Z",
                end: "2026-07-20T10:30:00Z",
                attendees: ["opposing@other.com"],
                add_meet: true,
                calendar: "primary",
            },
            db,
            userId: "u1",
            connector,
        });
        assert.ok(res.pendingCalendarWrite, "a calendar_pending event is returned");
        assert.equal(res.pendingCalendarWrite?.type, "calendar_pending");
        assert.equal(res.pendingCalendarWrite?.op_kind, "create");
        assert.deepEqual(res.pendingCalendarWrite?.attendees, ["opposing@other.com"]);
        assert.equal(res.pendingCalendarWrite?.add_meet, true);
        assert.equal(res.toolResult.status, "pending_approval");
        // The event is NOT created on Google — invitations wait for approval.
        assert.equal(
            calls.find((c) => c.m === "createEvent"),
            undefined,
            "Google is not touched before approval",
        );
    });

    await test("create_event WITHOUT attendees → executes now with sendUpdates none", async () => {
        const db = makeDb([
            { data: { id: "op-2" } }, // createAgentOperation
            {
                data: {
                    id: "cw-2",
                    user_id: "u1",
                    calendar_id: "primary",
                    op_kind: "create",
                    status: "pending_approval",
                    agent_operation_id: "op-2",
                    requires_approval: false,
                    event_input: {},
                    send_updates: "none",
                    created_at: "",
                    updated_at: "",
                },
            }, // createCalendarWrite
            { data: { id: "cw-2", status: "pending_approval", op_kind: "create", calendar_id: "primary", user_id: "u1", agent_operation_id: "op-2", send_updates: "none", event_input: {}, created_at: "", updated_at: "" } }, // getCalendarWrite
            { data: { id: "cw-2", status: "applying", op_kind: "create", calendar_id: "primary", user_id: "u1", agent_operation_id: "op-2", send_updates: "none", event_input: {}, created_at: "", updated_at: "" } }, // claim
            { data: { id: "cw-2", status: "applied", op_kind: "create", calendar_id: "primary", user_id: "u1", agent_operation_id: "op-2", send_updates: "none", event_input: {}, result_event_id: "evt-new", created_at: "", updated_at: "" } }, // markApplied
            { data: { id: "op-2" } }, // updateAgentOperation
        ]);
        const { connector, calls } = makeFakeConnector({ getEvent: sampleEvent({ id: "evt-new" }) });
        const res = await runCalendarToolCall({
            name: "create_event",
            args: {
                title: "Focus block",
                start: "2026-07-20",
                end: "2026-07-21",
                all_day: true,
                calendar: "primary",
            },
            db,
            userId: "u1",
            connector,
        });
        assert.equal(res.pendingCalendarWrite, undefined, "no approval card for a private event");
        assert.equal(res.toolResult.ok, true);
        const create = calls.find((c) => c.m === "createEvent");
        assert.ok(create, "the event is created immediately");
        assert.equal(create?.opts?.sendUpdates, "none", "a private event emails no one");
    });

    // Regression: an internal (no-attendee) write whose calendar_writes row can't
    // be persisted (migration 026 not applied) must report an HONEST failure — it
    // must NOT claim "Added the event" when nothing reached Google. This is the
    // bug where Quill said "Done" but the calendar stayed empty.
    const missingSchema = {
        error: {
            code: "42P01",
            message: 'relation "public.calendar_writes" does not exist',
        },
    };
    async function inProd<T>(fn: () => Promise<T>): Promise<T> {
        // Silence tolerateMissingSchema's dev-mode warn so output stays pristine.
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            return await fn();
        } finally {
            if (prev === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prev;
        }
    }

    await test("create_event (no attendees) with calendar_writes missing → honest failure, not a false 'Added'", async () => {
        const db = makeDb([
            { data: { id: "op-x" } }, // createAgentOperation
            missingSchema, // createCalendarWrite → schema missing → null
        ]);
        const { connector, calls } = makeFakeConnector({});
        const res = await inProd(() =>
            runCalendarToolCall({
                name: "create_event",
                args: {
                    title: "Pool tournament",
                    start: "2026-07-19",
                    end: "2026-07-20",
                    all_day: true,
                    calendar: "primary",
                },
                db,
                userId: "u1",
                connector,
            }),
        );
        assert.equal(
            res.toolResult.ok,
            false,
            "must NOT claim success when nothing was persisted",
        );
        assert.match(String(res.toolResult.error), /set up|migration|storage/i);
        assert.equal(
            calls.find((c) => c.m === "createEvent"),
            undefined,
            "Google is not written when the draft could not be persisted",
        );
    });

    await test("update_event (no attendees) with calendar_writes missing → honest failure", async () => {
        const db = makeDb([
            { data: { id: "op-y" } }, // createAgentOperation
            missingSchema, // createCalendarWrite → null
        ]);
        const { connector } = makeFakeConnector({ getEvent: sampleEvent() });
        const res = await inProd(() =>
            runCalendarToolCall({
                name: "update_event",
                args: { event_id: "evt-1", title: "Moved", calendar: "primary" },
                db,
                userId: "u1",
                connector,
            }),
        );
        assert.equal(res.toolResult.ok, false);
        assert.match(String(res.toolResult.error), /set up|migration|storage/i);
    });

    await test("delete_event (no attendees) with calendar_writes missing → honest failure", async () => {
        const db = makeDb([
            { data: { id: "op-z" } }, // createAgentOperation
            missingSchema, // createCalendarWrite → null
        ]);
        const { connector, calls } = makeFakeConnector({ getEvent: sampleEvent() });
        const res = await inProd(() =>
            runCalendarToolCall({
                name: "delete_event",
                args: { event_id: "evt-1", calendar: "primary" },
                db,
                userId: "u1",
                connector,
            }),
        );
        assert.equal(res.toolResult.ok, false);
        assert.equal(
            calls.find((c) => c.m === "deleteEvent"),
            undefined,
            "Google delete is not issued when the draft could not be persisted",
        );
    });

    await test("create_deadline with calendar_writes missing → honest failure", async () => {
        const db = makeDb([
            { data: { value: { calendar_id: "firmcal" } } }, // getFirmCalendarId
            { data: { id: "op-d" } }, // createAgentOperation
            missingSchema, // createCalendarWrite → null
        ]);
        const { connector } = makeFakeConnector({});
        const res = await inProd(() =>
            runCalendarToolCall({
                name: "create_deadline",
                args: { title: "Filing deadline — Acme", date: "2026-08-01" },
                db,
                userId: "u1",
                connector,
            }),
        );
        assert.equal(res.toolResult.ok, false);
        assert.match(String(res.toolResult.error), /set up|migration|storage/i);
    });

    await test("list_events summarizes upcoming events", async () => {
        const { connector } = makeFakeConnector({
            listEvents: [sampleEvent({ id: "e1", summary: "Deposition" })],
        });
        const res = await runCalendarToolCall({
            name: "list_events",
            args: { calendar: "primary" },
            db: makeDb([]),
            userId: "u1",
            connector,
        });
        assert.equal(res.toolResult.ok, true);
        assert.equal(res.toolResult.count, 1);
        const events = res.toolResult.events as { title: string; event_id: string }[];
        assert.equal(events[0].title, "Deposition");
        assert.equal(events[0].event_id, "e1");
    });

    await test("unconfigured connector degrades to ok:false, no throw", async () => {
        const { connector } = makeFakeConnector({ configured: false });
        const res = await runCalendarToolCall({
            name: "list_events",
            args: {},
            db: makeDb([]),
            userId: "u1",
            connector,
        });
        assert.equal(res.toolResult.ok, false);
    });

    console.log("calendar/tools.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
