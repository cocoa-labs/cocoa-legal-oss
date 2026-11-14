// Centralized upload-type constants for Cocoa Legal (frontend).
//
// SYNC: keep the document AND audio extension/MIME lists in lockstep with
// backend/src/lib/uploadTypes.ts. Both files must list the SAME sets so the
// macOS file picker's `accept=""` filter matches what the backend will
// actually accept on upload.
//
// If you add an extension or MIME here, also add it there (and vice versa).

/**
 * Every file extension Cocoa Legal accepts as a first-class document.
 * Matches backend/src/lib/uploadTypes.ts DOCUMENT_EXTENSIONS.
 */
export const DOCUMENT_EXTENSIONS: readonly string[] = [
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
];

/**
 * String for the `accept=""` attribute on `<input type="file">` for
 * document-only pickers (sidebar Add Doc, project doc upload, doc-review
 * explorer, tabular review modal, etc.).
 */
export const DOCUMENT_ACCEPT_ATTR: string = DOCUMENT_EXTENSIONS.map(
    (ext) => `.${ext}`,
).join(",");

/**
 * Image MIMEs accepted as vision-eligible chat attachments. These hit
 * the `/chat-attachments/images` endpoint and the `chat_attachments`
 * table (DB constraint: `kind='image'`).
 */
export const IMAGE_MIMES: readonly string[] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
];

/** String for `accept=""` when the input is image-only. */
export const IMAGE_ACCEPT_ATTR: string = IMAGE_MIMES.join(",");

/**
 * Max byte size for an image chat attachment (20 MB). Enforced client-side
 * for fast UX feedback and re-checked server-side in chatAttachments.ts.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Audio formats the Recordings feature accepts — the mic capture path
 * (webm/opus) plus the upload fallback for external recorders. Matches
 * backend/src/lib/uploadTypes.ts AUDIO_EXTENSIONS.
 */
export const AUDIO_EXTENSIONS: readonly string[] = [
    "mp3",
    "wav",
    "m4a",
    "webm",
    "ogg",
    "flac",
];

/**
 * Audio MIMEs accepted for a recording upload. Broader than one-per-extension
 * because browsers/OSes label the same formats inconsistently (e.g. wav as
 * audio/wav | audio/x-wav | audio/wave). Matches backend AUDIO_MIMES.
 */
export const AUDIO_MIMES: readonly string[] = [
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
];

/**
 * Max byte size for an audio upload (250 MB). Enforced client-side for fast
 * UX feedback and re-checked server-side by upload.ts (audioFileUpload).
 */
export const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

/**
 * String for `accept=""` on the recordings file picker — dot-extensions plus
 * MIMEs, mirroring CHAT_ACCEPT_ATTR's construction.
 */
export const AUDIO_ACCEPT_ATTR: string = [
    ...AUDIO_EXTENSIONS.map((ext) => `.${ext}`),
    ...AUDIO_MIMES,
].join(",");

/**
 * String for `accept=""` on the chat input — accepts both documents
 * (routed through the first-class document path) AND vision-eligible
 * images (routed through chat_attachments).
 */
export const CHAT_ACCEPT_ATTR: string = `${DOCUMENT_ACCEPT_ATTR},${IMAGE_ACCEPT_ATTR}`;

/** Extract the lowercase extension (without leading dot) from a filename. */
export function extractExtension(filename: string): string {
    if (!filename) return "";
    const lastDot = filename.lastIndexOf(".");
    if (lastDot <= 0) return "";
    return filename.slice(lastDot + 1).toLowerCase();
}

/** True if the File looks like one of our accepted document formats. */
export function isDocumentFile(file: File): boolean {
    return DOCUMENT_EXTENSIONS.includes(extractExtension(file.name));
}

/**
 * True if the File is one of our vision-eligible image formats. Checked
 * by MIME because browsers reliably set that for known image types.
 */
export function isImageFile(file: File): boolean {
    return IMAGE_MIMES.includes(file.type);
}

/**
 * True if the File looks like an accepted audio recording. Matches on
 * extension OR MIME: an uploaded file carries a reliable extension, while a
 * mic-captured Blob may carry only a MIME (e.g. audio/webm) with a generic
 * name.
 */
export function isAudioFile(file: File): boolean {
    return (
        AUDIO_EXTENSIONS.includes(extractExtension(file.name)) ||
        AUDIO_MIMES.includes(file.type)
    );
}

/** Human-readable list of accepted extensions for error/help text. */
export const DOCUMENT_EXTENSIONS_HUMAN: string = DOCUMENT_EXTENSIONS.slice()
    .sort()
    .join(", ");
