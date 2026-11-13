// backend/src/lib/calendar/env.ts
//
// Env accessors for the calendar deadline-reminder worker. Read live (function,
// not module constant) so tests can toggle them. The worker is OFF unless
// CALENDAR_REMINDER_WORKER_ENABLED is the literal string "true".
type Env = NodeJS.ProcessEnv;

/** True only when the reminder worker is explicitly enabled. */
export function calendarReminderWorkerEnabled(env: Env = process.env): boolean {
    return env.CALENDAR_REMINDER_WORKER_ENABLED === "true";
}

/** Reminder sweep interval (default 15 minutes). */
export function calendarReminderPollIntervalMs(env: Env = process.env): number {
    const raw = Number.parseInt(
        env.CALENDAR_REMINDER_POLL_INTERVAL_MS ?? "",
        10,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}
