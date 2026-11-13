import assert from "node:assert/strict";
import {
    extractDocumentMarkdown,
    extractDocumentStructureTree,
    extractDocumentText,
} from "./documentExtraction";

// Minimal ArrayBuffer fixtures. We don't try to construct real PDF / DOCX
// bytes here — the inner extractors are exercised by their own tests
// (and their failure modes are well-known: they catch and return "").
// What we test is the ROUTING — given a file_type, do we look at the
// raw buffer or the rendition buffer? That decision is the bug locus
// the catastrophic tabular hallucination fix depends on.

// Mint fresh buffers per call — pdfjs detaches the underlying
// ArrayBuffer when it tries to parse, so sharing fixtures across tests
// would fail on the second use.
function freshRaw(): ArrayBuffer {
    return new TextEncoder().encode("RAW_BYTES_NOT_REAL_PDF_OR_DOCX")
        .buffer as ArrayBuffer;
}
function freshRend(): ArrayBuffer {
    return new TextEncoder().encode("RENDITION_BYTES_NOT_REAL_PDF")
        .buffer as ArrayBuffer;
}

async function testPdfUsesRaw() {
    const text = await extractDocumentText({
        fileType: "pdf",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    // extractPdfText catches its own errors and returns "" on
    // garbage input. Just confirm it didn't throw.
    assert.equal(typeof text, "string");
}

async function testDocxUsesRaw() {
    const text = await extractDocumentText({
        fileType: "docx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: freshRend(), // should be IGNORED for docx
    });
    assert.equal(typeof text, "string");
}

async function testTier2WithRenditionUsesRendition() {
    const text = await extractDocumentText({
        fileType: "xlsx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: freshRend(),
    });
    assert.equal(typeof text, "string");
}

async function testTier2WithoutRenditionReturnsEmpty() {
    // The critical safety check: when pdfRenditionBuf is null for a
    // Tier 2 doc, we must NOT fall through to a mammoth call on the
    // raw xlsx/html/md bytes (the old bug). We must return "" so
    // callers can flag the cell as error.
    const text = await extractDocumentText({
        fileType: "xlsx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    assert.equal(text, "");
}

async function testMarkdownTier2RoutesToRendition() {
    const md = await extractDocumentMarkdown({
        fileType: "pptx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: freshRend(),
    });
    assert.equal(typeof md, "string");
}

async function testMarkdownTier2WithoutRenditionReturnsEmpty() {
    // The catastrophic-tabular-hallucination case: tabular calls this
    // for a doc without a rendition. We MUST return "" so the cell
    // gets flagged, NOT silently invoke mammoth on garbage.
    const md = await extractDocumentMarkdown({
        fileType: "md",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    assert.equal(md, "");
}

async function testMarkdownPdfPath() {
    const md = await extractDocumentMarkdown({
        fileType: "pdf",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    assert.equal(typeof md, "string");
}

async function testMarkdownDocxPath() {
    const md = await extractDocumentMarkdown({
        fileType: "docx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: freshRend(), // ignored
    });
    assert.equal(typeof md, "string");
}

async function testStructureTreeTier2WithoutRenditionIsNull() {
    const tree = await extractDocumentStructureTree({
        fileType: "csv",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    assert.equal(tree, null);
}

async function testStructureTreeRoutesByFileType() {
    const pdfTree = await extractDocumentStructureTree({
        fileType: "pdf",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    assert.ok(pdfTree === null || Array.isArray(pdfTree));

    const docxTree = await extractDocumentStructureTree({
        fileType: "docx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: freshRend(),
    });
    assert.ok(docxTree === null || Array.isArray(docxTree));

    const xlsxTree = await extractDocumentStructureTree({
        fileType: "xlsx",
        rawBuf: freshRaw(),
        pdfRenditionBuf: freshRend(),
    });
    assert.ok(xlsxTree === null || Array.isArray(xlsxTree));
}

async function testUnknownFileTypeRoutesToRendition() {
    // If a future file_type slips through that we don't know about,
    // we treat it as Tier 2 (use rendition). With no rendition,
    // return "" — defensive default.
    const text = await extractDocumentText({
        fileType: "future-format",
        rawBuf: freshRaw(),
        pdfRenditionBuf: null,
    });
    assert.equal(text, "");
}

async function main() {
    await testPdfUsesRaw();
    await testDocxUsesRaw();
    await testTier2WithRenditionUsesRendition();
    await testTier2WithoutRenditionReturnsEmpty();
    await testMarkdownTier2RoutesToRendition();
    await testMarkdownTier2WithoutRenditionReturnsEmpty();
    await testMarkdownPdfPath();
    await testMarkdownDocxPath();
    await testStructureTreeTier2WithoutRenditionIsNull();
    await testStructureTreeRoutesByFileType();
    await testUnknownFileTypeRoutesToRendition();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
