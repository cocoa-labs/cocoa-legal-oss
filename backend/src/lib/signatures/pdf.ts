// backend/src/lib/signatures/pdf.ts
//
// PDF manipulation for the signature pipeline. Three pure-ish operations on
// Buffers (no DB, no network):
//
//   ensurePdf                  — coerce an uploaded doc (docx/doc/odt/...) to PDF
//   stampSignatures            — draw visible signature blocks onto a PDF
//   embedCryptographicSignature — attach a PKCS#7 digital signature (LTV-ready
//                                 ByteRange/Sig dict) via @signpdf v3
//
// LibreOffice is only invoked for non-PDF inputs; an already-PDF buffer is
// returned untouched. All drawing uses pdf-lib so it stays portable.

import {
    PDFDocument,
    StandardFonts,
    rgb,
    type PDFFont,
    type PDFImage,
    type PDFPage,
} from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { normalizeDocxZipPaths } from "../convert";
import { convertWithLibreOffice } from "../libreoffice";

import { resolveSigningIdentity, SIGNATURE_PLACEHOLDER_LENGTH } from "./cert";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import path from "node:path";

// Bundled cursive signature font (Great Vibes, OFL) so a TYPED signature renders
// like a signature rather than italic print. Read once; if it can't be loaded or
// embedded we fall back to a standard oblique font so signing never breaks.
let cursiveFontBytes: Buffer | null | undefined;
function loadCursiveFontBytes(): Buffer | null {
    if (cursiveFontBytes !== undefined) return cursiveFontBytes;
    try {
        cursiveFontBytes = readFileSync(
            path.join(__dirname, "fonts", "GreatVibes-Regular.ttf"),
        );
    } catch {
        cursiveFontBytes = null;
    }
    return cursiveFontBytes;
}

/** Bytes that begin every PDF file: "%PDF". */
const PDF_MAGIC = Buffer.from("%PDF");
/** ZIP local-file header — OOXML (docx/xlsx/pptx) and ODF (odt/ods/odp) are ZIP containers. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** OLE compound-file header — legacy binary Office (.doc/.xls/.ppt). */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** PNG signature. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** JPEG SOI marker. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Filename extensions LibreOffice can reliably turn into PDF for us. */
const CONVERTIBLE_EXTENSIONS = new Set([
    "doc",
    "docx",
    "odt",
    "rtf",
    "txt",
    "html",
    "htm",
]);

function lowerExt(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** Normalize a stored file_type hint ("docx", ".DOCX") to a bare lowercase ext. */
function normalizeExt(fileType: string | null | undefined): string {
    if (!fileType) return "";
    return fileType.trim().toLowerCase().replace(/^\./, "");
}

function startsWith(bytes: Buffer, magic: Buffer): boolean {
    return (
        bytes.length >= magic.length &&
        bytes.subarray(0, magic.length).equals(magic)
    );
}

/**
 * Exported so callers that hand us bytes from storage can check the header
 * with the SAME predicate `ensurePdf` classifies on, rather than duplicating
 * the magic-byte test. `loadSourceDocument` (routes/signatures.ts) uses it to
 * validate a stored PDF rendition before preferring it over the source bytes.
 */
export function looksLikePdf(bytes: Buffer): boolean {
    return startsWith(bytes, PDF_MAGIC);
}

/** True if the bytes are a container LibreOffice can import: ZIP-based OOXML/ODF or OLE legacy Office. */
function looksLikeOfficeDoc(bytes: Buffer): boolean {
    return startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, OLE_MAGIC);
}

function looksLikePng(bytes: Buffer): boolean {
    return startsWith(bytes, PNG_MAGIC);
}

/** True for the raster images pdf-lib can embed directly (PNG or JPEG). */
function looksLikeEmbeddableImage(bytes: Buffer): boolean {
    return looksLikePng(bytes) || startsWith(bytes, JPEG_MAGIC);
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

export type PdfClassification =
    | "passthrough"
    | "convert"
    | "image"
    | "unsupported";

/**
 * Decide how to turn (bytes, filename, fileType) into a PDF — in priority order:
 * PDF magic bytes → filename extension → stored file_type hint → a content sniff
 * for Office containers. Pure and LibreOffice-free so it can be unit-tested.
 *
 * The content sniff is what keeps an extensionless name (e.g. a version labelled
 * "Clean Final") from failing: the DOCX bytes self-identify as a ZIP container,
 * and LibreOffice auto-detects the real format from the bytes regardless.
 */
export function classifyForPdf(
    bytes: Buffer,
    filename: string,
    fileType?: string | null,
): PdfClassification {
    if (looksLikePdf(bytes)) return "passthrough";
    // A raster image (e.g. a generated image saved as a document) can't be
    // "converted" — it's wrapped into a one-page PDF instead. Detect by magic
    // bytes first (most reliable), then by extension/file_type.
    if (looksLikeEmbeddableImage(bytes)) return "image";
    const ext = lowerExt(filename) || normalizeExt(fileType);
    if (ext === "pdf") {
        // Claims to be a PDF but lacks the header — pass through and let the
        // downstream parser surface a clear error rather than mis-converting.
        return "passthrough";
    }
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (CONVERTIBLE_EXTENSIONS.has(ext)) return "convert";
    // Name and type gave us nothing usable — trust the bytes.
    if (looksLikeOfficeDoc(bytes)) return "convert";
    return "unsupported";
}

/**
 * Wrap raster image bytes (PNG/JPEG) into a single-page PDF sized to the image,
 * so an image document can be previewed and signed like any other. Uses pdf-lib
 * (already imported for stamping), which supports embedPng/embedJpg only — hence
 * the PNG/JPEG scope.
 */
export async function imageToPdf(bytes: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const img = looksLikePng(bytes)
        ? await doc.embedPng(bytes)
        : await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    const out = await doc.save();
    return Buffer.from(out);
}

/**
 * Ensure the input bytes are a PDF.
 *
 * If the bytes already carry the `%PDF` header (or the filename ends in .pdf
 * and the header is present), they are returned as-is. Otherwise the document
 * is converted to PDF via LibreOffice. The format is resolved from the filename
 * extension, then the stored `fileType` hint, then a content sniff of the bytes
 * — so an extensionless name (e.g. a version labelled "Clean Final") still
 * converts. Throws only when a non-PDF input can't be identified as convertible.
 */
export async function ensurePdf(input: {
    bytes: Buffer;
    filename: string;
    fileType?: string | null;
}): Promise<Buffer> {
    const { bytes, filename, fileType } = input;
    const decision = classifyForPdf(bytes, filename, fileType);
    // The same derivation `classifyForPdf` used to reach `decision`, so the
    // error below names exactly what the classification saw.
    const classifiedExt = lowerExt(filename) || normalizeExt(fileType);
    // The format hint that names the temp file soffice opens. `filename` is
    // often a version display_name — a LABEL, not a filename — so its trailing
    // dotted fragment is only a real extension sometimes ("Agreement v1.2" ends
    // in ".2"). Trust it only when it names a format we convert; otherwise the
    // stored file_type is the authority, and an empty hint (which hands the
    // case to the converter's magic-byte sniff) beats an invented guess.
    const ext = CONVERTIBLE_EXTENSIONS.has(classifiedExt)
        ? classifiedExt
        : normalizeExt(fileType);

    if (decision === "passthrough") return bytes;
    if (decision === "image") {
        try {
            const pdf = await imageToPdf(bytes);
            if (looksLikePdf(pdf)) return pdf;
        } catch {
            // fall through to the clear error below
        }
        throw new Error(
            `ensurePdf: could not embed image into a PDF (filename: ${filename})`,
        );
    }
    if (decision === "unsupported") {
        throw new Error(
            `ensurePdf: cannot convert .${classifiedExt || "unknown"} to PDF (filename: ${filename})`,
        );
    }

    // Parity with `convertToPdf` (../convert), the upload-time entry point.
    // Both must prepare the bytes identically or a document that converts on
    // upload fails at signature time:
    //
    //  - normalizeDocxZipPaths repairs .docx archives whose entries use
    //    Windows backslash separators (`word\document.xml`). LibreOffice looks
    //    entries up by exact string and fails on those; the helper is a no-op
    //    on anything it cannot parse as a ZIP, so it is safe for every input.
    //  - the format hint names the temp file soffice opens. Pass it ONLY when
    //    we actually have an extension: a version labelled "Clean Final" has
    //    none, and the converter's magic-byte sniff handles that case better
    //    than an invented guess would.
    const normalized = await normalizeDocxZipPaths(bytes);
    const converted = await convertWithLibreOffice(
        normalized,
        ext ? { inputExtension: ext } : {},
    );
    if (!converted || !looksLikePdf(converted)) {
        throw new Error(
            `ensurePdf: LibreOffice conversion did not yield a PDF for ${filename}`,
        );
    }
    return converted;
}

export interface StampPlacement {
    /** 0-based page index. Defaults to the last page. */
    page?: number;
    /** Horizontal position of the block's left edge, 0..1 across page width. */
    xPct?: number;
    /** Vertical position of the block's baseline, 0..1 up from page bottom. */
    yPct?: number;
}

export interface SignerStampInput {
    /** Printed legal name shown beneath the signature. */
    name: string;
    /** Typed-signature text (used when no drawn image is supplied). */
    typedName: string | null;
    /** Captured signature image (PNG bytes), if the signer drew one. */
    signaturePng: Buffer | null;
    /** ISO timestamp the signer completed signing. */
    signedAt: string;
    /** Optional explicit placement; otherwise auto-stacked at page bottom. */
    placement?: StampPlacement;
}

/**
 * An explicit, sender-placed field box to stamp. Coordinates are TOP-LEFT
 * origin, normalized to the page (x/y = top-left corner fraction, y from the
 * top; w/h = size fractions) — the canonical convention captured in the
 * browser and stored in `signature_fields`. Converted to pdf-lib's bottom-left
 * space exactly once here, in `fieldRectToPdf`.
 */
export interface FieldStampInput {
    type: "signature" | "initials" | "date" | "name";
    page: number;
    xPct: number;
    yPct: number;
    wPct: number;
    hPct: number;
    /** Content (the field's signer). */
    name: string;
    typedName: string | null;
    signaturePng: Buffer | null;
    signedAt: string;
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(n, 0), 1);
}

/**
 * Convert a top-left-origin normalized field box into a pdf-lib bottom-left
 * rectangle (x,y = bottom-left corner in points; w,h in points). This is the
 * single place the Y axis is flipped — keep it that way to avoid the drift bug
 * that plagues every drag-drop e-sign implementation.
 */
export function fieldRectToPdf(
    f: { xPct: number; yPct: number; wPct: number; hPct: number },
    pageWidth: number,
    pageHeight: number,
): { x: number; y: number; w: number; h: number } {
    const x = clamp01(f.xPct) * pageWidth;
    const w = clamp01(f.wPct) * pageWidth;
    const h = clamp01(f.hPct) * pageHeight;
    // y_pct is the box's TOP edge measured from the page top; pdf-lib's y is the
    // BOTTOM edge measured from the page bottom.
    const y = pageHeight - (clamp01(f.yPct) + clamp01(f.hPct)) * pageHeight;
    return { x, y, w, h };
}

/** Target dimensions for an embedded signature image. */
const SIG_IMG_WIDTH = 160;
const SIG_IMG_HEIGHT = 50;

/** Vertical room one signer block occupies when auto-stacking. */
const BLOCK_HEIGHT = 78;
const PAGE_MARGIN = 48;

function formatSignedAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, " UTC");
}

/** Embed a PNG, falling back to null if the bytes are not a usable image. */
async function tryEmbedPng(
    doc: PDFDocument,
    png: Buffer,
): Promise<PDFImage | null> {
    try {
        return await doc.embedPng(png);
    } catch {
        return null;
    }
}

/**
 * Draw a single signer block at an absolute (x, y) — y is the baseline of the
 * signature line; the printed name + timestamp render below it.
 */
async function drawSignerBlock(
    doc: PDFDocument,
    page: PDFPage,
    fonts: { body: PDFFont; script: PDFFont },
    signer: SignerStampInput,
    x: number,
    y: number,
    opts?: { compact?: boolean },
): Promise<void> {
    const black = rgb(0.07, 0.07, 0.07);
    const grey = rgb(0.4, 0.4, 0.4);

    let drewImage = false;
    if (signer.signaturePng) {
        const img = await tryEmbedPng(doc, signer.signaturePng);
        if (img) {
            const scale = Math.min(
                SIG_IMG_WIDTH / img.width,
                SIG_IMG_HEIGHT / img.height,
                1,
            );
            const w = img.width * scale;
            const h = img.height * scale;
            page.drawImage(img, { x, y, width: w, height: h });
            drewImage = true;
        }
    }

    if (!drewImage) {
        const typed = (signer.typedName ?? signer.name).trim() || signer.name;
        // Sit the typed signature on the underscore line (a small lift above the
        // baseline). Use the cursive font; if it lacks a glyph, fall back to a
        // standard font so completion never throws.
        const opts = { x, y: y + 2, size: 20, color: black };
        try {
            page.drawText(typed, { ...opts, font: fonts.script });
        } catch {
            page.drawText(typed, { ...opts, font: fonts.body });
        }
    }

    // Compact mode (placed on the document's real signature line): draw only
    // the signature mark — the document already prints the party name + a Date
    // label, and the Certificate of Completion carries the authoritative
    // name/time/IP. Drawing our own rule + name + date here would duplicate them.
    if (opts?.compact) return;

    // Full standalone block (bottom-stack fallback): rule line + name + date.
    page.drawLine({
        start: { x, y: y - 4 },
        end: { x: x + SIG_IMG_WIDTH + 60, y: y - 4 },
        thickness: 0.75,
        color: grey,
    });

    page.drawText(signer.name, {
        x,
        y: y - 18,
        size: 10,
        font: fonts.body,
        color: black,
    });
    page.drawText(`Signed: ${formatSignedAt(signer.signedAt)}`, {
        x,
        y: y - 31,
        size: 8,
        font: fonts.body,
        color: grey,
    });
}

const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

function formatDateOnly(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function initialsOf(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const ini = parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
    return (ini || name.slice(0, 2)).slice(0, 4);
}

/** Largest font size (≤ maxSize) that fits `text` within the box. */
function fitFontSize(
    font: PDFFont,
    text: string,
    maxWidth: number,
    maxHeight: number,
    maxSize = 28,
    minSize = 6,
): number {
    let size = Math.min(maxSize, Math.max(minSize, maxHeight * 0.8));
    if (!text) return size;
    while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth)
        size -= 1;
    return size;
}

/**
 * Render one explicit field inside its box. Signature → the drawn PNG scaled to
 * fit (or the typed name in script), initials/date/name → fitted text. The box
 * is computed once via `fieldRectToPdf` (the only Y-flip).
 */
async function drawField(
    doc: PDFDocument,
    page: PDFPage,
    fonts: { body: PDFFont; script: PDFFont },
    f: FieldStampInput,
): Promise<void> {
    const { width: pw, height: ph } = page.getSize();
    const { x: boxX, y: boxY, w: boxW, h: boxH } = fieldRectToPdf(f, pw, ph);
    const black = rgb(0.07, 0.07, 0.07);
    const padX = Math.min(3, boxW * 0.04);

    if (f.type === "signature" && f.signaturePng) {
        const img = await tryEmbedPng(doc, f.signaturePng);
        if (img) {
            const scale = Math.min(boxW / img.width, boxH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            page.drawImage(img, {
                x: boxX + (boxW - w) / 2,
                y: boxY + (boxH - h) / 2,
                width: w,
                height: h,
            });
            return;
        }
        // fall through to the typed-name rendering on embed failure
    }

    let text: string;
    let font: PDFFont;
    let maxSize: number;
    if (f.type === "date") {
        text = formatDateOnly(f.signedAt);
        font = fonts.body;
        maxSize = 12;
    } else if (f.type === "name") {
        text = f.name;
        font = fonts.body;
        maxSize = 12;
    } else if (f.type === "initials") {
        text = initialsOf(f.name);
        font = fonts.script;
        maxSize = 28;
    } else {
        // signature (no usable PNG) → typed signature
        text = (f.typedName ?? f.name).trim() || f.name;
        font = fonts.script;
        maxSize = 28;
    }
    const size = fitFontSize(font, text, boxW - padX * 2, boxH, maxSize);
    const drawOpts = {
        x: boxX + padX,
        y: boxY + Math.max(2, (boxH - size) / 2) + size * 0.12,
        size,
        color: black,
    };
    try {
        page.drawText(text, { ...drawOpts, font });
    } catch {
        // Cursive font missing a glyph → fall back to a standard font.
        page.drawText(text, { ...drawOpts, font: fonts.body });
    }
}

/**
 * Stamp visible signature blocks onto a PDF.
 *
 * For each signer: embeds their drawn signature image (scaled to ~160x50) if
 * present, otherwise renders the typed name in an italic/script-ish standard
 * font; below it prints the legal name and the signed date. Signers without an
 * explicit placement are stacked from the bottom margin of the last page
 * upward; a provided `placement` (page + xPct/yPct) overrides that.
 *
 * Robust to arbitrary PDFs: placement is clamped to the page box and image
 * embedding failures degrade to the typed-name path.
 */
export async function stampSignatures(
    pdf: Buffer,
    signers: SignerStampInput[],
    opts?: {
        coverRects?: {
            page: number;
            x: number;
            y: number;
            width: number;
            height: number;
        }[];
        /**
         * Explicit, sender-placed fields. When present, these are stamped
         * exactly inside their boxes and the per-signer auto/anchor placement
         * loop is skipped entirely.
         */
        fields?: FieldStampInput[];
    },
): Promise<Buffer> {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
    const pages = doc.getPages();
    if (pages.length === 0) {
        // Nothing to stamp onto; return the input unchanged.
        return pdf;
    }

    const body = await doc.embedFont(StandardFonts.Helvetica);
    // Typed signatures use a cursive font; fall back to oblique Helvetica if the
    // bundled font can't be embedded.
    let script = await doc.embedFont(StandardFonts.HelveticaOblique);
    const cursive = loadCursiveFontBytes();
    if (cursive) {
        try {
            doc.registerFontkit(fontkit);
            script = await doc.embedFont(cursive, { subset: true });
        } catch {
            // keep the oblique fallback
        }
    }
    const fonts = { body, script };

    // White out any anchor-token markers (e.g. {{coco-sign:0}}) before drawing
    // the signatures, so the markers never appear in the executed PDF.
    for (const r of opts?.coverRects ?? []) {
        const pageIndex = Math.min(Math.max(r.page, 0), pages.length - 1);
        pages[pageIndex].drawRectangle({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            color: rgb(1, 1, 1),
        });
    }

    const lastIndex = pages.length - 1;

    // Explicit field placement (Phase 2): stamp each field in its box and skip
    // the per-signer auto/anchor placement entirely.
    if (opts?.fields && opts.fields.length > 0) {
        for (const f of opts.fields) {
            const pageIndex = Math.min(Math.max(f.page, 0), lastIndex);
            await drawField(doc, pages[pageIndex], fonts, f);
        }
        const out = await doc.save({ useObjectStreams: false });
        return Buffer.from(out);
    }

    let autoStackCount = 0;

    for (const signer of signers) {
        const placement = signer.placement;
        const pageIndex =
            placement?.page !== undefined
                ? Math.min(Math.max(placement.page, 0), lastIndex)
                : lastIndex;
        const page = pages[pageIndex];
        const { width, height } = page.getSize();

        let x: number;
        let y: number;
        const usedPlacement = !!(
            placement &&
            (placement.xPct !== undefined || placement.yPct !== undefined)
        );
        if (usedPlacement && placement) {
            const xPct = placement.xPct ?? 0.08;
            const yPct = placement.yPct ?? 0.1;
            x = Math.min(Math.max(xPct, 0), 1) * width;
            y = Math.min(Math.max(yPct, 0), 1) * height;
            // Keep the block inside the page.
            x = Math.min(
                x,
                Math.max(PAGE_MARGIN, width - (SIG_IMG_WIDTH + 70)),
            );
            y = Math.min(Math.max(y, PAGE_MARGIN), height - 24);
        } else {
            // Auto-stack from the bottom margin upward on the last page.
            x = PAGE_MARGIN;
            y = PAGE_MARGIN + 24 + autoStackCount * BLOCK_HEIGHT;
            // If we'd run off the top, wrap back toward the bottom (best effort).
            if (y > height - PAGE_MARGIN) {
                y = PAGE_MARGIN + 24;
            }
            autoStackCount += 1;
        }

        // Placed on a real signature line → draw just the signature mark;
        // otherwise draw the full standalone block.
        await drawSignerBlock(doc, page, fonts, signer, x, y, {
            compact: usedPlacement,
        });
    }

    const out = await doc.save({ useObjectStreams: false });
    return Buffer.from(out);
}

/** Apply the controlled-beta execution notice to every page before signing. */
export async function stampBetaNotice(pdf: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const label = "BETA TEST - NOT FOR LEGAL EXECUTION";
    for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        const size = Math.max(7, Math.min(11, width / 48));
        const textWidth = font.widthOfTextAtSize(label, size);
        page.drawRectangle({
            x: 0,
            y: height - size - 9,
            width,
            height: size + 9,
            color: rgb(1, 0.96, 0.88),
            opacity: 0.92,
        });
        page.drawText(label, {
            x: Math.max(12, (width - textWidth) / 2),
            y: height - size - 4,
            size,
            font,
            color: rgb(0.65, 0.28, 0.02),
        });
    }
    return Buffer.from(await doc.save());
}

/**
 * Attach a cryptographic (PKCS#7 detached, /SubFilter adbe.pkcs7.detached)
 * signature to a PDF.
 *
 * Uses the @signpdf v3 flow:
 *   1. Load the PDF into pdf-lib.
 *   2. Insert a signature placeholder (ByteRange + empty /Contents) with
 *      `pdflibAddPlaceholder`. `signatureLength` is set explicitly: the
 *      signature DER must fit in HALF the placeholder (hex-encoded), and the
 *      library default (8192 → 4 KB) cannot hold a CA-issued chain — swapping
 *      in a purchased cert would fail mid-envelope-completion without this.
 *   3. Re-serialise WITHOUT object streams (signpdf needs a parseable
 *      ByteRange) and sign with `SignPdf.sign` + a `P12Signer` built from the
 *      resolved signing identity (`resolveSigningIdentity()` — every cert in
 *      the P12 chain is embedded in the CMS).
 *
 * The returned Buffer contains a `/Type /Sig` dictionary and a populated
 * `/ByteRange`. Note: no RFC-3161 timestamp or DSS/VRI data is embedded, so
 * this is a plain CMS signature, not PAdES-LTV.
 */
/**
 * Descriptive fields written into the PDF signature dictionary. Contact and
 * location belong to the deploying firm (SIGNING_CONTACT_EMAIL,
 * SIGNING_LOCATION) and are left empty when unset.
 */
export function signaturePlaceholderMetadata(env: NodeJS.ProcessEnv = process.env): {
    reason: string;
    contactInfo: string;
    name: string;
    location: string;
} {
    return {
        reason: "Document executed via Coco Legal e-signature",
        contactInfo: env.SIGNING_CONTACT_EMAIL?.trim() || "",
        name: "Coco Legal Signing",
        location: env.SIGNING_LOCATION?.trim() || "",
    };
}

export async function embedCryptographicSignature(
    pdf: Buffer,
): Promise<Buffer> {
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });

    pdflibAddPlaceholder({
        pdfDoc: doc,
        ...signaturePlaceholderMetadata(),
        signatureLength: SIGNATURE_PLACEHOLDER_LENGTH,
    });

    // Object streams must be disabled so signpdf can find and patch the
    // ByteRange in the serialised bytes.
    const withPlaceholder = Buffer.from(
        await doc.save({ useObjectStreams: false }),
    );

    const { p12, passphrase } = resolveSigningIdentity();
    const signer = new P12Signer(p12, { passphrase });
    const signed = await new SignPdf().sign(withPlaceholder, signer);
    return Buffer.from(signed);
}
