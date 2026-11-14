"use client";

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { listEvents, type CalendarEvent } from "@/app/lib/cocoaLegalApi";
import { EventRow } from "./EventRow";
import { addDays, startOfDay } from "./calendarColors";

/**
 * A matter's upcoming calendar events (next 90 days), for the matter workspace.
 * Self-contained. Hidden entirely when there are none or the calendar isn't
 * configured yet — the matter page should never error on calendar unavailability.
 * `matterId` is the project id the matter page uses (calendar links store the
 * matter as project_id, matching recordings).
 */
export function MatterUpcomingEvents({ matterId }: { matterId: string }) {
    const [events, setEvents] = useState<CalendarEvent[] | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const from = startOfDay(new Date()).toISOString();
        const to = addDays(new Date(), 90).toISOString();
        listEvents({ from, to, matterId })
            .then((res) => {
                if (!cancelled) setEvents(res.events);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [matterId]);

    // Degrade silently: no calendar connector / no linked events → render
    // nothing rather than an error on the matter page.
    if (failed) return null;
    if (events && events.length === 0) return null;

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
                <CalendarDays className="h-3.5 w-3.5" />
                Upcoming events
            </h3>
            {events === null ? (
                <div className="h-14 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]" />
            ) : (
                <ul className="space-y-2">
                    {events
                        .slice()
                        .sort((a, b) =>
                            (a.isDeadline === b.isDeadline ? 0 : a.isDeadline ? -1 : 1),
                        )
                        .map((e) => (
                            <EventRow key={`${e.calendar}:${e.id}`} event={e} />
                        ))}
                </ul>
            )}
        </div>
    );
}
