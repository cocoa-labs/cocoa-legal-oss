"use client";

import { useEffect, useState } from "react";
import { getRecording } from "@/app/lib/cocoLegalApi";
import type { Recording } from "@/app/components/shared/types";

const POLL_INTERVAL_MS = 2500;

/** A recording is done (stop polling) once transcription+summary settle. */
function isDone(recording: Recording): boolean {
    return recording.status === "ready" || recording.status === "failed";
}

/**
 * Snapshot pattern cloned verbatim from `useAuthoringJob`: the entire poll
 * result lives in ONE state object tagged with the recordingId it belongs to.
 * That tag lets a recordingId change reset the hook during render (the
 * react.dev "adjusting state when props change" pattern) instead of via
 * setState-in-effect, and it makes stale writes structurally impossible to
 * observe — a snapshot for an old recording never matches the current id, so
 * it's replaced before anything renders from it. See useAuthoringJob.ts for the
 * fuller rationale.
 */
interface PollSnapshot {
    recordingId: string | null;
    recording: Recording | null;
    loading: boolean;
    error: string | null;
}

function freshSnapshot(recordingId: string | null): PollSnapshot {
    // A non-null id starts in the optimistic loading state; null is idle.
    return {
        recordingId,
        recording: null,
        loading: recordingId !== null,
        error: null,
    };
}

/**
 * Poll `getRecording` until the recording reaches a terminal status.
 *
 * While `recordingId` is non-null this fetches immediately and then every
 * ~2.5s, STOPPING once `status` is `ready`/`failed`. The interval is torn down
 * on unmount and whenever `recordingId` changes, and all writes are guarded
 * against a stale (unmounted / superseded) poll so a terminal recording always
 * resolves the UI rather than hanging on a spinner.
 *
 * `loading` is true while a non-terminal recording is still being polled (and
 * on the very first fetch); it flips false once terminal or a fetch errors.
 */
export function useRecordingStatus(recordingId: string | null): {
    recording: Recording | null;
    loading: boolean;
    error: string | null;
} {
    const [snapshot, setSnapshot] = useState<PollSnapshot>(() =>
        freshSnapshot(recordingId),
    );

    // recordingId changed (including → null): reset synchronously during render
    // so the old recording's data never paints next to the new id. Guarded by
    // the id tag, so it runs exactly once per change — no render loop.
    if (snapshot.recordingId !== recordingId) {
        setSnapshot(freshSnapshot(recordingId));
    }

    useEffect(() => {
        // Nothing to track — the render-phase reset already put us in idle.
        if (!recordingId) return;

        let active = true;
        let timer: ReturnType<typeof setInterval> | null = null;

        const stop = () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };

        const run = async () => {
            try {
                const next = await getRecording(recordingId);
                if (!active) return;
                setSnapshot({
                    recordingId,
                    recording: next,
                    error: null,
                    loading: !isDone(next),
                });
                if (isDone(next)) stop();
            } catch (err) {
                if (!active) return;
                // Keep polling on a transient fetch error; a later tick may
                // recover. Drop the spinner so the error is visible meanwhile,
                // but keep the last good recording payload.
                setSnapshot((prev) => ({
                    recordingId,
                    recording:
                        prev.recordingId === recordingId
                            ? prev.recording
                            : null,
                    error:
                        err instanceof Error
                            ? err.message
                            : "Could not load the recording.",
                    loading: false,
                }));
            }
        };

        void run();
        timer = setInterval(() => void run(), POLL_INTERVAL_MS);

        return () => {
            active = false;
            stop();
        };
    }, [recordingId]);

    return {
        recording: snapshot.recording,
        loading: snapshot.loading,
        error: snapshot.error,
    };
}
