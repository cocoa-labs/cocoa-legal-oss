import * as Sentry from "@sentry/nextjs";

type StreamSurface = "main" | "matter" | "tabular";

/** Privacy-safe counters only: no message text, ids, filenames, or users. */
export function recordAssistantStreamMetric(
    name:
        | "integrity_mismatch"
        | "premature_eof"
        | "reconciliation_success"
        | "reconciliation_failure",
    surface: StreamSurface,
): void {
    try {
        Sentry.metrics.count(`assistant.stream.${name}`, 1, {
            attributes: { surface },
        });
    } catch {
        // Telemetry must never affect response rendering or recovery.
    }
}

/** Where a capability proposal / result was surfaced. */
type ProposalSurface = "chat" | "matter";

/**
 * Capability-suggestion funnel counters: how often a chip is shown, acted on,
 * refused, and how its result lands. `not_now` is the client-only X (the chip
 * hides, nothing is remembered); `dismissed` and `suppressed` are the durable
 * refusals. `capability_id` is a fixed registry slug
 * (never model- or user-authored), so it is safe as a metric attribute —
 * nothing here carries message text, document names, or user identity.
 */
export function recordProposalMetric(
    name:
        | "shown"
        | "confirmed"
        | "not_now"
        | "dismissed"
        | "suppressed"
        | "result_rendered"
        | "result_failed"
        | "docx_exported",
    surface: ProposalSurface,
    capabilityId: string,
): void {
    try {
        Sentry.metrics.count(`assistant.proposal.${name}`, 1, {
            attributes: { surface, capability_id: capabilityId },
        });
    } catch {
        // Telemetry must never affect chip or card rendering.
    }
}
