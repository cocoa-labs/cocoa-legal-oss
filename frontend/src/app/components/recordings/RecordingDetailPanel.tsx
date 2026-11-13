"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    Check,
    Loader2,
    Mic,
    Pencil,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import {
    deleteRecording,
    getRecordingAudioUrl,
    listProjects,
    toggleRecordingActionItem,
    updateRecording,
} from "@/app/lib/cocoLegalApi";
import { useRecordingStatus } from "@/app/hooks/useRecordingStatus";
import { MarkdownContent } from "@/app/components/shared/MarkdownContent";
import type {
    CocoLegalProject,
    Recording,
    RecordingStatus,
} from "@/app/components/shared/types";
import { RecordingExtrasRow } from "./RecordingExtrasRow";
import { RecordingLinkedEvent } from "@/app/components/calendar/RecordingLinkedEvent";

/** Whole seconds → `mm:ss` (both zero-padded), matching the header/list. */
function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
        total % 60,
    ).padStart(2, "0")}`;
}

/** Whole seconds → `m:ss` (minutes unpadded), matching the transcript PDF. */
function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatCreated(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function isTerminal(status: RecordingStatus): boolean {
    return status === "ready" || status === "failed";
}

function processingLabel(status: RecordingStatus): string {
    switch (status) {
        case "transcribing":
            return "Transcribing audio…";
        case "summarizing":
            return "Summarizing…";
        case "queued":
        default:
            return "Queued for processing…";
    }
}

const WHITE_CARD =
    "rounded-lg border border-gray-200 bg-white p-4 font-sans shadow-sm";

// ---------------------------------------------------------------------------
// Audio player — lazy signed URL, refetched once on a playback error (expiry).
// ---------------------------------------------------------------------------

function RecordingAudioPlayer({ recordingId }: { recordingId: string }) {
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const retriedRef = useRef(false);
    // Bumped to re-run the fetch effect (initial load + the one expiry retry).
    const [reloadNonce, setReloadNonce] = useState(0);

    // Reset the one-shot retry guard when the recording changes (ref write, so
    // this stays out of the fetch effect's synchronous setState path).
    useEffect(() => {
        retriedRef.current = false;
    }, [recordingId]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const signed = await getRecordingAudioUrl(recordingId);
                if (cancelled) return;
                setUrl(signed);
                setError(null);
            } catch {
                if (!cancelled) setError("Audio is unavailable right now.");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [recordingId, reloadNonce]);

    const handleError = useCallback(() => {
        // A short-lived signed URL may have expired — refetch exactly once.
        if (retriedRef.current) {
            setError("Audio failed to play.");
            return;
        }
        retriedRef.current = true;
        setReloadNonce((n) => n + 1);
    }, []);

    if (error) {
        return <p className="text-xs text-[var(--app-text-subtle)]">{error}</p>;
    }
    if (!url) {
        return (
            <p className="flex items-center gap-1.5 text-xs text-[var(--app-text-subtle)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading audio…
            </p>
        );
    }
    return (
        <audio
            controls
            src={url}
            onError={handleError}
            className="w-full"
            aria-label="Recording playback"
        />
    );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function TranscriptCard({ recording }: { recording: Recording }) {
    const hasUtterances = recording.utterances.length > 0;
    const hasText = !!recording.transcript_text?.trim();

    return (
        <div className={WHITE_CARD}>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Transcript
            </p>
            {hasUtterances ? (
                <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-1">
                    {recording.utterances.map((u, i) => (
                        <div key={`${u.speaker}-${u.start_ms}-${i}`}>
                            <p className="text-xs font-semibold text-gray-900">
                                {u.speaker?.trim() || "Speaker"}{" "}
                                <span className="font-normal tabular-nums text-gray-400">
                                    [{formatClock(u.start_ms / 1000)}]
                                </span>
                            </p>
                            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-6 text-gray-700">
                                {u.text}
                            </p>
                        </div>
                    ))}
                </div>
            ) : hasText ? (
                <p className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-gray-700">
                    {recording.transcript_text}
                </p>
            ) : (
                <p className="flex items-center gap-1.5 py-6 text-sm text-gray-400">
                    {recording.status === "failed" ? (
                        "No transcript is available for this recording."
                    ) : (
                        <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            The transcript will appear here once transcription
                            finishes.
                        </>
                    )}
                </p>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function SummaryCard({ recording }: { recording: Recording }) {
    const summary = recording.summary_md?.trim();
    return (
        <div className={WHITE_CARD}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Summary
            </p>
            {summary ? (
                <MarkdownContent text={recording.summary_md ?? ""} citationsList={[]} />
            ) : (
                <p className="py-4 text-sm text-gray-400">
                    {recording.status === "failed"
                        ? "No summary is available for this recording."
                        : "The summary will appear here once processing finishes."}
                </p>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Action items — optimistic toggle with revert on error.
// ---------------------------------------------------------------------------

function ActionItemsCard({
    recording,
    onRecordingChange,
}: {
    recording: Recording;
    onRecordingChange: (recording: Recording) => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const [pendingId, setPendingId] = useState<string | null>(null);

    const toggle = useCallback(
        async (itemId: string) => {
            const previous = recording;
            setError(null);
            setPendingId(itemId);
            // Optimistic flip.
            onRecordingChange({
                ...recording,
                action_items: recording.action_items.map((it) =>
                    it.id === itemId ? { ...it, done: !it.done } : it,
                ),
            });
            try {
                const updated = await toggleRecordingActionItem(
                    recording.id,
                    itemId,
                );
                onRecordingChange(updated);
            } catch {
                onRecordingChange(previous); // revert
                setError("Could not update that action item.");
            } finally {
                setPendingId(null);
            }
        },
        [recording, onRecordingChange],
    );

    if (recording.action_items.length === 0) return null;

    return (
        <div className={WHITE_CARD}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
                Action items
            </p>
            <ul className="flex flex-col gap-1.5">
                {recording.action_items.map((item) => (
                    <li key={item.id}>
                        <button
                            type="button"
                            onClick={() => void toggle(item.id)}
                            disabled={pendingId === item.id}
                            className="flex w-full items-start gap-2 text-left text-sm disabled:opacity-70"
                            aria-pressed={item.done}
                        >
                            <span
                                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                    item.done
                                        ? "border-emerald-300 bg-emerald-50 text-emerald-600"
                                        : "border-gray-300 bg-white text-transparent"
                                }`}
                                aria-hidden="true"
                            >
                                {item.done && <Check className="h-3 w-3" />}
                            </span>
                            <span
                                className={`leading-snug ${
                                    item.done
                                        ? "text-gray-400 line-through"
                                        : "text-gray-800"
                                }`}
                            >
                                {item.text}
                                {(item.owner || item.due) && (
                                    <span className="ml-1 text-xs text-gray-400">
                                        {[item.owner, item.due]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </span>
                                )}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Header — editable title, source/duration/created, matter selector, delete.
// ---------------------------------------------------------------------------

function DetailHeader({
    recording,
    projects,
    onRecordingChange,
}: {
    recording: Recording;
    projects: CocoLegalProject[];
    onRecordingChange: (recording: Recording) => void;
}) {
    const router = useRouter();
    const SourceIcon = recording.source === "upload" ? Upload : Mic;

    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(recording.title);
    const [savingTitle, setSavingTitle] = useState(false);
    const [savingMatter, setSavingMatter] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const startEdit = () => {
        setTitleDraft(recording.title);
        setEditingTitle(true);
    };

    const saveTitle = useCallback(async () => {
        const next = titleDraft.trim();
        if (!next || next === recording.title) {
            setEditingTitle(false);
            return;
        }
        setSavingTitle(true);
        setError(null);
        try {
            const updated = await updateRecording(recording.id, {
                title: next,
            });
            onRecordingChange(updated);
            setEditingTitle(false);
        } catch {
            setError("Could not rename the recording.");
        } finally {
            setSavingTitle(false);
        }
    }, [titleDraft, recording.id, recording.title, onRecordingChange]);

    const changeMatter = useCallback(
        async (value: string) => {
            setSavingMatter(true);
            setError(null);
            try {
                const updated = await updateRecording(recording.id, {
                    project_id: value || null,
                });
                onRecordingChange(updated);
            } catch {
                setError("Could not update the matter link.");
            } finally {
                setSavingMatter(false);
            }
        },
        [recording.id, onRecordingChange],
    );

    const confirmDelete = useCallback(async () => {
        setDeleting(true);
        setError(null);
        try {
            await deleteRecording(recording.id);
            router.push("/recordings");
        } catch {
            setError("Could not delete the recording.");
            setDeleting(false);
        }
    }, [recording.id, router]);

    return (
        <div className="px-1 pb-3">
            <div className="flex items-start gap-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-800 ring-1 ring-sky-200">
                    <SourceIcon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    {editingTitle ? (
                        <div className="flex items-center gap-1.5">
                            <input
                                value={titleDraft}
                                onChange={(e) => setTitleDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") void saveTitle();
                                    if (e.key === "Escape")
                                        setEditingTitle(false);
                                }}
                                autoFocus
                                aria-label="Recording title"
                                className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-command)] px-2 py-1 text-sm font-semibold text-[var(--app-text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                            />
                            <button
                                type="button"
                                onClick={() => void saveTitle()}
                                disabled={savingTitle}
                                aria-label="Save title"
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] disabled:opacity-50"
                            >
                                {savingTitle ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Check className="h-4 w-4" />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => setEditingTitle(false)}
                                disabled={savingTitle}
                                aria-label="Cancel rename"
                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] disabled:opacity-50"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-1.5">
                            <h1 className="min-w-0 truncate text-base font-semibold text-[var(--app-text-strong)]">
                                {recording.title || "Untitled recording"}
                            </h1>
                            <button
                                type="button"
                                onClick={startEdit}
                                aria-label="Rename recording"
                                title="Rename"
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--app-text-subtle)]">
                        <span>
                            {recording.source === "upload"
                                ? "Uploaded"
                                : "Recorded"}
                        </span>
                        {typeof recording.duration_seconds === "number" && (
                            <>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                    {formatDuration(recording.duration_seconds)}
                                </span>
                            </>
                        )}
                        <span aria-hidden>·</span>
                        <span>{formatCreated(recording.created_at)}</span>
                    </p>
                </div>

                {/* Matter selector + delete */}
                <div className="flex shrink-0 items-center gap-1.5">
                    {savingMatter && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--app-text-subtle)]" />
                    )}
                    <label className="sr-only" htmlFor="recording-matter">
                        Linked matter
                    </label>
                    <select
                        id="recording-matter"
                        value={recording.project_id ?? ""}
                        disabled={savingMatter}
                        onChange={(e) => void changeMatter(e.target.value)}
                        className="max-w-[10rem] truncate rounded-md border border-[var(--app-border)] bg-[var(--app-command)] px-2 py-1.5 text-xs font-medium text-[var(--app-text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-60"
                    >
                        <option value="">No matter</option>
                        {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={() => setConfirmingDelete(true)}
                        aria-label="Delete recording"
                        title="Delete"
                        className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-text-subtle)] transition-colors hover:bg-red-500/10 hover:text-red-600"
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {confirmingDelete && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    <span className="font-medium">
                        Delete this recording and its transcript? This
                        can&apos;t be undone.
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void confirmDelete()}
                            disabled={deleting}
                            className="inline-flex items-center gap-1.5 rounded border border-red-600 bg-red-600 px-2.5 py-1 font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                        >
                            {deleting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                            )}
                            Delete
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmingDelete(false)}
                            disabled={deleting}
                            className="rounded border border-red-200 bg-white px-2.5 py-1 font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-60"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Full recording view. `useRecordingStatus` drives the page data: it polls
 * until the recording is terminal, and local mutations (rename, re-file,
 * action-item toggles, generated extras) layer on top via `setRecording`.
 * Renders progressively so the page is usable while still processing — no
 * layout jumps into an error state.
 */
export function RecordingDetailPanel({ recordingId }: { recordingId: string }) {
    const { recording: polled, error: pollError } =
        useRecordingStatus(recordingId);
    const [recording, setRecording] = useState<Recording | null>(null);
    const [projects, setProjects] = useState<CocoLegalProject[]>([]);

    // Sync from the poll during render (not via an effect): whenever the hook
    // yields a new snapshot — a fresh poll, or `null` when the route id changes
    // and the hook resets — adopt it. Polling stops once the recording is
    // terminal, so local mutations made afterwards are never clobbered.
    const [lastPolled, setLastPolled] = useState<Recording | null>(polled);
    if (lastPolled !== polled) {
        setLastPolled(polled);
        setRecording(polled);
    }

    useEffect(() => {
        listProjects()
            .then(setProjects)
            .catch(() => setProjects([]));
    }, []);

    if (!recording) {
        if (pollError) {
            return (
                <p className="px-1 py-6 text-sm text-red-600">
                    {pollError}
                </p>
            );
        }
        return (
            <div className="space-y-3 px-1 py-2">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-24 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                    />
                ))}
            </div>
        );
    }

    const status = recording.status;
    const ready = status === "ready";
    const failed = status === "failed";

    return (
        <div className="flex h-full w-full flex-col font-sans">
            <DetailHeader
                recording={recording}
                projects={projects}
                onRecordingChange={setRecording}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-6">
                {/* Processing / failed banner */}
                {!isTerminal(status) && (
                    <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {processingLabel(status)}
                    </div>
                )}
                {failed && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            {recording.error ??
                                "This recording could not be processed."}
                        </span>
                    </div>
                )}

                {/* Audio player */}
                <div className="mb-4">
                    <RecordingAudioPlayer recordingId={recording.id} />
                </div>

                {/* Linked calendar event (reciprocal of event→recording link) */}
                <div className="mb-4">
                    <RecordingLinkedEvent recordingId={recording.id} />
                </div>

                {/* Two-column body: transcript | summary + actions + extras */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div className="flex flex-col gap-4">
                        <TranscriptCard recording={recording} />
                    </div>
                    <div className="flex flex-col gap-4">
                        <SummaryCard recording={recording} />
                        <ActionItemsCard
                            recording={recording}
                            onRecordingChange={setRecording}
                        />
                        <div>
                            <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
                                Generate
                            </p>
                            <RecordingExtrasRow
                                recording={recording}
                                disabled={!ready}
                                onRecordingChange={setRecording}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
