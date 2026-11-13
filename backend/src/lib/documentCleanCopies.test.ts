import assert from "node:assert/strict";
import JSZip from "jszip";
import {
    normalizeCleanDocumentFilename,
    prepareCleanDocumentCopyBytes,
} from "./documentCleanCopies";
import {
    extractDocxBodyText,
    extractTrackedChangeIds,
} from "./docxTrackedChanges";

async function makeDocx(documentXmlBody: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${documentXmlBody}
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

async function testPreparesCleanCopyBytes() {
    const input = await makeDocx(`
<w:body>
  <w:p>
    <w:r><w:t>Effective as of </w:t></w:r>
    <w:ins w:id="1"><w:r><w:t>May 24, 2026</w:t></w:r></w:ins>
    <w:del w:id="2"><w:r><w:delText>September 25, 2025</w:delText></w:r></w:del>
    <w:r><w:t>.</w:t></w:r>
  </w:p>
  <w:p>
    <w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Highlighted text</w:t></w:r>
  </w:p>
</w:body>`);

    const result = await prepareCleanDocumentCopyBytes(input);
    const text = await extractDocxBodyText(result.bytes);
    const xml = await documentXml(result.bytes);

    assert.equal(result.changed, true);
    assert.equal(result.resolvedCount, 2);
    assert.equal(result.removedHighlightCount, 1);
    assert.match(text, /May 24, 2026/);
    assert.doesNotMatch(text, /September 25, 2025/);
    assert.doesNotMatch(xml, /w:highlight/);
    assert.deepEqual(await extractTrackedChangeIds(result.bytes), []);
}

async function testPreservesCommentsAndTrackingSetting() {
    const base = await makeDocx(`
<w:body>
  <w:p><w:commentRangeStart w:id="2"/><w:r><w:t>Reviewed text</w:t></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r></w:p>
</w:body>`);
    const zip = await JSZip.loadAsync(base);
    const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="2" w:author="Reviewer"><w:p><w:r><w:t>Retain this comment.</w:t></w:r></w:p></w:comment></w:comments>`;
    const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/></w:settings>`;
    zip.file("word/comments.xml", comments);
    zip.file("word/settings.xml", settings);
    const input = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });

    const result = await prepareCleanDocumentCopyBytes(input);
    const output = await JSZip.loadAsync(result.bytes);
    assert.equal(await output.file("word/comments.xml")!.async("string"), comments);
    assert.equal(await output.file("word/settings.xml")!.async("string"), settings);
    assert.match(await documentXml(result.bytes), /w:commentRangeStart w:id="2"/);
}

function testNormalizesFilename() {
    assert.equal(
        normalizeCleanDocumentFilename("Riley's Referral Agreement_Example.docx"),
        "Riley's Referral Agreement_Example.docx",
    );
    assert.equal(
        normalizeCleanDocumentFilename("Riley's Referral Agreement_Example"),
        "Riley's Referral Agreement_Example.docx",
    );
    assert.equal(
        normalizeCleanDocumentFilename("Riley's Referral Agreement_Example.pdf"),
        "Riley's Referral Agreement_Example.docx",
    );
}

function testRejectsUnsafeFilename() {
    assert.throws(() => normalizeCleanDocumentFilename("../bad.docx"));
    assert.throws(() => normalizeCleanDocumentFilename("nested/bad.docx"));
    assert.throws(() => normalizeCleanDocumentFilename("bad\u0000name.docx"));
    assert.throws(() => normalizeCleanDocumentFilename("   "));
}

async function main() {
    await testPreparesCleanCopyBytes();
    await testPreservesCommentsAndTrackingSetting();
    testNormalizesFilename();
    testRejectsUnsafeFilename();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
