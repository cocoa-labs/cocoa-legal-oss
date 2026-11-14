// Shared color map + date helpers for the calendar view, so the agenda and the
// month grid read events the same way. Calendars are color-coded by source
// (primary vs the shared firm calendar); deadlines are an orthogonal red flag.
import type { CalendarEvent, CalendarSource } from "@/app/lib/cocoaLegalApi";

export const CALENDAR_COLORS: Record<
    CalendarSource,
    { dot: string; text: string; soft: string; label: string }
> = {
    primary: {
        dot: "bg-cyan-500",
        text: "text-cyan-700 dark:text-cyan-300",
        soft: "bg-cyan-500/10",
        label: "Quill",
    },
    firm: {
        dot: "bg-amber-500",
        text: "text-amber-700 dark:text-amber-300",
        soft: "bg-amber-500/10",
        label: "Cocoa Legal",
    },
};

/** Parse an event's start into a local Date. All-day events carry a date-only
 * string, which we parse as LOCAL midnight (not UTC) to avoid off-by-one-day
 * shifts in negative-offset timezones. */
export function parseEventStart(event: CalendarEvent): Date {
    return parseDateTime(event.start.dateTime, event.start.date);
}

export function parseEventEnd(event: CalendarEvent): Date {
    return parseDateTime(event.end.dateTime, event.end.date);
}

function parseDateTime(
    dateTime: string | null | undefined,
    date: string | null | undefined,
): Date {
    if (dateTime) return new Date(dateTime);
    if (date) {
        const [y, m, d] = date.split("-").map((n) => Number.parseInt(n, 10));
        return new Date(y, (m ?? 1) - 1, d ?? 1);
    }
    return new Date(NaN);
}

/** Local YYYY-MM-DD key for grouping/comparison. */
export function localDayKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

export function sameLocalDay(a: Date, b: Date): boolean {
    return localDayKey(a) === localDayKey(b);
}

export function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

/** The first cell of a 6-week month grid: the Sunday on//before the 1st. */
export function startOfMonthGrid(anchor: Date): Date {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    return addDays(first, -first.getDay());
}

/** "Today" / "Tomorrow" / weekday + date for an agenda day heading. */
export function formatDayHeading(date: Date): string {
    const today = startOfDay(new Date());
    const target = startOfDay(date);
    const diffDays = Math.round(
        (target.getTime() - today.getTime()) / 86_400_000,
    );
    const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
    const dateLabel = date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
    if (diffDays === 0) return `Today · ${dateLabel}`;
    if (diffDays === 1) return `Tomorrow · ${dateLabel}`;
    return `${weekday} · ${dateLabel}`;
}

/** "9:00 AM", "9:00 – 9:30 AM", or "All day" for an event row. */
export function formatEventTime(event: CalendarEvent): string {
    if (event.allDay) return "All day";
    const start = parseEventStart(event);
    const end = parseEventEnd(event);
    const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    const startStr = start.toLocaleTimeString(undefined, opts);
    if (Number.isNaN(end.getTime())) return startStr;
    const endStr = end.toLocaleTimeString(undefined, opts);
    return `${startStr} – ${endStr}`;
}
