// backend/scripts/generateFixturePdfs.ts
//
// Generates the two checked-in PI fixture PDFs (fixtures/pi/dec-page.pdf +
// fixtures/pi/invoice.pdf) with pdf-lib — the same library the e-sign
// engine uses — so the fixtures are real text-layer PDFs (selectable text
// that pdfjs extracts) rather than binary blobs of unknown provenance.
// Checked in ALONGSIDE its output: regenerate with
//
//   cd backend && npx tsx scripts/generateFixturePdfs.ts
//
// Every name, number, address, and amount below is invented (see
// fixtures/pi/README.md). The carrier/vendor names come from the public
// registries seeded by migration 024, and each document carries an explicit
// "synthetic test fixture" line so a human can never mistake one for a real
// record. Values here are load-bearing for the fixture-validation test
// (src/lib/automation/rehearsalFixtures.test.ts) and for the expected
// outcomes documented in fixtures/pi/README.md — change them in lockstep.

import fs from "node:fs";
import path from "node:path";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { PI_FIXTURES_DIR } from "../src/lib/automation/rehearsalFixtures";

// Letter portrait, same geometry as signatures/certificate.ts.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);

interface Fonts {
    regular: PDFFont;
    bold: PDFFont;
    mono: PDFFont;
}

/** Minimal top-down cursor writer (one drawText per line = clean text layer). */
class Writer {
    page: PDFPage;
    y = PAGE_HEIGHT - MARGIN;

    constructor(
        private readonly doc: PDFDocument,
        private readonly fonts: Fonts,
    ) {
        this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    }

    newPage(): void {
        this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        this.y = PAGE_HEIGHT - MARGIN;
    }

    gap(h: number): void {
        this.y -= h;
    }

    line(
        text: string,
        opts: { size?: number; font?: PDFFont; muted?: boolean; x?: number } = {},
    ): void {
        const size = opts.size ?? 10;
        this.y -= size;
        this.page.drawText(text, {
            x: opts.x ?? MARGIN,
            y: this.y,
            size,
            font: opts.font ?? this.fonts.regular,
            color: opts.muted ? MUTED : INK,
        });
        this.y -= 4;
    }

    /** Two-column row (label at the margin, value at `xValue`). */
    row(label: string, value: string, xValue = 260): void {
        const size = 10;
        this.y -= size;
        this.page.drawText(label, {
            x: MARGIN,
            y: this.y,
            size,
            font: this.fonts.bold,
            color: INK,
        });
        this.page.drawText(value, {
            x: xValue,
            y: this.y,
            size,
            font: this.fonts.regular,
            color: INK,
        });
        this.y -= 4;
    }
}

async function newDoc(): Promise<{ doc: PDFDocument; fonts: Fonts }> {
    const doc = await PDFDocument.create();
    return {
        doc,
        fonts: {
            regular: await doc.embedFont(StandardFonts.Helvetica),
            bold: await doc.embedFont(StandardFonts.HelveticaBold),
            mono: await doc.embedFont(StandardFonts.Courier),
        },
    };
}

/**
 * dec-page.pdf — a two-page auto-policy declarations "claims copy":
 * page 1 carries the named insured, claim/policy numbers, and the coverage
 * table (BI limits "25/50", PD limit); page 2 carries the adjuster block.
 * These are the fields claim-email-1's extraction should cite by page.
 */
async function buildDecPage(): Promise<Uint8Array> {
    const { doc, fonts } = await newDoc();
    const w = new Writer(doc, fonts);

    // Page 1 — declarations.
    w.line("EXAMPLE MUTUAL CASUALTY INSURANCE COMPANY", { size: 14, font: fonts.bold });
    w.line("Auto Policy Declarations — Claims Copy", { size: 11 });
    w.line("SYNTHETIC TEST FIXTURE — NOT A REAL POLICY, CLAIM, OR PERSON", {
        size: 9,
        muted: true,
    });
    w.gap(14);
    w.row("Named Insured:", "Dana Specimen");
    w.row("Policy Number:", "904412345");
    w.row("Claim Number:", "26-4400123");
    w.row("Date of Loss:", "03/14/2026");
    w.row("Claimant:", "Jordan Sample");
    w.gap(16);
    w.line("COVERAGES AND LIMITS OF LIABILITY", { size: 11, font: fonts.bold });
    w.gap(6);
    w.row("Bodily Injury Liability", "$25,000 each person / $50,000 each accident", 260);
    w.row("Property Damage Liability", "$25,000 each accident", 260);
    w.row("Uninsured/Underinsured Motorist BI", "$25,000 each person / $50,000 each accident", 260);
    w.row("Medical Payments", "$5,000 each person", 260);
    w.gap(14);
    w.line("Bodily injury limits are stated as 25/50: $25,000 per person and $50,000", { size: 9 });
    w.line("per accident. Limits apply as stated on this declarations page only.", { size: 9 });
    w.gap(20);
    w.line("Page 1 of 2", { size: 8, muted: true });

    // Page 2 — claims handling / adjuster block.
    w.newPage();
    w.line("CLAIMS HANDLING INFORMATION", { size: 13, font: fonts.bold });
    w.line("SYNTHETIC TEST FIXTURE — NOT A REAL POLICY, CLAIM, OR PERSON", {
        size: 9,
        muted: true,
    });
    w.gap(14);
    w.row("Assigned Adjuster:", "Taylor Mock");
    w.row("Unit:", "Bodily Injury Unit, Claims Department");
    w.row("Direct Line:", "(800) 555-0142");
    w.row("Email:", "taylor.mock@claims.examplemutual.test");
    w.gap(16);
    w.line("Please reference claim number 26-4400123 on all correspondence", { size: 10 });
    w.line("regarding this claim.", { size: 10 });
    w.gap(20);
    w.line("Page 2 of 2", { size: 8, muted: true });

    return doc.save();
}

/**
 * invoice.pdf — a one-page policy-limits-request invoice from Example Case
 * Funding (seeded vendor registry): vendor block, invoice number
 * INV-002417, matter reference "Casey Example", and TOTAL DUE $1,850.00 —
 * the fields invoice-email-1's extraction should cite from page 1.
 */
async function buildInvoice(): Promise<Uint8Array> {
    const { doc, fonts } = await newDoc();
    const w = new Writer(doc, fonts);

    w.line("EXAMPLE CASE FUNDING", { size: 14, font: fonts.bold });
    w.line("Policy Limits & Records Services", { size: 10 });
    w.line("1234 Example Way, Suite 100, Testville, CA 90000 — (800) 555-0193", {
        size: 9,
        muted: true,
    });
    w.line("SYNTHETIC TEST FIXTURE — NOT A REAL INVOICE, VENDOR ADDRESS, OR PERSON", {
        size: 9,
        muted: true,
    });
    w.gap(18);
    w.line("INVOICE", { size: 13, font: fonts.bold });
    w.gap(8);
    w.row("Invoice Number:", "INV-002417");
    w.row("Invoice Date:", "07/02/2026");
    w.row("Due Date:", "08/01/2026");
    w.gap(12);
    w.row("Bill To:", "Sample & Example LLP");
    w.row("Matter Reference:", "Casey Example — policy limits request");
    w.gap(18);
    w.line("DESCRIPTION", { size: 10, font: fonts.bold });
    w.gap(4);
    w.row("Policy limits request — Casey Example", "$1,750.00", 420);
    w.row("Processing and delivery fee", "$100.00", 420);
    w.gap(10);
    w.row("Subtotal", "$1,850.00", 420);
    w.row("TOTAL DUE", "$1,850.00", 420);
    w.gap(18);
    w.line("Remit payment through the vendor payment portal within 30 days of the", { size: 9 });
    w.line("invoice date. Reference invoice number INV-002417 with your payment.", { size: 9 });
    w.gap(20);
    w.line("Page 1 of 1", { size: 8, muted: true });

    return doc.save();
}

async function main(): Promise<void> {
    fs.mkdirSync(PI_FIXTURES_DIR, { recursive: true });
    const outputs: [string, Uint8Array][] = [
        ["dec-page.pdf", await buildDecPage()],
        ["invoice.pdf", await buildInvoice()],
    ];
    for (const [name, bytes] of outputs) {
        const outPath = path.join(PI_FIXTURES_DIR, name);
        fs.writeFileSync(outPath, bytes);
        console.log(`wrote ${outPath} (${bytes.byteLength} bytes)`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
