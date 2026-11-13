// backend/src/lib/calendar/store.test.ts
//
// Pins the calendar_writes state-machine contract: the conditional UPDATE on
// status='pending_approval' is the mutex (two concurrent approvals can't both
// apply the same write, and a cancel can never clobber an already-applied
// write), and every read tolerates a missing schema (returns null/[]) so the
// routes degrade to 503/empty before migration 026 is applied. Scripted
// Supabase stub, no live database — mirrors email/store.test.ts.
import assert from "node:assert/strict";
import {
    claimCalendarWriteForApply,
    cancelPendingCalendarWrite,
    createCalendarWrite,
    getFirmCalendarId,
    setFirmCalendarId,
} from "./store";

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

function callsOf(chain: ChainLog, method: string) {
    return chain.calls.filter((c) => c.method === method);
}

const pendingWriteRow = {
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
    status: "applying",
    event_input: { summary: "Call" },
    prior_snapshot: null,
    result_event_id: null,
    send_updates: "all",
    error: null,
    applied_at: null,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
};

async function main(): Promise<void> {
    console.log("calendar/store.test.ts");

    await test("createCalendarWrite inserts a pending_approval row for an outward write", async () => {
        const { db, chains } = makeDb([
            { data: { ...pendingWriteRow, status: "pending_approval" } },
        ]);
        const write = await createCalendarWrite(db, {
            userId: "user-1",
            calendarId: "primary",
            opKind: "create",
            requiresApproval: true,
            status: "pending_approval",
            eventInput: { summary: "Call" },
            sendUpdates: "all",
            agentOperationId: "op-1",
        });
        assert.ok(write, "row returned");
        assert.equal(write?.status, "pending_approval");
        assert.equal(chains[0].table, "calendar_writes");
        const payload = callsOf(chains[0], "insert")[0].args[0] as Record<
            string,
            unknown
        >;
        assert.equal(payload.status, "pending_approval");
        assert.equal(payload.requires_approval, true);
        assert.equal(payload.calendar_id, "primary");
        assert.equal(payload.send_updates, "all");
    });

    await test("claimCalendarWriteForApply: WHERE on pending_approval is the mutex", async () => {
        const { db, chains } = makeDb([{ data: pendingWriteRow }]);
        const claimed = await claimCalendarWriteForApply(db, "cw-1");
        assert.ok(claimed, "matched pending row → claimed");
        assert.equal(claimed?.status, "applying");
        const payload = callsOf(chains[0], "update")[0].args[0] as Record<
            string,
            unknown
        >;
        assert.equal(payload.status, "applying", "flips to applying");
        assert.deepEqual(
            callsOf(chains[0], "eq").map((c) => c.args),
            [
                ["id", "cw-1"],
                ["status", "pending_approval"],
            ],
            "conditional UPDATE: id + still-pending — already-applying/applied rows never match",
        );
    });

    await test("claimCalendarWriteForApply: non-pending row → null, nothing applied twice", async () => {
        const { db } = makeDb([{ data: null }]);
        assert.equal(await claimCalendarWriteForApply(db, "cw-1"), null);
    });

    await test("cancelPendingCalendarWrite: guarded so an applied write is never clobbered", async () => {
        const { db, chains } = makeDb([
            { data: { ...pendingWriteRow, status: "cancelled" } },
        ]);
        const cancelled = await cancelPendingCalendarWrite(db, "cw-1");
        assert.equal(cancelled?.status, "cancelled");
        assert.deepEqual(
            callsOf(chains[0], "eq").map((c) => c.args),
            [
                ["id", "cw-1"],
                ["status", "pending_approval"],
            ],
            "only a still-pending write cancels",
        );
    });

    await test("cancelPendingCalendarWrite: already-applied → null (409 territory), nothing mutated", async () => {
        const { db } = makeDb([{ data: null }]);
        assert.equal(await cancelPendingCalendarWrite(db, "cw-1"), null);
    });

    await test("firm calendar id round-trips through calendar_sync_state; null when absent", async () => {
        const absent = makeDb([{ data: null }]);
        assert.equal(await getFirmCalendarId(absent.db), null);

        const present = makeDb([
            { data: { key: "firm_calendar_id", value: { calendar_id: "firmcal@g" } } },
        ]);
        assert.equal(await getFirmCalendarId(present.db), "firmcal@g");

        const write = makeDb([{ data: { key: "firm_calendar_id" } }]);
        await setFirmCalendarId(write.db, "firmcal@g");
        assert.equal(write.chains[0].table, "calendar_sync_state");
        assert.equal(callsOf(write.chains[0], "upsert").length, 1, "upsert used");
    });

    await test("missing schema degrades to null, not a throw", async () => {
        const { db } = makeDb([
            {
                error: {
                    code: "42P01",
                    message: 'relation "public.calendar_writes" does not exist',
                },
            },
        ]);
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            assert.equal(await claimCalendarWriteForApply(db, "cw-1"), null);
        } finally {
            if (prev === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = prev;
        }
    });

    console.log("calendar/store.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
