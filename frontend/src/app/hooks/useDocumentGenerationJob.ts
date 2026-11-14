"use client";

import { useCallback, useEffect, useState } from "react";
import { getDocumentGenerationJob } from "@/app/lib/cocoaLegalApi";
import type { DocumentGenerationJobStatus } from "@/app/components/shared/types";
import { startDocumentJobPolling } from "@/app/lib/documentJobPolling";

export function useDocumentGenerationJob(jobId: string) {
    const [snapshot, setSnapshot] = useState<{
        jobId: string;
        job: DocumentGenerationJobStatus | null;
        error: string | null;
    }>({ jobId, job: null, error: null });
    const [pollRevision, setPollRevision] = useState(0);
    const refresh = useCallback(
        () => setPollRevision((revision) => revision + 1),
        [],
    );
    useEffect(
        () =>
            startDocumentJobPolling({
                load: () => getDocumentGenerationJob(jobId),
                onJob: (job) => setSnapshot({ jobId, job, error: null }),
                onError: (error) =>
                    setSnapshot((previous) => ({
                        jobId,
                        job: previous.jobId === jobId ? previous.job : null,
                        error,
                    })),
            }),
        [jobId, pollRevision],
    );
    useEffect(() => {
        const updated = (event: Event) => {
            if ((event as CustomEvent).detail === jobId) refresh();
        };
        window.addEventListener("document-generation-job-updated", updated);
        window.addEventListener("focus", refresh);
        return () => {
            window.removeEventListener(
                "document-generation-job-updated",
                updated,
            );
            window.removeEventListener("focus", refresh);
        };
    }, [jobId, refresh]);
    return {
        job: snapshot.jobId === jobId ? snapshot.job : null,
        error: snapshot.jobId === jobId ? snapshot.error : null,
        refresh,
    };
}
