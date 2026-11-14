// backend/src/lib/signatures/pdf.test.ts
//
// Exercises the visible-stamp and cryptographic-signature paths against a
// minimal in-memory PDF. Uses the self-signed cert path (no SIGNING_CERT_*
// env), so it has no external dependencies and runs quickly.
//
// `ensurePdf`'s LibreOffice branch IS exercised, but never against a real
// LibreOffice: CI has none. It runs against a fake soffice shell script
// written to a temp dir at runtime (mode 0o755, so nothing executable is
// committed) and injected via SOFFICE_BINARY_PATH, which the resolver honours
// ahead of any discovery. The fake records the filename it was handed and
// keeps a copy of the exact bytes, so the tests can assert on both the format
// hint and the ZIP repair that `ensurePdf` is supposed to apply.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
    classifyForPdf,
    embedCryptographicSignature,
    signaturePlaceholderMetadata,
    ensurePdf,
    fieldRectToPdf,
    looksLikePdf,
    stampSignatures,
    type FieldStampInput,
    type SignerStampInput,
} from "./pdf";
import forge from "node-forge";
import { SIGNATURE_PLACEHOLDER_LENGTH } from "./cert";
import { mintSigningIdentity, bundleP12 } from "./certGen";

// A valid 1x1 transparent PNG (the canonical smallest-PNG constant).
const ONE_BY_ONE_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

const PDF_HEADER = "%PDF";

/** Build a tiny one-page PDF with a line of text. */
async function makeMinimalPdf(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Master Services Agreement", { x: 72, y: 720, size: 14, font });
    const bytes = await doc.save({ useObjectStreams: false });
    return Buffer.from(bytes);
}

function startsWithPdfHeader(buf: Buffer): boolean {
    return buf.subarray(0, 4).toString("latin1") === PDF_HEADER;
}

async function testStampTypedNameSigner() {
    const base = await makeMinimalPdf();
    const signers: SignerStampInput[] = [
        {
            name: "Dana Specimen",
            typedName: "Dana Specimen",
            signaturePng: null,
            signedAt: "2026-05-31T18:00:00.000Z",
        },
    ];
    const stamped = await stampSignatures(base, signers);

    // Still a PDF...
    assert.ok(startsWithPdfHeader(stamped), "stamped output must begin with %PDF");
    // ...and pdf-lib can re-load it (structurally valid).
    const reloaded = await PDFDocument.load(stamped);
    assert.equal(reloaded.getPageCount(), 1);
    return stamped;
}

async function testStampMultipleSignersAutoStack() {
    const base = await makeMinimalPdf();
    const signers: SignerStampInput[] = [
        { name: "Alice A", typedName: "Alice A", signaturePng: null, signedAt: "2026-05-31T18:00:00.000Z" },
        { name: "Bob B", typedName: null, signaturePng: null, signedAt: "2026-05-31T18:05:00.000Z" },
    ];
    const stamped = await stampSignatures(base, signers);
    assert.ok(startsWithPdfHeader(stamped));
    const reloaded = await PDFDocument.load(stamped);
    assert.equal(reloaded.getPageCount(), 1);
}

async function testEmbedCryptographicSignature(stamped: Buffer) {
    // Self-signed path: ensure no real cert env leaks in from the shell.
    delete process.env.SIGNING_CERT_P12_BASE64;
    delete process.env.SIGNING_CERT_PASSPHRASE;

    const signed = await embedCryptographicSignature(stamped);
    assert.ok(startsWithPdfHeader(signed), "signed output must begin with %PDF");

    // The signed PDF must carry a signature dictionary + ByteRange.
    const text = signed.toString("latin1");
    const hasSig = text.includes("/Type /Sig") || text.includes("/Type/Sig");
    const hasByteRange = text.includes("/ByteRange");
    assert.ok(hasSig, "expected a /Type /Sig signature dictionary");
    assert.ok(hasByteRange, "expected a /ByteRange entry");

    // Sanity: signing grew the document (placeholder + PKCS#7 added).
    assert.ok(signed.length > stamped.length, "signed PDF should be larger than input");
}

/**
 * Env-supplied CHAINED certificate: locks two production-critical behaviors —
 * (1) P12Signer embeds the full chain into the CMS, so a purchased CA cert
 * needs no code change, and (2) the explicit SIGNATURE_PLACEHOLDER_LENGTH
 * leaves headroom for it. The 4096-bit leaf+CA fixture produces a ~4.3 KB DER
 * that would NOT have fit the library's default 4 KB ceiling — this test fails
 * if the signatureLength option is ever dropped.
 */
async function testEmbedWithChainedEnvCert(stamped: Buffer) {
    const savedB64 = process.env.SIGNING_CERT_P12_BASE64;
    const savedPass = process.env.SIGNING_CERT_PASSPHRASE;
    try {
        // Realistic AATL shape: leaf ← issuing CA ← root, all 4096-bit. The
        // three-cert CMS lands well above the old 4 KB ceiling.
        const root = mintSigningIdentity({
            commonName: "Fixture Root CA",
            organization: "Cocoa Legal",
            keyBits: 4096,
            passphrase: "root",
            isCa: true,
        });
        const issuing = mintSigningIdentity({
            commonName: "Fixture Issuing CA",
            organization: "Cocoa Legal",
            keyBits: 4096,
            passphrase: "ca",
            isCa: true,
            issuer: { cert: root.cert, privateKey: root.privateKey },
        });
        const leaf = mintSigningIdentity({
            commonName: "Fixture Chained Signer",
            organization: "Cocoa Legal",
            keyBits: 4096,
            passphrase: "leaf",
            issuer: { cert: issuing.cert, privateKey: issuing.privateKey },
        });
        const chained = bundleP12(
            leaf.privateKey,
            [leaf.cert, issuing.cert, root.cert],
            "chain-pass",
        );
        process.env.SIGNING_CERT_P12_BASE64 = chained.toString("base64");
        process.env.SIGNING_CERT_PASSPHRASE = "chain-pass";

        const signed = await embedCryptographicSignature(stamped);
        assert.ok(startsWithPdfHeader(signed));

        // Pull the /Contents hex blob out of the signature dictionary and
        // parse the CMS with forge: both certificates must be embedded and
        // the DER must fit the raised placeholder budget.
        const text = signed.toString("latin1");
        const match = text.match(/\/Contents\s*<([0-9A-Fa-f]+)>/);
        assert.ok(match, "signed PDF exposes the /Contents hex string");
        const der = Buffer.from(match[1], "hex");
        assert.ok(
            der.length <= SIGNATURE_PLACEHOLDER_LENGTH / 2,
            `CMS DER (${der.length}B) fits the placeholder budget`,
        );
        const trimmed = extractPaddedDer(der);
        assert.ok(
            trimmed.length > 4096,
            `fixture CMS (${trimmed.length}B) genuinely exceeds the old 4 KB default`,
        );
        const asn1 = forge.asn1.fromDer(
            forge.util.createBuffer(trimmed.toString("binary")),
        );
        const p7 = forge.pkcs7.messageFromAsn1(
            asn1,
        ) as forge.pkcs7.PkcsSignedData;
        assert.equal(
            p7.certificates?.length,
            3,
            "CMS embeds the full leaf + issuing CA + root chain",
        );
    } finally {
        if (savedB64 === undefined) delete process.env.SIGNING_CERT_P12_BASE64;
        else process.env.SIGNING_CERT_P12_BASE64 = savedB64;
        if (savedPass === undefined) delete process.env.SIGNING_CERT_PASSPHRASE;
        else process.env.SIGNING_CERT_PASSPHRASE = savedPass;
    }
}

/** DER's encoded length distinguishes valid zero bytes from PDF padding. */
function extractPaddedDer(buf: Buffer): Buffer {
    assert.ok(buf.length >= 2, "DER tag and length must be present");
    let headerLength = 2;
    let contentLength = buf[1];
    if (contentLength & 0x80) {
        const lengthBytes = contentLength & 0x7f;
        assert.ok(lengthBytes > 0 && lengthBytes <= 4, "DER length must be definite and bounded");
        headerLength += lengthBytes;
        assert.ok(buf.length >= headerLength, "DER length bytes must be present");
        contentLength = buf.readUIntBE(2, lengthBytes);
    }
    const end = headerLength + contentLength;
    assert.ok(end <= buf.length, "DER content must be complete");
    assert.ok(
        buf.subarray(end).every((byte) => byte === 0),
        "only zero padding may follow the CMS DER value",
    );
    return buf.subarray(0, end);
}

function testPaddedDerPreservesContentZeros() {
    // OCTET STRING with a real zero as its final content byte. The previous
    // helper removed it, making random certificate signatures fail parsing.
    const der = Buffer.from([0x04, 0x02, 0x41, 0x00]);
    assert.deepEqual(extractPaddedDer(der), der);
    assert.deepEqual(extractPaddedDer(Buffer.concat([der, Buffer.alloc(8)])), der);
    const longDer = Buffer.concat([Buffer.from([0x04, 0x81, 0x82]), Buffer.alloc(130)]);
    assert.deepEqual(extractPaddedDer(Buffer.concat([longDer, Buffer.alloc(8)])), longDer);
    assert.throws(() => extractPaddedDer(der.subarray(0, -1)));
    assert.throws(() => extractPaddedDer(Buffer.concat([der, Buffer.from([0x01])])));
}

// The single Y-flip: top-left normalized box → pdf-lib bottom-left rect.
function testFieldRectToPdf() {
    // A box near the top of a 600x800 page.
    const top = fieldRectToPdf(
        { xPct: 0.1, yPct: 0, wPct: 0.2, hPct: 0.05 },
        600,
        800,
    );
    assert.equal(top.x, 60, "x = xPct*width");
    assert.equal(top.w, 120, "w = wPct*width");
    assert.equal(top.h, 40, "h = hPct*height");
    // top-left at the very top → bottom edge sits at height - boxHeight.
    assert.equal(top.y, 760, "top box → high pdf-y (just below the top)");

    // A box flush to the page bottom → pdf-y 0.
    const bottom = fieldRectToPdf(
        { xPct: 0, yPct: 0.95, wPct: 0.2, hPct: 0.05 },
        600,
        800,
    );
    assert.equal(bottom.y, 0, "bottom box → pdf-y 0");

    // Out-of-range fractions clamp to [0,1].
    const clamped = fieldRectToPdf(
        { xPct: 1.5, yPct: -1, wPct: 2, hPct: 0.1 },
        600,
        800,
    );
    assert.equal(clamped.x, 600, "xPct clamps to 1");
    assert.equal(clamped.w, 600, "wPct clamps to 1");
    assert.equal(clamped.y, 720, "yPct clamps to 0 → y = height - h");
}

async function testStampFields() {
    const base = await makeMinimalPdf();
    const fields: FieldStampInput[] = [
        {
            type: "signature",
            page: 0,
            xPct: 0.1,
            yPct: 0.8,
            wPct: 0.25,
            hPct: 0.05,
            name: "Dana Specimen",
            typedName: "Dana Specimen",
            signaturePng: null,
            signedAt: "2026-06-01T18:00:00.000Z",
        },
        {
            type: "date",
            page: 0,
            xPct: 0.6,
            yPct: 0.8,
            wPct: 0.2,
            hPct: 0.04,
            name: "Dana Specimen",
            typedName: null,
            signaturePng: null,
            signedAt: "2026-06-01T18:00:00.000Z",
        },
    ];
    const stamped = await stampSignatures(base, [], { fields });
    assert.ok(startsWithPdfHeader(stamped), "field-stamped output must be a PDF");
    const reloaded = await PDFDocument.load(stamped);
    assert.equal(reloaded.getPageCount(), 1);
    assert.ok(stamped.length > base.length, "stamping added content");
}

// classifyForPdf: the pure format-decision that guards ensurePdf. This is the
// regression net for the "cannot convert .unknown to PDF (filename: Clean Final)"
// bug — an extensionless version label must still convert via the file_type hint
// or a content sniff, instead of hard-failing.
function testClassifyForPdf() {
    const pdfBytes = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1");
    const zipBytes = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04 — DOCX/ODT container
        Buffer.from("rest of a zip"),
    ]);
    const oleBytes = Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // legacy .doc
        Buffer.from("rest of an ole file"),
    ]);
    const plainBytes = Buffer.from("just some bytes, not an office document");

    // %PDF magic → passthrough regardless of name.
    assert.equal(classifyForPdf(pdfBytes, "Clean Final"), "passthrough");
    // The reported bug: extensionless label, but file_type says docx → convert.
    assert.equal(classifyForPdf(plainBytes, "Clean Final", "docx"), "convert");
    assert.equal(classifyForPdf(plainBytes, "Clean Final", ".DOCX"), "convert");
    // Extensionless label, no file_type, but the bytes self-identify as a ZIP
    // (DOCX) / OLE (legacy .doc) container → convert via content sniff.
    assert.equal(classifyForPdf(zipBytes, "Clean Final"), "convert");
    assert.equal(classifyForPdf(oleBytes, "Clean Final", null), "convert");
    // A normal filename with a convertible extension → convert.
    assert.equal(classifyForPdf(zipBytes, "Letter of Intent.docx"), "convert");
    // Claims .pdf but lacks the header → passthrough (let the parser surface it).
    assert.equal(classifyForPdf(plainBytes, "report.pdf"), "passthrough");
    // Genuinely unidentifiable: unknown ext, no hint, non-office bytes → unsupported.
    assert.equal(classifyForPdf(plainBytes, "mystery.bin"), "unsupported");
    assert.equal(classifyForPdf(plainBytes, "noextension"), "unsupported");

    // Images (generated images saved as documents) → wrapped into a PDF, never
    // "unsupported". Detected by magic bytes first, then extension/file_type.
    const jpegBytes = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from("rest of a jpeg"),
    ]);
    assert.equal(classifyForPdf(ONE_BY_ONE_PNG, "banner"), "image"); // PNG magic, no ext
    assert.equal(classifyForPdf(jpegBytes, "photo"), "image"); // JPEG magic, no ext
    assert.equal(classifyForPdf(plainBytes, "banner.png"), "image"); // by extension
    assert.equal(classifyForPdf(plainBytes, "banner", "png"), "image"); // by file_type
    assert.equal(classifyForPdf(plainBytes, "photo.jpeg"), "image");
}

// ensurePdf must turn a real image into a real PDF (so image documents are
// previewable + signable) — the pdf-lib path is pure, so it runs here.
async function testEnsurePdfWrapsImage() {
    const fromExt = await ensurePdf({
        bytes: ONE_BY_ONE_PNG,
        filename: "An elegant minimalist invoice header banner - image.png",
        fileType: "png",
    });
    assert.ok(startsWithPdfHeader(fromExt), "PNG → PDF must begin with %PDF");
    const reloaded = await PDFDocument.load(fromExt);
    assert.equal(reloaded.getPageCount(), 1, "image PDF should be one page");

    // Extensionless label but PNG magic bytes → still wrapped (magic-byte path).
    const fromMagic = await ensurePdf({
        bytes: ONE_BY_ONE_PNG,
        filename: "Clean Final",
    });
    assert.ok(startsWithPdfHeader(fromMagic), "PNG magic → PDF even with no ext");

    // Corrupt image bytes claiming to be a png → clear error, not a silent hang.
    await assert.rejects(
        ensurePdf({ bytes: Buffer.from("not really a png"), filename: "x.png" }),
        /could not embed image/,
    );
}

// --- ensurePdf → LibreOffice wiring -------------------------------------
//
// The signature path (`ensurePdf`) and the upload path (`convertToPdf` in
// ../convert) are the only two ways into LibreOffice. They must prepare the
// bytes identically, or a document that converts on upload fails at signature
// time — which is exactly the drift these tests pin down.

let scratchDir = "";
/** Where the fake writes the basename of the file it was asked to convert. */
let recordPath = "";
/** A byte-for-byte copy of what the fake was actually handed. */
let seenInputPath = "";

/**
 * Write an executable stand-in for soffice. It parses `--outdir` and the
 * trailing input path the way the real binary does, records what it saw, then
 * writes a PDF named after the input's stem — the filename convention
 * `convertWithLibreOffice` reads the rendition back from.
 */
async function writeFakeSoffice(): Promise<string> {
    const scriptPath = path.join(scratchDir, "soffice-fake");
    const script = [
        "#!/bin/sh",
        'outdir=""; input=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    --outdir) outdir="$2"; shift 2 ;;',
        '    --convert-to) shift 2 ;;',
        "    -*) shift ;;",
        '    *) input="$1"; shift ;;',
        "  esac",
        "done",
        `basename "$input" > ${JSON.stringify(recordPath)}`,
        `cp "$input" ${JSON.stringify(seenInputPath)}`,
        "stem=$(basename \"$input\" | sed 's/\\.[^.]*$//')",
        `printf '%s\\n' '%PDF-1.4 fake soffice output' > "$outdir/$stem.pdf"`,
        "exit 0",
        "",
    ].join("\n");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await chmod(scriptPath, 0o755); // defeat a restrictive umask
    return scriptPath;
}

/** The basename soffice was handed, i.e. `input.<hint>`. */
async function recordedInputName(): Promise<string> {
    return (await readFile(recordPath, "utf-8")).trim();
}

/** Forget the last invocation, so "was the converter reached at all?" is answerable. */
async function clearRecord(): Promise<void> {
    await rm(recordPath, { force: true });
}

async function converterWasInvoked(): Promise<boolean> {
    return readFile(recordPath, "utf-8").then(
        () => true,
        () => false,
    );
}

/** Entry names inside the archive the fake actually received. */
async function seenZipEntryNames(): Promise<string[]> {
    const zip = await JSZip.loadAsync(await readFile(seenInputPath));
    const names: string[] = [];
    zip.forEach((relativePath) => names.push(relativePath));
    return names.sort();
}

/**
 * Build a .docx-shaped ZIP. With `separator: "\\"` the entry names use the
 * Windows backslash form some older Word builds emit (`word\document.xml`) —
 * LibreOffice looks entries up by exact string and fails to read those, which
 * is why both converter entry points must run `normalizeDocxZipPaths` first.
 */
async function makeDocxZip(separator: "/" | "\\"): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file(`_rels${separator}.rels`, "<Relationships/>");
    zip.file(`word${separator}document.xml`, "<w:document>Agreement</w:document>");
    return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * The format hint must reach the temp file soffice opens — from the filename
 * extension, from the stored file_type when the name has none, and from
 * neither when there is nothing to say (the converter's magic-byte sniff owns
 * that case; inventing an extension there would be a guess, not a hint).
 *
 * The cases below are chosen so the hint and the converter's sniff DISAGREE.
 * A .docx would prove nothing here: its bytes are a ZIP, which the sniff
 * already calls "docx", so that assertion would hold with or without the
 * threading this test exists to pin.
 */
async function testEnsurePdfThreadsFormatHint(): Promise<void> {
    const docx = await makeDocxZip("/");

    const fromFilename = await ensurePdf({
        bytes: docx,
        filename: "Master Services Agreement.docx",
    });
    assert.ok(
        startsWithPdfHeader(fromFilename),
        "ensurePdf must return the converter's PDF",
    );
    assert.equal(await recordedInputName(), "input.docx");

    // Plain text: the sniff has no magic bytes to go on and answers "bin".
    // Only the filename extension can name this format.
    await ensurePdf({
        bytes: Buffer.from("Termination notice.\nEffective immediately.\n"),
        filename: "notice.txt",
    });
    assert.equal(
        await recordedInputName(),
        "input.txt",
        "a .txt must be named as such; the content sniff cannot tell",
    );

    // ODT is a ZIP too, so the sniff would mislabel it "docx". The stored
    // file_type is the only thing that knows better — and this is the
    // extensionless-version-label case ("Clean Final") at the same time.
    await ensurePdf({
        bytes: docx,
        filename: "Clean Final",
        fileType: ".ODT",
    });
    assert.equal(
        await recordedInputName(),
        "input.odt",
        "file_type must supply the hint when the name has no extension",
    );

    // Nothing to go on but the bytes: no hint is passed and the converter's
    // own sniff recognises the ZIP container.
    await ensurePdf({ bytes: docx, filename: "Clean Final" });
    assert.equal(
        await recordedInputName(),
        "input.docx",
        "an extensionless, type-less document must still reach soffice sniffed as a docx",
    );
}

/**
 * A version `display_name` is a LABEL, not a filename — it routinely contains
 * dots that are not extensions ("Agreement v1.2", "MSA 2026.01.15"), and it is
 * user-editable via the rename endpoint (routes/documents.ts). The fragment
 * after the last dot must never be taken for a format hint: it would name the
 * temp file soffice opens (`input.2`) and shadow the stored `file_type`, which
 * is the column that actually knows the format.
 */
async function testEnsurePdfIgnoresDottedDisplayNames(): Promise<void> {
    const docx = await makeDocxZip("/");
    for (const displayName of [
        "Agreement v1.2", //                 → ".2"
        "Smith, J. Settlement Agreement", // → ".settlementagreement"
        "MSA 2026.01.15", //                 → ".15"
    ]) {
        await clearRecord();
        const converted = await ensurePdf({
            bytes: docx,
            filename: displayName,
            fileType: "docx",
        });
        assert.ok(
            startsWithPdfHeader(converted),
            `"${displayName}" must still convert`,
        );
        assert.equal(
            await recordedInputName(),
            "input.docx",
            `a dotted label ("${displayName}") must not shadow file_type "docx"`,
        );
    }
}

/**
 * The regression the drift caused. `convertToPdf` (upload) repairs
 * backslash-separated .docx entries; `ensurePdf` (signature) did not — so a
 * document that uploaded fine died at signature time with "This document
 * could not be converted to PDF."
 */
async function testEnsurePdfNormalizesBackslashDocx(): Promise<void> {
    const broken = await makeDocxZip("\\");
    // Guard the fixture itself: if JSZip ever stopped storing the backslash
    // literally, this test would pass while proving nothing.
    const brokenNames: string[] = [];
    (await JSZip.loadAsync(broken)).forEach((p) => brokenNames.push(p));
    assert.ok(
        brokenNames.includes("word\\document.xml"),
        `fixture is not backslash-separated: ${brokenNames.join(",")}`,
    );

    const converted = await ensurePdf({
        bytes: broken,
        filename: "Windows Export.docx",
    });
    assert.ok(
        startsWithPdfHeader(converted),
        "a backslash-path DOCX must still convert",
    );

    const seen = await seenZipEntryNames();
    assert.deepEqual(
        seen.filter((name) => name.includes("\\")),
        [],
        `soffice was handed backslash entries: ${seen.join(",")}`,
    );
    assert.ok(
        seen.includes("word/document.xml"),
        `expected a repaired word/document.xml, got: ${seen.join(",")}`,
    );
}

/**
 * `looksLikePdf` is exported so `loadSourceDocument` (routes/signatures.ts)
 * can validate a stored PDF rendition with the SAME predicate `ensurePdf`
 * classifies on, instead of duplicating the magic-byte check. Both halves of
 * that contract are pinned here: the predicate itself, and the passthrough it
 * is meant to unlock — rendition bytes handed back as fileType "pdf" must
 * reach the signing pipeline untouched, never re-converted.
 */
async function testRenditionPassthroughContract(): Promise<void> {
    const realPdf = await makeMinimalPdf();
    assert.equal(looksLikePdf(realPdf), true);
    assert.equal(looksLikePdf(await makeDocxZip("/")), false);
    assert.equal(looksLikePdf(Buffer.alloc(0)), false);
    // Truncated header: shorter than the magic, so the length guard matters.
    assert.equal(looksLikePdf(Buffer.from("%PD")), false);
    assert.equal(looksLikePdf(Buffer.from("not a pdf at all")), false);

    // The shape loadSourceDocument returns for a stored rendition.
    await clearRecord();
    const passed = await ensurePdf({
        bytes: realPdf,
        filename: "Clean Final",
        fileType: "pdf",
    });
    assert.ok(
        passed.equals(realPdf),
        "PDF rendition bytes must pass through ensurePdf byte-for-byte",
    );
    assert.equal(
        await converterWasInvoked(),
        false,
        "a stored PDF rendition must never be re-converted",
    );
}

/**
 * Run the LibreOffice-dependent tests against the fake, restoring the
 * environment afterwards so no later test inherits the override.
 */
async function withFakeSoffice(): Promise<void> {
    const previousBinary = process.env.SOFFICE_BINARY_PATH;
    // The converter builds its concurrency gate lazily from the environment;
    // pin it to the default so a developer's export cannot change what these
    // tests mean (or, at 0, hang them).
    const previousConcurrency = process.env.LIBREOFFICE_MAX_CONCURRENT;
    delete process.env.LIBREOFFICE_MAX_CONCURRENT;

    scratchDir = await mkdtemp(path.join(os.tmpdir(), "cocoa-sigpdf-test-"));
    recordPath = path.join(scratchDir, "record.txt");
    seenInputPath = path.join(scratchDir, "seen-input.bin");
    try {
        process.env.SOFFICE_BINARY_PATH = await writeFakeSoffice();
        await testEnsurePdfThreadsFormatHint();
        await testEnsurePdfIgnoresDottedDisplayNames();
        await testEnsurePdfNormalizesBackslashDocx();
        await testRenditionPassthroughContract();
    } finally {
        if (previousBinary === undefined)
            delete process.env.SOFFICE_BINARY_PATH;
        else process.env.SOFFICE_BINARY_PATH = previousBinary;
        if (previousConcurrency !== undefined)
            process.env.LIBREOFFICE_MAX_CONCURRENT = previousConcurrency;
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function main() {
    testPaddedDerPreservesContentZeros();
    const stamped = await testStampTypedNameSigner();
    await testStampMultipleSignersAutoStack();
    await testEmbedCryptographicSignature(stamped);
    await testEmbedWithChainedEnvCert(stamped);
    testFieldRectToPdf();
    await testStampFields();
    testClassifyForPdf();
    await testEnsurePdfWrapsImage();
    await withFakeSoffice();
    assert.deepEqual(signaturePlaceholderMetadata({}), {
        reason: "Document executed via Cocoa Legal e-signature",
        contactInfo: "",
        name: "Cocoa Legal Signing",
        location: "",
    });
    const configured = signaturePlaceholderMetadata({
        SIGNING_CONTACT_EMAIL: " signing@example.com ",
        SIGNING_LOCATION: "Example Law LLP",
    });
    assert.equal(configured.contactInfo, "signing@example.com");
    assert.equal(configured.location, "Example Law LLP");
    console.log("pdf.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
