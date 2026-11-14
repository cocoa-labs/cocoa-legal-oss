"use client";

import { useEffect, useState } from "react";
import { listEvents, type AgendaResponse, type CalendarSource } from "@/app/lib/cocoaLegalApi";

const REFRESH_MS = 60_000;

/**
 * Windowed calendar fetch for the CalendarPanel. Recomputes the {from,to} window
 * from the view + anchor, fetches once per change, and refreshes every 60s in
 * the background (writes are the primary freshness path; the interval catches
 * events created elsewhere). Mirrors the RecordingsLibraryPanel reloadTick idiom
 * rather than a per-event poll.
 */
export function useCalendarAgenda(params: {
    from: string;
    to: string;
    calendar: CalendarSource | "all";
    matterId?: string;
}): { data: AgendaResponse | null; error: string | null; reload: () => void } {
    const [data, setData] = useState<AgendaResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const { from, to, calendar, matterId } = params;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await listEvents({ from, to, calendar, matterId });
                if (cancelled) return;
                setData(res);
                setError(null);
            } catch (err) {
                if (cancelled) return;
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not load your calendar.",
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [from, to, calendar, matterId, tick]);

    // Background refresh so externally-created events show up without a manual
    // reload. Stops when the component unmounts.
    useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
        return () => clearInterval(timer);
    }, []);

    return { data, error, reload: () => setTick((n) => n + 1) };
}
