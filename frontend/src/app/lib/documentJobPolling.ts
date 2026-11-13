import type { DocumentGenerationJobStatus } from "@/app/components/shared/types";

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

/** The mounted artifact owns polling; the activity trace never owns it. */
export function startDocumentJobPolling(options: {
    load: () => Promise<DocumentGenerationJobStatus>;
    onJob: (job: DocumentGenerationJobStatus) => void;
    onError: (message: string) => void;
    schedule?: (
        callback: () => void,
        ms: number,
    ) => ReturnType<typeof setTimeout>;
    unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = options.schedule ?? setTimeout;
    const poll = async () => {
        try {
            const job = await options.load();
            if (!active) return;
            options.onJob(job);
            if (!TERMINAL.has(job.status))
                timer = schedule(() => void poll(), 2500);
        } catch (error) {
            if (!active) return;
            options.onError(
                error instanceof Error
                    ? error.message
                    : "Could not load the drafting job.",
            );
            timer = schedule(() => void poll(), 4000);
        }
    };
    void poll();
    return () => {
        active = false;
        if (timer !== null) (options.unschedule ?? clearTimeout)(timer);
    };
}
