// backend/src/lib/piClassifier.ts
//
// Deterministic (NO LLM) classifier that stamps a Personal Injury document
// type onto an upload. Called best-effort from the upload pipeline
// (documentUpload.ts) as the FALLBACK behind the CRE classifier — the CRE
// result wins first, and this classifier only runs when CRE returned null,
// so existing CRE behavior is unchanged. The upload must never fail because
// classification failed; the caller wraps the whole classification step in
// try/catch and falls back to null.
//
// The phrase vocabulary is anchored to the shared PI_DOCUMENT_HINTS in
// piProfiles.ts — every hint phrase that is strong enough to classify is
// mapped to a doc-type here, so the classifier and the capabilities'
// intentSignals can never recognize different vocabularies. A small set of
// tighter disambiguators (e.g. "declarations page", "time limited demand",
// "example case funding", "adjuster") is layered on so the generic shared
// terms resolve to the right type.
//
// Matching is ordered specific-before-generic: a document that trips
// several phrases is classified by the most specific rule, not the first
// lexical hit. A policy-limits demand asks for the declaration page, so the
// demand must win over "declaration page"; an adjuster letter mentions the
// medical invoices it requests, so claim correspondence must win over the
// bare "invoice" fallback; vendor-specific markers (ChartExample, SampleRecords,
// legal funding) win over the correspondence bucket because records/funding
// invoices routinely carry claim and case references.
//
// Matching runs over BOTH the lowercased filename and the lowercased first
// ~16KB of body text. We cap the body scan because the discriminating
// language (letterheads, subject lines, coverage tables) is at the top of
// these documents, and scanning the whole document would be wasteful on
// large PDFs.

import { PI_DOCUMENT_HINTS } from "./legalCapabilities/piProfiles";
import { matchesAnyPhrase } from "./legalCapabilities/intent";

/** Max bytes/chars of body text to scan. Discriminators live up top. */
const SCAN_LIMIT = 16 * 1024;

/** The kebab doc-types this classifier can assign. */
export type PiDocumentType =
    | "declaration-page"
    | "policy-limits-demand"
    | "vendor-invoice"
    | "insurance-correspondence";

/**
 * Maps a shared PI_DOCUMENT_HINTS phrase to the doc-type it signals. A hint
 * that is a useful PI intent signal but too weak to classify a document
 * type on its own (e.g. "policy limits" — it appears in declaration pages,
 * demands, and funding invoices alike) is intentionally LEFT OUT of this
 * map; the drift guard below treats an unmapped hint as deliberately weak
 * and skips it. The map plus that guard are what keep the classifier and
 * the capabilities' intentSignals anchored to the same shared vocabulary.
 */
const HINT_TO_TYPE: Partial<Record<string, PiDocumentType>> = {
    "declaration page": "declaration-page",
    "dec page": "declaration-page",
    "policy limit demand": "policy-limits-demand",
    "letter of representation": "insurance-correspondence",
    "claim number": "insurance-correspondence",
    uim: "insurance-correspondence",
    "um/uim": "insurance-correspondence",
    "bodily injury": "insurance-correspondence",
    invoice: "vendor-invoice",
    "legal funding": "vendor-invoice",
    chartexample: "vendor-invoice",
    samplerecords: "vendor-invoice",
    "medical records invoice": "vendor-invoice",
    // NOTE: "policy limits" is intentionally omitted — it is an intent
    // signal (carried by the capabilities' intentSignals) but too generic to
    // classify a document type, so it maps to nothing here.
};

/**
 * Ordered rule table. The FIRST rule whose any-phrase matches the combined
 * haystack wins, so order encodes specific-before-generic precedence. Each
 * rule's phrases are the shared hints that map to its type (via
 * HINT_TO_TYPE, asserted below) plus tighter disambiguators that resolve
 * the generic shared terms. A type may appear in more than one rule: the
 * vendor-specific invoice markers rank ABOVE the correspondence bucket,
 * while the bare "invoice" fallback ranks BELOW it (an adjuster letter that
 * mentions invoices is correspondence; an invoice naming its vendor is an
 * invoice). Phrases are lowercased; the shared matcher normalizes the
 * haystacks.
 */
const RULES: { type: PiDocumentType; phrases: string[] }[] = [
    // Policy-limits demand first: a demand routinely requests the dec page
    // and itemizes medical invoices, so it must outrank both.
    {
        type: "policy-limits-demand",
        phrases: [
            "policy limit demand",
            "policy limits demand",
            "time limited demand",
            "demand for policy limits",
            "demand for the policy limits",
        ],
    },
    // Declaration page: unambiguous coverage-evidence markers.
    {
        type: "declaration-page",
        phrases: ["declaration page", "declarations page", "dec page"],
    },
    // Vendor-specific invoice markers before the correspondence bucket:
    // records/funding invoices carry claim and case references, so the
    // vendor name must win over "claim number".
    {
        type: "vendor-invoice",
        phrases: [
            "chartexample",
            "samplerecords",
            "legal funding",
            "example case funding",
            "medical records invoice",
            "records invoice",
        ],
    },
    // Claim correspondence before the bare-"invoice" fallback: adjuster
    // letters mention the invoices/bills they request or acknowledge.
    {
        type: "insurance-correspondence",
        phrases: [
            "letter of representation",
            "claim number",
            "um/uim",
            "uim",
            "bodily injury",
            "adjuster",
        ],
    },
    // Generic invoice last among the document kinds.
    { type: "vendor-invoice", phrases: ["invoice"] },
];

// Drift guard: every shared hint that maps to a type must be covered by some
// rule's phrase list (so the classifier truly recognizes the shared
// vocabulary). Runs once at module load; throws loudly in dev/test if a
// future edit to PI_DOCUMENT_HINTS adds an unhandled phrase. Cheap and
// side-effect-free beyond the throw.
for (const hint of PI_DOCUMENT_HINTS) {
    const mapped = HINT_TO_TYPE[hint];
    if (!mapped) continue; // intentionally unmapped (weak signal)
    const covered = RULES.some(
        (r) => r.type === mapped && r.phrases.includes(hint),
    );
    if (!covered) {
        throw new Error(
            `piClassifier: shared hint "${hint}" maps to "${mapped}" but no rule lists it; ` +
                `add it to the matching rule's phrases.`,
        );
    }
}

/**
 * Classify a document into a Personal Injury document type, or null if no
 * PI rule matches. Deterministic and side-effect-free. Mirrors
 * classifyCreDocumentType — same signature, same shared matcher
 * (matchesAnyPhrase in legalCapabilities/intent.ts), so short acronyms
 * ("uim") match only on a word boundary while multi-word phrases match
 * across normalized separators (e.g. "ExampleMutual_Dec_Page.pdf").
 *
 * @param text     Extracted body text (may be empty). Only the first
 *                 ~16KB is scanned.
 * @param filename Original filename (may be empty).
 */
export function classifyPiDocumentType(
    text: string,
    filename: string,
): PiDocumentType | null {
    const body = (text ?? "").slice(0, SCAN_LIMIT);
    const name = filename ?? "";
    const haystacks = [name, body];
    for (const rule of RULES) {
        if (matchesAnyPhrase(rule.phrases, haystacks)) {
            return rule.type;
        }
    }
    return null;
}
