import assert from "node:assert/strict";

import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
    _internal,
    DOCUMENT_LAYOUT_QA_FAILED,
    DOCUMENT_QA_UNAVAILABLE,
    DocumentLayoutQaError,
    analyzePdfLayout,
    rejoinWrappedLongTokens,
    tokenizePdfRuns,
    verifyDocxLayout,
    verifyPdfLayout,
} from "./documentLayoutQa";
import { reflowFramedDocx } from "./docxLayout";
import { checkLibreOfficeReachable } from "./libreoffice";

function testRejoinsOnlyExactWrappedLongTokens(): void {
    const identifier = "XYZ-EXAMPLE-HOLDING-LLC-2026-REGULATORY-READINESS";
    assert.deepEqual(
        rejoinWrappedLongTokens(
            [identifier, "remains", "visible"],
            [
                "XYZ-EXAMPLE-HOLDING-",
                "LLC-2026-REGULATORY-READINESS",
                "remains",
                "visible",
            ],
        ),
        [identifier, "remains", "visible"],
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(
            [identifier],
            ["XYZ-EXAMPLE-HOLDING-", "LLC-2026-REGULATORY-CHANGED"],
        ),
        ["XYZ-EXAMPLE-HOLDING-", "LLC-2026-REGULATORY-CHANGED"],
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(
            ["litigation", "remains", "visible"],
            ["litigatio", "n", "remains", "visible"],
        ),
        ["litigation", "remains", "visible"],
        "Writer's mid-word PDF text runs must rejoin by exact characters",
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(["in", "to", "into"], ["in", "to"]),
        ["in", "to"],
        "ordinary expected words must never be merged into a different word",
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(
            ["Item", "10", "remains", "visible"],
            ["Item", "1", "0", "remains", "visible"],
        ),
        ["Item", "10", "remains", "visible"],
        "Writer's split multi-digit table identifiers must rejoin exactly",
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(
            ["Reg.", "3.10", "and", "item", "A10"],
            ["Reg.", "3.1", "0", "and", "item", "A1", "0"],
        ),
        ["Reg.", "3.10", "and", "item", "A10"],
        "Writer's split dotted and alphanumeric identifiers must rejoin exactly",
    );
}

function testHyphenatedWordsRemainExactAcrossWriterLineWraps(): void {
    const expected = _internal.tokenize("member-versus-non-member");
    assert.deepEqual(expected, [
        "member",
        "-",
        "versus",
        "-",
        "non",
        "-",
        "member",
    ]);
    assert.equal(
        _internal.tokenMultisetCoverage(
            expected,
            _internal.tokenize("member- versus- non- member"),
        ),
        1,
    );
    assert.ok(
        _internal.tokenMultisetCoverage(
            expected,
            _internal.tokenize("member versus non member"),
        ) < 1,
        "removing the hyphens must still fail exact content coverage",
    );
}

async function makePdf(
    draw: (
        page: ReturnType<PDFDocument["addPage"]>,
        font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
    ) => void,
): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    draw(page, font);
    return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function testPdfPassesAndMatchesDigest(): Promise<void> {
    const pdf = await makePdf((page, font) => {
        page.drawText("Alpha beta gamma", { x: 72, y: 700, size: 12, font });
        page.drawText("Delta epsilon zeta", { x: 72, y: 680, size: 12, font });
    });
    const report = await verifyPdfLayout(pdf, {
        expectedText: "Alpha beta gamma Delta epsilon zeta",
    });
    assert.equal(report.status, "passed");
    assert.equal(report.pdf?.collision_count, 0);
    assert.equal(report.pdf?.out_of_bounds_count, 0);
    assert.equal(report.pdf?.expected_token_coverage, 1);
}

async function testExactShortFragmentsAndMissingWords(): Promise<void> {
    const extracted = tokenizePdfRuns("Clause n\nbsp remains n\nbsp visible");
    const expected = _internal.tokenize("Clause nbsp remains nbsp visible");
    assert.deepEqual(
        rejoinWrappedLongTokens(
            expected,
            extracted.tokens,
            extracted.boundaries,
        ),
        expected,
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(["nbsp"], ["n", "bsp"], new Set()),
        ["n", "bsp"],
        "ordinary spaces are not extractor boundaries",
    );
    const ordinary = tokenizePdfRuns("in\nto");
    assert.deepEqual(
        rejoinWrappedLongTokens(
            ["in", "to", "into"],
            ordinary.tokens,
            ordinary.boundaries,
        ),
        ["in", "to"],
    );
    const limited = tokenizePdfRuns("n\nbsp n\nbsp");
    assert.deepEqual(
        rejoinWrappedLongTokens(["nbsp"], limited.tokens, limited.boundaries),
        ["nbsp", "n", "bsp"],
        "only exact token deficits may be reconciled",
    );
    const pdf = await makePdf((page, font) => {
        page.drawText("Clause n", { x: 72, y: 700, size: 12, font });
        page.drawText(
            "bsp remains visible and all the required terms survive",
            {
                x: 72,
                y: 680,
                size: 12,
                font,
            },
        );
    });
    const text =
        "Clause nbsp remains visible and all the required terms survive";
    const report = await verifyPdfLayout(pdf, { expectedText: text });
    assert.equal(report.pdf?.expected_token_coverage, 1);
    await assert.rejects(
        () => verifyPdfLayout(pdf, { expectedText: text + " fully" }),
        DocumentLayoutQaError,
    );
    await assert.rejects(
        () => verifyPdfLayout(pdf, { expectedText: text + " nbsp" }),
        DocumentLayoutQaError,
    );
}

function testGloballyReconcilesProductionLineBoundaryFragments(): void {
    const chained = tokenizePdfRuns(
        "communications communication\ns communicati\non on s",
    );
    assert.deepEqual(
        rejoinWrappedLongTokens(
            ["communications", "communications", "communication", "on", "s"],
            chained.tokens,
            chained.boundaries,
        ),
        ["communications", "communications", "communication", "on", "s"],
        "a neutral boundary merge may be paired with a related split to improve global coverage",
    );

    const shortFragments = tokenizePdfRuns("A\nS AD\nD RO\nWS NEE\nDED");
    assert.deepEqual(
        rejoinWrappedLongTokens(
            ["AS", "ADD", "ROWS", "NEEDED"],
            shortFragments.tokens,
            shortFragments.boundaries,
        ),
        ["AS", "ADD", "ROWS", "NEEDED"],
        "the four reproduced short-token deficits reconcile only at extractor boundaries",
    );

    const missing = tokenizePdfRuns("Required clause remains");
    const expected = _internal.tokenize("Required material clause remains");
    assert.ok(
        _internal.tokenMultisetCoverage(
            expected,
            rejoinWrappedLongTokens(
                expected,
                missing.tokens,
                missing.boundaries,
            ),
        ) < 1,
        "a genuinely removed word must remain a coverage failure",
    );
}

async function testDetectsCrossLineCollision(): Promise<void> {
    const pdf = await makePdf((page, font) => {
        page.drawText("First overlapping legal sentence", {
            x: 72,
            y: 700,
            size: 12,
            font,
        });
        page.drawText("Second overlapping legal sentence", {
            x: 72,
            y: 695,
            size: 12,
            font,
        });
    });
    const report = await analyzePdfLayout(pdf);
    assert.equal(report.status, "failed");
    assert.ok(report.collision_count > 0);
    assert.deepEqual(report.affected_pages, [1]);
    await assert.rejects(
        () => verifyPdfLayout(pdf),
        (error: unknown) =>
            error instanceof DocumentLayoutQaError &&
            error.code === DOCUMENT_LAYOUT_QA_FAILED,
    );
}

async function testContentDigestToleratesPdfExtractionOrder(): Promise<void> {
    const pdf = await makePdf((page, font) => {
        page.drawText("Delta epsilon zeta", { x: 72, y: 700, size: 12, font });
        page.drawText("Alpha beta gamma", { x: 72, y: 680, size: 12, font });
    });
    const report = await verifyPdfLayout(pdf, {
        expectedText: "Alpha beta gamma Delta epsilon zeta",
    });
    assert.equal(report.status, "passed");
    assert.equal(report.pdf?.expected_token_coverage, 1);
    assert.ok((report.pdf?.ordered_token_coverage ?? 1) < 1);
}

async function testIgnoresDecorativeLeadersAndSuperscripts(): Promise<void> {
    const pdf = await makePdf((page, font) => {
        page.drawText("Section x", { x: 72, y: 700, size: 12, font });
        page.drawText("2", { x: 118, y: 706, size: 7, font });
        page.drawText("................................................", {
            x: 72,
            y: 700,
            size: 12,
            font,
        });
    });
    const report = await analyzePdfLayout(pdf);
    assert.equal(report.status, "passed");
    assert.equal(report.collision_count, 0);
}

async function testDetectsOutOfBoundsAndMissingText(): Promise<void> {
    const pdf = await makePdf((page, font) => {
        page.drawText("This text leaves the page boundary", {
            x: 600,
            y: 700,
            size: 12,
            font,
        });
    });
    const report = await analyzePdfLayout(pdf, {
        expectedText:
            "This entirely different expected sentence contains enough tokens to require a complete digest match.",
    });
    assert.equal(report.status, "failed");
    assert.ok(report.out_of_bounds_count > 0);
    assert.ok(report.failure_reasons.includes("EXPECTED_TEXT_MISSING"));
}

async function testRejectsBlankGeneratedPdfWithoutExpectedText(): Promise<void> {
    const pdf = await makePdf(() => {});
    const report = await analyzePdfLayout(pdf);
    assert.equal(report.status, "failed");
    assert.ok(report.failure_reasons.includes("TEXT_COLLAPSE"));
    await assert.rejects(
        () => verifyPdfLayout(pdf),
        (error: unknown) =>
            error instanceof DocumentLayoutQaError &&
            error.code === DOCUMENT_LAYOUT_QA_FAILED,
    );
}

async function framedOverflowDocx(): Promise<Buffer> {
    const longClause = Array.from(
        { length: 70 },
        (_, index) => `confidential-information-${index + 1}`,
    ).join(" ");
    const document = new Document({
        sections: [
            {
                children: [
                    new Paragraph({ children: [new TextRun("1")] }),
                    new Paragraph({ children: [new TextRun(longClause)] }),
                    new Paragraph({ children: [new TextRun("2")] }),
                    new Paragraph({
                        children: [
                            new TextRun(
                                "The receiving party shall preserve the following clause without overlap.",
                            ),
                        ],
                    }),
                    new Paragraph({ children: [new TextRun("3")] }),
                    new Paragraph({
                        children: [
                            new TextRun("The final clause remains visible."),
                        ],
                    }),
                ],
            },
        ],
    });
    const packed = await Packer.toBuffer(document);
    const zip = await JSZip.loadAsync(packed);
    const entry = zip.file("word/document.xml");
    assert.ok(entry);
    let xml = await entry.async("string");
    const positions = [
        { x: 1440, y: 1200, w: 500 },
        { x: 2160, y: 1200, w: 7200 },
        { x: 1440, y: 1580, w: 500 },
        { x: 2160, y: 1580, w: 7200 },
        { x: 1440, y: 1960, w: 500 },
        { x: 2160, y: 1960, w: 7200 },
    ];
    let paragraphIndex = 0;
    xml = xml.replace(
        /<w:p(\s[^>]*)?>([\s\S]*?)<\/w:p>/g,
        (whole, pAttrs, inner) => {
            const position = positions[paragraphIndex++];
            if (!position) return whole;
            const frame = `<w:framePr w:x="${position.x}" w:y="${position.y}" w:w="${position.w}"/>`;
            const nextInner = /<w:pPr>/.test(inner)
                ? inner.replace(/<w:pPr>/, `<w:pPr>${frame}`)
                : `<w:pPr>${frame}</w:pPr>${inner}`;
            return `<w:p${pAttrs ?? ""}>${nextInner}</w:p>`;
        },
    );
    zip.file("word/document.xml", xml);
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function testOverflowFailsBeforeReflowAndPassesAfter(): Promise<void> {
    try {
        await checkLibreOfficeReachable();
    } catch {
        console.warn(
            "Skipping DOCX render QA integration test: LibreOffice unavailable.",
        );
        return;
    }
    const input = await framedOverflowDocx();
    let failedReport: DocumentLayoutQaError["report"] = null;
    try {
        await verifyDocxLayout(input, { trackedViews: false });
    } catch (error) {
        assert.ok(error instanceof DocumentLayoutQaError);
        // Binary discovery succeeded above. A present-but-broken converter is
        // a real failure, not a reason to skip the integration coverage.
        assert.notEqual(error.code, DOCUMENT_QA_UNAVAILABLE);
        assert.equal(error.code, DOCUMENT_LAYOUT_QA_FAILED);
        failedReport = error.report;
    }
    assert.ok(failedReport);
    assert.ok((failedReport.views?.[0]?.pdf.collision_count ?? 0) > 0);

    const reflowed = await reflowFramedDocx(input);
    const passed = await verifyDocxLayout(reflowed.bytes, {
        trackedViews: false,
    });
    assert.equal(passed.status, "passed");
    assert.equal(passed.views?.[0]?.pdf.collision_count, 0);
    assert.equal(passed.views?.[0]?.pdf.out_of_bounds_count, 0);
}

async function main(): Promise<void> {
    testRejoinsOnlyExactWrappedLongTokens();
    testHyphenatedWordsRemainExactAcrossWriterLineWraps();
    testGloballyReconcilesProductionLineBoundaryFragments();
    await testPdfPassesAndMatchesDigest();
    await testExactShortFragmentsAndMissingWords();
    await testDetectsCrossLineCollision();
    await testContentDigestToleratesPdfExtractionOrder();
    await testIgnoresDecorativeLeadersAndSuperscripts();
    await testDetectsOutOfBoundsAndMissingText();
    await testRejectsBlankGeneratedPdfWithoutExpectedText();
    await testOverflowFailsBeforeReflowAndPassesAfter();
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
