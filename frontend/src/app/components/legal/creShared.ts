"use client";

import type { UnifiedRiskBand } from "./RiskBadge";
import type { ColumnConfig, TabularCell, TabularReview } from "../shared/types";

/**
 * The eight built-in Commercial Real Estate (CRE) workflow ids that make up
 * the CRE practice suite. Four tabular abstraction packs plus four assistant
 * summaries. Kept in one place so the gallery grouping (WorkflowList) and the
 * CRE result-card gating (CreReviewCard / TRView) share a single source of
 * truth. See builtinWorkflows.ts for the workflow definitions themselves.
 */
export const CRE_WORKFLOW_IDS = [
    // Tabular abstraction packs
    "builtin-us-commercial-lease",
    "builtin-cre-estoppel",
    "builtin-cre-snda",
    "builtin-cre-psa",
    // Assistant summaries
    "builtin-cre-title-summary",
    "builtin-cre-loi-summary",
    "builtin-cre-loan-summary",
    "builtin-cre-ccr-summary",
] as const;

export const CRE_WORKFLOW_ID_SET: ReadonlySet<string> = new Set(
    CRE_WORKFLOW_IDS,
);

/**
 * The UK commercial lease pack is also practice "Real Estate" and is grouped
 * under the CRE section in the gallery (it's a lease pack). It has its own US
 * sibling, so it gets its own constant rather than living in the canonical
 * CRE-suite id list above.
 */
export const UK_COMMERCIAL_LEASE_ID = "builtin-commercial-lease";

/** Ids surfaced under the gallery's "Commercial Real Estate" section. */
export const CRE_GALLERY_ID_SET: ReadonlySet<string> = new Set([
    ...CRE_WORKFLOW_IDS,
    UK_COMMERCIAL_LEASE_ID,
]);

/**
 * Maps a backend legal-capability id (the registry id the chat intent router
 * proposes, e.g. "cre-review" from
 * backend/src/lib/legalCapabilities/commercialRealEstate.ts) to the front-end
 * built-in workflow the gallery launches for it. The CRE capability's tabular
 * column set is the US Commercial Lease abstraction, so a proposed cre-review
 * launches the `builtin-us-commercial-lease` pack. Returns null for an unknown
 * capability so callers can no-op rather than launch the wrong workflow.
 */
const CAPABILITY_TO_WORKFLOW_ID: Record<string, string> = {
    "cre-review": "builtin-us-commercial-lease",
};

export function capabilityIdToWorkflowId(
    capabilityId: string,
): string | null {
    return CAPABILITY_TO_WORKFLOW_ID[capabilityId] ?? null;
}

/**
 * Distinctive column names that identify the CRE lease-abstraction packs.
 * Used as the fallback CRE signal when a review has no source workflow id
 * (e.g. a review built by hand or copied). These names are specific to the
 * CRE packs in builtinWorkflows.ts and don't collide with the generic
 * commercial/credit packs.
 */
const CRE_COLUMN_SIGNALS = [
    "premises & rsf",
    "lease type",
    "rent escalations",
    "cam / operating expenses",
    "snda required",
    "estoppel required",
];

/**
 * A tabular review is treated as a CRE review when it was created from one of
 * the CRE workflows — the persisted `workflow_id` (the only origin linkage the
 * review carries; there is no `practice` column on a review). As a fallback for
 * reviews with no/unknown `workflow_id`, we sniff the column set for the CRE
 * lease-abstraction signals above.
 */
export function isCreReview(
    review: Pick<TabularReview, "workflow_id" | "columns_config">,
): boolean {
    if (
        review.workflow_id &&
        (CRE_WORKFLOW_ID_SET.has(review.workflow_id) ||
            review.workflow_id === UK_COMMERCIAL_LEASE_ID)
    ) {
        return true;
    }
    const names = (review.columns_config ?? []).map((c) =>
        c.name.toLowerCase(),
    );
    return CRE_COLUMN_SIGNALS.some((sig) => names.includes(sig));
}

/**
 * The represented-party choice offered for a CRE pack at configure time, plus
 * the default option. The option set depends on the document type: a
 * purchase-and-sale agreement is Buyer/Seller; every lease-family pack (US/UK
 * commercial lease, estoppel, SNDA) is Tenant/Landlord. The first entry is the
 * default. Kept here next to the CRE id sets so the modal and any future caller
 * share one source of truth. Returns null for a non-CRE workflow, so callers
 * render no control and leave `represented_party` unset.
 */
export interface RepresentedPartyChoice {
    options: [string, string];
    /** Default option (always equal to options[0]). */
    default: string;
}

const REPRESENTED_PARTY_BY_WORKFLOW: Record<string, RepresentedPartyChoice> = {
    // Lease family → Tenant (default) / Landlord.
    "builtin-us-commercial-lease": { options: ["Tenant", "Landlord"], default: "Tenant" },
    [UK_COMMERCIAL_LEASE_ID]: { options: ["Tenant", "Landlord"], default: "Tenant" },
    "builtin-cre-estoppel": { options: ["Tenant", "Landlord"], default: "Tenant" },
    "builtin-cre-snda": { options: ["Tenant", "Landlord"], default: "Tenant" },
    // Purchase & sale → Buyer (default) / Seller.
    "builtin-cre-psa": { options: ["Buyer", "Seller"], default: "Buyer" },
};

/**
 * The represented-party option set + default for a workflow id, or null when
 * the workflow is not a CRE pack that takes a represented side (so no control
 * is shown and `represented_party` stays null).
 */
export function representedPartyChoiceForWorkflow(
    workflowId: string | null | undefined,
): RepresentedPartyChoice | null {
    if (!workflowId) return null;
    return REPRESENTED_PARTY_BY_WORKFLOW[workflowId] ?? null;
}

export type CellFlag = "green" | "yellow" | "red" | "grey";

/**
 * Traffic-light → unified band mapping (the scheme RiskBadge documents):
 * green → low, yellow → medium, red → high. Grey ("not determinable") has no
 * risk meaning, so callers treat it as neutral and fall back to "low".
 */
export function flagToBand(flag: CellFlag | undefined): UnifiedRiskBand | null {
    switch (flag) {
        case "green":
            return "low";
        case "yellow":
            return "medium";
        case "red":
            return "high";
        default:
            // grey / undefined — no risk signal.
            return null;
    }
}

const FLAG_SEVERITY: Record<CellFlag, number> = {
    grey: 0,
    green: 1,
    yellow: 2,
    red: 3,
};

/**
 * Lawyer-facing vocabulary for each traffic-light flag, used on the result
 * card's risk badge and the per-term flag chips. Distinct from the unified
 * risk band labels (Low/Medium/High) — this is the deal vocabulary a reviewer
 * actually uses when scanning a lease abstract.
 */
export const FLAG_LAWYER_LABEL: Record<CellFlag, string> = {
    green: "Market",
    yellow: "Off-market / Material",
    red: "Deal-breaker",
    grey: "Not stated / Missing",
};

/**
 * A non-green flag carries review-worthy signal (yellow/red are material;
 * grey is a gap). Green ("market") is the only flag that doesn't get counted
 * as "flagged" in the exec summary or pulled into the Key issues list.
 */
export function isFlagged(flag: CellFlag | undefined): boolean {
    return flag === "red" || flag === "yellow" || flag === "grey";
}

/**
 * Sort comparator that orders flagged cells deal-breaker → material → gap
 * (red, then yellow, then grey), so the Key issues list pins the most severe
 * terms on top. Higher severity sorts first.
 */
export function compareFlagSeverityDesc(
    a: CellFlag | undefined,
    b: CellFlag | undefined,
): number {
    const sa = a ? FLAG_SEVERITY[a] : -1;
    const sb = b ? FLAG_SEVERITY[b] : -1;
    return sb - sa;
}

/**
 * Whether a review has any real extraction signal yet — at least one cell has
 * been generated (a flag was assigned, or the cell reached "done"). Used to
 * suppress a misleading pre-run "Low" risk badge and show a clean empty state
 * until the review has actually been run.
 */
export function hasReviewSignal(cells: TabularCell[]): boolean {
    return cells.some(
        (c) => c.status === "done" || c.content?.flag != null,
    );
}

/**
 * Stable markers (matched as substrings, case-insensitively where noted) that
 * identify the two CRE reliability advisories the backend prefixes onto a
 * cell's `reasoning`. Kept here so the result card and any future surface stay
 * in lockstep with backend/src/lib/creReliability.ts.
 *   - Truncation advisory → reasoning begins "⚠ Source truncated …"
 *     (truncationAdvisory()).
 *   - Scanned / no-OCR reason → "scanned/image-only" + "can't OCR"
 *     (emptyExtractionReason() for a PDF).
 */
const TRUNCATION_MARKER = "⚠ Source truncated";
const NO_OCR_MARKERS = ["scanned/image-only", "can't OCR"];

export interface ReliabilityAdvisory {
    /** Source text was hard-capped; late provisions may be unanalyzed. */
    truncated: boolean;
    /** A document couldn't be read (scanned / image-only, no text layer). */
    noOcr: boolean;
}

/** Detect the reliability markers in a single cell's reasoning string. */
export function detectCellAdvisory(
    reasoning: string | undefined,
): ReliabilityAdvisory {
    const text = reasoning ?? "";
    const truncated = text.includes(TRUNCATION_MARKER);
    const noOcr = NO_OCR_MARKERS.every((m) => text.includes(m));
    return { truncated, noOcr };
}

/**
 * Reduce a set of cells to whether any of them carries the truncation or the
 * no-OCR advisory — drives the calm card-level reliability banner.
 */
export function detectReliabilityAdvisory(
    cells: TabularCell[],
): ReliabilityAdvisory {
    let truncated = false;
    let noOcr = false;
    for (const c of cells) {
        const a = detectCellAdvisory(c.content?.reasoning);
        truncated = truncated || a.truncated;
        noOcr = noOcr || a.noOcr;
    }
    return { truncated, noOcr };
}

/**
 * The worst (most severe) flag across the supplied cells, ignoring cells that
 * are not done or carry no flag. Returns undefined when nothing has a flag.
 */
export function worstFlag(cells: TabularCell[]): CellFlag | undefined {
    let worst: CellFlag | undefined;
    for (const cell of cells) {
        const flag = cell.content?.flag as CellFlag | undefined;
        if (!flag) continue;
        if (worst === undefined || FLAG_SEVERITY[flag] > FLAG_SEVERITY[worst]) {
            worst = flag;
        }
    }
    return worst;
}

/** Whether any cell carries a red (deal-breaker) flag. */
export function hasRedFlag(cells: TabularCell[]): boolean {
    return cells.some((c) => (c.content?.flag as CellFlag | undefined) === "red");
}

/**
 * Column names (matched case-insensitively, by substring) that make up the
 * compact "key lease terms" abstract grid on the CRE result card. Ordered the
 * way a reviewer scans a lease abstract. Columns whose name matches one of
 * these are surfaced in the grid; everything else stays in the full table.
 */
export const KEY_LEASE_TERM_MATCHERS: { label: string; match: string[] }[] = [
    { label: "Base Rent", match: ["base rent"] },
    { label: "Term", match: ["expiration", "term"] },
    { label: "CAM / OpEx", match: ["cam", "operating expense"] },
    { label: "Renewal Options", match: ["renewal", "extension option"] },
    { label: "SNDA", match: ["snda"] },
    { label: "Estoppel", match: ["estoppel"] },
    { label: "Assignment", match: ["assignment"] },
    { label: "Governing Law", match: ["governing law"] },
];

/**
 * Pick the columns that correspond to key lease terms, preserving the abstract
 * ordering above. Each returned entry pairs the friendly label with the actual
 * matched column. Used to drive the card's abstract grid.
 */
export function selectKeyLeaseTerms(
    columns: ColumnConfig[],
): { label: string; column: ColumnConfig }[] {
    const out: { label: string; column: ColumnConfig }[] = [];
    for (const { label, match } of KEY_LEASE_TERM_MATCHERS) {
        const column = columns.find((c) => {
            const name = c.name.toLowerCase();
            return match.some((m) => name.includes(m));
        });
        if (column) out.push({ label, column });
    }
    return out;
}
