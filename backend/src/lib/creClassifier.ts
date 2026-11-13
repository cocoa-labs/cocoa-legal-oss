// backend/src/lib/creClassifier.ts
//
// Deterministic (NO LLM) classifier that stamps a CRE document type onto an
// upload. Called best-effort from the upload pipeline (documentUpload.ts);
// the upload must never fail because classification failed, so the caller
// wraps this in try/catch and falls back to null.
//
// The phrase vocabulary is anchored to the shared CRE_DOCUMENT_HINTS in
// creProfiles.ts — every hint phrase is mapped to a doc-type here, so the
// classifier and the capability's intentSignals can never recognize
// different vocabularies. A small set of tighter disambiguators (e.g.
// "commitment for title insurance", "schedule b", "office lease",
// "promissory note") is layered on so the generic shared terms resolve to
// the right type.
//
// Every phrase must be SPECIFIC to the instrument it classifies. Bare
// "lease", bare "subordination" and bare "purchase and sale" used to live in
// the table and matched inside ordinary English and unrelated instruments
// ("please", "release notes", a subordinated loan, the purchase and sale of
// shares) — misclassifying non-CRE uploads. They are gone; the specific
// forms ("commercial lease", "office lease", "subordination,
// non-disturbance", "purchase and sale agreement") keep the recall.
//
// Matching is ordered specific-before-generic: a document that trips several
// phrases is classified by the most specific rule, not the first lexical
// hit. An estoppel certificate names the underlying lease, so "estoppel"
// must win over the lease rule; a PSA must win over a bare "agreement";
// title-commitment markers win over everything else.
//
// Matching runs over BOTH the lowercased filename and the lowercased first
// ~16KB of body text. We cap the body scan because the discriminating
// language (titles, recitals, defined terms) is at the top of these
// instruments, and scanning the whole document would be wasteful on large
// PDFs.

import { CRE_DOCUMENT_HINTS } from "./legalCapabilities/creProfiles";
import { matchesAnyPhrase } from "./legalCapabilities/intent";

/** Max bytes/chars of body text to scan. Discriminators live up top. */
const SCAN_LIMIT = 16 * 1024;

/** The kebab doc-types this classifier can assign. */
export type CreDocumentType =
    | "commercial-lease"
    | "estoppel-certificate"
    | "snda"
    | "purchase-and-sale-agreement"
    | "title-commitment"
    | "rent-roll"
    | "loan-agreement";

/**
 * Maps a shared CRE_DOCUMENT_HINTS phrase to the doc-type it signals. A hint
 * that is a useful lease-review signal but too weak to classify a document
 * type on its own (e.g. "cam", "co-tenancy" — these appear in many CRE docs
 * and would misclassify) is intentionally LEFT OUT of this map; the drift
 * guard below treats an unmapped hint as deliberately weak and skips it. The
 * map plus that guard are what keep the classifier and the capability's
 * intentSignals anchored to the same shared vocabulary.
 */
const HINT_TO_TYPE: Partial<Record<string, CreDocumentType>> = {
    "commercial lease": "commercial-lease",
    "estoppel certificate": "estoppel-certificate",
    "subordination, non-disturbance": "snda",
    "non-disturbance": "snda",
    "purchase and sale agreement": "purchase-and-sale-agreement",
    psa: "purchase-and-sale-agreement",
    "rent roll": "rent-roll",
    "title commitment": "title-commitment",
    snda: "snda",
    // NOTE: "cam" and "co-tenancy" are intentionally omitted — they are
    // lease-review signals (carried by the capability's intentSignals) but
    // too generic to classify a document type, so they map to nothing here.
};

/**
 * Ordered rule table. The FIRST rule whose any-phrase matches the combined
 * haystack wins, so order encodes specific-before-generic precedence. Each
 * rule's phrases are the shared hints that map to its type (via
 * HINT_TO_TYPE, asserted below) plus tighter disambiguators that resolve the
 * generic shared terms. Phrases are lowercased; the haystack is lowercased
 * once.
 */
const RULES: { type: CreDocumentType; phrases: string[] }[] = [
    // Title commitment first: markers ("schedule b", "commitment for title
    // insurance") are unambiguous and can co-occur with lease/PSA language.
    {
        type: "title-commitment",
        phrases: [
            "commitment for title insurance",
            "alta commitment",
            "schedule b",
            "title commitment",
        ],
    },
    // Estoppel before lease: an estoppel certificate quotes lease terms.
    {
        type: "estoppel-certificate",
        phrases: ["estoppel certificate", "estoppel"],
    },
    // SNDA before lease: subordination / non-disturbance reference the lease.
    // Bare "subordination" is deliberately absent — a subordinated loan or an
    // intercreditor subordination is not an SNDA.
    {
        type: "snda",
        phrases: [
            "subordination, non-disturbance",
            "non-disturbance and attornment",
            "non-disturbance",
            "snda",
        ],
    },
    // Rent roll before lease: a rent roll lists many leases.
    { type: "rent-roll", phrases: ["rent roll"] },
    // PSA before the generic lease/agreement bucket. Bare "purchase and sale"
    // is deliberately absent — it names the purchase and sale of shares,
    // futures, or goods just as readily as real property.
    {
        type: "purchase-and-sale-agreement",
        phrases: [
            "purchase and sale agreement",
            "agreement of purchase and sale",
            "psa",
        ],
    },
    // Loan documents before lease (collateral may be the leased premises).
    {
        type: "loan-agreement",
        phrases: [
            "loan agreement",
            "promissory note",
            "deed of trust",
            "mortgage and security agreement",
        ],
    },
    // Lease last among the document kinds. Every phrase names the instrument;
    // bare "lease" is deliberately absent (it matches inside "please" and
    // "release", and a car lease is not a CRE document).
    {
        type: "commercial-lease",
        phrases: [
            "commercial lease",
            "lease agreement",
            "office lease",
            "retail lease",
            "industrial lease",
            "ground lease",
        ],
    },
];

// Drift guard: every shared hint that maps to a type must be covered by some
// rule's phrase list (so the classifier truly recognizes the shared
// vocabulary). Runs once at module load; throws loudly in dev/test if a
// future edit to CRE_DOCUMENT_HINTS adds an unhandled phrase. Cheap and
// side-effect-free beyond the throw.
for (const hint of CRE_DOCUMENT_HINTS) {
    const mapped = HINT_TO_TYPE[hint];
    if (!mapped) continue; // intentionally unmapped (weak signal)
    const covered = RULES.some(
        (r) => r.type === mapped && r.phrases.includes(hint),
    );
    if (!covered) {
        throw new Error(
            `creClassifier: shared hint "${hint}" maps to "${mapped}" but no rule lists it; ` +
                `add it to the matching rule's phrases.`,
        );
    }
}

/**
 * Classify a document into a CRE document type, or null if no CRE rule
 * matches. Deterministic and side-effect-free.
 *
 * @param text     Extracted body text (may be empty). Only the first
 *                 ~16KB is scanned.
 * @param filename Original filename (may be empty).
 */
export function classifyCreDocumentType(
    text: string,
    filename: string,
): CreDocumentType | null {
    const body = (text ?? "").slice(0, SCAN_LIMIT);
    const name = filename ?? "";
    // Match against the filename and the body as two separate haystacks,
    // routed through the SHARED matcher (matchesAnyPhrase / countPhraseHits in
    // legalCapabilities/intent.ts) so the classifier and the chat router share
    // one definition of "does this phrase appear": short acronyms ("psa",
    // "snda") match only on a word boundary — so "gypsa_chart.pdf",
    // "topsail_report.pdf", and "the gypsam mineral deposit" no longer
    // misclassify — while multi-word phrases still match across normalized
    // separators (e.g. "Office_Commercial_Lease.pdf"). The shared matcher
    // normalizes (lowercase + collapse _-. and whitespace) internally, so we
    // pass the raw strings. RULES order still encodes specific-before-generic
    // precedence: the first rule with any matching phrase wins.
    const haystacks = [name, body];
    for (const rule of RULES) {
        if (matchesAnyPhrase(rule.phrases, haystacks)) {
            return rule.type;
        }
    }
    return null;
}
