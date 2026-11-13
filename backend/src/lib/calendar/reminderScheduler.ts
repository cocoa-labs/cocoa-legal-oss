// backend/src/lib/calendar/reminderScheduler.ts
//
// Env-gated background worker that reminds about legal deadlines. Started once
// from index.ts after the server begins listening; a hard no-op unless
// CALENDAR_REMINDER_WORKER_ENABLED === "true". Each tick takes the singleton
// lease in calendar_sync_state (so exactly one instance sweeps, however many are
// deployed) and, when it wins, drafts an approval-gated reminder email for each
// due deadline and marks it sent so it never fires twice.
//
// Boot resilience is a hard requirement (mirrors recordings/scheduler.ts):
// migration 026 may be unapplied, so every step degrades to a logged no-op —
// never a crash loop, never an unhandled rejection. The interval is .unref()'d
// so the timer can never by itself hold the process open, and serializeTicks
// (shared re-entrancy discipline) skips overlapping ticks.
import os from "node:os";

import { createServerSupabase } from "../supabase";
import { serializeTicks } from "../automation/scheduler";
import {
    acquireCalendarReminderLease,
    isMissingCalendarSchema,
    listDueDeadlines,
    markReminderSent,
} from "./store";
import { draftDeadlineReminder } from "./reminderEmail";
import {
    calendarReminderWorkerEnabled,
    calendarReminderPollIntervalMs,
} from "./env";
import type { CalendarEventMeta } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/** Deadlines processed per tick. */
export const REMINDERS_PER_TICK = 25;

/** Lease TTL as a multiple of the poll interval (2 ticks + slack). */
export const LEASE_TTL_FACTOR = 2.5;

export interface ReminderSchedulerDeps {
    db: Db;
    instanceId: string;
    pollIntervalMs: number;
    acquireLease: (db: Db, instanceId: string, ttlMs: number) => Promise<boolean>;
    listDue: (
        db: Db,
        opts: { now?: Date; limit?: number },
    ) => Promise<CalendarEventMeta[]>;
    /** Draft the approval-gated reminder for one deadline (throws → retried). */
    remind: (db: Db, meta: CalendarEventMeta) => Promise<void>;
    markSent: (db: Db, id: string) => Promise<void>;
    log: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
}

function defaultLog(
    level: "info" | "warn" | "error",
    message: string,
    extra?: unknown,
): void {
    const line = `[calendar-reminders] ${message}`;
    const args = extra === undefined ? [line] : [line, extra];
    if (level === "info") console.log(...args);
    else if (level === "warn") console.warn(...args);
    else console.error(...args);
}

export interface ReminderPollResult {
    leased: boolean;
    /** Deadlines reminded this tick (null when the lease was lost). */
    reminded: number | null;
}

/**
 * One reminder tick. Never rejects: each step is individually wrapped so a
 * missing 026 schema or a failed draft is a logged skip. A deadline whose draft
 * throws is deliberately NOT marked sent, so it is retried next tick; one whose
 * draft resolves is marked sent even if it gave up (e.g. no resolvable
 * recipient) — the deadline is still visible on the calendar/agenda.
 */
export async function pollOnce(
    deps: ReminderSchedulerDeps,
): Promise<ReminderPollResult> {
    let leased = false;
    try {
        leased = await deps.acquireLease(
            deps.db,
            deps.instanceId,
            Math.round(deps.pollIntervalMs * LEASE_TTL_FACTOR),
        );
    } catch (err) {
        deps.log(
            "warn",
            "reminder lease unavailable; skipping tick (is migration 026 applied?)",
            err,
        );
        return { leased: false, reminded: null };
    }
    if (!leased) return { leased: false, reminded: null };

    let due: CalendarEventMeta[] = [];
    try {
        due = await deps.listDue(deps.db, { limit: REMINDERS_PER_TICK });
    } catch (err) {
        deps.log("warn", "listDueDeadlines failed on this tick", err);
        return { leased: true, reminded: 0 };
    }

    let reminded = 0;
    for (const m of due) {
        try {
            await deps.remind(deps.db, m);
            await deps.markSent(deps.db, m.id);
            reminded += 1;
        } catch (err) {
            deps.log("warn", `reminder for deadline ${m.id} failed; will retry`, err);
        }
    }
    if (reminded > 0) {
        deps.log("info", `drafted ${reminded} deadline reminder(s)`);
    }
    return { leased: true, reminded };
}

/**
 * Start the reminder scheduler. Returns a stop handle, or null when it declines
 * to start (worker off, or Supabase unusable). Must never throw — it is called
 * from the boot path.
 */
export function startCalendarReminderScheduler(
    overrides?: Partial<ReminderSchedulerDeps> & { env?: NodeJS.ProcessEnv },
): { stop: () => void } | null {
    const env = overrides?.env ?? process.env;
    const log = overrides?.log ?? defaultLog;

    // Off is the normal state — stay silent.
    if (!calendarReminderWorkerEnabled(env)) return null;

    let db: Db;
    try {
        db = overrides?.db ?? createServerSupabase();
    } catch (err) {
        log(
            "warn",
            "reminder worker is enabled but Supabase is not configured; scheduler not started",
            err,
        );
        return null;
    }

    const deps: ReminderSchedulerDeps = {
        db,
        instanceId: overrides?.instanceId ?? `${os.hostname()}:${process.pid}`,
        pollIntervalMs:
            overrides?.pollIntervalMs ?? calendarReminderPollIntervalMs(env),
        acquireLease: overrides?.acquireLease ?? acquireCalendarReminderLease,
        listDue: overrides?.listDue ?? listDueDeadlines,
        remind: overrides?.remind ?? draftDeadlineReminder,
        markSent: overrides?.markSent ?? markReminderSent,
        log,
    };

    // One-time boot probe for a missing 026 schema → actionable WARN (everywhere
    // else the store tolerates it silently). Best-effort; never throws.
    void (async () => {
        try {
            const { error } = await db
                .from("calendar_event_meta")
                .select("id")
                .limit(1);
            if (error && isMissingCalendarSchema(error)) {
                log(
                    "warn",
                    "calendar tables are missing (apply migration 026 in Supabase) — reminder worker will no-op until then",
                );
            }
        } catch {
            // A thrown probe is not a schema signal we can trust — swallow it.
        }
    })();

    const runTick = serializeTicks(
        () =>
            pollOnce(deps).catch((err) =>
                log("error", "reminder tick crashed", err),
            ),
        () => log("info", "previous reminder tick still running; skipping"),
    );
    const timer = setInterval(() => {
        void runTick();
    }, deps.pollIntervalMs);
    timer.unref?.();

    log(
        "info",
        `calendar reminder scheduler started (instance ${deps.instanceId}, every ${deps.pollIntervalMs}ms)`,
    );
    return { stop: () => clearInterval(timer) };
}
