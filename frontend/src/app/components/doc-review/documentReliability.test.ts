// Run: npx tsx src/app/components/doc-review/documentReliability.test.ts
import assert from "node:assert/strict";
import {
    captureDisplayedDocumentContext,
    normalizeDocEditedEvent,
} from "./documentReliability";

const tabs = [
    { documentId: "doc-a", filename: "Plan.docx", versionId: "ver-a2", versionNumber: 2 },
    { documentId: "doc-b", filename: "Plan.docx", versionId: "ver-b7", versionNumber: 7 },
];

const first = captureDisplayedDocumentContext(tabs, "doc-a");
assert.equal(first.displayedDoc?.documentId, "doc-a");
assert.equal(first.displayedDoc?.versionId, "ver-a2");
assert.deepEqual(first.openDocs.map((item) => item.displayed), [true, false]);

const switched = captureDisplayedDocumentContext(tabs, "doc-b");
assert.equal(switched.displayedDoc?.documentId, "doc-b");
assert.equal(switched.displayedDoc?.versionId, "ver-b7");
assert.deepEqual(switched.openDocs.map((item) => item.displayed), [false, true]);

const failed = normalizeDocEditedEvent({
    type: "doc_edited",
    filename: "Plan.docx",
    document_id: "doc-b",
    version_id: "ver-b7",
    error: "The displayed version is historical. No edit was applied.",
    error_code: "DISPLAYED_VERSION_NOT_CURRENT",
    retryable: false,
    resolution: { choices: ["edit current", "fork from displayed", "create a copy"] },
    candidates: [{ document_id: "doc-a", filename: "Plan.docx", version_number: 2 }],
    target: { document_id: "doc-b", version_id: "ver-b7", version_number: 7 },
});
assert.equal(failed.error_code, "DISPLAYED_VERSION_NOT_CURRENT");
assert.equal(failed.target?.version_id, "ver-b7");
assert.deepEqual(failed.resolution?.choices, [
    "edit current",
    "fork from displayed",
    "create a copy",
]);

console.log("documentReliability.test.ts: all passed");
