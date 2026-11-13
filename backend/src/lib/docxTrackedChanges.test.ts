import assert from "node:assert/strict";
import JSZip from "jszip";
import {
    acceptAllTrackedChangesInBody,
    extractDocxBodyText,
    extractTrackedChangeIds,
    rejectAllTrackedChangesInBody,
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

async function bodyText(bytes: Buffer): Promise<string> {
    return (await extractDocxBodyText(bytes)).replace(/\n+/g, "\n");
}

async function testAcceptsInsertion() {
    const input = await makeDocx(`
<w:body>
  <w:p><w:ins w:id="1"><w:r><w:t>new text</w:t></w:r></w:ins></w:p>
</w:body>`);
    const result = await acceptAllTrackedChangesInBody(input);
    assert.equal(result.changed, true);
    assert.equal(result.resolvedCount, 1);
    assert.equal(await bodyText(result.bytes), "new text");
    assert.deepEqual(await extractTrackedChangeIds(result.bytes), []);
}

async function testDropsDeletion() {
    const input = await makeDocx(`
<w:body>
  <w:p>
    <w:r><w:t>A </w:t></w:r>
    <w:del w:id="2"><w:r><w:delText>deleted</w:delText></w:r></w:del>
    <w:r><w:t> B</w:t></w:r>
  </w:p>
</w:body>`);
    const result = await acceptAllTrackedChangesInBody(input);
    assert.equal(result.changed, true);
    assert.equal(result.resolvedCount, 1);
    assert.equal(await bodyText(result.bytes), "A  B");
    assert.deepEqual(await extractTrackedChangeIds(result.bytes), []);
}

async function testMixedReplacement() {
    const input = await makeDocx(`
<w:body>
  <w:p>
    <w:r><w:t>Hello </w:t></w:r>
    <w:del w:id="3"><w:r><w:delText>old</w:delText></w:r></w:del>
    <w:ins w:id="4"><w:r><w:t>new</w:t></w:r></w:ins>
  </w:p>
</w:body>`);
    const result = await acceptAllTrackedChangesInBody(input);
    assert.equal(result.changed, true);
    assert.equal(result.resolvedCount, 2);
    assert.equal(await bodyText(result.bytes), "Hello new");
    assert.deepEqual(await extractTrackedChangeIds(result.bytes), []);
}

async function testRejectsMixedReplacement() {
    const input = await makeDocx(`
<w:body>
  <w:p>
    <w:r><w:t>Hello </w:t></w:r>
    <w:del w:id="3"><w:r><w:delText>old</w:delText></w:r></w:del>
    <w:ins w:id="4"><w:r><w:t>new</w:t></w:r></w:ins>
  </w:p>
</w:body>`);
    const result = await rejectAllTrackedChangesInBody(input);
    assert.equal(result.changed, true);
    assert.equal(result.resolvedCount, 2);
    assert.equal(await bodyText(result.bytes), "Hello old");
    assert.deepEqual(await extractTrackedChangeIds(result.bytes), []);
    const zip = await JSZip.loadAsync(result.bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.doesNotMatch(xml, /w:delText/);
    assert.match(xml, /<w:t>old<\/w:t>/);
}

async function testScopeIsBodyOnly() {
    const input = await makeDocx(`
<w:customHeaderLikePart>
  <w:ins w:id="9"><w:r><w:t>outside body</w:t></w:r></w:ins>
</w:customHeaderLikePart>
<w:body>
  <w:p><w:r><w:t>Body</w:t></w:r></w:p>
</w:body>`);
    const result = await acceptAllTrackedChangesInBody(input);
    assert.equal(result.changed, false);
    assert.equal(result.resolvedCount, 0);
    assert.equal(await bodyText(result.bytes), "Body");
    assert.deepEqual(await extractTrackedChangeIds(result.bytes), [
        { kind: "ins", w_id: "9" },
    ]);
}

async function main() {
    await testAcceptsInsertion();
    await testDropsDeletion();
    await testMixedReplacement();
    await testRejectsMixedReplacement();
    await testScopeIsBodyOnly();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
