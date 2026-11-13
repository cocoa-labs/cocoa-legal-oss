import type { DocumentGenerationJobStatus } from "@/app/components/shared/types";

type PacketItem = DocumentGenerationJobStatus["items"][number];

export function documentPacketFailureMessage(item: PacketItem) {
    if (item.failure_code === "DOCUMENT_SOURCE_LOAD_FAILED")
        return "The source files could not be loaded. Your drafting request is saved and can be retried.";
    if (item.failure_code === "DOCUMENT_DRAFT_SIZE_LIMIT")
        return "This draft exceeded its length budget. Its saved content is retained. Request a shorter scope or an explicit longer document.";
    if (
        item.failure_code === "DOCUMENT_LAYOUT_QA_FAILED" ||
        /DocumentLayoutQaError|layout verification/i.test(item.error ?? "")
    ) {
        return "This draft could not be laid out safely as a DOCX. Its saved content is ready to retry.";
    }
    if (item.failure_code === "DOCUMENT_QA_UNAVAILABLE") {
        return "Layout verification was temporarily unavailable. This saved draft can be retried.";
    }
    if (item.failure_code === "DOCUMENT_RENDER_FAILED") {
        return "The DOCX renderer could not finish this saved draft. It can be retried.";
    }
    if (item.failure_code === "DOCUMENT_DRAFT_REFUSED") {
        return "The selected model could not draft this document. Retry it or choose another model.";
    }
    if (item.failure_code === "DOCUMENT_GENERATION_MAX_OUTPUT") {
        return "The model reached its output limit. Saved section checkpoints are ready to continue.";
    }
    if (item.failure_code === "DOCUMENT_GENERATION_CONTEXT_LIMIT") {
        return "The model reached its context limit. Saved checkpoints can resume with fewer sources or a larger-context model.";
    }
    return "Document generation did not finish. Any saved draft content can be retried.";
}

export function documentPacketItemIsActive(item: PacketItem) {
    return ["queued", "planning", "drafting", "assembling", "qa"].includes(
        item.status,
    );
}

export function canRetryDocumentPacket(
    job: DocumentGenerationJobStatus | null,
) {
    return (
        !!job &&
        (job.status === "failed" || job.status === "partial") &&
        job.items.some((item) => item.can_retry)
    );
}

/** Artifact placement and identity are independent of assistant activity. */
export function documentPacketEvents(
    events: import("@/app/components/shared/types").AssistantEvent[],
) {
    const packets = new Map<
        string,
        Extract<
            import("@/app/components/shared/types").AssistantEvent,
            { type: "document_job_started" | "document_job_status" }
        >
    >();
    for (const event of events) {
        if (
            event.type === "document_job_started" ||
            event.type === "document_job_status"
        )
            packets.set(event.job_id, event);
    }
    return [...packets.values()];
}

/** Keep each saved packet at its most recent status reply, including on reload. */
export function documentPacketJobsByMessage(
    messages: {
        events?: import("@/app/components/shared/types").AssistantEvent[];
    }[],
) {
    const owners = new Map<string, number>();
    messages.forEach((message, index) =>
        documentPacketEvents(message.events ?? []).forEach((event) =>
            owners.set(event.job_id, index),
        ),
    );
    const result = messages.map(() => new Set<string>());
    owners.forEach((index, jobId) => result[index].add(jobId));
    return result;
}
