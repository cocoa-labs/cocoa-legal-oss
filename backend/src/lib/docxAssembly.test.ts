import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
    renderSectionsToDocxBuffer,
    normalizeDocxWhitespaceEntities,
    persistAuthoredDocxOrThrow,
} from "./docxAssembly";
import { fixtureDb } from "./documentGeneration/testFixtures";
import type { DocumentLayoutQaReport } from "./documentLayoutQa";

test("whitespace entities are normalized before DOCX rendering, including table cells", async () => {
    assert.equal(
        normalizeDocxWhitespaceEntities("A&nbsp;B&#160;C&#xA0;D&ensp;E&emsp;F"),
        "A B C D E F",
    );
    const res = await renderSectionsToDocxBuffer("Test", [
        {
            heading: "Scope",
            content: "The&nbsp;clause remains intact.",
            table: { headers: ["Column&nbsp;one"], rows: [["The&#160;value"]] },
        },
    ]);
    assert.ok("buffer" in res);
    const zip = await JSZip.loadAsync(res.buffer!);
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.doesNotMatch(xml, /nbsp|&amp;#160/);
    assert.match(xml, /The clause remains intact/);
    assert.match(xml, /The value/);
});

test("a worker that lost ownership cannot upload or publish an artifact", async () => {
    const fixture = fixtureDb(() => {
        throw new Error("No persistence allowed");
    });
    await assert.rejects(
        () =>
            persistAuthoredDocxOrThrow({
                db: fixture.db,
                userId: "owner",
                title: "Draft",
                buffer: Buffer.from("unused"),
                layoutQaReport: { status: "passed" } as DocumentLayoutQaReport,
                beforePublish: async () => {
                    throw new Error("worker ownership lost");
                },
            }),
        /worker ownership lost/,
    );
    assert.equal(fixture.calls.length, 0);
});

test("renderSectionsToDocxBuffer emits a valid OOXML package", async () => {
    const res = await renderSectionsToDocxBuffer("Commercial Lease", [
        { heading: "Term", content: "The term is five years." },
        { heading: "Rent", content: "Base rent is $10,000 per month." },
        {
            heading: "Signatures",
            content: "By: ____\nName: ____",
            pageBreak: true,
        },
    ]);
    assert.ok("buffer" in res, `expected buffer, got ${JSON.stringify(res)}`);
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer);
    for (const part of [
        "[Content_Types].xml",
        "word/document.xml",
        "word/_rels/document.xml.rels",
    ]) {
        assert.ok(zip.file(part), `missing ${part}`);
    }
});

test("renderSectionsToDocxBuffer preserves {{coco-sign:N}} anchor tokens", async () => {
    const res = await renderSectionsToDocxBuffer("NDA", [
        {
            heading: "Signatures",
            content: "{{coco-sign:1}}\nBy: ____",
            pageBreak: true,
        },
    ]);
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.ok(
        xml.includes("{{coco-sign:1}}"),
        "anchor token should survive rendering",
    );
});

test("renderer uses literal markers, preserves supplied bullets, and leaves prose unnumbered", async () => {
    const res = await renderSectionsToDocxBuffer("Regulatory Memo", [
        {
            heading: "Scope",
            level: 1,
            content: [
                "Ordinary prose has no automatic list marker.",
                "2026 regulatory changes remain ordinary prose.",
                "• Supplied bullet remains supplied.",
                "(a) Supplied legal marker remains supplied.",
                "☐ Supplied checkbox remains supplied.",
            ].join("\n"),
        },
    ]);
    assert.ok("buffer" in res);
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const plainText = xml.replace(/<[^>]+>/g, "");
    assert.ok(plainText.includes("1. SCOPE"));
    assert.ok(
        plainText.includes("Ordinary prose has no automatic list marker."),
    );
    assert.ok(
        plainText.includes("2026 regulatory changes remain ordinary prose."),
    );
    assert.ok(plainText.includes("• Supplied bullet remains supplied."));
    assert.ok(
        plainText.includes("(a) Supplied legal marker remains supplied."),
    );
    assert.ok(plainText.includes("[ ] Supplied checkbox remains supplied."));
    assert.ok(
        !xml.includes("<w:numPr>"),
        "automatic OOXML numbering must not be emitted",
    );
    assert.ok(xml.includes("<w:wordWrap"), "mid-word wrapping must be enabled");
});

test("compatibility renderer tightens layout and suppresses optional page breaks", async () => {
    const fixture = [
        {
            heading: "Long Heading",
            level: 1,
            content:
                "A long identifier XYZ-EXAMPLE-MARKETS-LLC-REGISTRATION-READINESS-2026 remains visible.",
            pageBreak: true,
        },
    ];
    const standard = await renderSectionsToDocxBuffer("Memo", fixture, {
        mode: "standard",
    });
    const compatibility = await renderSectionsToDocxBuffer("Memo", fixture, {
        mode: "compatibility",
    });
    assert.ok("buffer" in standard && "buffer" in compatibility);
    const standardXml = await (
        await JSZip.loadAsync((standard as { buffer: Buffer }).buffer)
    )
        .file("word/document.xml")!
        .async("string");
    const compatibilityXml = await (
        await JSZip.loadAsync((compatibility as { buffer: Buffer }).buffer)
    )
        .file("word/document.xml")!
        .async("string");
    assert.ok(standardXml.includes('w:type="page"'));
    assert.ok(!compatibilityXml.includes('w:type="page"'));
    assert.ok(compatibilityXml.includes('w:top="1080"'));
    assert.ok(compatibilityXml.includes('w:right="1080"'));
    assert.ok(compatibilityXml.includes('w:val="20"'));
});

test("renderer converts model-authored Markdown into native Word formatting", async () => {
    const res = await renderSectionsToDocxBuffer("Legal Brief", [
        {
            heading: "Analysis",
            content: [
                "### 1.1 Substantive Standard",
                "**Attorney confirmation required.** This is *material*.",
                "- **Owner:** Alex",
                "---",
            ].join("\n"),
        },
    ]);
    assert.ok("buffer" in res);
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const plainText = xml.replace(/<[^>]+>/g, "");
    assert.ok(plainText.includes("1.1 Substantive Standard"));
    assert.ok(plainText.includes("Attorney confirmation required."));
    assert.ok(plainText.includes("This is material."));
    assert.ok(plainText.includes("- Owner: Alex"));
    assert.ok(!plainText.includes("###"));
    assert.ok(!plainText.includes("**"));
    assert.ok(!plainText.includes("---"));
    assert.ok(xml.includes("<w:b"), "bold text must use native OOXML runs");
    assert.ok(xml.includes("<w:i"), "italic text must use native OOXML runs");
});

test("renderer keeps ordinary table rows together but permits oversized legal rows to split", async () => {
    const res = await renderSectionsToDocxBuffer("Table Pagination", [
        {
            heading: "Checklist",
            table: {
                headers: ["Item", "Detail", "Owner", "Target", "Status"],
                rows: [
                    [
                        "F.11b Interview dry run",
                        "Walk through the membership interview and review the answers.",
                        "All",
                        "Week 7",
                        "Not started",
                    ],
                    [
                        "Oversized exhibit",
                        "A".repeat(2_000),
                        "Counsel",
                        "TBD",
                        "Open",
                    ],
                ],
            },
        },
    ]);
    assert.ok("buffer" in res);
    const zip = await JSZip.loadAsync((res as { buffer: Buffer }).buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const tableRows = [...xml.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map(
        (match) => match[1],
    );
    const ordinaryRow = tableRows.find((row) => row.includes("F.11b"));
    const oversizedRow = tableRows.find((row) =>
        row.includes("Oversized exhibit"),
    );
    assert.ok(ordinaryRow?.includes("<w:cantSplit"));
    assert.ok(!oversizedRow?.includes("<w:cantSplit"));
    assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 2);
    assert.ok(xml.includes('w:type="page"'));
    assert.ok(xml.includes('<w:tblLayout w:type="fixed"'));
});
