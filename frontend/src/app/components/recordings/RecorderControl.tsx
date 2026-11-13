"use client";

import { useState } from "react";
import { Loader2, Mic, Pause, Play, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
    useMediaRecorder,
    type RecorderError,
} from "@/app/hooks/useMediaRecorder";
import { ConsentConfirm } from "./ConsentConfirm";

export interface RecorderCompleteResult {
    blob: Blob;
    mimeType: string;
    durationMs: number;
    suggestedFilename: string;
}

interface Props {
    onComplete: (result: RecorderCompleteResult) => void | Promise<void>;
    disabled?: boolean;
    variant?: "composer" | "full";
}

/** `elapsedMs` → `mm:ss`. */
function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Container extension for a recorder MIME type (default `.webm`). */
function extensionForMime(mime: string): string {
    const value = mime.toLowerCase();
    if (value.includes("webm")) return ".webm";
    if (value.includes("mp4")) return ".m4a";
    if (value.includes("ogg")) return ".ogg";
    return ".webm";
}

/** `Recording 2026-07-17 14.09.webm` — colon-free so it is filename-safe. */
function buildSuggestedFilename(mime: string, now: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
        now.getDate(),
    )} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
    return `Recording ${stamp}${extensionForMime(mime)}`;
}

function errorMessage(error: RecorderError): string {
    switch (error.kind) {
        case "permission-denied":
            return "Microphone access was denied — enable it in your browser settings.";
        case "no-device":
            return "No microphone found.";
        case "unsupported":
            return "Recording isn't supported in this browser.";
        default:
            return "Something went wrong while starting the recording.";
    }
}

const BAR_CLASS =
    "flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2";

/**
 * Self-contained mic capture affordance. Owns the record → consent → capture →
 * complete flow and hands the finished blob to `onComplete`; it performs NO API
 * calls, so callers (chat composer T12, library upload T13) own upload and
 * navigation. `variant` only changes the idle trigger: `composer` is an
 * icon-only button sized like the chat attach button, `full` a labeled button.
 */
export function RecorderControl({
    onComplete,
    disabled = false,
    variant = "composer",
}: Props) {
    const { state, elapsedMs, start, pause, resume, stop, cancel, error } =
        useMediaRecorder();
    const [showConsent, setShowConsent] = useState(false);
    // True while awaiting stop()+onComplete, so we can hold a "Saving…" view
    // instead of flashing the idle mic button before the caller finishes.
    const [saving, setSaving] = useState(false);

    const handleMicClick = () => {
        if (disabled) return;
        setShowConsent(true);
    };

    const handleConsentConfirm = () => {
        setShowConsent(false);
        void start();
    };

    const handleStop = async () => {
        setSaving(true);
        try {
            const result = await stop();
            if (result) {
                await onComplete({
                    ...result,
                    suggestedFilename: buildSuggestedFilename(result.mimeType),
                });
            }
        } finally {
            setSaving(false);
        }
    };

    const handleCancel = () => {
        cancel();
        setShowConsent(false);
        setSaving(false);
    };

    // Error takes precedence so a denied/absent mic is always visible.
    if (state === "error" && error) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
                <span className="flex-1">{errorMessage(error)}</span>
                <button
                    type="button"
                    onClick={handleCancel}
                    aria-label="Dismiss recording error"
                    className="rounded p-0.5 text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        );
    }

    if (saving) {
        return (
            <div className={cn(BAR_CLASS, "text-xs text-[var(--app-text-muted)]")}>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Saving…</span>
            </div>
        );
    }

    if (showConsent) {
        return (
            <ConsentConfirm
                onConfirm={handleConsentConfirm}
                onCancel={handleCancel}
            />
        );
    }

    if (state === "requesting") {
        return (
            <div className={cn(BAR_CLASS, "text-xs text-[var(--app-text-muted)]")}>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Requesting microphone…</span>
            </div>
        );
    }

    if (state === "recording" || state === "paused") {
        const isRecording = state === "recording";
        return (
            <div className={BAR_CLASS}>
                <span
                    className="relative flex h-2.5 w-2.5 shrink-0"
                    aria-hidden="true"
                >
                    {isRecording && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                    )}
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                </span>
                <span className="tabular-nums text-sm font-medium text-[var(--app-text-strong)]">
                    {formatDuration(elapsedMs)}
                </span>

                <div className="ml-auto flex items-center gap-1.5">
                    {isRecording ? (
                        <button
                            type="button"
                            onClick={pause}
                            aria-label="Pause recording"
                            title="Pause"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                        >
                            <Pause className="h-4 w-4" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={resume}
                            aria-label="Resume recording"
                            title="Resume"
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                        >
                            <Play className="h-4 w-4" />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => void handleStop()}
                        aria-label="Stop and save recording"
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--app-active-strong)] px-2.5 text-xs font-medium text-[var(--app-active-foreground)] transition-opacity hover:opacity-90"
                    >
                        <Square
                            className="h-3 w-3"
                            fill="currentColor"
                            strokeWidth={0}
                        />
                        Stop
                    </button>
                    <button
                        type="button"
                        onClick={handleCancel}
                        aria-label="Discard recording"
                        className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    // idle
    if (variant === "full") {
        return (
            <button
                type="button"
                onClick={handleMicClick}
                disabled={disabled}
                aria-label="Record audio"
                title="Record audio"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 text-sm font-medium text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
            >
                <Mic className="h-4 w-4 shrink-0" />
                Record
            </button>
        );
    }

    return (
        <button
            type="button"
            onClick={handleMicClick}
            disabled={disabled}
            aria-label="Record audio"
            title="Record audio"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] disabled:opacity-50"
        >
            <Mic className="h-4 w-4 shrink-0" />
        </button>
    );
}
