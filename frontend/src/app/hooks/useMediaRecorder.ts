"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How often the elapsed-time readout is recomputed while recording. */
const TIMER_INTERVAL_MS = 500;
/**
 * Emit a `dataavailable` chunk every second so audio accumulates steadily
 * instead of being buffered until `stop()` — keeps memory bounded and makes a
 * mid-recording crash recoverable up to the last flushed second.
 */
const TIMESLICE_MS = 1000;

/**
 * MIME preference order. `MediaRecorder.isTypeSupported` is consulted at
 * `start()` time (never at module scope), so this stays SSR-safe. Opus-in-WebM
 * is the smallest/best-supported on Chromium/Firefox; plain WebM is the
 * fallback; `audio/mp4` covers Safari; `""` lets the browser pick its default.
 */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export type MediaRecorderState =
    | "idle"
    | "requesting"
    | "recording"
    | "paused"
    | "error";

export type RecorderErrorKind =
    | "unsupported"
    | "permission-denied"
    | "no-device"
    | "unknown";

export interface RecorderError {
    kind: RecorderErrorKind;
    message: string;
}

export interface RecordingResult {
    blob: Blob;
    mimeType: string;
    durationMs: number;
}

export interface UseMediaRecorder {
    state: MediaRecorderState;
    /** Active (non-paused) recording time in ms, refreshed ~every 500ms. */
    elapsedMs: number;
    start: () => Promise<void>;
    pause: () => void;
    resume: () => void;
    /**
     * Stop, flush the final chunk, release the mic, and resolve with the
     * assembled blob. Resolves `null` when nothing was captured.
     */
    stop: () => Promise<RecordingResult | null>;
    /** Discard everything in flight and return to idle without a result. */
    cancel: () => void;
    error: RecorderError | null;
    /** The MIME type the recorder actually chose (empty until `start`). */
    mimeType: string;
}

/** Map a `getUserMedia`/`MediaRecorder` exception to a stable error kind. */
function toRecorderError(err: unknown): RecorderError {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
        return {
            kind: "permission-denied",
            message: "Microphone access was denied.",
        };
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
        return { kind: "no-device", message: "No microphone was found." };
    }
    return {
        kind: "unknown",
        message:
            err instanceof Error
                ? err.message
                : "The recording could not be started.",
    };
}

/** Pick the first supported MIME type; `""` means "browser default". */
function pickMimeType(): string {
    if (
        typeof MediaRecorder === "undefined" ||
        typeof MediaRecorder.isTypeSupported !== "function"
    ) {
        return "";
    }
    for (const candidate of MIME_CANDIDATES) {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    }
    return "";
}

/**
 * Microphone capture backed by the `MediaRecorder` API.
 *
 * All browser globals are touched only inside callbacks (never at module scope
 * or during render), so the hook is safe to import from a server-rendered tree.
 * Timing is pause-aware: we accumulate the duration of each active span rather
 * than diffing wall-clock start→stop, so paused time is excluded from both the
 * live readout and the final `durationMs`.
 */
export function useMediaRecorder(): UseMediaRecorder {
    const [state, setState] = useState<MediaRecorderState>("idle");
    const [elapsedMs, setElapsedMs] = useState(0);
    const [error, setError] = useState<RecorderError | null>(null);
    const [mimeType, setMimeType] = useState("");

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const mimeTypeRef = useRef("");
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Pause-aware timing: `accumulatedMs` holds the duration of completed active
    // spans; `spanStart` is the timestamp the current running span began (null
    // while paused/stopped). Live elapsed = accumulated + (now - spanStart).
    const accumulatedMsRef = useRef(0);
    const spanStartRef = useRef<number | null>(null);
    // Set while a stop() is awaiting its recorder's `onstop`.
    const stopResolveRef = useRef<((r: RecordingResult | null) => void) | null>(
        null,
    );

    const releaseTracks = useCallback(() => {
        const stream = streamRef.current;
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }
    }, []);

    const clearTimer = useCallback(() => {
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
    }, []);

    /** Detach handlers and stop the recorder without producing a result. */
    const teardownRecorder = useCallback(() => {
        const recorder = recorderRef.current;
        if (recorder) {
            recorder.ondataavailable = null;
            recorder.onstop = null;
            if (recorder.state !== "inactive") {
                try {
                    recorder.stop();
                } catch {
                    // Already stopping/inactive — nothing to do.
                }
            }
        }
        recorderRef.current = null;
    }, []);

    const start = useCallback(async () => {
        if (
            typeof navigator === "undefined" ||
            !navigator.mediaDevices?.getUserMedia ||
            typeof MediaRecorder === "undefined"
        ) {
            setError({
                kind: "unsupported",
                message: "Recording is not supported in this browser.",
            });
            setState("error");
            return;
        }

        setError(null);
        setState("requesting");

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            setError(toRecorderError(err));
            setState("error");
            return;
        }
        streamRef.current = stream;

        const preferredMime = pickMimeType();
        let recorder: MediaRecorder;
        try {
            recorder = new MediaRecorder(
                stream,
                preferredMime ? { mimeType: preferredMime } : undefined,
            );
        } catch {
            // Some browsers reject the options object even for a supported
            // type; retry with the plain default before giving up.
            try {
                recorder = new MediaRecorder(stream);
            } catch {
                releaseTracks();
                setError({
                    kind: "unsupported",
                    message: "Recording is not supported in this browser.",
                });
                setState("error");
                return;
            }
        }

        recorderRef.current = recorder;
        chunksRef.current = [];
        const actualMime = recorder.mimeType || preferredMime;
        mimeTypeRef.current = actualMime;
        setMimeType(actualMime);

        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) {
                chunksRef.current.push(event.data);
            }
        };
        recorder.onstop = () => {
            releaseTracks();
            const chunks = chunksRef.current;
            chunksRef.current = [];
            const resolve = stopResolveRef.current;
            stopResolveRef.current = null;
            if (chunks.length === 0) {
                resolve?.(null);
                return;
            }
            const type = mimeTypeRef.current || recorder.mimeType || "";
            const blob = new Blob(chunks, type ? { type } : undefined);
            resolve?.({
                blob,
                mimeType: blob.type || type,
                durationMs: accumulatedMsRef.current,
            });
        };

        accumulatedMsRef.current = 0;
        spanStartRef.current = performance.now();
        setElapsedMs(0);
        clearTimer();
        intervalRef.current = setInterval(() => {
            const running =
                spanStartRef.current !== null
                    ? performance.now() - spanStartRef.current
                    : 0;
            setElapsedMs(accumulatedMsRef.current + running);
        }, TIMER_INTERVAL_MS);

        recorder.start(TIMESLICE_MS);
        setState("recording");
    }, [clearTimer, releaseTracks]);

    const pause = useCallback(() => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state !== "recording") return;
        recorder.pause();
        if (spanStartRef.current !== null) {
            accumulatedMsRef.current += performance.now() - spanStartRef.current;
            spanStartRef.current = null;
        }
        setElapsedMs(accumulatedMsRef.current);
        setState("paused");
    }, []);

    const resume = useCallback(() => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state !== "paused") return;
        recorder.resume();
        spanStartRef.current = performance.now();
        setState("recording");
    }, []);

    const stop = useCallback((): Promise<RecordingResult | null> => {
        return new Promise((resolve) => {
            const recorder = recorderRef.current;
            clearTimer();
            // Finalize the running span synchronously so `onstop` reports the
            // correct duration.
            if (spanStartRef.current !== null) {
                accumulatedMsRef.current +=
                    performance.now() - spanStartRef.current;
                spanStartRef.current = null;
            }
            setElapsedMs(accumulatedMsRef.current);

            if (!recorder || recorder.state === "inactive") {
                releaseTracks();
                recorderRef.current = null;
                setState("idle");
                resolve(null);
                return;
            }

            stopResolveRef.current = (result) => {
                recorderRef.current = null;
                setState("idle");
                resolve(result);
            };
            try {
                recorder.stop();
            } catch {
                stopResolveRef.current = null;
                releaseTracks();
                recorderRef.current = null;
                setState("idle");
                resolve(null);
            }
        });
    }, [clearTimer, releaseTracks]);

    const cancel = useCallback(() => {
        clearTimer();
        stopResolveRef.current = null;
        teardownRecorder();
        chunksRef.current = [];
        releaseTracks();
        accumulatedMsRef.current = 0;
        spanStartRef.current = null;
        setElapsedMs(0);
        setError(null);
        setState("idle");
    }, [clearTimer, releaseTracks, teardownRecorder]);

    // Release the mic and timer if the component unmounts mid-recording.
    useEffect(() => {
        return () => {
            clearTimer();
            teardownRecorder();
            releaseTracks();
        };
    }, [clearTimer, releaseTracks, teardownRecorder]);

    return {
        state,
        elapsedMs,
        start,
        pause,
        resume,
        stop,
        cancel,
        error,
        mimeType,
    };
}
