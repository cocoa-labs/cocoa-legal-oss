/**
 * Temporal grounding for Quill's system prompt.
 *
 * Nothing else in the prompt tells the model what "now" is, so every
 * relative-time judgment ("today", "upcoming", "overdue", deadlines, statutes
 * of limitations) was previously unanchored — Quill would hedge or try to infer
 * the date from message contents. buildMessages appends the line produced here
 * (gated on SystemPromptContext.currentDateLine) so every provider (Claude,
 * OpenAI, Gemini) and every live chat path shares one authoritative clock.
 *
 * The server clock supplies the instant (device clocks are untrusted); the
 * caller supplies the display zone — the browser's IANA zone for interactive
 * chat, the firm default (CALENDAR_DEFAULT_TIMEZONE) for non-browser paths such
 * as email auto-reply.
 */

/** Firm-wide default zone, read at call time so tests can set it. */
function defaultTimeZone(): string {
    return process.env.CALENDAR_DEFAULT_TIMEZONE || "UTC";
}

/**
 * Return `candidate` when it is a valid IANA time zone, else the firm default
 * (CALENDAR_DEFAULT_TIMEZONE) or "UTC". Validation is done by asking Intl to
 * build a formatter for the zone: an unknown or hostile string throws a
 * RangeError and falls through, so only real zones are ever used. This makes it
 * safe to pass raw client-supplied input straight in.
 */
export function resolveTimeZone(candidate?: string | null): string {
    if (typeof candidate === "string" && candidate.trim()) {
        try {
            // Throws RangeError for an invalid/unknown time zone.
            new Intl.DateTimeFormat("en-US", { timeZone: candidate });
            return candidate;
        } catch {
            // fall through to the firm default
        }
    }
    return defaultTimeZone();
}

/**
 * Build the body of the "Current date and time" grounding block. `now` defaults
 * to the server clock (injectable for deterministic tests); `timeZone` is passed
 * through resolveTimeZone so callers may hand it raw client input. The caller
 * (buildMessages) adds the "## Current date and time" heading.
 */
export function temporalGroundingLine(opts?: {
    now?: Date;
    timeZone?: string | null;
}): string {
    const now = opts?.now ?? new Date();
    const timeZone = resolveTimeZone(opts?.timeZone ?? undefined);

    // e.g. "Friday, July 17, 2026"
    const dateStr = new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone,
    }).format(now);

    // e.g. "2:34 PM PDT"
    const timeStr = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone,
    }).format(now);

    const iso = now.toISOString();

    return (
        `Today is ${dateStr}. The current local time is ${timeStr} (${timeZone}). ` +
        `In UTC (ISO 8601) this instant is ${iso}.\n` +
        `Treat this as the authoritative "now" for all relative-time reasoning — ` +
        `"today", "tomorrow", "this week", "upcoming", "overdue", deadlines, statutes ` +
        `of limitations, and calendar/email recency. Do not guess the date or infer it ` +
        `from message contents; when a calendar or email tool needs a start time and none ` +
        `is given, use this.`
    );
}
