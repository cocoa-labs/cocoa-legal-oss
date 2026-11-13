// backend/src/lib/creAbstractFormat.ts
//
// Pure formatting helpers for the CRE lease-abstract DOCX export
// (routes/tabular.ts → POST /tabular-review/:reviewId/export-docx). Kept
// dependency-free so they can be unit-tested in the backend tsx test style.
//
// Tabular cell summaries carry inline citation markers in the form
// `[[page:N||quote:verbatim excerpt]]` and bracket "pill" markers like
// `[[Yes]]`. For a Word memo we want a clean prose value with the markers
// stripped, plus (optionally) the first citation rendered as a readable
// reference.

/** Human label for a cell flag, shown in the memo's Flag column. */
export const CRE_DOCX_FLAG_LABEL: Record<string, string> = {
    green: "Market",
    yellow: "Review",
    red: "Deal-breaker",
    grey: "Not stated",
};

const CITATION_RE =
    /\[\[page:(\d+)\|\|(?:quote:)?((?:[^[\]]|\[[^\]]*\])+)\]\]/i;

/**
 * Strip inline `[[page:N||quote:...]]` citation markers and bracket pill
 * markers (`[[Yes]]` → `Yes`) from a cell summary, collapsing whitespace.
 * Returns a clean value suitable for a document table cell.
 */
export function cleanSummaryForDocx(summary: string | undefined | null): string {
    if (!summary) return "";
    return summary
        .replace(/\[\[page:\d+\|\|(?:quote:)?(?:[^[\]]|\[[^\]]*\])+\]\]/gi, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

/**
 * Render the first page citation in a summary as `p. N — "quote"`, or an empty
 * string when there is none. Used for the memo's Citation column.
 */
export function firstCitationForDocx(
    summary: string | undefined | null,
): string {
    if (!summary) return "";
    const m = summary.match(CITATION_RE);
    if (!m) return "";
    const quote = m[2].trim();
    return quote ? `p. ${m[1]} — "${quote}"` : `p. ${m[1]}`;
}
