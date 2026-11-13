// backend/src/lib/signatures/anchors.test.ts
//
// Round-trips a pdf-lib-drawn PDF through resolveSignerPlacements (which reads
// the text layer via pdfjs) to verify token placement, text-anchor fallback,
// and bottom-stack fallback + order-based signer assignment.
import assert from "node:assert/strict";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { resolveSignerPlacements } from "./anchors";
import type { SignatureSigner } from "./types";

function signer(id: string, order: number): SignatureSigner {
    return {
        id,
        envelope_id: "env",
        name: id,
        email: `${id}@example.com`,
        order_index: order,
        role: "signer",
        status: "signed",
        token_expires_at: null,
        signature_image_path: null,
        typed_name: id,
        consent_at: null,
        viewed_at: null,
        signed_at: null,
        declined_at: null,
        decline_reason: null,
        signer_ip: null,
        signer_user_agent: null,
        created_at: "",
        updated_at: "",
    };
}

async function pdfWith(lines: { text: string; y: number }[]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const l of lines) {
        page.drawText(l.text, { x: 72, y: l.y, size: 12, font, color: rgb(0, 0, 0) });
    }
    return Buffer.from(await doc.save());
}

/** Multi-page variant: one {text,y}[] per page (all drawn at x=72). */
async function pdfWithPages(
    pages: { text: string; y: number }[][],
): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const lines of pages) {
        const page = doc.addPage([612, 792]);
        for (const l of lines)
            page.drawText(l.text, { x: 72, y: l.y, size: 12, font, color: rgb(0, 0, 0) });
    }
    return Buffer.from(await doc.save());
}

/** Positioned variant: explicit {text,x,y}[] on a single page (for side-by-side). */
async function pdfWithItems(
    items: { text: string; x: number; y: number }[],
): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const it of items)
        page.drawText(it.text, { x: it.x, y: it.y, size: 12, font, color: rgb(0, 0, 0) });
    return Buffer.from(await doc.save());
}

async function testTokensPlaceAndCover() {
    const pdf = await pdfWith([
        { text: "Accepted and agreed:", y: 420 },
        { text: "{{coco-sign:0}}", y: 360 },
        { text: "Alex Sampleton, Partner   Date", y: 345 },
        { text: "{{coco-sign:1}}", y: 300 },
        { text: "Riley Testerson   Date", y: 285 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0), signer("b", 1)]);
    assert.ok(["token", "mixed"].includes(res.mode), `expected token, got ${res.mode}`);
    assert.ok(res.placements.has("a") && res.placements.has("b"), "both signers placed by token");
    assert.ok(res.coverRects.length >= 2, "a cover rect per token line");
    const pa = res.placements.get("a")!;
    assert.equal(pa.page, 0);
    // token:0 sits at y=360 on a 792-tall page → ~0.457 up from the bottom.
    assert.ok(pa.yPct !== undefined && pa.yPct > 0.4 && pa.yPct < 0.5, `signer a near token0, yPct=${pa.yPct}`);
}

async function testSplitTokenStillResolves() {
    // Two adjacent draws on the same baseline emulate pdfjs splitting a token.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("{{coco", { x: 72, y: 300, size: 12, font });
    page.drawText("-sign:0}}", { x: 130, y: 300, size: 12, font });
    const pdf = Buffer.from(await doc.save());
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.ok(res.placements.has("a"), "split token across items still resolves via line-join");
}

async function testTextAnchorFallback() {
    const pdf = await pdfWith([
        { text: "By: ____________________", y: 300 },
        { text: "Name: Jane Roe", y: 285 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.equal(res.mode, "anchor");
    assert.ok(res.placements.has("a"), "anchored to the By: line");
    assert.equal(res.coverRects.length, 0, "no token rects for an anchor-only doc");
}

async function testBottomFallback() {
    const pdf = await pdfWith([
        { text: "Just an ordinary paragraph of prose with no cues.", y: 400 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.equal(res.mode, "fallback");
    assert.equal(res.placements.size, 0, "no placement → stamper bottom-stacks");
}

// T1 — the reported bug: page-1 prose with "by"/"date" must NOT win over the
// real signature block on the last page.
async function testRegressionPage1ProseLoses() {
    const pdf = await pdfWithPages([
        [
            {
                text: "This Agreement is entered into by and between Example Holdings, LLC and Riley Testerson,",
                y: 720,
            },
            {
                text: "effective as of the date of the last signature below.",
                y: 700,
            },
            { text: "1. REFERRAL ARRANGEMENT. Referrer may refer clients.", y: 660 },
        ],
        [
            {
                text: "IN WITNESS WHEREOF, the parties have executed this Agreement.",
                y: 600,
            },
            { text: "By: ____________________", y: 520 },
            { text: "Alex Sampleton, Partner", y: 505 },
            { text: "By: ____________________", y: 420 },
            { text: "Riley Testerson", y: 405 },
        ],
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0), signer("b", 1)]);
    assert.equal(res.mode, "anchor", `expected anchor, got ${res.mode}`);
    assert.ok(res.placements.has("a") && res.placements.has("b"), "both placed");
    const pa = res.placements.get("a")!;
    const pb = res.placements.get("b")!;
    assert.equal(pa.page, 1, `signer a must be on the last page, got ${pa.page}`);
    assert.equal(pb.page, 1, `signer b must be on the last page, got ${pb.page}`);
    assert.ok(pa.yPct !== pb.yPct, "the two signers land on different lines");
}

// T2 — a bare underscore run is a valid signature line.
async function testUnderscoreOnlyLine() {
    const pdf = await pdfWith([
        { text: "Accepted and agreed:", y: 240 },
        { text: "____________________________", y: 200 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.equal(res.mode, "anchor");
    assert.ok(res.placements.has("a"), "anchored to the underscore run");
    assert.equal(res.coverRects.length, 0, "no token rects");
}

// T3 — an IN WITNESS cue scopes placement to the block, not the body.
async function testCueScopesRegion() {
    const pdf = await pdfWith([
        { text: "Payment is due by the date listed in Exhibit A herein.", y: 700 },
        { text: "IN WITNESS WHEREOF the parties have executed this Agreement.", y: 300 },
        { text: "By:", y: 240 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.equal(res.mode, "anchor");
    const pa = res.placements.get("a")!;
    assert.ok(pa.yPct !== undefined && pa.yPct < 0.4, `placed on the By: line, yPct=${pa.yPct}`);
}

// T4 — prose containing "by"/"date" inside the region is still rejected.
async function testProseRejectedInRegion() {
    const pdf = await pdfWith([
        { text: "Amounts due by the date specified; signed copies to follow herein.", y: 120 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.equal(res.mode, "fallback", `prose must not anchor, got ${res.mode}`);
    assert.equal(res.placements.size, 0);
}

// T5 — fewer blocks than signers: the surplus signer is left to bottom-stack.
async function testFewerBlocksThanSigners() {
    const pdf = await pdfWith([
        { text: "IN WITNESS WHEREOF the parties have executed this Agreement.", y: 300 },
        { text: "By: ____________________", y: 240 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0), signer("b", 1)]);
    assert.equal(res.mode, "anchor");
    assert.ok(res.placements.has("a"), "first signer placed");
    assert.ok(!res.placements.has("b"), "second signer left for bottom-stack");
    assert.equal(res.placements.size, 1);
}

// T7 — single-page block survives even with heavy top preamble and no cue.
async function testSinglePageBlockNoCue() {
    const pdf = await pdfWith([
        { text: "This Agreement is entered into by and between the parties hereto.", y: 760 },
        { text: "Compensation shall be paid by the date of invoice receipt.", y: 740 },
        { text: "By: ____________________", y: 120 },
        { text: "Jane Roe", y: 105 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.equal(res.mode, "anchor");
    const pa = res.placements.get("a")!;
    assert.equal(pa.page, 0);
    assert.ok(pa.yPct !== undefined && pa.yPct < 0.2, `near the bottom block, yPct=${pa.yPct}`);
}

// T8 — two parties' blocks side by side on one row → two distinct slots.
async function testSideBySideRow() {
    const pdf = await pdfWithItems([
        { text: "IN WITNESS WHEREOF the parties have executed this Agreement.", x: 72, y: 300 },
        { text: "By: ____________", x: 72, y: 200 },
        { text: "By: ____________", x: 360, y: 200 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0), signer("b", 1)]);
    assert.equal(res.mode, "anchor");
    assert.ok(res.placements.has("a") && res.placements.has("b"), "both placed");
    const pa = res.placements.get("a")!;
    const pb = res.placements.get("b")!;
    assert.equal(pa.page, 0);
    assert.equal(pb.page, 0);
    assert.ok(
        pa.yPct !== undefined && pb.yPct !== undefined && Math.abs(pa.yPct - pb.yPct) < 0.02,
        "same row → same yPct",
    );
    assert.ok(pa.xPct !== pb.xPct, "different columns → different xPct");
}

// Name-match bonus: a real party name on the signer routes it to that block
// regardless of order_index.
async function testPartyNameMatch() {
    const pdf = await pdfWithPages([
        [{ text: "Boilerplate clause one with the word by and a date.", y: 700 }],
        [
            { text: "IN WITNESS WHEREOF the parties have executed.", y: 600 },
            { text: "By: ____________________", y: 520 },
            { text: "Alex Sampleton, Partner", y: 505 },
            { text: "By: ____________________", y: 420 },
            { text: "Riley Testerson, Referrer", y: 405 },
        ],
    ]);
    // order_index would put "riley" first, but name-match should pin it to the
    // Riley Testerson block (the lower one, y=420).
    const riley = { ...signer("riley", 0), name: "Riley Testerson" };
    const alex = { ...signer("alex", 1), name: "Alex Sampleton" };
    const res = await resolveSignerPlacements(pdf, [riley, alex]);
    assert.equal(res.mode, "anchor");
    const pl = res.placements.get("riley")!;
    const pk = res.placements.get("alex")!;
    assert.ok(pl.yPct !== undefined && pk.yPct !== undefined, "both placed");
    assert.ok(pl.yPct < pk.yPct, "Testerson routed to the lower block by name, not order");
}

// T10 — a token sitting above the party name + "By:" line should SNAP the
// signature down onto the real "By:" line, not land on the token/party-name line.
async function testTokenSnapsToByLine() {
    const pdf = await pdfWith([
        { text: "COMPANY:", y: 420 },
        { text: "{{coco-sign:0}}", y: 400 },
        { text: "EXAMPLE Holdings, LLC", y: 385 },
        { text: "By: ____________________", y: 340 },
        { text: "Name:", y: 320 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0)]);
    assert.ok(["token", "mixed"].includes(res.mode), `expected token, got ${res.mode}`);
    assert.ok(res.placements.has("a"), "signer placed");
    assert.ok(res.coverRects.length >= 1, "token line covered");
    const pa = res.placements.get("a")!;
    // By: line at y=340 → ~0.434; token line at y=400 → ~0.508. Must snap to By:.
    assert.ok(
        pa.yPct !== undefined && pa.yPct > 0.42 && pa.yPct < 0.47,
        `snapped onto the By: line (yPct=${pa.yPct}), not the token line (~0.508)`,
    );
}

// Two party signature blocks, each By:/Name:/Title:/Date:. With 2 signers whose
// names don't name-match a block, each should land on a DISTINCT "By:" line
// (one per party) — NOT both inside the first block, and NEVER on a "Date:" line.
async function testMultiPartyOnePerByLine() {
    const pdf = await pdfWith([
        { text: "IN WITNESS WHEREOF, the parties have executed this Agreement.", y: 500 },
        { text: "EXAMPLE HOLDINGS, INC.", y: 460 },
        { text: "By: ____________________", y: 440 },
        { text: "Name: Alex Sampleton", y: 420 },
        { text: "Title: Chief Executive Officer", y: 400 },
        { text: "Date: ____________________", y: 380 },
        { text: "SAMPLECREST CAPITAL ADVISORS, LLC", y: 340 },
        { text: "By: ____________________", y: 320 },
        { text: "Name: Morgan T. Fixture", y: 300 },
        { text: "Title: Managing Partner", y: 280 },
        { text: "Date: ____________________", y: 260 },
    ]);
    // Short names → surnameToken null → positional assignment (the failing path).
    const res = await resolveSignerPlacements(pdf, [signer("a", 0), signer("b", 1)]);
    assert.equal(res.mode, "anchor");
    assert.ok(res.placements.has("a") && res.placements.has("b"), "both placed");
    const pa = res.placements.get("a")!;
    const pb = res.placements.get("b")!;
    // a → Example By: (y=440 → ~0.556); b → Samplecrest By: (y=320 → ~0.404).
    assert.ok(pa.yPct !== undefined && pa.yPct > 0.52 && pa.yPct < 0.58, `a on Example By:, yPct=${pa.yPct}`);
    assert.ok(pb.yPct !== undefined && pb.yPct > 0.38 && pb.yPct < 0.43, `b on Samplecrest By:, yPct=${pb.yPct}`);
    assert.ok(pa.yPct > pb.yPct, "Example block above Samplecrest block");
    // Neither lands on a Date: line (Example Date ~0.48, Samplecrest Date ~0.33).
    assert.ok(Math.abs(pa.yPct - 380 / 792) > 0.02, "a not on Example Date:");
    assert.ok(Math.abs(pb.yPct - 260 / 792) > 0.02, "b not on Samplecrest Date:");
}

// LOI geometry: the first party's "By:" block sits ABOVE a same-page
// "AGREED AND ACCEPTED" cue, the second party's block below it. Both signers
// must land on their "By:" lines — the first must NOT be dropped (bottom-stack)
// just because it's above the cue.
async function testLoiBlockAboveCue() {
    const pdf = await pdfWith([
        { text: "By: ____________________", y: 500 }, // Example (ABOVE the cue)
        { text: "Name: Alex Sampleton", y: 480 },
        { text: "Title: Chief Executive Officer", y: 460 },
        { text: "Date: ____________________", y: 440 },
        { text: "AGREED AND ACCEPTED:", y: 400 }, // cue, BETWEEN the blocks
        { text: "TESTBED YARDS PARTNERS, LLC", y: 380 },
        { text: "By: ____________________", y: 360 }, // Testbed (BELOW the cue)
        { text: "Name: Taylor Mockley", y: 340 },
        { text: "Title: Managing Director", y: 320 },
        { text: "Date: ____________________", y: 300 },
    ]);
    const res = await resolveSignerPlacements(pdf, [signer("a", 0), signer("b", 1)]);
    assert.equal(res.mode, "anchor");
    assert.equal(res.placements.size, 2, "both signers anchored (neither bottom-stacked)");
    const pa = res.placements.get("a")!;
    const pb = res.placements.get("b")!;
    assert.ok(pa.yPct !== undefined && pa.yPct > 0.6 && pa.yPct < 0.66, `a on the upper By: (yPct=${pa.yPct})`);
    assert.ok(pb.yPct !== undefined && pb.yPct > 0.43 && pb.yPct < 0.48, `b on the lower By: (yPct=${pb.yPct})`);
    assert.ok(pa.yPct > pb.yPct, "first party block above the second");
}

async function main() {
    await testTokensPlaceAndCover();
    await testTokenSnapsToByLine();
    await testMultiPartyOnePerByLine();
    await testLoiBlockAboveCue();
    await testSplitTokenStillResolves();
    await testTextAnchorFallback();
    await testBottomFallback();
    await testRegressionPage1ProseLoses();
    await testUnderscoreOnlyLine();
    await testCueScopesRegion();
    await testProseRejectedInRegion();
    await testFewerBlocksThanSigners();
    await testSinglePageBlockNoCue();
    await testSideBySideRow();
    await testPartyNameMatch();
    console.log("anchors.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
