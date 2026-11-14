// backend/src/lib/signatures/certificate.ts
//
// Builds the "Certificate of Completion" — the audit page that accompanies an
// executed envelope. It records the document identity (both SHA-256 hashes),
// every signer (name / email / signed time / IP / consent), and the full
// audit-event log, and discloses when signer identity rests on an organisation
// self-signed certificate. Pure pdf-lib; no DB or network.

import {
    PDFDocument,
    StandardFonts,
    rgb,
    type PDFFont,
    type PDFPage,
} from "pdf-lib";
import type { SigningIdentityDescription } from "./cert";

export interface CertificateInput {
    envelopeId: string;
    subject: string;
    documentName: string;
    originalSha256: string;
    executedSha256: string;
    signers: {
        name: string;
        email: string;
        signedAt: string | null;
        ip: string | null;
        consentAt: string | null;
    }[];
    events: { type: string; created_at: string; detail?: string }[];
    /**
     * The identity that produced the cryptographic signature — parsed from the
     * actual certificate (describeSigningIdentity()), never a boolean flag, so
     * the disclosure below cannot drift from what really signed the PDF.
     */
    signingIdentity: SigningIdentityDescription;
}

// Letter portrait.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.82, 0.82, 0.85);
const ACCENT = rgb(0.36, 0.21, 0.13); // warm brown

interface Fonts {
    regular: PDFFont;
    bold: PDFFont;
    mono: PDFFont;
}

/**
 * Cursor-based page writer that auto-paginates. `y` walks down from the top
 * margin; when a block would overflow the bottom margin a fresh page is added.
 */
class Doc {
    readonly doc: PDFDocument;
    readonly fonts: Fonts;
    page: PDFPage;
    y: number;

    private constructor(doc: PDFDocument, fonts: Fonts, page: PDFPage) {
        this.doc = doc;
        this.fonts = fonts;
        this.page = page;
        this.y = PAGE_HEIGHT - MARGIN;
    }

    static async create(): Promise<Doc> {
        const doc = await PDFDocument.create();
        const fonts: Fonts = {
            regular: await doc.embedFont(StandardFonts.Helvetica),
            bold: await doc.embedFont(StandardFonts.HelveticaBold),
            mono: await doc.embedFont(StandardFonts.Courier),
        };
        const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        return new Doc(doc, fonts, page);
    }

    private ensureSpace(needed: number): void {
        if (this.y - needed < MARGIN) {
            this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            this.y = PAGE_HEIGHT - MARGIN;
        }
    }

    gap(h: number): void {
        this.y -= h;
    }

    text(
        value: string,
        opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {},
    ): void {
        const size = opts.size ?? 10;
        const font = opts.font ?? this.fonts.regular;
        this.ensureSpace(size + 4);
        this.y -= size;
        this.page.drawText(sanitize(value), {
            x: opts.x ?? MARGIN,
            y: this.y,
            size,
            font,
            color: opts.color ?? INK,
        });
        this.y -= 4;
    }

    /** Wrap a long string to the content width and emit each line. */
    paragraph(value: string, opts: { size?: number; font?: PDFFont } = {}): void {
        const size = opts.size ?? 10;
        const font = opts.font ?? this.fonts.regular;
        for (const line of wrap(sanitize(value), font, size, CONTENT_WIDTH)) {
            this.text(line, { size, font });
        }
    }

    rule(): void {
        this.ensureSpace(8);
        this.y -= 6;
        this.page.drawLine({
            start: { x: MARGIN, y: this.y },
            end: { x: PAGE_WIDTH - MARGIN, y: this.y },
            thickness: 0.75,
            color: RULE,
        });
        this.y -= 6;
    }

    /** Label: value pair on one line, label in bold. */
    field(label: string, value: string): void {
        const size = 10;
        this.ensureSpace(size + 6);
        this.y -= size;
        this.page.drawText(sanitize(label), {
            x: MARGIN,
            y: this.y,
            size,
            font: this.fonts.bold,
            color: INK,
        });
        const labelWidth = this.fonts.bold.widthOfTextAtSize(sanitize(label), size);
        this.page.drawText(sanitize(value), {
            x: MARGIN + labelWidth + 6,
            y: this.y,
            size,
            font: this.fonts.regular,
            color: INK,
        });
        this.y -= 6;
    }

    async save(): Promise<Buffer> {
        const bytes = await this.doc.save({ useObjectStreams: false });
        return Buffer.from(bytes);
    }
}

/** Drop characters outside WinAnsi so the standard fonts never throw. */
function sanitize(value: string): string {
    return (
        (value ?? "")
            // Map common typographic punctuation to ASCII first, so e.g. an
            // em/en dash renders as "-" instead of the catch-all "?" (U+2014 is
            // outside WinAnsi). Otherwise "Cocoa Legal — …" became "Cocoa Legal ? …".
            .replace(/[—–]/g, "-")
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"')
            // eslint-disable-next-line no-control-regex
            .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?")
    );
}

/** Greedy word-wrap measured against the chosen font/size. */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
            current = candidate;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function fmt(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Hard-wrap a hex hash so the 64-char digest fits within the content width. */
function chunkHash(hash: string, perLine = 64): string[] {
    if (!hash) return ["—"];
    const out: string[] = [];
    for (let i = 0; i < hash.length; i += perLine) {
        out.push(hash.slice(i, i + perLine));
    }
    return out;
}

/**
 * Render the Certificate of Completion for an executed envelope and return the
 * PDF bytes.
 */
export async function buildCertificateOfCompletion(input: CertificateInput): Promise<Buffer> {
    const d = await Doc.create();

    // Title.
    d.text("Certificate of Completion", { size: 20, font: d.fonts.bold, color: ACCENT });
    d.text("Cocoa Legal — native e-signature engine", { size: 9, color: MUTED });
    d.gap(6);
    d.rule();

    // Envelope / document identity.
    d.field("Envelope ID:", input.envelopeId);
    d.field("Subject:", input.subject || "—");
    d.field("Document:", input.documentName || "—");
    d.gap(4);

    // Document integrity hashes.
    d.text("Document integrity (SHA-256)", { size: 12, font: d.fonts.bold });
    d.gap(2);
    d.text("Original document:", { size: 9, font: d.fonts.bold, color: MUTED });
    for (const line of chunkHash(input.originalSha256)) {
        d.text(line, { size: 9, font: d.fonts.mono });
    }
    d.gap(2);
    d.text("Executed document:", { size: 9, font: d.fonts.bold, color: MUTED });
    for (const line of chunkHash(input.executedSha256)) {
        d.text(line, { size: 9, font: d.fonts.mono });
    }
    d.gap(4);
    d.rule();

    // Signer identity disclosure — tri-state, derived from the parsed
    // certificate that actually signed the executed PDF.
    d.text("Signer identity", { size: 12, font: d.fonts.bold });
    d.gap(2);
    const identity = input.signingIdentity;
    if (identity.mode === "dev-ephemeral") {
        d.paragraph(
            "The cryptographic signature was produced with an ephemeral development " +
                "certificate that is regenerated whenever the signing service restarts. " +
                "It provides document-integrity protection only and is not suitable for " +
                "legally binding execution.",
            { size: 9 },
        );
    } else if (identity.mode === "org-self-signed") {
        d.paragraph(
            "Signer identity: organization self-signed certificate. The cryptographic " +
                "signature on the executed PDF was produced with a certificate generated and " +
                "held by the issuing organization rather than a publicly trusted certificate " +
                "authority.",
            { size: 9 },
        );
    } else {
        d.paragraph(
            `The executed PDF was cryptographically signed using a certificate issued by ` +
                `"${identity.issuerCN}".`,
            { size: 9 },
        );
    }
    d.gap(2);
    d.field("Certificate:", identity.subjectCN);
    d.field("Issuer:", identity.issuerCN);
    d.field("Serial:", identity.serialHex);
    d.field("Valid until:", fmt(identity.notAfter.toISOString()));
    d.text("SHA-256 fingerprint:", { size: 9, font: d.fonts.bold, color: MUTED });
    for (const line of chunkHash(identity.sha256Fingerprint)) {
        d.text(line, { size: 9, font: d.fonts.mono });
    }
    d.gap(4);
    d.rule();

    // Signer table.
    d.text("Signers", { size: 12, font: d.fonts.bold });
    d.gap(2);
    if (input.signers.length === 0) {
        d.text("No signers recorded.", { size: 9, color: MUTED });
    }
    for (const [i, s] of input.signers.entries()) {
        d.text(`${i + 1}. ${s.name}`, { size: 10, font: d.fonts.bold });
        d.text(`Email:   ${s.email}`, { size: 9, color: MUTED });
        d.text(`Signed:  ${fmt(s.signedAt)}`, { size: 9, color: MUTED });
        d.text(`IP:      ${s.ip ?? "—"}`, { size: 9, color: MUTED });
        d.text(`Consent: ${fmt(s.consentAt)}`, { size: 9, color: MUTED });
        d.gap(4);
    }
    d.rule();

    // Audit-event log.
    d.text("Audit trail", { size: 12, font: d.fonts.bold });
    d.gap(2);
    if (input.events.length === 0) {
        d.text("No events recorded.", { size: 9, color: MUTED });
    }
    for (const e of input.events) {
        const head = `${fmt(e.created_at)}  ·  ${e.type}`;
        d.text(head, { size: 9, font: d.fonts.mono });
        if (e.detail) {
            d.paragraph(`    ${e.detail}`, { size: 8, font: d.fonts.regular });
        }
    }

    return d.save();
}
