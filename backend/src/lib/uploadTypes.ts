// Centralized upload-type constants for Coco Legal.
//
// SYNC: keep the document AND audio extension/MIME lists in lockstep with
// frontend/src/app/lib/uploadTypes.ts. If you add/remove an extension or MIME
// here, also update the frontend module (and vice versa) so the macOS file
// picker's accept filter matches what the backend will actually accept.

/**
 * Every file extension Coco Legal accepts as a first-class document.
 *
 * - Tier 1 (full feature set): pdf, docx, doc — tracked changes,
 *   highlights, citation page mapping, etc.
 * - Tier 2 (LibreOffice → PDF rendition for viewing): everything else.
 *
 * Image chat attachments are handled separately by `chat_attachments`
 * (see IMAGE_MIMES below) and are NOT in this set.
 */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
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
]);

/** Stable sorted list for use in error messages. */
export const DOCUMENT_EXTENSIONS_LIST: readonly string[] = Array.from(
    DOCUMENT_EXTENSIONS,
).sort();

/**
 * MIME types accepted as vision-eligible chat attachments. These land in
 * the `chat_attachments` table (DB constraint: kind='image') and are
 * passed inline to vision-capable LLMs. Keep this list in sync with
 * what the underlying models actually accept — Claude/Gemini/OpenAI all
 * support PNG/JPEG/WebP.
 */
export const IMAGE_MIMES: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
]);

/** Formats that current model providers accept as visual input. */
export const VISION_IMAGE_MIMES: ReadonlySet<string> = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
]);

/**
 * Max byte size for an image chat attachment (20 MB). Enforced server-side
 * in chatAttachments.ts and mirrored client-side in the frontend
 * uploadTypes module for fast UX feedback.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Every file extension the Recordings feature accepts as audio — the mic
 * capture path (webm/opus) plus the upload fallback for external recorders.
 * Kept strictly disjoint from DOCUMENT_EXTENSIONS so audio never routes into
 * the LibreOffice → PDF conversion path.
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
    "mp3",
    "wav",
    "m4a",
    "webm",
    "ogg",
    "flac",
]);

/**
 * MIME types accepted for an audio upload. Broader than the canonical
 * per-extension MIMEs below because browsers and OSes label the same formats
 * inconsistently (e.g. wav as audio/wav | audio/x-wav | audio/wave). Used for
 * the file-picker accept attribute and the client-side isAudioFile check; the
 * server derives the STORED Content-Type from the trusted extension via
 * mimeForAudioExtension, never from this set. Kept disjoint from IMAGE_MIMES.
 */
export const AUDIO_MIMES: ReadonlySet<string> = new Set([
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/webm",
    "audio/ogg",
    "audio/flac",
    "audio/x-flac",
]);

/**
 * Max byte size for an audio upload (250 MB). webm/opus mic captures are
 * ~28 MB/h so they never approach it; 250 MB covers ~4.5 h of 128 kbps MP3
 * from an external recorder. Enforced by the dedicated multer instance in
 * upload.ts (audioFileUpload) and mirrored client-side for fast UX feedback.
 */
export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

/**
 * Extract the lowercase extension (without leading dot) from a filename.
 * Returns "" if there is no extension or the filename is malformed.
 *
 * Examples:
 *   extractExtension("Contract.DOCX") === "docx"
 *   extractExtension("notes")          === ""
 *   extractExtension(".hidden")        === ""    // dotfile, no real ext
 *   extractExtension("a.b.c")          === "c"
 */
export function extractExtension(filename: string): string {
    if (!filename) return "";
    const lastDot = filename.lastIndexOf(".");
    if (lastDot <= 0) return ""; // 0 means dotfile like ".env", -1 means no dot
    return filename.slice(lastDot + 1).toLowerCase();
}

/** True if `filename` ends with one of our accepted document extensions. */
export function isAllowedDocumentExtension(filename: string): boolean {
    return DOCUMENT_EXTENSIONS.has(extractExtension(filename));
}

/** True if `mime` is one of our accepted image MIME types. */
export function isAllowedImageMime(mime: string): boolean {
    return IMAGE_MIMES.has(mime);
}

export function isVisionImageMime(mime: string): boolean {
    return VISION_IMAGE_MIMES.has(mime);
}

/** Detect a supported raster format from trusted file-signature bytes. */
export function sniffRasterImageMime(
    bytes: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
    if (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
    )
        return "image/png";
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    )
        return "image/jpeg";
    if (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
    )
        return "image/webp";
    if (
        bytes.length >= 6 &&
        (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
            bytes.subarray(0, 6).toString("ascii") === "GIF89a")
    )
        return "image/gif";
    return null;
}

/** True if `filename` ends with one of our accepted audio extensions. */
export function isAllowedAudioExtension(filename: string): boolean {
    return AUDIO_EXTENSIONS.has(extractExtension(filename));
}

/**
 * True if an uploaded document needs LibreOffice conversion to produce a
 * viewable PDF rendition. Only PDFs are exempt — the PDF is its own
 * rendition. Everything else (DOCX, XLSX, PPTX, HTML, MD, TXT, etc.)
 * gets routed through `convertToPdf` so the doc-review workspace has
 * something to display.
 */
export function needsPdfConversion(extension: string): boolean {
    const ext = extension.toLowerCase().replace(/^\./, "");
    if (ext === "pdf") return false;
    return DOCUMENT_EXTENSIONS.has(ext);
}

/**
 * True for the three Tier 1 formats that have first-class native
 * handling end-to-end (own viewer, mammoth body extraction, native
 * tracked changes, native highlights). Tier 2 formats are viewable
 * only through their PDF rendition and have no native editing path.
 *
 * Use this discriminator in:
 *   - documentExtraction.ts to decide raw-vs-rendition source.
 *   - any code that wants to gate a DOCX/PDF-only feature.
 */
export function hasFullFeatureSet(fileType: string): boolean {
    const ext = fileType.toLowerCase().replace(/^\./, "");
    return ext === "pdf" || ext === "docx" || ext === "doc";
}

/**
 * Canonical IANA MIME type for each accepted document extension.
 * Used at every storage-write site to derive Content-Type from the
 * trusted server-side suffix rather than the browser-supplied
 * `file.mimetype` (which an attacker can spoof in a multipart upload).
 *
 * Returns null for extensions not in DOCUMENT_EXTENSIONS so callers can
 * fall back explicitly. Callers should prefer this value over
 * `file.mimetype` and use `file.mimetype` only as a last resort.
 */
export function mimeForExtension(extension: string): string | null {
    const ext = extension.toLowerCase().replace(/^\./, "");
    switch (ext) {
        case "pdf":
            return "application/pdf";
        case "docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "doc":
            return "application/msword";
        case "rtf":
            return "application/rtf";
        case "odt":
            return "application/vnd.oasis.opendocument.text";
        case "xls":
            return "application/vnd.ms-excel";
        case "xlsx":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        case "ods":
            return "application/vnd.oasis.opendocument.spreadsheet";
        case "csv":
            return "text/csv";
        case "ppt":
            return "application/vnd.ms-powerpoint";
        case "pptx":
            return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        case "odp":
            return "application/vnd.oasis.opendocument.presentation";
        case "html":
        case "htm":
            return "text/html";
        case "txt":
            return "text/plain";
        case "md":
            return "text/markdown";
        case "epub":
            return "application/epub+zip";
        // Image artifacts (generated images saved as documents). Serving these
        // with the right MIME lets the doc viewer render them as images instead
        // of falling through to the DOCX viewer.
        case "png":
            return "image/png";
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "webp":
            return "image/webp";
        case "gif":
            return "image/gif";
        default:
            return null;
    }
}

/**
 * Canonical IANA MIME type for each accepted audio extension. Like
 * mimeForExtension, this derives the STORED Content-Type from the trusted
 * server-side suffix rather than the browser-supplied `file.mimetype` (which a
 * multipart upload can spoof). Returns null for non-audio extensions so
 * callers fall back explicitly.
 */
export function mimeForAudioExtension(extension: string): string | null {
    const ext = extension.toLowerCase().replace(/^\./, "");
    switch (ext) {
        case "mp3":
            return "audio/mpeg";
        case "wav":
            return "audio/wav";
        case "m4a":
            return "audio/mp4";
        case "webm":
            return "audio/webm";
        case "ogg":
            return "audio/ogg";
        case "flac":
            return "audio/flac";
        default:
            return null;
    }
}
