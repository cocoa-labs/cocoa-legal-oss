import type { createServerSupabase } from "../supabase";
import type { DocumentGenerationJobRow } from "./types";

export class DocumentGenerationLeaseLost extends Error {
    constructor(message = "Document worker no longer owns this packet.") {
        super(message);
    }
}

/** A settled heartbeat schedules the next one, so slow writes cannot overlap. */
export function createDocumentJobLease(
    db: ReturnType<typeof createServerSupabase>,
    job: DocumentGenerationJobRow,
    timers = { schedule: setTimeout, unschedule: clearTimeout },
) {
    let stopped = false;
    let failure: Error | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: Promise<void> | null = null;
    const assertOwned = async () => {
        if (failure) throw failure;
        if (!job.claimed_by) throw new DocumentGenerationLeaseLost();
        const { data, error } = await db
            .from("document_generation_jobs")
            .select("id")
            .eq("id", job.id)
            .eq("claimed_by", job.claimed_by)
            .eq("status", "running")
            .maybeSingle();
        if (error)
            throw new DocumentGenerationLeaseLost(
                `Could not verify document worker ownership: ${error.message}`,
            );
        if (!data) throw new DocumentGenerationLeaseLost();
    };
    const beat = async () => {
        if (stopped) return;
        try {
            if (!job.claimed_by) throw new DocumentGenerationLeaseLost();
            const now = new Date().toISOString();
            const { data, error } = await db
                .from("document_generation_jobs")
                .update({ heartbeat_at: now, updated_at: now })
                .eq("id", job.id)
                .eq("claimed_by", job.claimed_by)
                .eq("status", "running")
                .select("id")
                .maybeSingle();
            if (error)
                throw new DocumentGenerationLeaseLost(
                    `Document worker heartbeat failed: ${error.message}`,
                );
            if (!data) throw new DocumentGenerationLeaseLost();
        } catch (error) {
            failure =
                error instanceof Error
                    ? error
                    : new DocumentGenerationLeaseLost(String(error));
            console.error("[document-generation] lease heartbeat stopped", {
                jobId: job.id,
                error: failure.message,
            });
            return;
        }
        if (!stopped) {
            timer = timers.schedule(() => {
                pending = beat();
            }, 30_000);
            timer.unref?.();
        }
    };
    return {
        assertOwned,
        async start() {
            pending = beat();
            await pending;
            if (failure) throw failure;
        },
        async stop() {
            stopped = true;
            if (timer) timers.unschedule(timer);
            await pending;
        },
    };
}

export type DocumentJobLease = ReturnType<typeof createDocumentJobLease>;
