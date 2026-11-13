// backend/src/lib/automation/rehearsalFixtures.test.ts
//
// Fixture-validation test for the PI rollout kit (fixtures/pi):
//   1. every email fixture parses as a ParsedEmail and its referenced
//      attachment PDFs exist on disk;
//   2. the checked-in PDFs are REAL text-layer PDFs — the production
//      extractor (lib/documentExtraction → pdfjs) recovers their text, page
//      counts match the fixture design, and the load-bearing values the
//      README/expectations promise (claim number, insured, limits, invoice
//      number, total) are actually extractable — i.e. citation verification
//      has something to verify against;
//   3. fixture content stays in lockstep with the expectations map the
//      rehearsal script judges against (registry domains classify as
//      promised, the multi-claim fixture really carries two claim numbers,
//      the skip fixture can never reach the LLM gate).
//
// No Supabase, no storage, no LLM — pure fs + pdfjs, so it runs in the
// normal `npm test` suite.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { extractDocumentText } from "../documentExtraction";
import { normalizeForVerify } from "./extract/verify";
import { isPdfAttachment, splitPageMarkedText } from "./extract/pdfInputs";
import { classifyEmailDeterministic, shouldLlmClassify } from "./classify";
import {
    FIXTURE_EMAIL_NAMES,
    FIXTURE_EXPECTATIONS,
    FIXTURE_PDF_NAMES,
    PI_FIXTURES_DIR,
    loadEmailFixture,
    type LoadedEmailFixture,
} from "./rehearsalFixtures";

// The seeded registries' classification signals (migration 024): the test
// only needs domains, since that is the deterministic path the fixtures use.
const SEED_CARRIERS = [
    { name: "Example Mutual", domains: ["examplemutual.test"] },
    { name: "Sample Casualty", domains: ["samplecasualty.test"] },
];
const SEED_VENDORS = [
    { name: "Example Case Funding", domains: ["examplecasefunding.test"] },
    { name: "ChartExample", domains: ["chartexample.test"] },
];

function readPdf(name: string): ArrayBuffer {
    const buf = fs.readFileSync(path.join(PI_FIXTURES_DIR, name));
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

/** Assert `needle` survives the SAME normalization citation checks use. */
function assertExtractable(haystack: string, needle: string, label: string) {
    assert.ok(
        normalizeForVerify(haystack).includes(normalizeForVerify(needle)),
        `${label}: "${needle}" is not extractable from the PDF text layer`,
    );
}

async function testEveryFixtureParsesAsParsedEmail() {
    for (const name of FIXTURE_EMAIL_NAMES) {
        const fixture = loadEmailFixture(name); // throws on shape violations
        assert.equal(fixture.name, name);
        assert.ok(fixture.email.from.includes("@"), `${name}: from has no address`);
        assert.ok(fixture.email.bodyText.length > 0, `${name}: empty bodyText`);
        // Every referenced attachment resolved to an on-disk PDF.
        for (const att of fixture.email.attachments) {
            const resolved = fixture.attachmentPaths.get(att.attachmentId);
            assert.ok(resolved, `${name}: unresolved attachment ${att.attachmentId}`);
            assert.ok(
                isPdfAttachment(att),
                `${name}: attachment ${att.filename} is not PDF-shaped`,
            );
        }
        assert.ok(
            FIXTURE_EXPECTATIONS[name],
            `${name}: missing an entry in FIXTURE_EXPECTATIONS`,
        );
    }
    console.log(
        `  ok — all ${FIXTURE_EMAIL_NAMES.length} email fixtures parse as ParsedEmail`,
    );
}

async function testDecPagePdfHasExtractableText() {
    const text = await extractDocumentText({
        fileType: "pdf",
        rawBuf: readPdf("dec-page.pdf"),
        pdfRenditionBuf: null,
    });
    assert.ok(text.trim().length > 0, "dec-page.pdf produced no text");
    const pages = splitPageMarkedText(text);
    assert.equal(pages.length, 2, "dec-page.pdf should be 2 pages");
    assert.ok(pages.every((p) => p.trim().length > 0), "a dec page is empty");

    // Load-bearing values from the fixture design (see the generator +
    // fixtures/pi/README.md).
    assertExtractable(pages[0], "26-4400123", "dec-page p1 claim number");
    assertExtractable(pages[0], "Dana Specimen", "dec-page p1 named insured");
    assertExtractable(pages[0], "904412345", "dec-page p1 policy number");
    assertExtractable(
        pages[0],
        "$25,000 each person / $50,000 each accident",
        "dec-page p1 BI limits (25/50)",
    );
    assertExtractable(pages[1], "Taylor Mock", "dec-page p2 adjuster");
    assertExtractable(pages[1], "(800) 555-0142", "dec-page p2 adjuster phone");
    console.log("  ok — dec-page.pdf: 2 pages of extractable text with the seeded values");
}

async function testInvoicePdfHasExtractableText() {
    const text = await extractDocumentText({
        fileType: "pdf",
        rawBuf: readPdf("invoice.pdf"),
        pdfRenditionBuf: null,
    });
    assert.ok(text.trim().length > 0, "invoice.pdf produced no text");
    const pages = splitPageMarkedText(text);
    assert.equal(pages.length, 1, "invoice.pdf should be 1 page");

    assertExtractable(pages[0], "INV-002417", "invoice number");
    assertExtractable(pages[0], "Example Case Funding", "invoice vendor block");
    assertExtractable(pages[0], "Casey Example", "invoice matter reference");
    assertExtractable(pages[0], "TOTAL DUE $1,850.00", "invoice total due");
    console.log("  ok — invoice.pdf: 1 page of extractable text with the seeded values");
}

/** The fixtures' classification signals must match their expected kinds
 * deterministically (sender domain against the seeded registries), and the
 * skip fixture must be unable to reach the LLM fallback. */
async function testFixturesClassifyAsExpected() {
    const classify = (fixture: LoadedEmailFixture) =>
        classifyEmailDeterministic({
            fromAddress: fixture.email.from,
            subject: fixture.email.subject,
            attachmentNames: fixture.email.attachments.map((a) => a.filename),
            carriers: SEED_CARRIERS.map((c) => ({ ...c })),
            vendors: SEED_VENDORS.map((v) => ({ ...v })),
        });

    for (const name of FIXTURE_EMAIL_NAMES) {
        const fixture = loadEmailFixture(name);
        const expected = FIXTURE_EXPECTATIONS[name];
        const result = classify(fixture);
        assert.equal(
            result?.kind ?? null,
            expected.kind,
            `${name}: deterministic classification should be ${expected.kind ?? "null"}`,
        );
    }

    // nonmatch-email: no PDF → the LLM gate must stay closed even when the
    // LLM stage is enabled, so a rehearsal skip costs zero model calls.
    const nonmatch = loadEmailFixture("nonmatch-email");
    assert.equal(nonmatch.email.attachments.length, 0);
    assert.equal(
        shouldLlmClassify({
            deterministicMatched: false,
            hasPdfAttachment: nonmatch.email.attachments.some((a) =>
                isPdfAttachment(a),
            ),
            llmEnabled: true,
        }),
        false,
        "nonmatch-email must never reach the LLM classifier",
    );
    console.log("  ok — fixtures classify deterministically as their expected kinds");
}

/** Multi-claim fixture really carries both claim numbers verbatim, and the
 * demand-deadline surface the README promises is present in the body. */
async function testMultiClaimFixtureContent() {
    const fixture = loadEmailFixture("claim-email-2");
    const body = fixture.email.bodyText;
    assert.ok(body.includes("SCC-26-887701"), "first claim number missing");
    assert.ok(body.includes("SCC-26-887702"), "second claim number missing");
    assert.ok(
        /policy limits demand/i.test(body),
        "policy-limits-demand language missing",
    );
    assert.ok(
        body.includes("August 15, 2026"),
        "response deadline missing from the demand fixture",
    );
    assert.equal(FIXTURE_EXPECTATIONS["claim-email-2"].minClaims, 2);
    console.log("  ok — claim-email-2 carries two claim numbers + a response deadline");
}

/** Bodies must contain the values the extractions will cite, so email-body
 * citations can verify deterministically. */
async function testBodiesCarryCitableValues() {
    const checks: [ReturnType<typeof loadEmailFixture>, string[]][] = [
        [
            loadEmailFixture("claim-email-1"),
            ["26-4400123", "Jordan Sample", "904412345", "Taylor Mock"],
        ],
        [
            loadEmailFixture("invoice-email-1"),
            ["INV-002417", "$1,850.00", "Casey Example"],
        ],
        [
            loadEmailFixture("invoice-email-2"),
            ["CE-778812", "$64.50", "Casey Example"],
        ],
    ];
    for (const [fixture, needles] of checks) {
        const normBody = normalizeForVerify(fixture.email.bodyText);
        for (const needle of needles) {
            assert.ok(
                normBody.includes(normalizeForVerify(needle)),
                `${fixture.name}: body does not carry "${needle}"`,
            );
        }
    }
    console.log("  ok — fixture bodies carry the citable values");
}

async function main() {
    console.log("automation/rehearsalFixtures.test.ts");
    for (const pdf of FIXTURE_PDF_NAMES) {
        assert.ok(
            fs.existsSync(path.join(PI_FIXTURES_DIR, pdf)),
            `${pdf} missing — run: npx tsx scripts/generateFixturePdfs.ts`,
        );
    }
    await testEveryFixtureParsesAsParsedEmail();
    await testDecPagePdfHasExtractableText();
    await testInvoicePdfHasExtractableText();
    await testFixturesClassifyAsExpected();
    await testMultiClaimFixtureContent();
    await testBodiesCarryCitableValues();
    console.log("automation/rehearsalFixtures.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
