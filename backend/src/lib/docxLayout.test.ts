import assert from "node:assert/strict";

import JSZip from "jszip";

import {
    DOCUMENT_REFLOW_UNSUPPORTED,
    DocumentReflowError,
    extractDocxTextView,
    inspectDocxLayout,
    reflowFramedDocx,
} from "./docxLayout";

const W_NS =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function framedParagraph(params: {
    x: number;
    y: number;
    width: number;
    content: string;
}): string {
    return `<w:p><w:pPr><w:framePr w:x="${params.x}" w:y="${params.y}" w:w="${params.width}"/></w:pPr>${params.content}</w:p>`;
}

async function makePackage(documentBody: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`,
    );
    zip.file(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.file(
        "word/_rels/document.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
</Relationships>`,
    );
    zip.file(
        "word/comments.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W_NS}"><w:comment w:id="7" w:author="Reviewer" w:date="2026-08-25T20:15:00Z"><w:p><w:r><w:t>Keep this note.</w:t></w:r></w:p></w:comment></w:comments>`,
    );
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>${documentBody}</w:body>
</w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const sectionProperties = `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;

async function packageXml(bytes: Buffer, path: string): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file(path);
    assert.ok(entry, `${path} must exist`);
    return entry.async("string");
}

async function testReflowsFramesAndPreservesReviewMarkup(): Promise<void> {
    const firstClause = framedParagraph({
        x: 1440,
        y: 1200,
        width: 500,
        content: `<w:r><w:t>1</w:t></w:r>`,
    });
    const firstBody = framedParagraph({
        x: 2160,
        y: 1200,
        width: 7600,
        content: `<w:r><w:t>Original </w:t></w:r><w:del w:id="110" w:author="Example Reviewer" w:date="2026-08-25T20:15:00Z"><w:r><w:delText>short</w:delText></w:r></w:del><w:ins w:id="111" w:author="Quill" w:date="2026-08-25T21:30:00Z"><w:r><w:t>substantially longer tracked replacement text</w:t></w:r></w:ins>`,
    });
    const commented = framedParagraph({
        x: 2160,
        y: 1800,
        width: 7600,
        content: `<w:commentRangeStart w:id="7"/><w:r><w:t>Commented language</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>`,
    });
    const secondClause = framedParagraph({
        x: 1440,
        y: 1200,
        width: 500,
        content: `<w:r><w:t>2</w:t></w:r>`,
    });
    const secondBody = framedParagraph({
        x: 2160,
        y: 1200,
        width: 7600,
        content: `<w:r><w:t>Second-page clause body.</w:t></w:r>`,
    });
    const footerTitle = framedParagraph({
        x: 1440,
        y: 15000,
        width: 6000,
        content: `<w:r><w:t>Mutual Confidentiality Agreement</w:t></w:r>`,
    });
    const footerPage = framedParagraph({
        x: 10000,
        y: 15000,
        width: 400,
        content: `<w:r><w:t>2</w:t></w:r>`,
    });
    const input = await makePackage(
        `${firstClause}${firstBody}${commented}<w:p><w:pPr>${sectionProperties}</w:pPr></w:p>${secondClause}${secondBody}${footerTitle}${footerPage}${sectionProperties}`,
    );

    const inspection = await inspectDocxLayout(input);
    assert.equal(inspection.framedParagraphCount, 7);
    assert.equal(inspection.sectionCount, 2);
    assert.equal(inspection.trackedInsertionCount, 1);
    assert.equal(inspection.trackedDeletionCount, 1);
    assert.equal(inspection.commentCount, 1);
    assert.equal(inspection.commentAnchorCount, 3);
    assert.equal(inspection.supportedForAutomaticReflow, true);

    const result = await reflowFramedDocx(input);
    const repeated = await reflowFramedDocx(input);
    assert.deepEqual(
        repeated.bytes,
        result.bytes,
        "identical source bytes must produce a byte-identical reflow",
    );
    assert.equal(result.changed, true);
    assert.equal(result.metadata.original_frame_count, 7);
    assert.equal(result.metadata.original_section_count, 2);
    assert.ok(result.metadata.converted_table_count >= 2);
    assert.equal(result.metadata.converted_footer_count, 1);

    const outputInspection = await inspectDocxLayout(result.bytes);
    assert.equal(outputInspection.framedParagraphCount, 0);
    assert.equal(outputInspection.sectionCount, 2);
    assert.equal(outputInspection.trackedInsertionCount, 1);
    assert.equal(outputInspection.trackedDeletionCount, 1);
    assert.equal(outputInspection.commentCount, 1);
    assert.equal(outputInspection.commentAnchorCount, 3);

    const documentXml = await packageXml(result.bytes, "word/document.xml");
    const commentsXml = await packageXml(result.bytes, "word/comments.xml");
    const footerXml = await packageXml(result.bytes, "word/footer1.xml");
    const relationshipsXml = await packageXml(
        result.bytes,
        "word/_rels/document.xml.rels",
    );
    assert.doesNotMatch(documentXml, /w:framePr/);
    assert.match(documentXml, /w:tbl/);
    assert.match(documentXml, /w:footerReference/);
    assert.match(documentXml, /w:id="110" w:author="Example Reviewer"/);
    assert.match(documentXml, /w:id="111" w:author="Quill"/);
    assert.match(documentXml, /w:commentRangeStart w:id="7"/);
    assert.match(commentsXml, /Keep this note\./);
    assert.match(footerXml, /w:instrText[^>]*> PAGE <\/w:instrText>/);
    assert.match(footerXml, /Mutual Confidentiality Agreement/);
    assert.match(relationshipsXml, /Target="comments\.xml"/);
    assert.match(relationshipsXml, /Target="footer1\.xml"/);
}

async function testNormalizesExactHeightRows(): Promise<void> {
    const input = await makePackage(
        `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:trPr><w:trHeight w:val="240" w:hRule="exact"/></w:trPr><w:tc><w:p><w:r><w:t>Auto-height content</w:t></w:r></w:p></w:tc></w:tr></w:tbl>${sectionProperties}`,
    );
    const inspection = await inspectDocxLayout(input);
    assert.equal(inspection.fixedHeightRowCount, 1);
    assert.equal(inspection.supportedForAutomaticReflow, true);

    const result = await reflowFramedDocx(input);
    const xml = await packageXml(result.bytes, "word/document.xml");
    assert.equal(result.metadata.normalized_fixed_height_row_count, 1);
    assert.doesNotMatch(xml, /w:hRule="exact"/);
    assert.match(xml, /w:hRule="atLeast"/);
    assert.match(xml, /Auto-height content/);
}

async function testRejectsFloatingObjects(): Promise<void> {
    const input = await makePackage(
        `<w:p><w:r><w:drawing><wp:anchor><wp:positionH/></wp:anchor></w:drawing></w:r></w:p>${sectionProperties}`,
    );
    const inspection = await inspectDocxLayout(input);
    assert.ok(inspection.floatingObjectCount > 0);
    assert.match(inspection.unsupportedReasons.join(" "), /floating drawings/);
    await assert.rejects(
        () => reflowFramedDocx(input),
        (error: unknown) =>
            error instanceof DocumentReflowError &&
            error.code === DOCUMENT_REFLOW_UNSUPPORTED,
    );
}

async function testNoOpReturnsOriginalBytes(): Promise<void> {
    const input = await makePackage(
        `<w:p><w:r><w:t>Ordinary flow document.</w:t></w:r></w:p>${sectionProperties}`,
    );
    const result = await reflowFramedDocx(input);
    assert.equal(result.changed, false);
    assert.equal(result.bytes, input);
}

async function testPreservesNumericLookingLegalTextExactly(): Promise<void> {
    const input = await makePackage(
        `<w:p><w:r><w:t>Items 3.10, 3.1, 40.30, 0010 and 10.00 remain distinct.</w:t></w:r></w:p>${sectionProperties}`,
    );
    assert.equal(
        await extractDocxTextView(input, "accepted"),
        "Items 3.10, 3.1, 40.30, 0010 and 10.00 remain distinct.",
    );
}

async function testPreservesMixedFlowParagraphOrder(): Promise<void> {
    const input = await makePackage(
        `${framedParagraph({ x: 1440, y: 1200, width: 500, content: "<w:r><w:t>1</w:t></w:r>" })}${framedParagraph({ x: 2160, y: 1200, width: 7600, content: "<w:r><w:t>First framed clause.</w:t></w:r>" })}<w:p><w:r><w:t>Ordinary flow paragraph between frame groups.</w:t></w:r></w:p>${framedParagraph({ x: 1440, y: 1800, width: 500, content: "<w:r><w:t>2</w:t></w:r>" })}${framedParagraph({ x: 2160, y: 1800, width: 7600, content: "<w:r><w:t>Second framed clause.</w:t></w:r>" })}${sectionProperties}`,
    );
    const before = await extractDocxTextView(input, "accepted");
    const result = await reflowFramedDocx(input);
    const after = await extractDocxTextView(result.bytes, "accepted");
    assert.equal(after, before);
}

async function testKeepsCenteredLetterheadAheadOfVisuallySortedFrames(): Promise<void> {
    const input = await makePackage(
        `${framedParagraph({ x: 2160, y: 3600, width: 7600, content: "<w:r><w:t>Agreement title</w:t></w:r>" })}<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Company letterhead</w:t></w:r></w:p>${framedParagraph({ x: 2160, y: 5200, width: 7600, content: "<w:r><w:t>Later clause</w:t></w:r>" })}${framedParagraph({ x: 2160, y: 4400, width: 7600, content: "<w:r><w:t>Earlier clause</w:t></w:r>" })}${sectionProperties}`,
    );
    const result = await reflowFramedDocx(input);
    const after = await extractDocxTextView(result.bytes, "accepted");
    assert.ok(
        after.indexOf("Company letterhead") < after.indexOf("Agreement title"),
        "the centered flow letterhead must remain ahead of the fixed page body",
    );
    assert.ok(
        after.indexOf("Earlier clause") < after.indexOf("Later clause"),
        "the framed body must still be sorted by visual row",
    );
}

async function testDoesNotOverwriteExistingFooterPart(): Promise<void> {
    const base = await makePackage(
        `${framedParagraph({ x: 1440, y: 15000, width: 6000, content: "<w:r><w:t>Agreement footer</w:t></w:r>" })}${framedParagraph({ x: 10000, y: 15000, width: 400, content: "<w:r><w:t>1</w:t></w:r>" })}${sectionProperties}`,
    );
    const zip = await JSZip.loadAsync(base);
    zip.file(
        "word/footer1.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="${W_NS}"><w:p><w:r><w:t>Existing unreferenced footer part.</w:t></w:r></w:p></w:ftr>`,
    );
    const rels = zip.file("word/_rels/document.xml.rels");
    assert.ok(rels);
    zip.file(
        "word/_rels/document.xml.rels",
        (await rels.async("string")).replace(
            "</Relationships>",
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>',
        ),
    );
    const input = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    const result = await reflowFramedDocx(input);
    const existingFooter = await packageXml(result.bytes, "word/footer1.xml");
    const convertedFooter = await packageXml(result.bytes, "word/footer2.xml");
    assert.match(existingFooter, /Existing unreferenced footer part\./);
    assert.match(convertedFooter, /Agreement footer/);
    assert.match(convertedFooter, / PAGE /);
}

async function main(): Promise<void> {
    await testReflowsFramesAndPreservesReviewMarkup();
    await testNormalizesExactHeightRows();
    await testRejectsFloatingObjects();
    await testNoOpReturnsOriginalBytes();
    await testPreservesNumericLookingLegalTextExactly();
    await testPreservesMixedFlowParagraphOrder();
    await testKeepsCenteredLetterheadAheadOfVisuallySortedFrames();
    await testDoesNotOverwriteExistingFooterPart();
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
