// backend/src/lib/calendar/apply.test.ts
//
// Pins the calendar apply/undo executor — the analogue of email/send.ts's
// sendEmailNow. Verifies: applyCalendarWriteNow claims + writes to Google with
// the row's sendUpdates and reconciles the operation; it is an idempotent no-op
// when the write is not pending; a ConnectorNotConfiguredError marks the write
// failed but NOT the operation (so callers map it to 503); an internal
// (no-attendee) write drafts + applies with sendUpdates "none"; and undo of a
// created event deletes it. A fake CalendarConnector + scripted Supabase stub —
// no network, no live database.
import assert from "node:assert/strict";
import {
    applyCalendarWriteNow,
    executeInternalCalendarWrite,
    undoCalendarWriteNow,
} from "./apply";
import { ConnectorNotConfiguredError } from "../connectors/types";
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

interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown },
    ) => {
        const c: Record<string, unknown> = {};
        const record =
            (method: string) =>
            (...args: unknown[]) => {
                log.calls.push({ method, args });
                return c;
            };
        for (const m of [
            "insert",
            "update",
            "upsert",
            "delete",
            "select",
            "eq",
            "neq",
            "in",
            "is",
            "or",
            "not",
            "ilike",
            "lt",
            "lte",
            "gt",
            "gte",
            "order",
            "limit",
            "range",
        ]) {
            c[m] = record(m);
        }
        const resolved = {
            data: result.data ?? null,
            error: result.error ?? null,
        };
        c.single = () => Promise.resolve(resolved);
        c.maybeSingle = () => Promise.resolve(resolved);
        c.then = (resolve: (v: unknown) => void) => resolve(resolved);
        return c;
    };
    const db = {
        from: (table: string) => {
            const log: ChainLog = { table, calls: [] };
            chains.push(log);
            return makeChain(log, script[next++] ?? {});
        },
    } as never;
    return { db, chains };
}

interface FakeCall {
    m: string;
    calendarId?: string;
    eventId?: string;
    opts?: { sendUpdates?: string };
}

function makeFakeConnector(overrides: {
    createdEvent?: Partial<CalendarEvent>;
    getEvent?: CalendarEvent | null;
    createThrows?: Error;
}) {
    const calls: FakeCall[] = [];
    const connector: CalendarConnector = {
        isConfigured: () => true,
        listEvents: async () => ({ events: [], nextPageToken: null, nextSyncToken: null }),
        getEvent: async (calendarId, eventId) => {
            calls.push({ m: "getEvent", calendarId, eventId });
            return overrides.getEvent ?? null;
        },
        createEvent: async (calendarId, _input, opts) => {
            calls.push({ m: "createEvent", calendarId, opts });
            if (overrides.createThrows) throw overrides.createThrows;
            return {
                id: "evt-new",
                calendarId,
                status: "confirmed",
                summary: "",
                description: null,
                location: null,
                start: {},
                end: {},
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
                ...overrides.createdEvent,
            };
        },
        updateEvent: async (calendarId, eventId, _input, opts) => {
            calls.push({ m: "updateEvent", calendarId, eventId, opts });
            return { id: eventId, calendarId } as CalendarEvent;
        },
        deleteEvent: async (calendarId, eventId, opts) => {
            calls.push({ m: "deleteEvent", calendarId, eventId, opts });
        },
        listCalendars: async () => [],
        ensureFirmCalendar: async () => "firmcal",
    };
    return { connector, calls };
}

function writeRow(overrides: Record<string, unknown>) {
    return {
        id: "cw-1",
        user_id: "user-1",
        org_id: null,
        matter_id: null,
        project_id: null,
        chat_id: null,
        agent_operation_id: "op-1",
        calendar_id: "primary",
        op_kind: "create",
        target_event_id: null,
        requires_approval: true,
        status: "pending_approval",
        event_input: { summary: "Call", attendees: [{ email: "x@y.com" }] },
        prior_snapshot: null,
        result_event_id: null,
        send_updates: "all",
        error: null,
        applied_at: null,
        created_at: "2026-07-17T00:00:00Z",
        updated_at: "2026-07-17T00:00:00Z",
        ...overrides,
    };
}

function opRow() {
    return { id: "op-1", status: "succeeded", tool_name: "create_event", action_type: "create", actor_user_id: "user-1", created_at: "", updated_at: "" };
}

async function main(): Promise<void> {
    console.log("calendar/apply.test.ts");

    await test("applyCalendarWriteNow: creates on Google with the row's sendUpdates, marks applied, reconciles op", async () => {
        const { db, chains } = makeDb([
            { data: writeRow({}) }, // getCalendarWrite → pending
            { data: writeRow({ status: "applying" }) }, // claim → applying
            { data: writeRow({ status: "applied", result_event_id: "evt-new" }) }, // markApplied
            { data: opRow() }, // updateAgentOperation
        ]);
        const { connector, calls } = makeFakeConnector({});
        const applied = await applyCalendarWriteNow(db, "cw-1", {
            approvedBy: "user-1",
            connector,
        });
        assert.equal(applied.status, "applied");
        assert.equal(applied.result_event_id, "evt-new");
        const create = calls.find((c) => c.m === "createEvent");
        assert.ok(create, "connector.createEvent called");
        assert.equal(create?.calendarId, "primary");
        assert.equal(create?.opts?.sendUpdates, "all", "invites fan out for an attendee event");
        // The operation is reconciled on agent_operations.
        assert.ok(chains.some((ch) => ch.table === "agent_operations"));
    });

    await test("applyCalendarWriteNow: idempotent no-op when the write is not pending", async () => {
        const { db } = makeDb([{ data: writeRow({ status: "applied", result_event_id: "evt-new" }) }]);
        const { connector, calls } = makeFakeConnector({});
        const res = await applyCalendarWriteNow(db, "cw-1", { approvedBy: "user-1", connector });
        assert.equal(res.status, "applied");
        assert.equal(calls.length, 0, "Google is never touched a second time");
    });

    await test("applyCalendarWriteNow: ConnectorNotConfigured marks write failed but NOT the operation", async () => {
        const { db, chains } = makeDb([
            { data: writeRow({}) }, // getCalendarWrite
            { data: writeRow({ status: "applying" }) }, // claim
            { data: {} }, // markCalendarWriteFailed (update, no select)
        ]);
        const { connector } = makeFakeConnector({
            createThrows: new ConnectorNotConfiguredError("calendar"),
        });
        await assert.rejects(
            () => applyCalendarWriteNow(db, "cw-1", { approvedBy: "user-1", connector }),
            ConnectorNotConfiguredError,
        );
        // Only calendar_writes was touched — the operation is left intact so a
        // missing-config failure is not recorded as a hard operation failure.
        assert.ok(
            chains.every((ch) => ch.table === "calendar_writes"),
            "agent_operations is never marked failed on a config error",
        );
    });

    await test("executeInternalCalendarWrite: no-attendee write drafts + applies with sendUpdates none", async () => {
        const { db } = makeDb([
            { data: opRow() }, // createAgentOperation
            { data: writeRow({ status: "pending_approval", send_updates: "none", requires_approval: false, event_input: { summary: "Block" } }) }, // createCalendarWrite
            { data: writeRow({ status: "pending_approval", send_updates: "none" }) }, // getCalendarWrite (in apply)
            { data: writeRow({ status: "applying", send_updates: "none" }) }, // claim
            { data: writeRow({ status: "applied", send_updates: "none", result_event_id: "evt-new" }) }, // markApplied
            { data: opRow() }, // updateAgentOperation
        ]);
        const { connector, calls } = makeFakeConnector({ getEvent: null });
        const res = await executeInternalCalendarWrite(
            db,
            {
                userId: "user-1",
                calendarId: "primary",
                opKind: "create",
                eventInput: { summary: "Block", start: { date: "2026-07-20" }, end: { date: "2026-07-21" } },
            },
            { connector },
        );
        assert.ok(res.write, "write returned");
        assert.equal(res.write?.status, "applied");
        const create = calls.find((c) => c.m === "createEvent");
        assert.equal(create?.opts?.sendUpdates, "none", "a private event sends no invitations");
    });

    await test("undoCalendarWriteNow: undo of a created event deletes it on Google", async () => {
        const { db } = makeDb([
            { data: writeRow({ status: "applied", op_kind: "create", result_event_id: "evt-new", send_updates: "all" }) }, // getCalendarWrite
            { data: { id: "undo-op" } }, // createAgentOperation (child)
            { data: {} }, // markCalendarWriteUndone
            { data: { id: "undo-op", status: "succeeded" } }, // updateAgentOperation
            { data: writeRow({ status: "undone", op_kind: "create", result_event_id: "evt-new" }) }, // getCalendarWrite (return)
        ]);
        const { connector, calls } = makeFakeConnector({});
        const res = await undoCalendarWriteNow(db, "cw-1", { userId: "user-1", connector });
        assert.equal(res.status, "undone");
        const del = calls.find((c) => c.m === "deleteEvent");
        assert.ok(del, "the created event is deleted");
        assert.equal(del?.eventId, "evt-new");
        assert.equal(del?.opts?.sendUpdates, "all", "attendees get cancellations");
    });

    console.log("calendar/apply.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
