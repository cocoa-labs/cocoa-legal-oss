"use client";

import { useEffect, useState } from "react";
import { getAuthoringJob } from "@/app/lib/cocoaLegalApi";
import type { AuthoringJobStatus } from "@/app/components/shared/types";

const POLL_INTERVAL_MS = 2500;

/** A job is done (stop polling) once it reaches a terminal status or stalls. */
function isDone(job: AuthoringJobStatus): boolean {
    return (
        job.status === "ready" ||
        job.status === "failed" ||
        job.stalled === true
    );
}

/**
 * The whole poll result lives in ONE state object tagged with the jobId it
 * belongs to. That tag is what lets a jobId change reset the hook during
 * render (the react.dev "adjusting state when props change" pattern) instead
 * of via setState-in-effect, and it makes stale writes structurally
 * impossible to observe: a snapshot for an old job never matches the current
 * jobId, so it's replaced before anything renders from it.
 */
interface PollSnapshot {
    jobId: string | null;
    job: AuthoringJobStatus | null;
    loading: boolean;
    error: string | null;
}

function freshSnapshot(jobId: string | null): PollSnapshot {
    // A non-null job starts in the optimistic loading state; null is idle.
    return { jobId, job: null, loading: jobId !== null, error: null };
}

/**
 * Poll an async authoring (assembly) job until it reaches a terminal state.
 *
 * Pass the `job_id` returned by `startAuthorDocument` (wizard) or the
 * assemble_document approve response (chat). While `jobId` is non-null this
 * fetches `getAuthoringJob` immediately and then every ~2.5s, STOPPING once the
 * job's `status` is `ready`/`failed` or `stalled` is true. The interval is torn
 * down on unmount and whenever `jobId` changes, and all state writes are guarded
 * against a stale (unmounted / superseded) poll so a terminal/stalled job always
 * resolves the UI rather than hanging on a spinner.
 *
 * `loading` is true while a non-terminal job is still being polled (and on the
 * very first fetch); it flips false once the job is terminal/stalled or a fetch
 * errors.
 */
export function useAuthoringJob(jobId: string | null): {
    job: AuthoringJobStatus | null;
    loading: boolean;
    error: string | null;
} {
    const [snapshot, setSnapshot] = useState<PollSnapshot>(() =>
        freshSnapshot(jobId),
    );

    // jobId changed (including → null): reset synchronously during render so
    // the old job's data never paints next to the new id. Guarded by the
    // jobId tag, so it runs exactly once per change — no render loop.
    if (snapshot.jobId !== jobId) {
        setSnapshot(freshSnapshot(jobId));
    }

    useEffect(() => {
        // No job to track — nothing to poll (the render-phase reset above
        // already put the hook in the idle state).
        if (!jobId) return;

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
                const next = await getAuthoringJob(jobId);
                if (!active) return;
                setSnapshot({
                    jobId,
                    job: next,
                    error: null,
                    loading: !isDone(next),
                });
                if (isDone(next)) stop();
            } catch (err) {
                if (!active) return;
                // Keep polling on a transient fetch error; a later tick may
                // recover. Drop the spinner so the error is visible meanwhile,
                // but keep the last good job payload.
                setSnapshot((prev) => ({
                    jobId,
                    job: prev.jobId === jobId ? prev.job : null,
                    error:
                        err instanceof Error
                            ? err.message
                            : "Could not load the assembly job.",
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
    }, [jobId]);

    return { job: snapshot.job, loading: snapshot.loading, error: snapshot.error };
}
