"use client";

import { useState } from "react";
import {
    CalendarPlus,
    CalendarClock,
    CalendarX,
    Users,
    Video,
    Check,
    Loader2,
    ShieldCheck,
    X,
} from "lucide-react";
import { approveCalendarWrite, cancelCalendarWrite } from "@/app/lib/cocoaLegalApi";
import type { AssistantEvent } from "../shared/types";

type CalendarPending = Extract<AssistantEvent, { type: "calendar_pending" }>;

type CardState =
    | "idle"
    | "arming"
    | "applying"
    | "applied"
    | "cancelling"
    | "cancelled"
    | "failed";

const KIND_META = {
    create: {
        Icon: CalendarPlus,
        title: "Event ready to schedule",
        cta: "Approve & schedule",
        confirm: "Schedule this event?",
        done: "Scheduled",
    },
    update: {
        Icon: CalendarClock,
        title: "Event change ready",
        cta: "Approve change",
        confirm: "Apply this change?",
        done: "Updated",
    },
    delete: {
        Icon: CalendarX,
        title: "Cancellation ready",
        cta: "Approve cancellation",
        confirm: "Cancel this event?",
        done: "Cancelled",
    },
} as const;

function fmt(value: string): string {
    if (!value) return "—";
    // A date-only (all-day) value has no "T"; a timestamp does.
    const d = value.includes("T") ? new Date(value) : new Date(`${value}T00:00`);
    if (Number.isNaN(d.getTime())) return value;
    return value.includes("T")
        ? d.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
          })
        : d.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
          });
}

/**
 * Inline approval card for an agent-prepared calendar change (create / update /
 * delete of an event WITH attendees). Rendered from a `calendar_pending` event.
 * Invitations and cancellations reach attendees only after an explicit
 * human-in-the-loop confirm — "Approve" first arms a distinct confirm button.
 * --app-* themed so it reads correctly in light and dark.
 */
export function EventApprovalCard({ event }: { event: CalendarPending }) {
    const meta = KIND_META[event.op_kind];
    const initialState: CardState =
        event.status === "applied"
            ? "applied"
            : event.status === "cancelled"
              ? "cancelled"
              : event.status === "failed"
                ? "failed"
                : "idle";
    const [state, setState] = useState<CardState>(initialState);
    const [error, setError] = useState<string | null>(null);

    const terminal =
        state === "applied" || state === "cancelled" || state === "failed";
    const busy = state === "applying" || state === "cancelling";

    const confirmApprove = async () => {
        if (busy || terminal) return;
        setState("applying");
        setError(null);
        try {
            const write = await approveCalendarWrite(event.write_id);
            if (write.status === "applied") setState("applied");
            else if (write.status === "cancelled") setState("cancelled");
            else {
                setError(
                    "This change wasn't applied — it may have already been cancelled.",
                );
                setState("idle");
            }
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Could not apply this change.",
            );
            setState("idle");
        }
    };

    const cancel = async () => {
        if (busy || terminal) return;
        setState("cancelling");
        setError(null);
        try {
            await cancelCalendarWrite(event.write_id);
            setState("cancelled");
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Could not cancel this change.",
            );
            setState("idle");
        }
    };

    const Icon = meta.Icon;

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 font-sans">
            <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 ring-1 ring-sky-200">
                    <Icon className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-semibold text-[var(--app-text-strong)]">
                    {meta.title}
                </span>
                <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                    <ShieldCheck className="h-3 w-3" />
                    Approval required
                </span>
            </div>

            <dl className="mt-3 space-y-1 text-sm">
                <Row label="What">
                    <span className="font-medium text-[var(--app-text-strong)]">
                        {event.title || "—"}
                    </span>
                </Row>
                <Row label="When">
                    {event.op_kind === "delete"
                        ? fmt(event.start)
                        : `${fmt(event.start)}${event.end ? ` – ${fmt(event.end)}` : ""}`}
                </Row>
                {event.location && <Row label="Where">{event.location}</Row>}
                <Row label="Calendar">
                    {event.calendar === "firm" ? "Cocoa Legal (firm)" : "Quill"}
                </Row>
            </dl>

            {event.attendees.length > 0 && (
                <p className="mt-2 flex items-center gap-1.5 rounded-md bg-[var(--app-warm-soft)] px-2.5 py-1.5 text-xs text-[var(--app-text-muted)]">
                    <Users className="h-3.5 w-3.5 shrink-0" />
                    {event.op_kind === "delete"
                        ? `Cancellation notices will be sent to ${event.attendees.length} attendee${event.attendees.length === 1 ? "" : "s"} on approval.`
                        : `Invitations will be sent to ${event.attendees.length} attendee${event.attendees.length === 1 ? "" : "s"} on approval.`}
                    {event.add_meet && (
                        <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                            <Video className="h-3.5 w-3.5" />
                            + Meet
                        </span>
                    )}
                </p>
            )}

            {error && <p className="mt-2 text-xs leading-5 text-red-600">{error}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {state === "applied" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                        <Check className="h-3.5 w-3.5" />
                        {meta.done}
                    </span>
                ) : state === "cancelled" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--app-active)] px-3 py-1 text-xs font-medium text-[var(--app-text-muted)]">
                        <X className="h-3.5 w-3.5" />
                        Cancelled
                    </span>
                ) : state === "failed" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
                        <X className="h-3.5 w-3.5" />
                        Failed
                    </span>
                ) : state === "arming" ? (
                    <>
                        <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                            {meta.confirm}
                        </span>
                        <button
                            type="button"
                            onClick={confirmApprove}
                            className="inline-flex items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-amber-200 hover:bg-amber-700"
                        >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Confirm
                        </button>
                        <button
                            type="button"
                            onClick={() => setState("idle")}
                            className="rounded border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                        >
                            Back
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => setState("arming")}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded border border-[var(--app-border-strong)] bg-[var(--app-text-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--app-shell)] hover:opacity-90 disabled:opacity-50"
                        >
                            {state === "applying" ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Applying…
                                </>
                            ) : (
                                <>
                                    <Icon className="h-3.5 w-3.5" />
                                    {meta.cta}
                                </>
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={cancel}
                            disabled={busy}
                            className="rounded border border-[var(--app-border)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] disabled:opacity-50"
                        >
                            {state === "cancelling" ? "Cancelling…" : "Dismiss"}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex gap-2">
            <dt className="w-16 shrink-0 font-medium text-[var(--app-text-subtle)]">
                {label}
            </dt>
            <dd className="min-w-0 break-words text-[var(--app-text-strong)]">
                {children}
            </dd>
        </div>
    );
}
