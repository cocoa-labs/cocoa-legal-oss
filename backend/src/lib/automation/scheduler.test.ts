// backend/src/lib/automation/scheduler.test.ts
//
// The scheduler skeleton's contract, pinned with injected deps (no timers, no
// database): a tick takes the singleton lease FIRST and does nothing when it
// loses; a won tick runs cursor-mode ingest then processDueRuns; and — the
// boot-resilience requirement — every step degrades to a logged no-op when
// the automation tables don't exist yet (migration 023 unapplied), never a
// crash loop. startAutomationScheduler is a hard no-op unless
// AUTOMATION_ENABLED=true.
import assert from "node:assert/strict";
import {
    pollOnce,
    serializeTicks,
    shouldReconcile,
    startAutomationScheduler,
    LEASE_TTL_FACTOR,
    RUNS_PER_TICK,
    STALL_SWEEP_OLDER_THAN_MS,
    type SchedulerDeps,
} from "./scheduler";

const noopLog: SchedulerDeps["log"] = () => {};
const fakeDb = { __tag: "fake-db" } as never;

function baseDeps(overrides: Partial<SchedulerDeps>): SchedulerDeps {
    return {
        db: fakeDb,
        instanceId: "test-host:1",
        pollIntervalMs: 1000,
        acquireLease: async () => true,
        ingest: async () => ({ ingested: 0 }),
        processDueRuns: async () => ({ processed: 0, due: 0 }),
        sweepStalled: async () => 0,
        log: noopLog,
        ...overrides,
    };
}

async function testLeaseWonRunsIngestThenProcess() {
    const calls: string[] = [];
    const result = await pollOnce(
        baseDeps({
            acquireLease: async (db, instanceId, ttlMs) => {
                calls.push("lease");
                assert.equal(db, fakeDb, "lease uses the injected db");
                assert.equal(instanceId, "test-host:1");
                assert.equal(
                    ttlMs,
                    Math.round(1000 * LEASE_TTL_FACTOR),
                    "lease TTL is 2.5 × the poll interval",
                );
                return true;
            },
            ingest: async (opts) => {
                calls.push("ingest");
                assert.deepEqual(
                    opts,
                    { useCursor: true },
                    "scheduler ingest runs in cursor mode",
                );
                return { ingested: 2 };
            },
            processDueRuns: async (db, opts) => {
                calls.push("process");
                assert.equal(db, fakeDb);
                assert.deepEqual(opts, { limit: RUNS_PER_TICK });
                return { processed: 0, due: 3 };
            },
        }),
    );
    assert.deepEqual(
        calls,
        ["lease", "ingest", "process"],
        "won tick: lease, then ingest, then processDueRuns — in that order",
    );
    assert.deepEqual(result, { leased: true, ingested: 2, due: 3 });
}

async function testLeaseLostRunsNothing() {
    let touched = false;
    const result = await pollOnce(
        baseDeps({
            acquireLease: async () => false,
            ingest: async () => {
                touched = true;
                return { ingested: 0 };
            },
            processDueRuns: async () => {
                touched = true;
                return { processed: 0, due: 0 };
            },
        }),
    );
    assert.equal(touched, false, "lost lease → neither ingest nor process runs");
    assert.deepEqual(result, { leased: false, ingested: null, due: null });
}

async function testLeaseThrowIsALoggedNoOp() {
    // automation_state does not exist yet (migration 023 unapplied): the lease
    // read throws. The tick must degrade to a logged no-op — never propagate.
    let touched = false;
    const warnings: string[] = [];
    const result = await pollOnce(
        baseDeps({
            acquireLease: async () => {
                throw Object.assign(new Error("automation_state missing"), {
                    code: "42P01",
                });
            },
            ingest: async () => {
                touched = true;
                return { ingested: 0 };
            },
            processDueRuns: async () => {
                touched = true;
                return { processed: 0, due: 0 };
            },
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        }),
    );
    assert.equal(touched, false);
    assert.deepEqual(result, { leased: false, ingested: null, due: null });
    assert.ok(warnings.length >= 1, "the skipped tick is logged, not silent");
}

async function testIngestFailureStillProcessesRuns() {
    // One step's failure must not starve the other: already-enqueued runs are
    // still listed when ingest breaks, and vice versa.
    let processed = false;
    const result = await pollOnce(
        baseDeps({
            ingest: async () => {
                throw new Error("gmail unreachable");
            },
            processDueRuns: async () => {
                processed = true;
                return { processed: 0, due: 1 };
            },
        }),
    );
    assert.equal(processed, true, "processDueRuns runs despite ingest failure");
    assert.deepEqual(result, { leased: true, ingested: null, due: 1 });
}

async function testProcessFailureDoesNotThrow() {
    const result = await pollOnce(
        baseDeps({
            ingest: async () => ({ ingested: 1 }),
            processDueRuns: async () => {
                throw Object.assign(new Error("automation_runs missing"), {
                    code: "42P01",
                });
            },
        }),
    );
    assert.deepEqual(
        result,
        { leased: true, ingested: 1, due: null },
        "a processDueRuns failure is absorbed — the interval must survive",
    );
}

async function testStartIsNoOpWhenDisabled() {
    let touched = false;
    const handle = startAutomationScheduler({
        env: {},
        db: fakeDb,
        sweepStalled: async () => {
            touched = true;
            return 0;
        },
        log: noopLog,
    });
    assert.equal(handle, null, "disabled env → scheduler never starts");
    // The recovery sweep is part of scheduler startup — it must not run either.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(touched, false, "no boot sweep when disabled");
}

async function testStartRunsRecoverySweepAndTicks() {
    let sweepArgs: { olderThanMs: number } | null = null;
    let leaseCalls = 0;
    const handle = startAutomationScheduler({
        env: { AUTOMATION_ENABLED: "true", AUTOMATION_POLL_INTERVAL_MS: "10" },
        db: fakeDb,
        instanceId: "test-host:2",
        acquireLease: async () => {
            leaseCalls += 1;
            return false;
        },
        ingest: async () => ({ ingested: 0 }),
        processDueRuns: async () => ({ processed: 0, due: 0 }),
        sweepStalled: async (db, opts) => {
            assert.equal(db, fakeDb);
            sweepArgs = opts;
            return 2;
        },
        log: noopLog,
    });
    assert.ok(handle, "enabled env → scheduler starts");
    try {
        // Wait long enough for the boot sweep and at least one interval tick.
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(
            sweepArgs,
            { olderThanMs: STALL_SWEEP_OLDER_THAN_MS },
            "boot recovery sweep uses the 5-minute stall cutoff",
        );
        assert.ok(leaseCalls >= 1, "the interval drives pollOnce ticks");
    } finally {
        handle!.stop();
    }
}

async function testBootSweepFailureIsSwallowed() {
    // Node crashes the process on an unhandled rejection, so this test fails
    // loudly if the sweep's rejection ever escapes the scheduler.
    const warnings: string[] = [];
    const handle = startAutomationScheduler({
        env: { AUTOMATION_ENABLED: "true", AUTOMATION_POLL_INTERVAL_MS: "60000" },
        db: fakeDb,
        acquireLease: async () => false,
        ingest: async () => ({ ingested: 0 }),
        processDueRuns: async () => ({ processed: 0, due: 0 }),
        sweepStalled: async () => {
            throw Object.assign(new Error("automation_runs missing"), {
                code: "42P01",
            });
        },
        log: (level, message) => {
            if (level === "warn" || level === "error") warnings.push(message);
        },
    });
    assert.ok(handle, "a failed sweep must not prevent the scheduler starting");
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(warnings.length >= 1, "the failed sweep is logged");
    } finally {
        handle!.stop();
    }
}

async function testStartWithoutSupabaseIsALoggedNoOp() {
    // Enabled, but no db injected and Supabase env absent:
    // createServerSupabase() throws — startup must degrade to a logged no-op.
    const saved = {
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    try {
        const warnings: string[] = [];
        const handle = startAutomationScheduler({
            env: { AUTOMATION_ENABLED: "true" },
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        });
        assert.equal(handle, null, "no Supabase → scheduler declines to start");
        assert.ok(warnings.length >= 1, "the declined start is logged");
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

// Reconciliation sweep: every Nth tick swaps the cursor walk for the 2-day
// query scan, healing any message a transient getMessage failure skipped
// (cursor-mode history walks never re-list a message once the cursor moves
// past it). Pure tick-counting decision.
function testShouldReconcile() {
    assert.equal(shouldReconcile(1, 30), false);
    assert.equal(shouldReconcile(29, 30), false);
    assert.equal(shouldReconcile(30, 30), true, "every Nth tick reconciles");
    assert.equal(shouldReconcile(60, 30), true);
    assert.equal(shouldReconcile(31, 30), false);
    assert.equal(shouldReconcile(1, 1), true, "N=1 → reconcile every tick");
    assert.equal(shouldReconcile(2, 1), true);
    assert.equal(
        shouldReconcile(30, 0),
        false,
        "a non-positive cadence disables reconciliation instead of dividing by zero",
    );
    assert.equal(shouldReconcile(30, -5), false);
}

async function testReconcileTickUsesQueryModeIngest() {
    const modes: boolean[] = [];
    const deps = baseDeps({
        ingest: async (opts) => {
            modes.push(opts.useCursor);
            return { ingested: 0 };
        },
    });
    await pollOnce(deps); // default: cursor walk
    await pollOnce(deps, { reconcile: true }); // reconciliation sweep
    await pollOnce(deps, { reconcile: false });
    assert.deepEqual(
        modes,
        [true, false, true],
        "a reconcile tick runs the 2-day query scan INSTEAD of the cursor walk",
    );
}

// Re-entrancy guard: setInterval can fire while the previous tick is still
// running (slow batch) — the wrapped runner must skip, log, and recover.
async function testSerializeTicksSkipsOverlappingRuns() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let runs = 0;
    let skips = 0;
    const tick = serializeTicks(
        async () => {
            runs += 1;
            await gate;
        },
        () => {
            skips += 1;
        },
    );

    const first = tick(); // starts, blocks on the gate
    await tick(); // fires while the first is in flight → skipped
    await tick(); // still in flight → skipped
    assert.equal(runs, 1, "only the first tick actually ran");
    assert.equal(skips, 2, "overlapping ticks were skipped (and reported)");

    release();
    await first;
    await tick(); // the guard clears once the in-flight tick resolves
    assert.equal(runs, 2, "after completion the next tick runs again");
    assert.equal(skips, 2);
}

async function testSerializeTicksClearsGuardOnRejection() {
    let attempts = 0;
    const tick = serializeTicks(
        async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("tick crashed");
        },
        () => {},
    );
    await tick(); // rejection must be contained AND clear the running flag
    await tick();
    assert.equal(
        attempts,
        2,
        "a crashed tick releases the guard in finally — no permanent wedge",
    );
}

async function main() {
    await testLeaseWonRunsIngestThenProcess();
    await testLeaseLostRunsNothing();
    await testLeaseThrowIsALoggedNoOp();
    await testIngestFailureStillProcessesRuns();
    await testProcessFailureDoesNotThrow();
    await testStartIsNoOpWhenDisabled();
    await testStartRunsRecoverySweepAndTicks();
    await testBootSweepFailureIsSwallowed();
    await testStartWithoutSupabaseIsALoggedNoOp();
    testShouldReconcile();
    await testReconcileTickUsesQueryModeIngest();
    await testSerializeTicksSkipsOverlappingRuns();
    await testSerializeTicksClearsGuardOnRejection();
    console.log("automation/scheduler.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
