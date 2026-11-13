// backend/src/lib/automation/runsStore.test.ts
//
// The automation_runs store is the state machine under the phase-4 pipeline;
// what these tests pin is its concurrency contract, mirroring
// signatures/store.test.ts: for claimRunStep and acquireSchedulerLease the
// conditional WHERE clause IS the mutex, for enqueueRun the unique-violation
// fallback IS the exactly-one-run-per-email guarantee. Scripted Supabase
// stubs only — no live database.
import assert from "node:assert/strict";
import {
    REQUEUEABLE_RUN_STATUSES,
    SCHEDULER_LEASE_KEY,
    WORKING_RUN_STATUSES,
    acquireSchedulerLease,
    claimRunStep,
    countRunsByStatus,
    enqueueRun,
    isLeaseClaimable,
    isMissingAutomationSchema,
    listDueRuns,
    listRuns,
    markStalledRunsQueued,
    requeueRun,
    scheduleRetry,
} from "./runsStore";
import { RUN_STATUSES } from "./types";

// Scripted chainable Supabase stub: each db.from() consumes the next scripted
// result; every builder call is recorded so tests can pin tables, filters and
// payloads. Terminal reads (single / maybeSingle / awaiting the chain itself)
// resolve to the scripted {data, error}.
interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown; count?: number }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown; count?: number },
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
            count: result.count ?? null,
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

// claimRunStep is the per-step mutex: two schedulers ticking the same run must
// resolve to a single winner via the conditional UPDATE (id + status=from).
async function testClaimRunStepWinner() {
    const { db, chains } = makeDb([{ data: { id: "run-1" } }]);
    const won = await claimRunStep(db, "run-1", "queued", "classifying");
    assert.equal(won, true, "matched row → this caller won the claim");

    assert.equal(chains[0].table, "automation_runs");
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.deepEqual(
        Object.keys(payload).sort(),
        ["status", "updated_at"],
        "the claim flips ONLY status (updated_at bump is the stall marker)",
    );
    assert.equal(payload.status, "classifying");
    assert.equal(typeof payload.updated_at, "string");
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["id", "run-1"],
            ["status", "queued"],
        ],
        "the WHERE clause is the mutex: id match + status still `from`",
    );
}

async function testClaimRunStepLoser() {
    const lost = await claimRunStep(
        makeDb([{ data: null }]).db,
        "run-1",
        "queued",
        "classifying",
    );
    assert.equal(lost, false, "no row matched → claim lost, not a throw");
}

// enqueueRun: exactly one run per email, enforced by the unique index on
// email_id — the loser of an insert race must return the existing run.
async function testEnqueueRunInsertWins() {
    const { db, chains } = makeDb([{ data: { id: "run-1" } }]);
    const result = await enqueueRun(db, {
        emailId: "email-1",
        userId: "user-1",
    });
    assert.deepEqual(result, { id: "run-1", created: true });

    assert.equal(chains[0].table, "automation_runs");
    const payload = callsOf(chains[0], "insert")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.deepEqual(payload, {
        user_id: "user-1",
        email_id: "email-1",
        status: "queued",
    });
}

async function testEnqueueRunDuplicateFetchesExisting() {
    const { db, chains } = makeDb([
        { error: { code: "23505", message: "duplicate key" } },
        { data: { id: "run-9", user_id: "user-1", email_id: "email-1" } },
    ]);
    const result = await enqueueRun(db, {
        emailId: "email-1",
        userId: "user-1",
    });
    assert.deepEqual(result, { id: "run-9", created: false });
    assert.deepEqual(
        callsOf(chains[1], "eq")[0].args,
        ["email_id", "email-1"],
        "the fallback fetch resolves by the conflicting email_id",
    );
}

async function testEnqueueRunUnexpectedErrorThrows() {
    await assert.rejects(
        enqueueRun(makeDb([{ error: { code: "XX000", message: "boom" } }]).db, {
            emailId: "email-1",
            userId: "user-1",
        }),
        (err: unknown) =>
            (err as { message?: string }).message === "boom" ||
            /boom/.test(String((err as { message?: string }).message)),
    );
}

// isLeaseClaimable is the pure expiry decision under acquireSchedulerLease.
function testIsLeaseClaimable() {
    const now = Date.parse("2026-07-16T12:00:00Z");
    assert.equal(isLeaseClaimable(null, "me", now), true, "no lease row yet");
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "me", claimed_until: "2026-07-16T12:05:00Z" },
            "me",
            now,
        ),
        true,
        "an instance can always renew its own live lease",
    );
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "other", claimed_until: "2026-07-16T12:05:00Z" },
            "me",
            now,
        ),
        false,
        "another live holder → not claimable",
    );
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "other", claimed_until: "2026-07-16T11:59:59Z" },
            "me",
            now,
        ),
        true,
        "expired lease → claimable",
    );
    assert.equal(
        isLeaseClaimable({ claimed_by: "other", claimed_until: null }, "me", now),
        true,
        "a lease without expiry can never wedge the scheduler forever",
    );
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "other", claimed_until: "not-a-date" },
            "me",
            now,
        ),
        true,
        "malformed expiry is treated as free, not as a permanent lock",
    );
}

async function testAcquireLeaseInsertsWhenAbsent() {
    const { db, chains } = makeDb([
        { data: null }, // no lease row yet
        {}, // insert succeeds
    ]);
    const got = await acquireSchedulerLease(db, "worker-a", 30_000);
    assert.equal(got, true);

    assert.equal(chains[1].table, "automation_state");
    const payload = callsOf(chains[1], "insert")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.key, SCHEDULER_LEASE_KEY);
    assert.equal(payload.claimed_by, "worker-a");
    assert.equal(typeof payload.claimed_until, "string");
}

async function testAcquireLeaseRacedInsertLoses() {
    const { db } = makeDb([
        { data: null },
        { error: { code: "23505", message: "duplicate key" } },
    ]);
    assert.equal(
        await acquireSchedulerLease(db, "worker-a", 30_000),
        false,
        "losing the create race means another instance holds the lease",
    );
}

async function testAcquireLeaseRespectsLiveHolder() {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { db, chains } = makeDb([
        {
            data: {
                claimed_by: "worker-b",
                claimed_until: future,
                updated_at: "2026-07-16T11:59:00+00:00",
            },
        },
    ]);
    assert.equal(await acquireSchedulerLease(db, "worker-a", 30_000), false);
    assert.equal(chains.length, 1, "a live foreign lease → read only, no write");
}

async function testAcquireLeaseStealsExpiredViaCas() {
    const past = new Date(Date.now() - 60_000).toISOString();
    const readRow = {
        claimed_by: "worker-b",
        claimed_until: past,
        updated_at: "2026-07-16T11:00:00+00:00",
    };
    const { db, chains } = makeDb([
        { data: readRow },
        { data: { key: "scheduler_lease" } }, // CAS update matched
    ]);
    assert.equal(await acquireSchedulerLease(db, "worker-a", 30_000), true);

    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.claimed_by, "worker-a");
    assert.equal(typeof payload.claimed_until, "string");
    assert.deepEqual(
        callsOf(chains[1], "eq").map((c) => c.args),
        [
            ["key", SCHEDULER_LEASE_KEY],
            ["updated_at", readRow.updated_at],
        ],
        "the takeover is CAS-guarded on updated_at: only steal what nobody moved",
    );

    // Same read, but the conditional update matches nothing (another instance
    // won the CAS between our read and write) → lease not acquired.
    const lost = makeDb([{ data: readRow }, { data: null }]);
    assert.equal(
        await acquireSchedulerLease(lost.db, "worker-a", 30_000),
        false,
    );
}

async function testMarkStalledRunsQueued() {
    const { db, chains } = makeDb([{ data: [{ id: "a" }, { id: "b" }] }]);
    const recovered = await markStalledRunsQueued(db, {
        olderThanMs: 10 * 60_000,
    });
    assert.equal(recovered, 2);

    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.status, "queued");
    assert.ok(
        !("retry_count" in payload),
        "recovery re-queues without consuming a retry",
    );
    assert.deepEqual(
        callsOf(chains[0], "in")[0].args,
        ["status", ["classifying", "extracting", "matching", "staging"]],
        "only non-terminal WORKING statuses are swept — staged/terminal rows are untouchable",
    );
    const lt = callsOf(chains[0], "lt")[0];
    assert.equal(lt.args[0], "updated_at");
    const cutoff = Date.parse(String(lt.args[1]));
    assert.ok(
        Number.isFinite(cutoff) && cutoff <= Date.now() - 10 * 60_000 + 1000,
        "cutoff is roughly now - olderThanMs",
    );
    assert.deepEqual(WORKING_RUN_STATUSES, [
        "classifying",
        "extracting",
        "matching",
        "staging",
    ]);
}

async function testListDueRunsFiltersAndOrder() {
    const row = {
        id: "run-1",
        user_id: "user-1",
        email_id: "email-1",
        status: "queued",
        created_at: "2026-07-16T11:00:00+00:00",
        updated_at: "2026-07-16T11:00:00+00:00",
    };
    const { db, chains } = makeDb([{ data: [row] }]);
    const due = await listDueRuns(db, { limit: 5 });
    assert.equal(due.length, 1);
    assert.equal(due[0].id, "run-1");
    assert.deepEqual(due[0].operation_ids, [], "jsonb defaults normalized");
    assert.deepEqual(due[0].extracted, {});

    assert.deepEqual(callsOf(chains[0], "eq")[0].args, ["status", "queued"]);
    assert.match(
        String(callsOf(chains[0], "or")[0].args[0]),
        /^next_attempt_at\.is\.null,next_attempt_at\.lte\./,
        "due = never scheduled OR scheduled time reached",
    );
    assert.deepEqual(
        callsOf(chains[0], "order")[0].args,
        ["created_at", { ascending: true }],
        "oldest first",
    );
    assert.deepEqual(callsOf(chains[0], "limit")[0].args, [5]);
}

async function testScheduleRetry() {
    const { db, chains } = makeDb([{}]);
    const before = Date.now();
    await scheduleRetry(db, "run-1", {
        error: "carrier page timed out",
        retryCount: 3,
        delayMs: 120_000,
    });
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.status, "queued");
    assert.equal(payload.retry_count, 3);
    assert.equal(payload.error, "carrier page timed out");
    const at = Date.parse(String(payload.next_attempt_at));
    assert.ok(
        at >= before + 120_000 && at <= Date.now() + 121_000,
        "next attempt lands ~delayMs in the future",
    );
    assert.deepEqual(callsOf(chains[0], "eq")[0].args, ["id", "run-1"]);
}

// requeueRun is the operator's forced retry (POST /automation/runs/:id/retry):
// same conditional-UPDATE-as-mutex shape as claimRunStep, but FROM a set of
// terminal-ish statuses (failed/triage) — a run that moved on (approved,
// rejected, already requeued) matches nothing and the caller gets null, not
// a clobbered state.
async function testRequeueRunCasShape() {
    const row = {
        id: "run-1",
        user_id: "user-1",
        email_id: "email-1",
        workflow_kind: "vendor_invoice",
        status: "queued",
        case_id: null,
        match_method: null,
        match_confidence: null,
        extracted: {},
        citations: [],
        confidence: null,
        verification: {},
        proposal: {},
        ack_email_id: null,
        operation_ids: [],
        error: null,
        retry_count: 2,
        next_attempt_at: null,
        triage_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: "2026-07-16T00:00:00Z",
        updated_at: "2026-07-16T00:00:00Z",
    };
    const { db, chains } = makeDb([{ data: row }]);
    const requeued = await requeueRun(db, "run-1", REQUEUEABLE_RUN_STATUSES);
    assert.ok(requeued, "matched row → the requeue won");
    assert.equal(requeued?.status, "queued");

    assert.equal(chains[0].table, "automation_runs");
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.deepEqual(
        Object.keys(payload).sort(),
        ["error", "next_attempt_at", "status", "triage_reason", "updated_at"],
        "requeue resets status/backoff/error/triage_reason and nothing else",
    );
    assert.equal(payload.status, "queued");
    assert.equal(payload.next_attempt_at, null, "backoff cleared → due now");
    assert.equal(payload.error, null);
    assert.equal(payload.triage_reason, null);
    assert.ok(
        !("retry_count" in payload),
        "retry_count is history, not reset by a forced retry",
    );
    assert.deepEqual(callsOf(chains[0], "eq")[0].args, ["id", "run-1"]);
    assert.deepEqual(
        callsOf(chains[0], "in")[0].args,
        [["status", ["failed", "triage"]]][0],
        "the WHERE on the from-statuses is the mutex (claimRunStep semantics)",
    );
}

async function testRequeueRunLostCas() {
    const requeued = await requeueRun(
        makeDb([{ data: null }]).db,
        "run-1",
        REQUEUEABLE_RUN_STATUSES,
    );
    assert.equal(requeued, null, "no row in a from-status → null, not a throw");
}

// listRuns grew a case_id filter for GET /cases/:id (the runs panel of the
// case detail view) — additive, and always still scoped to the owner.
async function testListRunsCaseIdFilter() {
    const { db, chains } = makeDb([{ data: [] }]);
    await listRuns(db, "user-1", { caseId: "case-9", limit: 10 });
    const eqs = callsOf(chains[0], "eq").map((c) => c.args);
    assert.deepEqual(eqs[0], ["user_id", "user-1"], "tenancy filter first");
    assert.ok(
        eqs.some(
            (args) => args[0] === "case_id" && args[1] === "case-9",
        ),
        "case_id filter applied",
    );
}

// countRunsByStatus powers GET /automation/status: one exact head-count per
// status, every one of them tenancy-scoped.
async function testCountRunsByStatus() {
    const script = RUN_STATUSES.map((status) => ({
        count: status === "queued" ? 3 : status === "staged" ? 1 : 0,
    }));
    const { db, chains } = makeDb(script);
    const counts = await countRunsByStatus(db, "user-1");
    assert.equal(counts.queued, 3);
    assert.equal(counts.staged, 1);
    assert.equal(counts.approved, 0);
    assert.equal(chains.length, RUN_STATUSES.length);
    for (const chain of chains) {
        assert.equal(chain.table, "automation_runs");
        const eqs = callsOf(chain, "eq").map((c) => c.args);
        assert.deepEqual(eqs[0], ["user_id", "user-1"], "every count is tenancy-scoped");
        assert.equal(eqs[1]?.[0], "status");
    }
}

// isMissingAutomationSchema is what lets the /automation routes degrade to
// zeros + schema_ready:false on a database where migration 023 is unapplied,
// instead of 500-ing (mirrors lib/email/store.ts's tolerance codes).
function testIsMissingAutomationSchema() {
    assert.equal(isMissingAutomationSchema({ code: "42P01" }), true);
    assert.equal(isMissingAutomationSchema({ code: "PGRST205" }), true);
    assert.equal(isMissingAutomationSchema({ code: "PGRST204" }), true);
    assert.equal(isMissingAutomationSchema({ code: "42703" }), true);
    assert.equal(
        isMissingAutomationSchema({
            message: 'relation "public.automation_runs" does not exist',
        }),
        true,
    );
    assert.equal(
        isMissingAutomationSchema({
            message: "Could not find the table 'public.automation_state' in the schema cache",
        }),
        true,
    );
    assert.equal(
        isMissingAutomationSchema(new Error("connection refused")),
        false,
        "a real outage is NOT a missing schema — it must surface",
    );
    assert.equal(isMissingAutomationSchema(null), false);
    assert.equal(isMissingAutomationSchema("42P01"), false);
}

async function main() {
    await testClaimRunStepWinner();
    await testClaimRunStepLoser();
    await testEnqueueRunInsertWins();
    await testEnqueueRunDuplicateFetchesExisting();
    await testEnqueueRunUnexpectedErrorThrows();
    testIsLeaseClaimable();
    await testAcquireLeaseInsertsWhenAbsent();
    await testAcquireLeaseRacedInsertLoses();
    await testAcquireLeaseRespectsLiveHolder();
    await testAcquireLeaseStealsExpiredViaCas();
    await testMarkStalledRunsQueued();
    await testListDueRunsFiltersAndOrder();
    await testScheduleRetry();
    await testRequeueRunCasShape();
    await testRequeueRunLostCas();
    await testListRunsCaseIdFilter();
    await testCountRunsByStatus();
    testIsMissingAutomationSchema();
    console.log("automation/runsStore.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
