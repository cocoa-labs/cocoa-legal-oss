"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import {
    getEventForRecording,
    type CalendarEvent,
} from "@/app/lib/cocoaLegalApi";
import { formatEventTime, parseEventStart } from "./calendarColors";

/**
 * The calendar event linked to a recording, shown as a compact "linked meeting"
 * row on the recording detail page. Renders nothing when there's no link or the
 * calendar isn't configured — the recordings page never errors on calendar.
 */
export function RecordingLinkedEvent({ recordingId }: { recordingId: string }) {
    const [event, setEvent] = useState<CalendarEvent | null>(null);

    useEffect(() => {
        let cancelled = false;
        getEventForRecording(recordingId)
            .then((e) => {
                if (!cancelled) setEvent(e);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [recordingId]);

    if (!event) return null;

    return (
        <Link
            href={`/calendar/${encodeURIComponent(event.id)}?calendar=${event.calendar}`}
            className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm transition-colors hover:bg-[var(--app-hover)]"
        >
            <CalendarDays className="h-4 w-4 shrink-0 text-[var(--app-text-subtle)]" />
            <span className="min-w-0 flex-1 truncate font-medium text-[var(--app-text-strong)]">
                {event.title || "Linked meeting"}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">
                {parseEventStart(event).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                })}{" "}
                · {formatEventTime(event)}
            </span>
        </Link>
    );
}
