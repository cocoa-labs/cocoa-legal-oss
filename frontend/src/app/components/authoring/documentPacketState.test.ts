import assert from "node:assert/strict";

import type { DocumentGenerationJobStatus } from "@/app/components/shared/types";
import {
    canRetryDocumentPacket,
    documentPacketFailureMessage,
    documentPacketItemIsActive,
} from "./documentPacketState";

function packet(
    status: DocumentGenerationJobStatus["status"],
    itemStatus: DocumentGenerationJobStatus["items"][number]["status"],
    canRetry: boolean,
): DocumentGenerationJobStatus {
    return {
        id: "job-1",
        status,
        model_id: "claude-fable-5",
        total_items: 2,
        completed_items: status === "partial" ? 1 : 0,
        failed_items: itemStatus === "failed" ? 1 : 0,
        cancellation_requested: false,
        error: null,
        items: [
            {
                id: "item-1",
                position: 0,
                title: "Test document",
                document_type: "memorandum",
                status: itemStatus,
                progress: itemStatus === "failed" ? 100 : 0,
                qa_status: "pending",
                qa_findings: [],
                error: null,
                failure_code: null,
                failure_stage: null,
                retryable: false,
                can_retry: canRetry,
                layout_summary: null,
                result: null,
            },
        ],
    };
}

assert.equal(canRetryDocumentPacket(packet("failed", "failed", true)), true);
assert.equal(canRetryDocumentPacket(packet("partial", "failed", true)), true);
assert.equal(
    canRetryDocumentPacket(packet("completed", "ready", false)),
    false,
);
assert.equal(canRetryDocumentPacket(packet("failed", "failed", false)), false);

const sourceFailure = documentPacketFailureMessage({
    ...packet("failed", "failed", true).items[0],
    failure_code: "DOCUMENT_SOURCE_LOAD_FAILED",
    error: "PGRST201: internal relationship details and private source text",
});
assert.match(
    sourceFailure,
    /source files could not be loaded.*request is saved/i,
);
assert.doesNotMatch(sourceFailure, /PGRST201|internal|private|draft content/i);

// A retry can have a failed first item while its sibling is still queued or
// drafting. Only the active sibling should show a progress bar.
for (const status of ["failed", "ready", "cancelled"] as const)
    assert.equal(
        documentPacketItemIsActive(packet("running", status, false).items[0]),
        false,
    );
for (const status of [
    "queued",
    "planning",
    "drafting",
    "assembling",
    "qa",
] as const)
    assert.equal(
        documentPacketItemIsActive(packet("running", status, false).items[0]),
        true,
    );
assert.equal(canRetryDocumentPacket(packet("queued", "queued", false)), false);
assert.equal(canRetryDocumentPacket(packet("running", "failed", true)), false);

const rawError = "DocumentLayoutQaError: internal stack and storage details";
const message = documentPacketFailureMessage({
    ...packet("failed", "failed", true).items[0],
    error: rawError,
    failure_code: "DOCUMENT_LAYOUT_QA_FAILED",
});
assert.match(message, /saved content is ready to retry/i);
assert.doesNotMatch(message, /DocumentLayoutQaError|internal stack|storage/i);

assert.match(
    documentPacketFailureMessage({
        ...packet("failed", "failed", true).items[0],
        failure_code: "DOCUMENT_GENERATION_MAX_OUTPUT",
    }),
    /output limit.*checkpoints/i,
);
assert.match(
    documentPacketFailureMessage({
        ...packet("failed", "failed", true).items[0],
        failure_code: "DOCUMENT_GENERATION_CONTEXT_LIMIT",
    }),
    /context limit.*checkpoints/i,
);

console.log("documentPacketState.test.ts: all passed");
