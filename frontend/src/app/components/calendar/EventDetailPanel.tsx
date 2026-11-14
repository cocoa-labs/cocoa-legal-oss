"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Clock,
    MapPin,
    Users,
    Video,
    Pencil,
    Trash2,
    ShieldCheck,
    ArrowLeft,
    Flag,
    FolderOpen,
    Mic,
} from "lucide-react";
import {
    getEvent,
    deleteEvent,
    type CalendarEvent,
    type CalendarSource,
} from "@/app/lib/cocoaLegalApi";
import {
    CALENDAR_COLORS,
    formatEventTime,
    parseEventStart,
} from "./calendarColors";
import { EventComposer } from "./EventComposer";

const RESPONSE_DOT: Record<string, string> = {
    accepted: "bg-emerald-500",
    declined: "bg-red-500",
    tentative: "bg-amber-500",
    needsAction: "bg-[var(--app-text-subtle)]",
};

const CARD =
    "rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4 shadow-sm";

export function EventDetailPanel({
    eventId,
    calendar = "primary",
}: {
    eventId: string;
    calendar?: CalendarSource;
}) {
    const router = useRouter();
    const [event, setEvent] = useState<CalendarEvent | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pendingNote, setPendingNote] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const e = await getEvent(eventId, calendar);
            setEvent(e);
            setError(null);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Could not load the event.",
            );
        }
    }, [eventId, calendar]);

    useEffect(() => {
        void load();
    }, [load]);

    async function handleDelete() {
        if (!event) return;
        setBusy(true);
        try {
            const res = await deleteEvent(event.id, event.calendar);
            if (res.operation) {
                setPendingNote(
                    "Cancellation prepared. Attendees are notified only when you approve it on the assistant chat card.",
                );
                setConfirmDelete(false);
            } else {
                router.push("/calendar");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not delete the event.");
        } finally {
            setBusy(false);
        }
    }

    if (error) {
        return (
            <div className="mx-auto w-full max-w-5xl">
                <BackLink />
                <p className="mt-4 text-sm text-red-600">{error}</p>
            </div>
        );
    }
    if (!event) {
        return (
            <div className="mx-auto w-full max-w-5xl space-y-3">
                <BackLink />
                <div className="h-24 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]" />
            </div>
        );
    }

    const color = CALENDAR_COLORS[event.calendar];

    return (
        <div className="mx-auto w-full max-w-5xl font-sans">
            <BackLink />

            {/* Header */}
            <div className="mt-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-lg font-semibold text-[var(--app-text-strong)]">
                        {event.title || "(no title)"}
                    </h1>
                    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--app-text-subtle)]">
                        <span
                            className={`h-2 w-2 rounded-full ${color.dot}`}
                            aria-hidden
                        />
                        <span className={color.text}>{color.label}</span>
                        <span aria-hidden>·</span>
                        <span>
                            {parseEventStart(event).toLocaleDateString(undefined, {
                                weekday: "short",
                                month: "short",
                                day: "numeric",
                            })}
                        </span>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setEditing(true)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 text-sm font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                    >
                        <Pencil className="h-4 w-4" />
                        Edit
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        aria-label="Delete event"
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-[var(--app-border)] px-2.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {confirmDelete && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30">
                    <span>
                        Delete this event
                        {event.attendees.length > 0
                            ? " and notify attendees (needs approval)?"
                            : "?"}
                    </span>
                    <span className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => setConfirmDelete(false)}
                            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={busy}
                            className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                            Delete
                        </button>
                    </span>
                </div>
            )}

            {pendingNote && (
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--app-warm-soft)] px-3 py-2 text-sm text-[var(--app-text-muted)]">
                    <ShieldCheck className="h-4 w-4 text-amber-600" />
                    {pendingNote}
                </div>
            )}

            {/* Body */}
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className={CARD}>
                    <SectionLabel>When &amp; where</SectionLabel>
                    <div className="flex items-center gap-2 text-sm text-[var(--app-text-strong)]">
                        <Clock className="h-4 w-4 text-[var(--app-text-subtle)]" />
                        {event.allDay ? "All day" : formatEventTime(event)}
                        {event.start.timeZone && !event.allDay && (
                            <span className="text-xs text-[var(--app-text-subtle)]">
                                ({event.start.timeZone})
                            </span>
                        )}
                    </div>
                    {event.location && (
                        <div className="mt-2 flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
                            <MapPin className="h-4 w-4 text-[var(--app-text-subtle)]" />
                            {event.location}
                        </div>
                    )}
                    {event.meetLink && (
                        <a
                            href={event.meetLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-700"
                        >
                            <Video className="h-4 w-4" />
                            Join Google Meet
                        </a>
                    )}
                </div>

                <div className={CARD}>
                    <SectionLabel>
                        <span className="inline-flex items-center gap-1.5">
                            <Users className="h-3.5 w-3.5" />
                            Attendees ({event.attendees.length})
                        </span>
                    </SectionLabel>
                    {event.attendees.length === 0 ? (
                        <p className="text-sm text-[var(--app-text-subtle)]">
                            No attendees — this is a private event on Quill&apos;s
                            calendar.
                        </p>
                    ) : (
                        <ul className="space-y-1.5">
                            {event.attendees.map((a) => (
                                <li
                                    key={a.email}
                                    className="flex items-center gap-2 text-sm text-[var(--app-text-strong)]"
                                >
                                    <span
                                        className={`h-2 w-2 rounded-full ${
                                            RESPONSE_DOT[a.responseStatus ?? "needsAction"] ??
                                            RESPONSE_DOT.needsAction
                                        }`}
                                        aria-label={a.responseStatus ?? "no response"}
                                    />
                                    <span className="min-w-0 truncate">{a.email}</span>
                                    {a.organizer && (
                                        <span className="text-[11px] text-[var(--app-text-subtle)]">
                                            organizer
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {event.isDeadline && event.deadline && (
                    <div
                        className={`${CARD} border-red-300 lg:col-span-2 dark:border-red-900/50`}
                    >
                        <SectionLabel>
                            <span className="inline-flex items-center gap-1.5 text-red-600">
                                <Flag className="h-3.5 w-3.5" />
                                Legal deadline
                            </span>
                        </SectionLabel>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--app-text-strong)]">
                            <span className="font-medium capitalize">
                                {event.deadline.type.replace(/_/g, " ")}
                            </span>
                            {event.deadline.dueAt && (
                                <span className="text-[var(--app-text-muted)]">
                                    Due{" "}
                                    {new Date(
                                        event.deadline.dueAt,
                                    ).toLocaleDateString(undefined, {
                                        weekday: "short",
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                    })}
                                </span>
                            )}
                            {typeof event.deadline.leadDays === "number" && (
                                <span className="text-[var(--app-text-subtle)]">
                                    Reminder {event.deadline.leadDays} day
                                    {event.deadline.leadDays === 1 ? "" : "s"} before
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {(event.matterId || event.recordingId) && (
                    <div className={`${CARD} lg:col-span-2`}>
                        <SectionLabel>Linked</SectionLabel>
                        <div className="flex flex-wrap gap-2">
                            {event.matterId && (
                                <Link
                                    href={`/projects/${event.matterId}`}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-2.5 py-1 text-xs font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                    Matter
                                </Link>
                            )}
                            {event.recordingId && (
                                <Link
                                    href={`/recordings/${event.recordingId}`}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-2.5 py-1 text-xs font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                                >
                                    <Mic className="h-3.5 w-3.5" />
                                    Recording
                                </Link>
                            )}
                        </div>
                    </div>
                )}

                {event.description && (
                    <div className={`${CARD} lg:col-span-2`}>
                        <SectionLabel>Description</SectionLabel>
                        <p className="whitespace-pre-wrap text-sm text-[var(--app-text-strong)]">
                            {event.description}
                        </p>
                    </div>
                )}
            </div>

            {editing && (
                <EventComposer
                    editEvent={event}
                    onClose={() => setEditing(false)}
                    onDone={() => {
                        setEditing(false);
                        void load();
                    }}
                />
            )}
        </div>
    );
}

function BackLink() {
    return (
        <Link
            href="/calendar"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:text-[var(--app-text-strong)]"
        >
            <ArrowLeft className="h-3.5 w-3.5" />
            Calendar
        </Link>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
            {children}
        </div>
    );
}
