// backend/src/lib/recordings/scheduler.test.ts
//
// The recordings poll loop's contract, pinned with injected deps (no timers, no
// database): a tick takes the singleton recordings lease FIRST and does nothing
// when it loses; a won tick runs the stall sweep THEN processDueRecordings; and
// — the boot-resilience requirement — every step degrades to a logged no-op
// when the recordings tables don't exist yet (migration 025 unapplied), never a
// crash loop. startRecordingsScheduler is a hard no-op unless the worker is
// enabled (ASSEMBLYAI_API_KEY present) AND object storage is configured.
//
// The one deliberate divergence from the automation blueprint is asserted in
// testLeasedTickSweepsEveryWinningTick: the stall sweep runs on EVERY winning
// tick (it is the retry path for failed summarize steps), not boot-only.
//
// serializeTicks behaviour is already covered by automation/scheduler.test.ts —
// it is imported here, not re-tested.
import assert from "node:assert/strict";
import {
    pollOnce,
    startRecordingsScheduler,
    LEASE_TTL_FACTOR,
    RECORDINGS_PER_TICK,
    RECORDINGS_STALL_OLDER_THAN_MS,
    type RecordingsSchedulerDeps,
} from "./scheduler";

const noopLog: RecordingsSchedulerDeps["log"] = () => {};
const fakeDb = { __tag: "fake-db" } as never;

function baseDeps(
    overrides: Partial<RecordingsSchedulerDeps>,
): RecordingsSchedulerDeps {
    return {
        db: fakeDb,
        instanceId: "test-host:1",
        pollIntervalMs: 1000,
        acquireLease: async () => true,
        processDue: async () => ({ processed: 0, due: 0 }),
        sweepStalled: async () => 0,
        log: noopLog,
        ...overrides,
    };
}

// 1. Lease read throws (recordings_state missing — migration 025 unapplied):
//    the tick must degrade to a logged no-op mentioning 025, never propagate.
async function testLeaseThrowIsALoggedNoOp() {
    let touched = false;
    const warnings: string[] = [];
    const result = await pollOnce(
        baseDeps({
            acquireLease: async () => {
                throw Object.assign(new Error("recordings_state missing"), {
                    code: "42P01",
                });
            },
            sweepStalled: async () => {
                touched = true;
                return 0;
            },
            processDue: async () => {
                touched = true;
                return { processed: 0, due: 0 };
            },
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        }),
    );
    assert.equal(touched, false, "a lease error runs neither sweep nor process");
    assert.deepEqual(result, { leased: false, swept: null, due: null });
    assert.ok(warnings.length >= 1, "the skipped tick is logged, not silent");
    assert.ok(
        warnings.some((w) => w.includes("025")),
        "the lease-error log points at the unapplied 025 recordings tables",
    );
}

// 2. Lease lost (another instance holds it): the normal case — no work, and no
//    warning (a lost lease is not a problem).
async function testLeaseLostRunsNothingQuietly() {
    let touched = false;
    const warnings: string[] = [];
    const result = await pollOnce(
        baseDeps({
            acquireLease: async () => false,
            sweepStalled: async () => {
                touched = true;
                return 0;
            },
            processDue: async () => {
                touched = true;
                return { processed: 0, due: 0 };
            },
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        }),
    );
    assert.equal(touched, false, "lost lease → neither sweep nor process runs");
    assert.deepEqual(result, { leased: false, swept: null, due: null });
    assert.equal(
        warnings.length,
        0,
        "a lost lease is the normal case, not a logged problem",
    );
}

// 3. Won tick: lease, then stall sweep (with the 5-minute cutoff), then
//    processDue (limit 5), in that order — AND the sweep runs on EVERY winning
//    tick (the documented divergence from the boot-only automation blueprint).
async function testLeasedTickSweepsEveryWinningTick() {
    const calls: string[] = [];
    let sweepCount = 0;
    const deps = baseDeps({
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
        sweepStalled: async (db, opts) => {
            calls.push("sweep");
            sweepCount += 1;
            assert.equal(db, fakeDb);
            assert.deepEqual(
                opts,
                { olderThanMs: RECORDINGS_STALL_OLDER_THAN_MS },
                "the stall sweep uses the 5-minute cutoff",
            );
            return 0;
        },
        processDue: async (db, opts) => {
            calls.push("process");
            assert.equal(db, fakeDb);
            assert.deepEqual(
                opts,
                { limit: RECORDINGS_PER_TICK },
                "processDue takes 5 recordings per tick",
            );
            return { processed: 0, due: 2 };
        },
    });

    const first = await pollOnce(deps);
    assert.deepEqual(
        calls,
        ["lease", "sweep", "process"],
        "won tick: lease, then stall sweep, then processDue — in that order",
    );
    assert.deepEqual(first, { leased: true, swept: 0, due: 2 });

    // The divergence: unlike the automation scheduler (boot-only sweep), the
    // recordings sweep must fire again on the next winning tick — it is the
    // ONLY retry path for a row left at status='summarizing' by a failed
    // summarize step, which listDueRecordings cannot see.
    await pollOnce(deps);
    assert.equal(
        sweepCount,
        2,
        "the stall sweep runs on every winning tick, not once at boot",
    );
}

// 4. Step isolation: a sweep failure must not starve processDue, and a
//    processDue failure must be absorbed (the interval has to survive both).
async function testStepFailuresAreIsolatedAndAbsorbed() {
    let processed = false;
    const r1 = await pollOnce(
        baseDeps({
            sweepStalled: async () => {
                throw Object.assign(new Error("recordings missing"), {
                    code: "42P01",
                });
            },
            processDue: async () => {
                processed = true;
                return { processed: 1, due: 1 };
            },
        }),
    );
    assert.equal(processed, true, "processDue runs despite a sweep failure");
    assert.deepEqual(
        r1,
        { leased: true, swept: null, due: 1 },
        "a failed sweep is absorbed; processDue still reports",
    );

    const r2 = await pollOnce(
        baseDeps({
            sweepStalled: async () => 3,
            processDue: async () => {
                throw Object.assign(new Error("recordings missing"), {
                    code: "42P01",
                });
            },
        }),
    );
    assert.deepEqual(
        r2,
        { leased: true, swept: 3, due: null },
        "a processDue failure is absorbed — the interval must survive",
    );
}

// 5. Start gates, in order: worker disabled → silent null; key set but storage
//    off → warn + null; Supabase constructor throws → warn + null.
async function testStartGates() {
    // Gate 1: no ASSEMBLYAI_API_KEY → worker disabled → SILENT null.
    {
        let touched = false;
        const warnings: string[] = [];
        const handle = startRecordingsScheduler({
            env: {},
            db: fakeDb,
            storageEnabled: true,
            sweepStalled: async () => {
                touched = true;
                return 0;
            },
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        });
        assert.equal(handle, null, "no key → scheduler never starts");
        assert.equal(
            warnings.length,
            0,
            "the absent-key off state is silent, not a warning",
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(touched, false, "no boot sweep when disabled");
    }

    // Gate 2: key present but object storage off → WARN + null.
    {
        let touched = false;
        const warnings: string[] = [];
        const handle = startRecordingsScheduler({
            env: { ASSEMBLYAI_API_KEY: "sk-test" },
            db: fakeDb,
            storageEnabled: false,
            sweepStalled: async () => {
                touched = true;
                return 0;
            },
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        });
        assert.equal(handle, null, "key set but no R2 → declines to start");
        assert.ok(
            warnings.length >= 1,
            "the storage misconfiguration is logged (not silent)",
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(touched, false, "no boot sweep when storage is off");
    }

    // Gate 3: key + storage present, but createServerSupabase() throws (no
    // Supabase env and no injected db) → WARN + null, never a boot crash.
    {
        const saved = {
            SUPABASE_URL: process.env.SUPABASE_URL,
            SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
        };
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SECRET_KEY;
        try {
            const warnings: string[] = [];
            const handle = startRecordingsScheduler({
                env: { ASSEMBLYAI_API_KEY: "sk-test" },
                storageEnabled: true,
                log: (level, message) => {
                    if (level === "warn" || level === "error")
                        warnings.push(message);
                },
            });
            assert.equal(
                handle,
                null,
                "no Supabase → scheduler declines to start",
            );
            assert.ok(warnings.length >= 1, "the declined start is logged");
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    }
}

// 6. Successful start: the boot recovery sweep fires with the 5-minute cutoff,
//    a recovered>0 count is logged, and the interval drives pollOnce ticks.
async function testStartRunsBootSweepAndTicks() {
    let sweepArgs: { olderThanMs: number } | null = null;
    let leaseCalls = 0;
    const infos: string[] = [];
    const handle = startRecordingsScheduler({
        env: { ASSEMBLYAI_API_KEY: "sk-test" },
        storageEnabled: true,
        db: fakeDb,
        instanceId: "test-host:2",
        pollIntervalMs: 10, // direct override: bypasses the env 2000ms clamp
        acquireLease: async () => {
            leaseCalls += 1;
            return false; // lose every tick → only the BOOT sweep runs
        },
        processDue: async () => ({ processed: 0, due: 0 }),
        sweepStalled: async (db, opts) => {
            assert.equal(db, fakeDb);
            sweepArgs = opts;
            return 2;
        },
        log: (level, message) => {
            if (level === "info") infos.push(message);
        },
    });
    assert.ok(handle, "enabled + storage + supabase → scheduler starts");
    try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(
            sweepArgs,
            { olderThanMs: RECORDINGS_STALL_OLDER_THAN_MS },
            "boot recovery sweep uses the 5-minute stall cutoff",
        );
        assert.ok(
            infos.some((m) => m.includes("recovered") && m.includes("2")),
            "a recovered>0 boot sweep is logged with its count",
        );
        assert.ok(leaseCalls >= 1, "the interval drives pollOnce ticks");
    } finally {
        handle!.stop();
    }
}

// 7. stop() clears the interval: no ticks fire after it is called.
async function testStopClearsInterval() {
    let leaseCalls = 0;
    const handle = startRecordingsScheduler({
        env: { ASSEMBLYAI_API_KEY: "sk-test" },
        storageEnabled: true,
        db: fakeDb,
        pollIntervalMs: 10,
        acquireLease: async () => {
            leaseCalls += 1;
            return false;
        },
        processDue: async () => ({ processed: 0, due: 0 }),
        sweepStalled: async () => 0,
        log: noopLog,
    });
    assert.ok(handle, "scheduler starts");
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle!.stop();
    // Let any in-flight tick settle before snapshotting the count.
    await new Promise((resolve) => setImmediate(resolve));
    const afterStop = leaseCalls;
    assert.ok(afterStop >= 1, "ticks fired before stop()");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
        leaseCalls,
        afterStop,
        "stop() clears the interval — no further ticks",
    );
}

// 8. Boot probe: the one place the worker breaks the store's otherwise-silent
//    missing-schema tolerance. On a db whose recordings table is missing (a raw
//    select returns a 42P01), start logs the actionable "apply migration 025"
//    WARN once while STILL returning a working handle. A healthy db (select
//    returns rows, no error) stays silent — no boot-probe line on the happy path.
async function testBootProbeSurfacesMissingSchema() {
    const probeDb = (result: { data: unknown; error: unknown }) =>
        ({
            from: () => ({
                select: () => ({ limit: async () => result }),
            }),
        }) as never;

    // Missing schema → one WARN naming migration 025, and a working handle.
    {
        const warnings: string[] = [];
        const handle = startRecordingsScheduler({
            env: { ASSEMBLYAI_API_KEY: "sk-test" },
            storageEnabled: true,
            db: probeDb({ data: null, error: { code: "42P01" } }),
            pollIntervalMs: 10_000, // idle: the boot probe is the only db touch
            acquireLease: async () => false,
            processDue: async () => ({ processed: 0, due: 0 }),
            sweepStalled: async () => 0,
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        });
        assert.ok(handle, "a missing 025 schema still yields a working handle");
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.ok(
                warnings.some(
                    (w) =>
                        w.includes("recordings tables are missing") &&
                        w.includes("025"),
                ),
                "the boot probe warns that the 025 tables are missing",
            );
        } finally {
            handle!.stop();
        }
    }

    // Healthy schema → the boot probe stays silent (no happy-path line).
    {
        const warnings: string[] = [];
        const handle = startRecordingsScheduler({
            env: { ASSEMBLYAI_API_KEY: "sk-test" },
            storageEnabled: true,
            db: probeDb({ data: [], error: null }),
            pollIntervalMs: 10_000,
            acquireLease: async () => false,
            processDue: async () => ({ processed: 0, due: 0 }),
            sweepStalled: async () => 0,
            log: (level, message) => {
                if (level === "warn" || level === "error")
                    warnings.push(message);
            },
        });
        assert.ok(handle, "scheduler starts against a healthy db");
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.ok(
                !warnings.some((w) =>
                    w.includes("recordings tables are missing"),
                ),
                "a healthy boot probe logs no missing-schema warning",
            );
        } finally {
            handle!.stop();
        }
    }
}

async function main() {
    await testLeaseThrowIsALoggedNoOp();
    await testLeaseLostRunsNothingQuietly();
    await testLeasedTickSweepsEveryWinningTick();
    await testStepFailuresAreIsolatedAndAbsorbed();
    await testStartGates();
    await testStartRunsBootSweepAndTicks();
    await testStopClearsInterval();
    await testBootProbeSurfacesMissingSchema();
    console.log("recordings/scheduler.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
