"use client";

import Link from "next/link";
import { Users, Video, Flag } from "lucide-react";
import type { CalendarEvent } from "@/app/lib/cocoLegalApi";
import { CALENDAR_COLORS, formatEventTime } from "./calendarColors";

/**
 * One event as a clickable card, used by the agenda list (and the month grid's
 * day popover). Shows time, a calendar color dot, title, and meta chips
 * (attendee count, Meet indicator, deadline flag). Themed with --app-* tokens so
 * it reads correctly in both light and dark.
 */
export function EventRow({ event }: { event: CalendarEvent }) {
    const color = CALENDAR_COLORS[event.calendar];
    return (
        <li>
            <Link
                href={`/calendar/${encodeURIComponent(event.id)}?calendar=${event.calendar}`}
                className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 transition-colors hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            >
                <span className="w-24 shrink-0 text-[11px] tabular-nums text-[var(--app-text-subtle)]">
                    {formatEventTime(event)}
                </span>
                <span
                    className={`h-2 w-2 shrink-0 rounded-full ${color.dot}`}
                    aria-hidden
                />
                <span className="min-w-0 flex-1">
                    <span className="block min-w-0 truncate text-sm font-semibold text-[var(--app-text-strong)]">
                        {event.title || "(no title)"}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--app-text-subtle)]">
                        <span className={color.text}>{color.label}</span>
                        {event.attendees.length > 0 && (
                            <span className="inline-flex items-center gap-1">
                                <Users className="h-3 w-3" aria-hidden />
                                {event.attendees.length}
                            </span>
                        )}
                        {event.meetLink && (
                            <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                                <Video className="h-3 w-3" aria-hidden />
                                Meet
                            </span>
                        )}
                        {event.isDeadline && (
                            <span className="inline-flex items-center gap-1 text-red-600">
                                <Flag className="h-3 w-3" aria-hidden />
                                Deadline
                            </span>
                        )}
                    </span>
                </span>
            </Link>
        </li>
    );
}
