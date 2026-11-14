"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Mic, Upload } from "lucide-react";
import {
    createRecording,
    listProjects,
    listRecordings,
} from "@/app/lib/cocoaLegalApi";
import {
    AUDIO_ACCEPT_ATTR,
    MAX_AUDIO_BYTES,
} from "@/app/lib/uploadTypes";
import type {
    CocoaLegalProject,
    Recording,
    RecordingSource,
    RecordingStatus,
} from "@/app/components/shared/types";
import { RecorderControl } from "./RecorderControl";
import { ConsentConfirm } from "./ConsentConfirm";

const POLL_INTERVAL_MS = 5000;

/** Terminal statuses stop the list poll. */
function isTerminal(status: RecordingStatus): boolean {
    return status === "ready" || status === "failed";
}

/** Whole seconds → `mm:ss` (both zero-padded), matching RecorderControl. */
function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Compact created-at date for a list row. */
function formatCreated(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

interface StatusChip {
    label: string;
    cls: string;
    /** Processing states show a subtle pulse + spinner. */
    processing: boolean;
}

function statusChip(status: RecordingStatus): StatusChip {
    switch (status) {
        case "ready":
            return {
                label: "Ready",
                cls: "border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)]",
                processing: false,
            };
        case "failed":
            return {
                label: "Failed",
                cls: "border-red-300 bg-red-50 text-red-600",
                processing: false,
            };
        case "transcribing":
            return {
                label: "Transcribing",
                cls: "border-amber-300 bg-amber-50 text-amber-700",
                processing: true,
            };
        case "summarizing":
            return {
                label: "Summarizing",
                cls: "border-amber-300 bg-amber-50 text-amber-700",
                processing: true,
            };
        case "queued":
        default:
            return {
                label: "Queued",
                cls: "border-amber-300 bg-amber-50 text-amber-700",
                processing: true,
            };
    }
}

function SourceGlyph({ source }: { source: RecordingSource }) {
    const Icon = source === "upload" ? Upload : Mic;
    return (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-panel)] text-[var(--app-text-muted)] ring-1 ring-[var(--app-border)]">
            <Icon className="h-4 w-4" />
        </div>
    );
}

function RecordingRow({
    recording,
    matterName,
}: {
    recording: Recording;
    matterName: string | null;
}) {
    const chip = statusChip(recording.status);
    return (
        <li>
            <div className="flex items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 transition-colors hover:bg-[var(--app-hover)]">
                <SourceGlyph source={recording.source} />
                <div className="min-w-0 flex-1">
                    <Link
                        href={`/recordings/${recording.id}`}
                        className="min-w-0 truncate text-sm font-semibold text-[var(--app-text-strong)] hover:underline"
                    >
                        {recording.title || "Untitled recording"}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--app-text-subtle)]">
                        <span>{formatCreated(recording.created_at)}</span>
                        {typeof recording.duration_seconds === "number" && (
                            <>
                                <span aria-hidden>·</span>
                                <span className="tabular-nums">
                                    {formatDuration(recording.duration_seconds)}
                                </span>
                            </>
                        )}
                        {matterName && (
                            <>
                                <span aria-hidden>·</span>
                                <span className="truncate">{matterName}</span>
                            </>
                        )}
                    </div>
                </div>
                <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium ${chip.cls} ${
                        chip.processing ? "animate-pulse" : ""
                    }`}
                >
                    {chip.processing && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                    )}
                    {chip.label}
                </span>
            </div>
        </li>
    );
}

/**
 * Standalone recordings library: capture (RecorderControl) or upload an audio
 * file straight into a new recording, then browse every recording newest-first.
 * Self-contained (owns its fetching), like CasesPanel / InboxPanel. Rows with a
 * non-terminal status are refreshed by a SINGLE list-level poll (every ~5s)
 * rather than one useRecordingStatus per row.
 */
export function RecordingsLibraryPanel() {
    const router = useRouter();
    const [recordings, setRecordings] = useState<Recording[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [projectNames, setProjectNames] = useState<Record<string, string>>(
        {},
    );

    // Capture/upload affordance state.
    const [pendingUpload, setPendingUpload] = useState<File | null>(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // Reload trigger: bumped on mount and by the poll to re-run the fetch
    // effect. Keeping the fetch inside the effect as an inline async IIFE (the
    // useFetchSingleDoc idiom) avoids a synchronous setState-in-effect.
    const [reloadTick, setReloadTick] = useState(0);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listRecordings();
                if (cancelled) return;
                setRecordings(rows);
                setLoadError(null);
            } catch (err) {
                if (cancelled) return;
                setLoadError(
                    err instanceof Error
                        ? err.message
                        : "Could not load your recordings.",
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadTick]);

    // Matter-name map (resolve project_id → name, mirroring AppSidebar's
    // listProjects() lookup). Fetched once.
    useEffect(() => {
        listProjects()
            .then((projects: CocoaLegalProject[]) => {
                const map: Record<string, string> = {};
                for (const p of projects) map[p.id] = p.name;
                setProjectNames(map);
            })
            .catch(() => setProjectNames({}));
    }, []);

    // Single page-level poll: while ANY row is still processing, bump the
    // reload tick every ~5s to refresh the whole list; stop once all terminal.
    useEffect(() => {
        if (!recordings) return;
        if (recordings.every((r) => isTerminal(r.status))) return;
        const timer = setInterval(
            () => setReloadTick((n) => n + 1),
            POLL_INTERVAL_MS,
        );
        return () => clearInterval(timer);
    }, [recordings]);

    const handleMicComplete = useCallback(
        async (result: {
            blob: Blob;
            durationMs: number;
            suggestedFilename: string;
        }) => {
            // Rejections here would be swallowed by RecorderControl's `void
            // handleStop()`, so surface failures via our own error affordance.
            setActionBusy(true);
            setActionError(null);
            try {
                const recording = await createRecording({
                    file: result.blob,
                    filename: result.suggestedFilename,
                    source: "mic",
                    consent: true,
                    durationSeconds: Math.round(result.durationMs / 1000),
                });
                router.push(`/recordings/${recording.id}`);
            } catch (err) {
                setActionError(
                    err instanceof Error
                        ? err.message
                        : "Could not save that recording.",
                );
                setActionBusy(false);
            }
        },
        [router],
    );

    const handleFilePicked = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0] ?? null;
            // Reset the input so re-picking the same file still fires onChange.
            if (fileInputRef.current) fileInputRef.current.value = "";
            if (!file) return;
            if (file.size > MAX_AUDIO_BYTES) {
                setActionError(
                    `Audio file skipped — over ${Math.round(
                        MAX_AUDIO_BYTES / (1024 * 1024),
                    )} MB.`,
                );
                return;
            }
            setActionError(null);
            setPendingUpload(file);
        },
        [],
    );

    // Consent confirmed for the parked upload → create the recording, then
    // navigate to its detail page (same discipline as the T12 composer path).
    const handleUploadConfirm = useCallback(async () => {
        if (!pendingUpload) return;
        const file = pendingUpload;
        setPendingUpload(null);
        setActionBusy(true);
        setActionError(null);
        try {
            const recording = await createRecording({
                file,
                filename: file.name,
                source: "upload",
                consent: true,
            });
            router.push(`/recordings/${recording.id}`);
        } catch (err) {
            setActionError(
                err instanceof Error
                    ? err.message
                    : "Could not upload that file.",
            );
            setActionBusy(false);
        }
    }, [pendingUpload, router]);

    return (
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col font-sans">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-1 pb-3 pt-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-800 ring-1 ring-sky-200">
                    <Mic className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-[var(--app-text-strong)]">
                        Recordings
                    </h1>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        Capture or upload audio to transcribe and summarize
                    </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    <RecorderControl
                        variant="full"
                        disabled={actionBusy}
                        onComplete={handleMicComplete}
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={actionBusy}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-medium text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
                    >
                        <Upload className="h-4 w-4 shrink-0" />
                        Upload
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={AUDIO_ACCEPT_ATTR}
                        onChange={handleFilePicked}
                        className="hidden"
                        aria-hidden="true"
                        tabIndex={-1}
                    />
                </div>
            </div>

            {/* Inline consent gate for a parked upload (shown before anything
                uploads, mirroring the composer flow). */}
            {pendingUpload && (
                <div className="px-1 pb-3">
                    <ConsentConfirm
                        onConfirm={() => void handleUploadConfirm()}
                        onCancel={() => setPendingUpload(null)}
                    />
                </div>
            )}

            {actionBusy && (
                <p className="flex items-center gap-1.5 px-1 pb-2 text-xs text-[var(--app-text-muted)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving…
                </p>
            )}
            {actionError && (
                <p className="px-1 pb-2 text-xs text-red-600">{actionError}</p>
            )}
            {loadError && (
                <p className="px-1 pb-2 text-xs text-red-600">{loadError}</p>
            )}

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {recordings === null ? (
                    <div className="space-y-2 px-1">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-16 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                            />
                        ))}
                    </div>
                ) : recordings.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-6 py-12 text-center">
                        <Mic className="h-6 w-6 text-[var(--app-text-subtle)]" />
                        <p className="text-sm font-medium text-[var(--app-text-muted)]">
                            No recordings yet
                        </p>
                        <p className="max-w-xs text-xs text-[var(--app-text-subtle)]">
                            Record audio right here or upload an existing file —
                            we&apos;ll transcribe it, summarize it, and pull out
                            action items.
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                            <RecorderControl
                                variant="full"
                                disabled={actionBusy}
                                onComplete={handleMicComplete}
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={actionBusy}
                                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-medium text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
                            >
                                <Upload className="h-4 w-4 shrink-0" />
                                Upload
                            </button>
                        </div>
                    </div>
                ) : (
                    <ul className="space-y-2 px-1 pb-2">
                        {recordings.map((recording) => (
                            <RecordingRow
                                key={recording.id}
                                recording={recording}
                                matterName={
                                    recording.project_id
                                        ? projectNames[recording.project_id] ??
                                          null
                                        : null
                                }
                            />
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
