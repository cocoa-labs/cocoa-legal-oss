// backend/src/lib/recordings/scheduler.ts
//
// Env-gated background poll loop for the Recordings & transcription pipeline.
// Started once from index.ts after the server begins listening; a hard no-op
// unless the worker is enabled (recordingsWorkerEnabled — i.e. ASSEMBLYAI_API_KEY
// is present) AND object storage (R2) is configured. Each tick takes the
// singleton lease in recordings_state (so exactly one instance polls, however
// many are deployed) and, when it wins, sweeps stalled rows then runs
// processDueRecordings. Fully independent of the PI automation loop — its own
// lease row, its own enable switch; it never gates on AUTOMATION_ENABLED.
//
// Boot resilience is a hard requirement: migration 025 may not be applied in a
// given environment, so the boot sweep and EVERY poll step degrade to a logged
// no-op — never a crash loop and never an unhandled rejection. The interval is
// .unref()'d (same discipline as the automation scheduler) so the timer can
// never by itself hold the process open. serializeTicks is IMPORTED from the
// automation module (shared re-entrancy discipline), not re-implemented.
//
// DELIBERATE DIVERGENCE FROM THE AUTOMATION BLUEPRINT (required, from the T5
// review): the automation scheduler sweeps stalled runs at boot ONLY. The
// recordings loop ALSO runs the stall sweep on every winning tick — see pollOnce
// for the constraint that forces it.

import os from "node:os";

import { createServerSupabase } from "../supabase";
import { storageEnabled } from "../storage";
import { serializeTicks } from "../automation/scheduler";
import { recordingsWorkerEnabled, recordingsPollIntervalMs } from "./env";
import {
    acquireRecordingsLease,
    isMissingRecordingsSchema,
    markStalledRecordingsQueued,
} from "./store";
import { processDueRecordings } from "./pipeline";

type Db = ReturnType<typeof createServerSupabase>;

/** Recordings handed to processDueRecordings per tick. */
export const RECORDINGS_PER_TICK = 5;

/**
 * Lease TTL as a multiple of the poll interval: long enough that a healthy
 * holder always renews before expiry (2 ticks + slack), short enough that a
 * dead holder is displaced within ~2.5 intervals.
 */
export const LEASE_TTL_FACTOR = 2.5;

/** A working-status recording untouched this long was abandoned by a dead worker. */
export const RECORDINGS_STALL_OLDER_THAN_MS = 5 * 60_000;

export interface RecordingsSchedulerDeps {
    db: Db;
    /** Identifies this process in the lease row (hostname:pid by default). */
    instanceId: string;
    pollIntervalMs: number;
    acquireLease: (
        db: Db,
        instanceId: string,
        ttlMs: number,
    ) => Promise<boolean>;
    processDue: (
        db: Db,
        opts: { limit: number },
    ) => Promise<{ processed: number; due: number }>;
    sweepStalled: (db: Db, opts: { olderThanMs: number }) => Promise<number>;
    log: (
        level: "info" | "warn" | "error",
        message: string,
        extra?: unknown,
    ) => void;
}

/** Repo logging convention: console.* with a subsystem prefix. */
function defaultLog(
    level: "info" | "warn" | "error",
    message: string,
    extra?: unknown,
): void {
    const line = `[recordings] ${message}`;
    const args = extra === undefined ? [line] : [line, extra];
    if (level === "info") console.log(...args);
    else if (level === "warn") console.warn(...args);
    else console.error(...args);
}

export interface PollOnceResult {
    /** Whether this tick won the scheduler lease. */
    leased: boolean;
    /** Recordings recovered by the stall sweep (null when the lease was lost
     * or the sweep failed). */
    swept: number | null;
    /** Due recordings reported (null when the lease was lost or the list failed). */
    due: number | null;
}

/**
 * One scheduler tick. Never rejects: every step is individually wrapped so one
 * failure (recordings tables missing, LLM down, …) is a logged skip — a
 * rejection here would otherwise kill the interval or crash the process.
 * Exported with injected deps so tests drive a tick without timers.
 */
export async function pollOnce(
    deps: RecordingsSchedulerDeps,
): Promise<PollOnceResult> {
    let leased = false;
    try {
        leased = await deps.acquireLease(
            deps.db,
            deps.instanceId,
            Math.round(deps.pollIntervalMs * LEASE_TTL_FACTOR),
        );
    } catch (err) {
        // Typical cause: recordings_state does not exist yet (migration 025
        // unapplied). The tick must be a logged no-op, never a crash loop.
        deps.log(
            "warn",
            "scheduler lease unavailable; skipping tick (are the 025 recordings tables applied?)",
            err,
        );
        return { leased: false, swept: null, due: null };
    }
    if (!leased) return { leased: false, swept: null, due: null };

    // DIVERGENCE FROM THE AUTOMATION BLUEPRINT (required by the T5 review): the
    // stall sweep runs on EVERY winning tick here, not only at boot. A failed
    // summarize step leaves the row at status='summarizing', which
    // listDueRecordings CANNOT see — so the periodic sweep is the ONLY path that
    // returns it to 'queued'. It is therefore the retry mechanism for the
    // summarize stage, and the stall cutoff IS the summarize retry cadence.
    // Wrapped independently so a missing 025 schema degrades to a logged skip
    // and never starves processDue.
    let swept: number | null = null;
    try {
        const recovered = await deps.sweepStalled(deps.db, {
            olderThanMs: RECORDINGS_STALL_OLDER_THAN_MS,
        });
        swept = recovered;
        if (recovered > 0) {
            deps.log(
                "info",
                `recovered ${recovered} stalled recording(s) back to queued`,
            );
        }
    } catch (err) {
        deps.log(
            "warn",
            "stalled-recording sweep failed on this tick (are the 025 recordings tables applied?)",
            err,
        );
    }

    let due: number | null = null;
    try {
        const result = await deps.processDue(deps.db, {
            limit: RECORDINGS_PER_TICK,
        });
        due = result.due;
        if (result.due > 0) {
            deps.log(
                "info",
                `${result.due} recording(s) due, ${result.processed} processed`,
            );
        }
    } catch (err) {
        deps.log("warn", "processDueRecordings failed on this tick", err);
    }

    return { leased: true, swept, due };
}

/**
 * Start the recordings scheduler. Returns a stop handle, or null when it
 * declines to start. Must never throw — it is called from the boot path.
 *
 * Gate order:
 *  1. worker disabled (no ASSEMBLYAI_API_KEY) → silent null (the normal off state)
 *  2. object storage not configured → warn + null (key set but no R2 is a misconfig)
 *  3. Supabase unusable → warn + null (bare dev boot; decline, don't crash)
 */
export function startRecordingsScheduler(
    overrides?: Partial<RecordingsSchedulerDeps> & {
        env?: NodeJS.ProcessEnv;
        storageEnabled?: boolean;
    },
): { stop: () => void } | null {
    const env = overrides?.env ?? process.env;
    const log = overrides?.log ?? defaultLog;

    // Gate 1: worker off. A missing key is the normal off state — stay silent.
    if (!recordingsWorkerEnabled(env)) return null;

    // Gate 2: enabled but no object storage. The pipeline persists the
    // transcript PDF (and audio) to R2, so a missing bucket is a
    // misconfiguration worth a log — not the silent off state.
    const storageOk = overrides?.storageEnabled ?? storageEnabled;
    if (!storageOk) {
        log(
            "warn",
            "recordings worker is enabled but object storage (R2) is not configured; scheduler not started",
        );
        return null;
    }

    // Gate 3: enabled but unusable (e.g. bare dev boot without Supabase env):
    // decline to start instead of crashing the boot path.
    let db: Db;
    try {
        db = overrides?.db ?? createServerSupabase();
    } catch (err) {
        log(
            "warn",
            "recordings worker is enabled but Supabase is not configured; scheduler not started",
            err,
        );
        return null;
    }

    const deps: RecordingsSchedulerDeps = {
        db,
        instanceId: overrides?.instanceId ?? `${os.hostname()}:${process.pid}`,
        pollIntervalMs:
            overrides?.pollIntervalMs ?? recordingsPollIntervalMs(env),
        acquireLease: overrides?.acquireLease ?? acquireRecordingsLease,
        processDue: overrides?.processDue ?? processDueRecordings,
        sweepStalled: overrides?.sweepStalled ?? markStalledRecordingsQueued,
        log,
    };

    // Boot recovery sweep (mirror blueprint): recordings abandoned mid-step by
    // a dead process go back to 'queued'. Best-effort — both arms handled so a
    // missing 025 table can never surface as an unhandled rejection at boot.
    // (The per-tick sweep in pollOnce covers the steady state; this heals
    // whatever is already stalled at the instant the worker comes up.)
    void deps.sweepStalled(db, {
        olderThanMs: RECORDINGS_STALL_OLDER_THAN_MS,
    }).then(
        (recovered) => {
            if (recovered > 0) {
                log(
                    "info",
                    `recovered ${recovered} stalled recording(s) back to queued`,
                );
            }
        },
        (err) =>
            log(
                "warn",
                "stalled-recording recovery sweep failed (are the 025 recordings tables applied?)",
                err,
            ),
    );

    // One-time boot probe for a missing 025 schema. Everywhere else the store
    // TOLERATES a missing schema silently (tolerateMissingSchema → null/empty/0),
    // so a forgotten migration reads exactly like an idle queue and the worker
    // no-ops without a word. This single raw select — deliberately NOT routed
    // through tolerateMissingSchema, so the true error is visible — turns that
    // one case into an actionable WARN. Fires once at boot, best-effort: both
    // arms are handled so it can never throw or reject (same discipline as the
    // recovery sweep above). A non-schema error or success stays silent — no
    // happy-path boot line is wanted.
    void (async () => {
        try {
            const { error } = await db
                .from("recordings")
                .select("id")
                .limit(1);
            if (error && isMissingRecordingsSchema(error)) {
                log(
                    "warn",
                    "recordings tables are missing (apply migration 025 in Supabase) — worker will no-op until then",
                );
            }
        } catch {
            // A thrown probe (transport fault, or an injected db without .from
            // in tests) is not a schema signal we can trust — swallow it; live
            // faults are already logged per tick.
        }
    })();

    // Re-entrancy guard: setInterval keeps firing during a slow batch, so
    // overlapping ticks are skipped (logged). serializeTicks is imported from
    // the automation module — the discipline is shared, not duplicated. No
    // reconciliation-tick machinery: that is ingest-specific and recordings has
    // no inbound ingest.
    const runTick = serializeTicks(
        () =>
            pollOnce(deps).catch((err) =>
                // pollOnce never rejects by construction; belt-and-braces so a
                // future bug degrades to a logged tick, not a crash.
                log("error", "scheduler tick crashed", err),
            ),
        () =>
            log(
                "info",
                "previous scheduler tick still running; skipping this tick",
            ),
    );
    const timer = setInterval(() => {
        void runTick();
    }, deps.pollIntervalMs);
    // The scheduler must never by itself keep the process alive.
    timer.unref?.();

    log(
        "info",
        `recordings scheduler started (instance ${deps.instanceId}, polling every ${deps.pollIntervalMs}ms)`,
    );
    return { stop: () => clearInterval(timer) };
}
