"use client";

import { useState } from "react";
import { X, Video, ShieldCheck, Undo2, Check } from "lucide-react";
import {
    createEvent,
    updateEvent,
    undoCalendarWrite,
    type CalendarEvent,
    type CalendarSource,
    type EventInput,
    type CalendarWriteResult,
} from "@/app/lib/cocoaLegalApi";
import { CALENDAR_COLORS } from "./calendarColors";

const BROWSER_TZ =
    typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "UTC";

/** Local Date → the value a <input type="datetime-local"> expects. */
function toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDateInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Create (and edit) an event. The core rule, consistent with email: when the
 * event has attendees the Save produces an approval-gated pending write
 * ("invitations sent on approval"); with no attendees it is applied directly and
 * offered an Undo. Rendered as a centered modal overlay, --app-* themed.
 */
export function EventComposer({
    seedDate,
    editEvent,
    onClose,
    onDone,
}: {
    seedDate?: Date | null;
    editEvent?: CalendarEvent | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const isEdit = Boolean(editEvent);
    const base = seedDate ?? new Date();
    const defaultStart = new Date(base);
    if (!seedDate) defaultStart.setMinutes(0, 0, 0);
    const defaultEnd = new Date(defaultStart.getTime() + 30 * 60_000);

    const [calendar, setCalendar] = useState<CalendarSource>(
        editEvent?.calendar ?? "primary",
    );
    const [title, setTitle] = useState(editEvent?.title ?? "");
    const [allDay, setAllDay] = useState(editEvent?.allDay ?? false);
    const [start, setStart] = useState(
        editEvent?.start.dateTime
            ? toLocalInput(new Date(editEvent.start.dateTime))
            : toLocalInput(defaultStart),
    );
    const [end, setEnd] = useState(
        editEvent?.end.dateTime
            ? toLocalInput(new Date(editEvent.end.dateTime))
            : toLocalInput(defaultEnd),
    );
    const [startDate, setStartDate] = useState(
        editEvent?.start.date ?? toDateInput(defaultStart),
    );
    const [endDate, setEndDate] = useState(
        editEvent?.end.date ?? toDateInput(defaultStart),
    );
    const [location, setLocation] = useState(editEvent?.location ?? "");
    const [description, setDescription] = useState(editEvent?.description ?? "");
    const [attendees, setAttendees] = useState<string[]>(
        editEvent?.attendees.map((a) => a.email) ?? [],
    );
    const [attendeeDraft, setAttendeeDraft] = useState("");
    const [addMeet, setAddMeet] = useState(Boolean(editEvent?.meetLink));

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<CalendarWriteResult | null>(null);

    const hasAttendees = attendees.length > 0;

    function commitAttendee() {
        const email = attendeeDraft.trim();
        if (email && /.+@.+\..+/.test(email) && !attendees.includes(email)) {
            setAttendees((prev) => [...prev, email]);
        }
        setAttendeeDraft("");
    }

    function buildInput(): EventInput {
        return {
            calendar,
            title: title.trim(),
            description: description.trim() || undefined,
            location: location.trim() || undefined,
            allDay,
            start: allDay
                ? { date: startDate }
                : { dateTime: new Date(start).toISOString(), timeZone: BROWSER_TZ },
            end: allDay
                ? { date: endDate }
                : { dateTime: new Date(end).toISOString(), timeZone: BROWSER_TZ },
            timeZone: BROWSER_TZ,
            attendees,
            addMeet: hasAttendees && addMeet,
        };
    }

    async function handleSave() {
        if (!title.trim()) {
            setError("A title is required.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const input = buildInput();
            const res =
                isEdit && editEvent
                    ? await updateEvent(editEvent.id, input)
                    : await createEvent(input);
            setResult(res);
            // Outward writes stay open showing the pending state; internal writes
            // show the Undo affordance. Both let the user dismiss to refresh.
            if (!res.operation) {
                // Internal (applied) — reload the list underneath immediately.
                // Keep the composer open briefly for the Undo affordance.
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save the event.");
        } finally {
            setBusy(false);
        }
    }

    async function handleUndo() {
        const writeId = result?.write_id;
        if (!writeId) return;
        setBusy(true);
        try {
            await undoCalendarWrite(writeId);
        } catch {
            // best-effort
        } finally {
            setBusy(false);
            onDone();
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-xl">
                <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
                    <h2 className="text-sm font-semibold text-[var(--app-text-strong)]">
                        {isEdit ? "Edit event" : "New event"}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="rounded-md p-1 text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Post-save states */}
                {result?.operation ? (
                    <div className="space-y-3 px-4 py-6">
                        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                            <ShieldCheck className="h-5 w-5" />
                            <span className="text-sm font-semibold">Approval required</span>
                        </div>
                        <p className="text-sm text-[var(--app-text-muted)]">
                            Quill prepared this event. Invitations to{" "}
                            {attendees.length} attendee
                            {attendees.length === 1 ? "" : "s"} are sent only when
                            you approve it — review it on the approval card in the
                            assistant chat.
                        </p>
                        <button
                            type="button"
                            onClick={onDone}
                            className="w-full rounded-lg bg-[var(--app-active)] px-3 py-2 text-sm font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                        >
                            Done
                        </button>
                    </div>
                ) : result ? (
                    <div className="space-y-3 px-4 py-6">
                        <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
                            <Check className="h-5 w-5" />
                            <span className="text-sm font-semibold">
                                Event {isEdit ? "updated" : "created"}
                            </span>
                        </div>
                        <p className="text-sm text-[var(--app-text-muted)]">
                            Added to Quill&apos;s calendar. No attendees, so no
                            invitations were sent.
                        </p>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handleUndo}
                                disabled={busy || !result.write_id}
                                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)] disabled:opacity-50"
                            >
                                <Undo2 className="h-4 w-4" />
                                Undo
                            </button>
                            <button
                                type="button"
                                onClick={onDone}
                                className="flex-1 rounded-lg bg-[var(--app-active)] px-3 py-2 text-sm font-medium text-[var(--app-text-strong)] hover:bg-[var(--app-hover)]"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-4">
                        {/* Calendar picker */}
                        <div className="flex gap-2">
                            {(["primary", "firm"] as CalendarSource[]).map((c) => (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => setCalendar(c)}
                                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                                        calendar === c
                                            ? "border-[var(--app-border-strong)] bg-[var(--app-active)] text-[var(--app-text-strong)]"
                                            : "border-[var(--app-border)] text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                                    }`}
                                >
                                    <span
                                        className={`h-2 w-2 rounded-full ${CALENDAR_COLORS[c].dot}`}
                                        aria-hidden
                                    />
                                    {CALENDAR_COLORS[c].label}
                                </button>
                            ))}
                        </div>

                        <Field label="Title">
                            <input
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Call — opposing counsel"
                                className={inputCls}
                            />
                        </Field>

                        <label className="flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
                            <input
                                type="checkbox"
                                checked={allDay}
                                onChange={(e) => setAllDay(e.target.checked)}
                            />
                            All day
                        </label>

                        <div className="grid grid-cols-2 gap-2">
                            <Field label="Start">
                                {allDay ? (
                                    <input
                                        type="date"
                                        value={startDate}
                                        onChange={(e) => setStartDate(e.target.value)}
                                        className={inputCls}
                                    />
                                ) : (
                                    <input
                                        type="datetime-local"
                                        value={start}
                                        onChange={(e) => setStart(e.target.value)}
                                        className={inputCls}
                                    />
                                )}
                            </Field>
                            <Field label="End">
                                {allDay ? (
                                    <input
                                        type="date"
                                        value={endDate}
                                        onChange={(e) => setEndDate(e.target.value)}
                                        className={inputCls}
                                    />
                                ) : (
                                    <input
                                        type="datetime-local"
                                        value={end}
                                        onChange={(e) => setEnd(e.target.value)}
                                        className={inputCls}
                                    />
                                )}
                            </Field>
                        </div>

                        <Field label="Location">
                            <input
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                                placeholder="Optional"
                                className={inputCls}
                            />
                        </Field>

                        <Field label="Attendees">
                            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-shell)] p-1.5">
                                {attendees.map((email) => (
                                    <span
                                        key={email}
                                        className="inline-flex items-center gap-1 rounded-full bg-[var(--app-active)] px-2 py-0.5 text-[11px] text-[var(--app-text-strong)]"
                                    >
                                        {email}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setAttendees((prev) =>
                                                    prev.filter((e) => e !== email),
                                                )
                                            }
                                            aria-label={`Remove ${email}`}
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </span>
                                ))}
                                <input
                                    value={attendeeDraft}
                                    onChange={(e) => setAttendeeDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === ",") {
                                            e.preventDefault();
                                            commitAttendee();
                                        } else if (
                                            e.key === "Backspace" &&
                                            !attendeeDraft
                                        ) {
                                            setAttendees((prev) => prev.slice(0, -1));
                                        }
                                    }}
                                    onBlur={commitAttendee}
                                    placeholder="email@firm.com"
                                    className="min-w-32 flex-1 bg-transparent px-1 text-sm text-[var(--app-text-strong)] outline-none"
                                />
                            </div>
                        </Field>

                        {hasAttendees && (
                            <label className="flex items-center gap-2 text-sm text-[var(--app-text-muted)]">
                                <input
                                    type="checkbox"
                                    checked={addMeet}
                                    onChange={(e) => setAddMeet(e.target.checked)}
                                />
                                <Video className="h-4 w-4" />
                                Add a Google Meet link
                            </label>
                        )}

                        <Field label="Description">
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                                placeholder="Optional"
                                className={inputCls}
                            />
                        </Field>

                        {hasAttendees && (
                            <p className="rounded-lg bg-[var(--app-warm-soft)] px-3 py-2 text-[11px] text-[var(--app-text-muted)]">
                                This event has attendees, so it will be prepared as
                                an approval card — invitations are sent only when you
                                approve it.
                            </p>
                        )}

                        {error && <p className="text-xs text-red-600">{error}</p>}

                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                type="button"
                                onClick={onClose}
                                className="rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm font-medium text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={busy}
                                className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                            >
                                {busy
                                    ? "Saving…"
                                    : hasAttendees
                                      ? "Save & request approval"
                                      : "Save"}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

const inputCls =
    "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-shell)] px-2.5 py-1.5 text-sm text-[var(--app-text-strong)] outline-none focus:border-[var(--app-border-strong)]";

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <label className="block">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--app-text-subtle)]">
                {label}
            </span>
            {children}
        </label>
    );
}
