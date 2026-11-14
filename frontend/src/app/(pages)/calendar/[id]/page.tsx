"use client";

import { useParams, useSearchParams } from "next/navigation";
import { EventDetailPanel } from "@/app/components/calendar/EventDetailPanel";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import type { CalendarSource } from "@/app/lib/cocoaLegalApi";

export default function CalendarEventPage() {
    const params = useParams();
    const search = useSearchParams();
    const id = params.id as string;
    const calendar: CalendarSource =
        search.get("calendar") === "firm" ? "firm" : "primary";
    return (
        <div className="relative h-full w-full overflow-y-auto bg-[var(--app-shell)] px-6 py-6 text-[var(--app-text)]">
            <AppBackButton
                variant="dark"
                className="absolute left-4 top-4 z-20 md:left-6 md:top-6"
            />
            <div className="mx-auto flex h-full max-w-5xl flex-col pt-10">
                <EventDetailPanel eventId={id} calendar={calendar} />
            </div>
        </div>
    );
}
