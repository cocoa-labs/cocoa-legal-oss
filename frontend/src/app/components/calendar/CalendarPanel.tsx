"use client";

import { useMemo, useState } from "react";
import {
    CalendarDays,
    ChevronLeft,
    ChevronRight,
    Plus,
} from "lucide-react";
import type { CalendarEvent, CalendarSource } from "@/app/lib/cocoLegalApi";
import { useCalendarAgenda } from "@/app/hooks/useCalendarAgenda";
import {
    CALENDAR_COLORS,
    addDays,
    formatDayHeading,
    localDayKey,
    parseEventStart,
    startOfDay,
    startOfMonthGrid,
} from "./calendarColors";
import { EventRow } from "./EventRow";
import { MonthGrid } from "./MonthGrid";
import { EventComposer } from "./EventComposer";

type View = "agenda" | "grid";
type Filter = CalendarSource | "all";

/**
 * Quill's calendar: an upcoming-events agenda (default) with a toggle into a
 * month grid, over Quill's own calendar and the shared firm calendar merged and
 * color-coded. Self-contained (owns its fetching), like RecordingsLibraryPanel /
 * InboxPanel. --app-* themed so it reads correctly in light and dark.
 */
export function CalendarPanel() {
    const [view, setView] = useState<View>("agenda");
    // Anchor starts at today (stable across renders → no refetch loop).
    const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
    const [filter, setFilter] = useState<Filter>("all");
    const [composerOpen, setComposerOpen] = useState(false);
    const [composerSeed, setComposerSeed] = useState<Date | null>(null);

    const window = useMemo(() => {
        if (view === "grid") {
            const start = startOfMonthGrid(anchor);
            return { from: start.toISOString(), to: addDays(start, 42).toISOString() };
        }
        const start = startOfDay(anchor);
        return { from: start.toISOString(), to: addDays(start, 60).toISOString() };
    }, [view, anchor]);

    const { data, error, reload } = useCalendarAgenda({
        from: window.from,
        to: window.to,
        calendar: filter,
    });

    const events = data?.events ?? null;

    function openCreate(seed: Date | null) {
        setComposerSeed(seed);
        setComposerOpen(true);
    }

    return (
        <div
            className={`mx-auto flex h-full w-full flex-col font-sans ${
                view === "grid" ? "max-w-5xl" : "max-w-3xl"
            }`}
        >
            {/* Header + controls */}
            <div className="flex flex-wrap items-center gap-2.5 px-1 pb-3 pt-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-800 ring-1 ring-sky-200">
                    <CalendarDays className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-[var(--app-text-strong)]">
                        Calendar
                    </h1>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        Quill&apos;s calendars for you and the firm
                    </p>
                </div>

                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    {/* View toggle */}
                    <div className="inline-flex rounded-lg border border-[var(--app-border)] p-0.5">
                        {(["agenda", "grid"] as View[]).map((v) => (
                            <button
                                key={v}
                                type="button"
                                onClick={() => setView(v)}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                    view === v
                                        ? "bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                        : "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                                }`}
                            >
                                {v === "agenda" ? "Agenda" : "Month"}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={() => openCreate(null)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-medium text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                    >
                        <Plus className="h-4 w-4 shrink-0" />
                        New event
                    </button>
                </div>
            </div>

            {/* Calendar filter pills + month nav (grid) */}
            <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
                {(["all", "primary", "firm"] as Filter[]).map((f) => {
                    const label =
                        f === "all"
                            ? "All"
                            : CALENDAR_COLORS[f as CalendarSource].label;
                    const active = filter === f;
                    return (
                        <button
                            key={f}
                            type="button"
                            onClick={() => setFilter(f)}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                active
                                    ? "border-[var(--app-border-strong)] bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                    : "border-[var(--app-border)] text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                            }`}
                        >
                            {f !== "all" && (
                                <span
                                    className={`h-2 w-2 rounded-full ${CALENDAR_COLORS[f as CalendarSource].dot}`}
                                    aria-hidden
                                />
                            )}
                            {label}
                        </button>
                    );
                })}

                {view === "grid" && (
                    <div className="ml-auto flex items-center gap-1.5">
                        <button
                            type="button"
                            aria-label="Previous month"
                            onClick={() =>
                                setAnchor(
                                    new Date(
                                        anchor.getFullYear(),
                                        anchor.getMonth() - 1,
                                        1,
                                    ),
                                )
                            }
                            className="rounded-md p-1 text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <span className="min-w-32 text-center text-sm font-medium text-[var(--app-text-strong)]">
                            {anchor.toLocaleDateString(undefined, {
                                month: "long",
                                year: "numeric",
                            })}
                        </span>
                        <button
                            type="button"
                            aria-label="Next month"
                            onClick={() =>
                                setAnchor(
                                    new Date(
                                        anchor.getFullYear(),
                                        anchor.getMonth() + 1,
                                        1,
                                    ),
                                )
                            }
                            className="rounded-md p-1 text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setAnchor(startOfDay(new Date()))}
                            className="rounded-md border border-[var(--app-border)] px-2 py-1 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                        >
                            Today
                        </button>
                    </div>
                )}
            </div>

            {error && <p className="px-1 pb-2 text-xs text-red-600">{error}</p>}

            {/* Body */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {events === null ? (
                    <div className="space-y-2 px-1">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-16 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                            />
                        ))}
                    </div>
                ) : view === "grid" ? (
                    <MonthGrid
                        anchor={anchor}
                        events={events}
                        onCreateOn={(day) => openCreate(day)}
                    />
                ) : (
                    <AgendaList events={events} onCreate={() => openCreate(null)} />
                )}
            </div>

            {composerOpen && (
                <EventComposer
                    seedDate={composerSeed}
                    onClose={() => setComposerOpen(false)}
                    onDone={() => {
                        setComposerOpen(false);
                        reload();
                    }}
                />
            )}
        </div>
    );
}

/** Date-grouped agenda of event rows. */
function AgendaList({
    events,
    onCreate,
}: {
    events: CalendarEvent[];
    onCreate: () => void;
}) {
    const groups = useMemo(() => {
        const map = new Map<string, { date: Date; items: CalendarEvent[] }>();
        for (const e of events) {
            const d = parseEventStart(e);
            const key = localDayKey(d);
            const g = map.get(key) ?? { date: d, items: [] };
            g.items.push(e);
            map.set(key, g);
        }
        return [...map.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, g]) => g);
    }, [events]);

    if (events.length === 0) {
        return (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-6 py-12 text-center">
                <CalendarDays className="h-6 w-6 text-[var(--app-text-subtle)]" />
                <p className="text-sm font-medium text-[var(--app-text-muted)]">
                    Nothing on the calendar
                </p>
                <p className="max-w-xs text-xs text-[var(--app-text-subtle)]">
                    Events Quill schedules for you and the firm will show up here.
                </p>
                <button
                    type="button"
                    onClick={onCreate}
                    className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                >
                    <Plus className="h-4 w-4" />
                    New event
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-4 px-1 pb-2">
            {groups.map((g) => (
                <div key={localDayKey(g.date)}>
                    <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
                        {formatDayHeading(g.date)}
                    </h2>
                    <ul className="space-y-2">
                        {g.items.map((e) => (
                            <EventRow key={`${e.calendar}:${e.id}`} event={e} />
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}
