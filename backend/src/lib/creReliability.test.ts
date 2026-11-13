// backend/src/lib/creReliability.test.ts
import assert from "node:assert/strict";
import {
    EXTRACTION_CHAR_LIMIT,
    truncateForExtraction,
    truncationAdvisory,
    emptyExtractionReason,
} from "./creReliability";

// Under the limit: text passes through byte-for-byte, not truncated.
async function testUnderLimitPassthrough() {
    const text = "a".repeat(1000);
    const r = truncateForExtraction(text);
    assert.equal(r.truncated, false);
    assert.equal(r.droppedChars, 0);
    assert.equal(r.text, text);
    assert.equal(r.text.length, 1000);
}

// Empty string is trivially under the limit.
async function testEmptyPassthrough() {
    const r = truncateForExtraction("");
    assert.equal(r.truncated, false);
    assert.equal(r.droppedChars, 0);
    assert.equal(r.text, "");
}

// Exactly at the limit is the inclusive boundary: not truncated.
async function testAtLimitNotTruncated() {
    const text = "x".repeat(EXTRACTION_CHAR_LIMIT);
    const r = truncateForExtraction(text);
    assert.equal(r.truncated, false);
    assert.equal(r.droppedChars, 0);
    assert.equal(r.text.length, EXTRACTION_CHAR_LIMIT);
    assert.equal(r.text, text);
}

// Over the limit: truncated, sliced to exactly the limit, dropped count
// equals the overflow.
async function testOverLimitTruncated() {
    const overflow = 5_000;
    const text = "y".repeat(EXTRACTION_CHAR_LIMIT + overflow);
    const r = truncateForExtraction(text);
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, EXTRACTION_CHAR_LIMIT);
    assert.equal(r.text.length, 120_000);
    assert.equal(r.droppedChars, overflow);
    // The kept slice is the HEAD of the source.
    assert.equal(r.text, text.slice(0, EXTRACTION_CHAR_LIMIT));
}

// One char over the limit drops exactly one char.
async function testOneOverLimit() {
    const text = "z".repeat(EXTRACTION_CHAR_LIMIT + 1);
    const r = truncateForExtraction(text);
    assert.equal(r.truncated, true);
    assert.equal(r.droppedChars, 1);
    assert.equal(r.text.length, EXTRACTION_CHAR_LIMIT);
}

// The advisory names the limit and the dropped-char count, and carries the
// late-document verification cue.
async function testTruncationAdvisoryContent() {
    const msg = truncationAdvisory(5_000);
    assert.match(msg, /120,000 chars/);
    assert.match(msg, /5,000 chars/);
    assert.match(msg, /exhibits, schedules, exception lists/);
}

// A PDF with empty extracted text yields the distinguished scanned-PDF /
// no-OCR reason.
async function testEmptyReasonPdfIsScanned() {
    const reason = emptyExtractionReason("pdf");
    assert.match(reason, /scanned\/image-only/);
    assert.match(reason, /Read the document in chat/);
}

// file_type is matched case-insensitively (e.g. "PDF").
async function testEmptyReasonPdfCaseInsensitive() {
    assert.equal(emptyExtractionReason("PDF"), emptyExtractionReason("pdf"));
}

// A non-PDF empty extraction keeps the generic message (NOT the OCR one).
async function testEmptyReasonNonPdfIsGeneric() {
    const reason = emptyExtractionReason("docx");
    assert.match(reason, /returned empty content/);
    assert.doesNotMatch(reason, /OCR/);
}

// Undefined / null file type falls back to the generic message.
async function testEmptyReasonUndefinedIsGeneric() {
    assert.match(emptyExtractionReason(undefined), /returned empty content/);
    assert.match(emptyExtractionReason(null), /returned empty content/);
    assert.doesNotMatch(emptyExtractionReason(undefined), /OCR/);
}

async function run() {
    await testUnderLimitPassthrough();
    await testEmptyPassthrough();
    await testAtLimitNotTruncated();
    await testOverLimitTruncated();
    await testOneOverLimit();
    await testTruncationAdvisoryContent();
    await testEmptyReasonPdfIsScanned();
    await testEmptyReasonPdfCaseInsensitive();
    await testEmptyReasonNonPdfIsGeneric();
    await testEmptyReasonUndefinedIsGeneric();
    console.log("creReliability.test.ts: all assertions passed");
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
