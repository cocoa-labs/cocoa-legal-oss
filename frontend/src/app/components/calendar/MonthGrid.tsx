"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CalendarEvent } from "@/app/lib/cocoLegalApi";
import {
    CALENDAR_COLORS,
    addDays,
    localDayKey,
    parseEventStart,
    sameLocalDay,
    startOfMonthGrid,
} from "./calendarColors";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A lightweight, dependency-free month grid (6 weeks × 7 days) themed with
 * --app-* tokens. Events are shown as color-dotted chips per day; a keyboard
 * grid (arrow keys) moves focus, Enter/Space opens the focused day's first
 * event. Clicking a chip opens the event; clicking an empty day seeds the
 * composer for that date.
 */
export function MonthGrid({
    anchor,
    events,
    onCreateOn,
}: {
    anchor: Date;
    events: CalendarEvent[];
    onCreateOn: (day: Date) => void;
}) {
    const router = useRouter();
    const [focusIndex, setFocusIndex] = useState(0);

    const gridStart = useMemo(() => startOfMonthGrid(anchor), [anchor]);
    const days = useMemo(
        () => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
        [gridStart],
    );

    const byDay = useMemo(() => {
        const map = new Map<string, CalendarEvent[]>();
        for (const e of events) {
            const key = localDayKey(parseEventStart(e));
            const list = map.get(key) ?? [];
            list.push(e);
            map.set(key, list);
        }
        return map;
    }, [events]);

    const today = new Date();
    const month = anchor.getMonth();

    function onKeyDown(e: React.KeyboardEvent, index: number, day: Date) {
        let next = index;
        if (e.key === "ArrowRight") next = Math.min(41, index + 1);
        else if (e.key === "ArrowLeft") next = Math.max(0, index - 1);
        else if (e.key === "ArrowDown") next = Math.min(41, index + 7);
        else if (e.key === "ArrowUp") next = Math.max(0, index - 7);
        else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const dayEvents = byDay.get(localDayKey(day)) ?? [];
            if (dayEvents[0]) {
                router.push(
                    `/calendar/${encodeURIComponent(dayEvents[0].id)}?calendar=${dayEvents[0].calendar}`,
                );
            } else {
                onCreateOn(day);
            }
            return;
        } else return;
        e.preventDefault();
        setFocusIndex(next);
    }

    return (
        <div className="w-full" role="grid" aria-label="Month">
            <div
                className="grid grid-cols-7 border-b border-[var(--app-border)]"
                role="row"
            >
                {WEEKDAYS.map((w) => (
                    <div
                        key={w}
                        role="columnheader"
                        className="px-2 py-1.5 text-center text-[11px] font-medium text-[var(--app-text-subtle)]"
                    >
                        {w}
                    </div>
                ))}
            </div>
            <div className="grid grid-cols-7">
                {days.map((day, index) => {
                    const dayEvents = byDay.get(localDayKey(day)) ?? [];
                    const inMonth = day.getMonth() === month;
                    const isToday = sameLocalDay(day, today);
                    return (
                        <div
                            key={index}
                            role="gridcell"
                            tabIndex={index === focusIndex ? 0 : -1}
                            aria-label={`${day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}
                            aria-selected={index === focusIndex}
                            onKeyDown={(e) => onKeyDown(e, index, day)}
                            onFocus={() => setFocusIndex(index)}
                            onClick={() => {
                                if (dayEvents.length === 0) onCreateOn(day);
                            }}
                            className={`min-h-24 min-w-0 border-b border-r border-[var(--app-border)] p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)] ${
                                inMonth ? "" : "opacity-50"
                            }`}
                        >
                            <div className="mb-1 flex justify-end">
                                <span
                                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums ${
                                        isToday
                                            ? "bg-[var(--app-warm)] font-semibold text-white"
                                            : "text-[var(--app-text-subtle)]"
                                    }`}
                                >
                                    {day.getDate()}
                                </span>
                            </div>
                            <div className="space-y-0.5">
                                {dayEvents.slice(0, 3).map((ev) => {
                                    const color = CALENDAR_COLORS[ev.calendar];
                                    return (
                                        <button
                                            key={ev.id}
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                router.push(
                                                    `/calendar/${encodeURIComponent(ev.id)}?calendar=${ev.calendar}`,
                                                );
                                            }}
                                            className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-[var(--app-hover)]"
                                            title={ev.title}
                                        >
                                            <span
                                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${ev.isDeadline ? "bg-red-500" : color.dot}`}
                                                aria-hidden
                                            />
                                            <span className="min-w-0 truncate text-[var(--app-text-strong)]">
                                                {ev.title || "(no title)"}
                                            </span>
                                        </button>
                                    );
                                })}
                                {dayEvents.length > 3 && (
                                    <div className="px-1 text-[10px] text-[var(--app-text-subtle)]">
                                        +{dayEvents.length - 3} more
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
