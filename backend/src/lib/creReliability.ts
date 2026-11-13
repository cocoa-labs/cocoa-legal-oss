// backend/src/lib/creReliability.ts
//
// Pure, dependency-free reliability helpers for the CRE tabular review
// path. Extracted from tabular.ts (mirroring creAbstractFormat.ts) so
// they can be unit-tested without standing up Express, Supabase, or the
// LLM client. No imports here on purpose — keep this module free of side
// effects.
//
// Two reliability rails live here:
//   1. truncateForExtraction — the document text fed to the extraction
//      LLM is hard-capped at a fixed character limit. Long PSAs / ALTA
//      title commitments keep their exhibits and Schedule B exception
//      lists at the TAIL, so a truncated abstract can look complete but
//      silently drop the highest-risk content. This makes the cut visible
//      rather than silent.
//   2. emptyExtractionReason — a scanned / image-only PDF yields empty
//      pdfjs text. The empty-extraction guard already red-flags the cell;
//      this produces a DISTINGUISHED reason for that case so the user
//      learns Coco Legal can't OCR, instead of the generic "empty content".

/**
 * Maximum number of characters of document text sent to the extraction
 * LLM. This is the long-standing hard limit at the tabular call sites —
 * exported so the truncation advisory and the limit stay in lockstep.
 */
export const EXTRACTION_CHAR_LIMIT = 120_000;

/**
 * Cap document text at EXTRACTION_CHAR_LIMIT for the extraction prompt,
 * reporting whether the cut happened and how many characters were dropped.
 * Under the limit, the text passes through byte-for-byte and `truncated`
 * is false (so non-truncated docs are completely unaffected).
 */
export function truncateForExtraction(text: string): {
    text: string;
    truncated: boolean;
    droppedChars: number;
} {
    if (text.length <= EXTRACTION_CHAR_LIMIT) {
        return { text, truncated: false, droppedChars: 0 };
    }
    return {
        text: text.slice(0, EXTRACTION_CHAR_LIMIT),
        truncated: true,
        droppedChars: text.length - EXTRACTION_CHAR_LIMIT,
    };
}

/**
 * Deterministic advisory appended to an affected cell's reasoning when its
 * source document was truncated. Surfaces in the result card and the XLSX
 * export via the same `reasoning` field the empty-extraction guard uses.
 */
export function truncationAdvisory(droppedChars: number): string {
    return `⚠ Source truncated at ${EXTRACTION_CHAR_LIMIT.toLocaleString(
        "en-US",
    )} chars (~${droppedChars.toLocaleString(
        "en-US",
    )} chars / late sections not analyzed) — verify late-document provisions (exhibits, schedules, exception lists).`;
}

/**
 * Additive, truncation-only system-prompt instruction. Conditionally
 * appended to the extraction system prompt so the model flags potentially
 * incomplete answers and biases late-appearing fields toward a cautious
 * "yellow". Never appended for non-truncated documents — behaviour for
 * in-limit docs is unchanged.
 */
export const TRUNCATION_SYSTEM_SUFFIX = `

IMPORTANT — the document text below was truncated to a fixed character limit, so its LATE sections (exhibits, schedules, exception lists, signature pages) may be missing. When an answer depends on content that typically appears late in such documents and you cannot find it, note in "reasoning" that the source was truncated and the answer may be incomplete, and prefer a cautious "yellow" flag over "green" for those fields.`;

/**
 * Reason string for the empty-extraction guard. When the file is a PDF and
 * extraction came back empty, the PDF is almost certainly scanned /
 * image-only (no selectable text), so we tell the user Coco Legal can't OCR.
 * Every other (genuinely-empty, non-PDF) case keeps the generic message.
 */
export function emptyExtractionReason(fileType: string | null | undefined): string {
    if ((fileType ?? "").trim().toLowerCase() === "pdf") {
        return "This PDF appears to be scanned/image-only (no selectable text). Read the document in chat to extract the scanned pages. Native text extraction alone is incomplete.";
    }
    return "Document extraction returned empty content — answer may be unreliable.";
}
