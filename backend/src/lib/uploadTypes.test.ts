import assert from "node:assert/strict";
import {
    AUDIO_EXTENSIONS,
    AUDIO_MIMES,
    DOCUMENT_EXTENSIONS,
    DOCUMENT_EXTENSIONS_LIST,
    IMAGE_MIMES,
    VISION_IMAGE_MIMES,
    MAX_AUDIO_BYTES,
    extractExtension,
    hasFullFeatureSet,
    isAllowedAudioExtension,
    isAllowedDocumentExtension,
    isAllowedImageMime,
    isVisionImageMime,
    mimeForAudioExtension,
    mimeForExtension,
    needsPdfConversion,
} from "./uploadTypes";

async function testExtractExtensionBasic() {
    assert.equal(extractExtension("Contract.docx"), "docx");
    assert.equal(extractExtension("Contract.DOCX"), "docx");
    assert.equal(extractExtension("a.b.c"), "c");
    assert.equal(extractExtension("Report.PDF"), "pdf");
}

async function testExtractExtensionEdgeCases() {
    assert.equal(extractExtension(""), "");
    assert.equal(extractExtension("noext"), "");
    assert.equal(extractExtension(".hidden"), ""); // dotfiles have no extension
    assert.equal(extractExtension("trailing."), "");
    assert.equal(extractExtension("Spread Sheet.xlsx"), "xlsx");
}

async function testTier1Extensions() {
    // Original first-class formats — must remain accepted
    for (const ext of ["pdf", "docx", "doc"]) {
        assert.ok(
            DOCUMENT_EXTENSIONS.has(ext),
            `Tier 1 extension missing: ${ext}`,
        );
        assert.ok(isAllowedDocumentExtension(`file.${ext}`));
    }
}

async function testTier2Extensions() {
    // New broader formats — every one of these should be accepted
    const tier2 = [
        "rtf",
        "odt",
        "xls",
        "xlsx",
        "ods",
        "csv",
        "ppt",
        "pptx",
        "odp",
        "html",
        "htm",
        "txt",
        "md",
        "epub",
    ];
    for (const ext of tier2) {
        assert.ok(
            DOCUMENT_EXTENSIONS.has(ext),
            `Tier 2 extension missing: ${ext}`,
        );
        assert.ok(isAllowedDocumentExtension(`file.${ext}`));
        // All Tier 2 formats need PDF conversion (only PDF is exempt)
        assert.ok(
            needsPdfConversion(ext),
            `Tier 2 ${ext} should need PDF conversion`,
        );
    }
}

async function testNeedsPdfConversion() {
    // PDF is its own rendition — no conversion
    assert.equal(needsPdfConversion("pdf"), false);
    assert.equal(needsPdfConversion("PDF"), false);
    assert.equal(needsPdfConversion(".pdf"), false);

    // All other accepted formats need conversion
    assert.equal(needsPdfConversion("docx"), true);
    assert.equal(needsPdfConversion("xlsx"), true);
    assert.equal(needsPdfConversion("md"), true);
    assert.equal(needsPdfConversion("html"), true);
    assert.equal(needsPdfConversion("txt"), true);

    // Unsupported types — should NOT need conversion (because we reject
    // them at the extension gate before reaching the converter)
    assert.equal(needsPdfConversion("zip"), false);
    assert.equal(needsPdfConversion("exe"), false);
    assert.equal(needsPdfConversion(""), false);
}

async function testRejectsUnsupportedExtensions() {
    assert.equal(isAllowedDocumentExtension("malware.exe"), false);
    assert.equal(isAllowedDocumentExtension("archive.zip"), false);
    assert.equal(isAllowedDocumentExtension("photo.gif"), false); // images go through different path
    assert.equal(isAllowedDocumentExtension("noext"), false);
    assert.equal(isAllowedDocumentExtension(""), false);
}

async function testImageMimes() {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
        assert.ok(IMAGE_MIMES.has(mime));
        assert.ok(isAllowedImageMime(mime));
    }

    for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
        assert.ok(VISION_IMAGE_MIMES.has(mime));
        assert.ok(isVisionImageMime(mime));
    }
    assert.equal(isVisionImageMime("image/gif"), false);
    assert.equal(isAllowedImageMime("image/tiff"), false);
    assert.equal(isAllowedImageMime("image/svg+xml"), false);
    assert.equal(isAllowedImageMime("application/pdf"), false);
    assert.equal(isAllowedImageMime(""), false);
}

async function testExtensionsListIsSorted() {
    // The error-message list should be deterministic
    const sorted = [...DOCUMENT_EXTENSIONS_LIST];
    const reSorted = [...sorted].sort();
    assert.deepEqual(sorted, reSorted);
    // Length matches the set
    assert.equal(DOCUMENT_EXTENSIONS_LIST.length, DOCUMENT_EXTENSIONS.size);
}

async function testHasFullFeatureSet() {
    // Tier 1 — full feature set
    assert.equal(hasFullFeatureSet("pdf"), true);
    assert.equal(hasFullFeatureSet("docx"), true);
    assert.equal(hasFullFeatureSet("doc"), true);
    assert.equal(hasFullFeatureSet("PDF"), true);
    assert.equal(hasFullFeatureSet(".pdf"), true);

    // Tier 2 — rendition-based viewing only
    for (const ext of [
        "xlsx",
        "pptx",
        "md",
        "html",
        "txt",
        "rtf",
        "odt",
        "csv",
        "epub",
    ]) {
        assert.equal(
            hasFullFeatureSet(ext),
            false,
            `${ext} should NOT have full feature set`,
        );
    }

    // Unknown
    assert.equal(hasFullFeatureSet("exe"), false);
    assert.equal(hasFullFeatureSet(""), false);
}

async function testMimeForExtension() {
    // Every accepted extension must map to a non-null MIME so callers
    // can derive Content-Type without falling back to octet-stream.
    for (const ext of [
        "pdf",
        "docx",
        "doc",
        "rtf",
        "odt",
        "xls",
        "xlsx",
        "ods",
        "csv",
        "ppt",
        "pptx",
        "odp",
        "html",
        "htm",
        "txt",
        "md",
        "epub",
    ]) {
        const mime = mimeForExtension(ext);
        assert.ok(
            mime !== null,
            `mimeForExtension(${JSON.stringify(ext)}) returned null`,
        );
        assert.ok(
            typeof mime === "string" && mime.includes("/"),
            `mimeForExtension(${JSON.stringify(ext)}) returned invalid MIME ${JSON.stringify(mime)}`,
        );
    }

    // Spot-check a few canonical values
    assert.equal(mimeForExtension("pdf"), "application/pdf");
    assert.equal(
        mimeForExtension("docx"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(
        mimeForExtension("xlsx"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    assert.equal(mimeForExtension("md"), "text/markdown");
    assert.equal(mimeForExtension("html"), "text/html");
    assert.equal(mimeForExtension("htm"), "text/html");

    // Tolerant input
    assert.equal(mimeForExtension("PDF"), "application/pdf");
    assert.equal(mimeForExtension(".pdf"), "application/pdf");

    // Image artifacts (generated images saved as documents) — must resolve so
    // /display serves image/* and the viewer renders them instead of the DOCX
    // fallback. Regression net for the "not a valid Word (.docx)" preview bug.
    assert.equal(mimeForExtension("png"), "image/png");
    assert.equal(mimeForExtension("PNG"), "image/png");
    assert.equal(mimeForExtension("jpg"), "image/jpeg");
    assert.equal(mimeForExtension("jpeg"), "image/jpeg");
    assert.equal(mimeForExtension("webp"), "image/webp");
    assert.equal(mimeForExtension("gif"), "image/gif");

    // Unknown → null
    assert.equal(mimeForExtension("exe"), null);
    assert.equal(mimeForExtension(""), null);
}

async function testAudioExtensions() {
    // Every audio format the recordings feature accepts (mic + upload fallback).
    for (const ext of ["mp3", "wav", "m4a", "webm", "ogg", "flac"]) {
        assert.ok(AUDIO_EXTENSIONS.has(ext), `Audio extension missing: ${ext}`);
        assert.ok(isAllowedAudioExtension(`clip.${ext}`));
        assert.ok(
            isAllowedAudioExtension(`CLIP.${ext.toUpperCase()}`),
            `case-insensitive: CLIP.${ext.toUpperCase()}`,
        );
    }
}

async function testRejectsNonAudioExtensions() {
    // Documents, images, and junk must never be treated as audio.
    for (const name of [
        "brief.pdf",
        "notes.txt",
        "deck.pptx",
        "photo.png",
        "malware.exe",
        "noext",
        "",
    ]) {
        assert.equal(
            isAllowedAudioExtension(name),
            false,
            `should reject ${JSON.stringify(name)}`,
        );
    }
}

async function testMimeForAudioExtension() {
    // Canonical, server-trusted MIME per accepted extension.
    assert.equal(mimeForAudioExtension("mp3"), "audio/mpeg");
    assert.equal(mimeForAudioExtension("wav"), "audio/wav");
    assert.equal(mimeForAudioExtension("m4a"), "audio/mp4");
    assert.equal(mimeForAudioExtension("webm"), "audio/webm");
    assert.equal(mimeForAudioExtension("ogg"), "audio/ogg");
    assert.equal(mimeForAudioExtension("flac"), "audio/flac");

    // Tolerant input (case + leading dot), mirroring mimeForExtension.
    assert.equal(mimeForAudioExtension("MP3"), "audio/mpeg");
    assert.equal(mimeForAudioExtension(".wav"), "audio/wav");

    // Non-audio → null so callers fall back explicitly.
    assert.equal(mimeForAudioExtension("pdf"), null);
    assert.equal(mimeForAudioExtension("exe"), null);
    assert.equal(mimeForAudioExtension(""), null);

    // Every accepted extension maps to a non-null audio/* MIME that is itself
    // a member of the accepted-mime set.
    for (const ext of AUDIO_EXTENSIONS) {
        const mime = mimeForAudioExtension(ext);
        assert.ok(
            typeof mime === "string" && mime.startsWith("audio/"),
            `mimeForAudioExtension(${JSON.stringify(ext)}) should be an audio/* MIME, got ${JSON.stringify(mime)}`,
        );
        assert.ok(
            AUDIO_MIMES.has(mime as string),
            `canonical MIME ${JSON.stringify(mime)} missing from AUDIO_MIMES`,
        );
    }
}

async function testMaxAudioBytes() {
    // 250 MB — covers ~4.5 h of 128 kbps MP3; the mic path is far under it.
    assert.equal(MAX_AUDIO_BYTES, 250 * 1024 * 1024);
}

async function testAudioSetsDisjointFromDocumentAndImage() {
    // Audio must NOT enter the document path (it would hit LibreOffice → PDF).
    for (const ext of AUDIO_EXTENSIONS) {
        assert.ok(
            !DOCUMENT_EXTENSIONS.has(ext),
            `audio extension ${ext} must NOT be a document extension`,
        );
        assert.equal(
            needsPdfConversion(ext),
            false,
            `audio ${ext} must not route to PDF conversion`,
        );
    }
    // Audio MIMEs must NOT be treated as vision-eligible images.
    for (const mime of AUDIO_MIMES) {
        assert.ok(
            !IMAGE_MIMES.has(mime),
            `audio MIME ${mime} must NOT be an image MIME`,
        );
    }
}

async function main() {
    await testExtractExtensionBasic();
    await testExtractExtensionEdgeCases();
    await testTier1Extensions();
    await testTier2Extensions();
    await testNeedsPdfConversion();
    await testRejectsUnsupportedExtensions();
    await testImageMimes();
    await testExtensionsListIsSorted();
    await testHasFullFeatureSet();
    await testMimeForExtension();
    await testAudioExtensions();
    await testRejectsNonAudioExtensions();
    await testMimeForAudioExtension();
    await testMaxAudioBytes();
    await testAudioSetsDisjointFromDocumentAndImage();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
