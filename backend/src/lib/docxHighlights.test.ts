import assert from "node:assert/strict";
import JSZip from "jszip";
import { applyDocxHighlights } from "./docxHighlights";
import {
    isDurableHighlightSetId,
    normalizeHighlightApplyFallbackRows,
} from "./documentHighlights";

async function makeDocx(paragraphText: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function documentXml(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file("word/document.xml");
    assert.ok(entry);
    return entry.async("string");
}

async function testAppliesDocxHighlight() {
    const input = await makeDocx(
        "The Agreement contains no insurance requirements for either party.",
    );
    const result = await applyDocxHighlights(input, [
        {
            quote: "no insurance requirements",
            occurrence_index: 0,
        },
    ]);

    assert.equal(result.applied.length, 1);
    assert.deepEqual(result.errors, []);
    const xml = await documentXml(result.bytes);
    assert.match(xml, /w:highlight/);
    assert.match(xml, /w:val="yellow"/);
}

function testFallbackRowsKeepOnlyApplicableAnchors() {
    const rows = normalizeHighlightApplyFallbackRows([
        {
            id: "keep-1",
            quote: "first quote",
            occurrence_index: 2,
            status: "kept",
        },
        {
            id: "remove-1",
            quote: "removed quote",
            occurrence_index: 0,
            status: "removed",
        },
        {
            id: "applied-1",
            quote: "applied quote",
            occurrence_index: 1,
            status: "applied",
        },
        {
            id: "empty",
            quote: "   ",
            occurrence_index: 0,
            status: "kept",
        },
    ]);

    assert.deepEqual(rows, [
        { id: "keep-1", quote: "first quote", occurrence_index: 2 },
        { id: "applied-1", quote: "applied quote", occurrence_index: 1 },
    ]);
}

function testEphemeralIdsAreNotDurableUuidIds() {
    assert.equal(
        isDurableHighlightSetId("ephemeral-85be488c-2391-48ea-a973-019450d2bd3d"),
        false,
    );
    assert.equal(
        isDurableHighlightSetId("85be488c-2391-48ea-a973-019450d2bd3d"),
        true,
    );
}

async function main() {
    await testAppliesDocxHighlight();
    testFallbackRowsKeepOnlyApplicableAnchors();
    testEphemeralIdsAreNotDurableUuidIds();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
