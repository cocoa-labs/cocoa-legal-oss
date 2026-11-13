// backend/src/lib/automation/scheduler.ts
//
// Env-gated background scheduler for the PI email-automation pipeline.
// Started once from index.ts after the server begins listening; a hard no-op
// unless AUTOMATION_ENABLED=true. Each tick takes the singleton lease in
// automation_state (so exactly one instance polls, however many are deployed)
// and, when it wins, runs cursor-mode inbound ingest then processDueRuns.
//
// Boot resilience is a hard requirement: migration 023 may not be applied in
// a given environment, so the boot sweep and EVERY poll step degrade to a
// logged no-op — never a crash loop and never an unhandled rejection. The
// interval is .unref()'d (same discipline as the authoringExecute heartbeat)
// so the timer can never by itself hold the process open.

import os from "node:os";

import { createServerSupabase } from "../supabase";
import {
    automationEnabled,
    automationPollIntervalMs,
    automationReconcileEveryNTicks,
} from "./env";
import { acquireSchedulerLease, markStalledRunsQueued } from "./runsStore";
import { processDueRuns } from "./pipeline";
import { ingestInbound } from "../email/ingest";

type Db = ReturnType<typeof createServerSupabase>;

/** Runs handed to processDueRuns per tick. */
export const RUNS_PER_TICK = 5;

/**
 * Lease TTL as a multiple of the poll interval: long enough that a healthy
 * holder always renews before expiry (2 ticks + slack), short enough that a
 * dead holder is displaced within ~2.5 intervals.
 */
export const LEASE_TTL_FACTOR = 2.5;

/** A WORKING-status run untouched this long was abandoned by a dead worker. */
export const STALL_SWEEP_OLDER_THAN_MS = 5 * 60_000;

export interface SchedulerDeps {
    db: Db;
    /** Identifies this process in the lease row (hostname:pid by default). */
    instanceId: string;
    pollIntervalMs: number;
    /** Every Nth tick reconciles via query-mode ingest (default from env). */
    reconcileEveryNTicks?: number;
    acquireLease: (
        db: Db,
        instanceId: string,
        ttlMs: number,
    ) => Promise<boolean>;
    ingest: (opts: { useCursor: boolean }) => Promise<{ ingested: number }>;
    processDueRuns: (
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
    const line = `[automation] ${message}`;
    const args = extra === undefined ? [line] : [line, extra];
    if (level === "info") console.log(...args);
    else if (level === "warn") console.warn(...args);
    else console.error(...args);
}

export interface PollOnceResult {
    /** Whether this tick won the scheduler lease. */
    leased: boolean;
    /** Messages ingested (null when the lease was lost or ingest failed). */
    ingested: number | null;
    /** Due runs reported (null when the lease was lost or the list failed). */
    due: number | null;
}

/**
 * Pure reconciliation decision: is `tick` (1-based) a reconciliation
 * sweep? The cursor-mode history walk never re-lists a message whose
 * getMessage transiently failed, so a blip could skip an email FOREVER —
 * every Nth tick therefore runs the 2-day query ingest INSTEAD of the
 * cursor walk; the provider_message_id dedupe makes the re-list cheap and
 * heals anything skipped within the window. A non-positive cadence
 * disables reconciliation rather than dividing by zero.
 */
export function shouldReconcile(tick: number, everyNTicks: number): boolean {
    if (everyNTicks <= 0) return false;
    return tick > 0 && tick % everyNTicks === 0;
}

/**
 * Wrap an async tick so overlapping invocations are SKIPPED while one is
 * in flight (setInterval keeps firing during a slow batch; two concurrent
 * pollOnce calls would race the same lease renewal and double-process
 * ingest). The guard is cleared in finally — a crashed tick can never
 * wedge the scheduler — and the wrapped fn's rejection is contained.
 */
export function serializeTicks(
    run: () => Promise<unknown>,
    onSkip: () => void,
): () => Promise<void> {
    let running = false;
    return async () => {
        if (running) {
            onSkip();
            return;
        }
        running = true;
        try {
            await run();
        } catch {
            // The runner (pollOnce) never rejects by construction; contain
            // anyway so the interval callback cannot raise.
        } finally {
            running = false;
        }
    };
}

/**
 * One scheduler tick. Never rejects: every step is individually wrapped so
 * one failure (Gmail down, automation tables missing, …) is a logged skip —
 * a rejection here would otherwise kill the interval or crash the process.
 * Exported with injected deps so tests drive a tick without timers.
 * `opts.reconcile` swaps the cursor walk for the 2-day query scan (see
 * shouldReconcile).
 */
export async function pollOnce(
    deps: SchedulerDeps,
    opts?: { reconcile?: boolean },
): Promise<PollOnceResult> {
    let leased = false;
    try {
        leased = await deps.acquireLease(
            deps.db,
            deps.instanceId,
            Math.round(deps.pollIntervalMs * LEASE_TTL_FACTOR),
        );
    } catch (err) {
        // Typical cause: automation_state does not exist yet (migration 023
        // unapplied). The tick must be a logged no-op, never a crash loop.
        deps.log(
            "warn",
            "scheduler lease unavailable; skipping tick (are the 023 automation tables applied?)",
            err,
        );
        return { leased: false, ingested: null, due: null };
    }
    if (!leased) return { leased: false, ingested: null, due: null };

    // Ingest and run-processing are wrapped separately: inbound mail being
    // unreachable must not starve already-enqueued runs, and vice versa.
    // A reconciliation tick runs the query scan INSTEAD of the cursor walk.
    let ingested: number | null = null;
    try {
        const useCursor = !opts?.reconcile;
        if (!useCursor) {
            deps.log("info", "reconciliation tick: query-mode ingest sweep");
        }
        ingested = (await deps.ingest({ useCursor })).ingested;
    } catch (err) {
        deps.log("warn", "inbound ingest failed on this tick", err);
    }

    let due: number | null = null;
    try {
        const result = await deps.processDueRuns(deps.db, {
            limit: RUNS_PER_TICK,
        });
        due = result.due;
        if (result.due > 0) {
            deps.log(
                "info",
                `${result.due} automation run(s) due, ${result.processed} processed`,
            );
        }
    } catch (err) {
        deps.log("warn", "processDueRuns failed on this tick", err);
    }

    return { leased: true, ingested, due };
}

/**
 * Start the automation scheduler. Returns a stop handle, or null when it
 * declines to start (automation disabled, or Supabase not configured). Must
 * never throw — it is called from the boot path.
 */
export function startAutomationScheduler(
    overrides?: Partial<SchedulerDeps> & { env?: NodeJS.ProcessEnv },
): { stop: () => void } | null {
    const env = overrides?.env ?? process.env;
    const log = overrides?.log ?? defaultLog;
    if (!automationEnabled(env)) return null;

    let db: Db;
    try {
        db = overrides?.db ?? createServerSupabase();
    } catch (err) {
        // Enabled but unusable (e.g. bare dev boot without Supabase env):
        // decline to start instead of crashing the boot path.
        log(
            "warn",
            "automation is enabled but Supabase is not configured; scheduler not started",
            err,
        );
        return null;
    }

    const deps: SchedulerDeps = {
        db,
        instanceId: overrides?.instanceId ?? `${os.hostname()}:${process.pid}`,
        pollIntervalMs:
            overrides?.pollIntervalMs ?? automationPollIntervalMs(env),
        reconcileEveryNTicks:
            overrides?.reconcileEveryNTicks ??
            automationReconcileEveryNTicks(env),
        acquireLease: overrides?.acquireLease ?? acquireSchedulerLease,
        ingest: overrides?.ingest ?? ingestInbound,
        processDueRuns: overrides?.processDueRuns ?? processDueRuns,
        sweepStalled: overrides?.sweepStalled ?? markStalledRunsQueued,
        log,
    };

    // Boot recovery sweep: runs abandoned mid-step by a dead process go back
    // to 'queued'. Best-effort — both arms handled so a missing table can
    // never surface as an unhandled rejection at boot.
    void deps.sweepStalled(db, { olderThanMs: STALL_SWEEP_OLDER_THAN_MS }).then(
        (recovered) => {
            if (recovered > 0) {
                log(
                    "info",
                    `recovered ${recovered} stalled run(s) back to queued`,
                );
            }
        },
        (err) =>
            log(
                "warn",
                "stalled-run recovery sweep failed (are the 023 automation tables applied?)",
                err,
            ),
    );

    // Re-entrancy guard + tick counting: setInterval keeps firing during a
    // slow batch, so overlapping ticks are skipped (logged), and every Nth
    // COMPLETED-or-started tick runs the reconciliation sweep instead of
    // the cursor walk.
    let tick = 0;
    const runTick = serializeTicks(
        () => {
            tick += 1;
            return pollOnce(deps, {
                reconcile: shouldReconcile(
                    tick,
                    deps.reconcileEveryNTicks ?? 0,
                ),
            }).catch((err) =>
                // pollOnce never rejects by construction; belt-and-braces so
                // a future bug degrades to a logged tick, not a crash.
                log("error", "scheduler tick crashed", err),
            );
        },
        () =>
            log(
                "info",
                "previous scheduler tick still running; skipping this tick",
            ),
    );
    const timer = setInterval(() => {
        void runTick();
    }, deps.pollIntervalMs);
    // Same discipline as the authoringExecute heartbeat: the scheduler must
    // never by itself keep the process alive.
    timer.unref?.();

    log(
        "info",
        `scheduler started (instance ${deps.instanceId}, polling every ${deps.pollIntervalMs}ms)`,
    );
    return { stop: () => clearInterval(timer) };
}
