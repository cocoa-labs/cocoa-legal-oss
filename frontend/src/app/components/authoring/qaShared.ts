// Shared QA presentation logic for the document-authoring blocks
// (DraftQABlock, DraftFindingsPanel, AuthoringCard). Pure helpers — no React,
// no data fetching — so the inline-chat block and the workspace side-rail render
// the four-guardrail QA result identically.

import type { AuthoringJobStatus, DraftQAFinding } from "../shared/types";

export type QaStatus = "passed" | "advisory" | "blocked";
export type QaGuardrail = DraftQAFinding["guardrail"];
export type QaSeverity = DraftQAFinding["severity"];

/**
 * Narrow an authoring job's `qa_status` (which includes the non-terminal
 * `"pending"`) to the three-state UI `QaStatus`. Returns null while QA is still
 * pending so callers render progress rather than a (wrong) terminal pill.
 */
export function mapJobQaStatus(
    qaStatus: AuthoringJobStatus["qa_status"],
): QaStatus | null {
    return qaStatus === "passed" ||
        qaStatus === "advisory" ||
        qaStatus === "blocked"
        ? qaStatus
        : null;
}

/** Human label for each of the four guardrails, in display order. */
export const GUARDRAIL_LABELS: Record<QaGuardrail, string> = {
    defined_terms: "Defined terms & cross-references",
    playbook: "Playbook compliance",
    jurisdiction: "Jurisdiction",
    research: "Legal research",
};

/** Stable render order for guardrail groups. */
export const GUARDRAIL_ORDER: QaGuardrail[] = [
    "defined_terms",
    "playbook",
    "jurisdiction",
    "research",
];

/** Severity → dot color (Tailwind bg utility). blocking=red, advisory=amber, info=slate. */
export const SEVERITY_DOT: Record<QaSeverity, string> = {
    blocking: "bg-red-500",
    advisory: "bg-amber-500",
    info: "bg-slate-400",
};

export interface QaStatusStyle {
    /** Pill label, e.g. "QA passed". */
    label: string;
    /** Tailwind classes for the status pill (bg + text + ring). */
    pill: string;
    /** Tailwind text color for the count summary. */
    countText: string;
}

/** Pill copy + colors for each terminal QA status. */
export const STATUS_STYLES: Record<QaStatus, QaStatusStyle> = {
    passed: {
        label: "QA passed",
        pill: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
        countText: "text-emerald-600",
    },
    advisory: {
        label: "Review advisories",
        pill: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
        countText: "text-amber-600",
    },
    blocked: {
        label: "Blocking issues — do not send",
        pill: "bg-red-50 text-red-700 ring-1 ring-red-200",
        countText: "text-red-600",
    },
};

export interface FindingGroup {
    guardrail: QaGuardrail;
    label: string;
    findings: DraftQAFinding[];
}

/**
 * Bucket findings by guardrail in the canonical order, dropping empty groups.
 * Severity ordering within a group is preserved as received (the backend emits
 * blocking-first); we don't re-sort so caller-supplied order is respected.
 */
export function groupFindings(findings: DraftQAFinding[]): FindingGroup[] {
    const byGuardrail = new Map<QaGuardrail, DraftQAFinding[]>();
    for (const finding of findings) {
        const bucket = byGuardrail.get(finding.guardrail);
        if (bucket) bucket.push(finding);
        else byGuardrail.set(finding.guardrail, [finding]);
    }
    return GUARDRAIL_ORDER.filter((g) => byGuardrail.has(g)).map((g) => ({
        guardrail: g,
        label: GUARDRAIL_LABELS[g],
        findings: byGuardrail.get(g) ?? [],
    }));
}

export interface SeverityCounts {
    blocking: number;
    advisory: number;
    info: number;
}

/** Tally findings by severity. */
export function countBySeverity(findings: DraftQAFinding[]): SeverityCounts {
    const counts: SeverityCounts = { blocking: 0, advisory: 0, info: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    return counts;
}

/**
 * Compact count summary, e.g. "2 blocking · 3 advisory". Only non-zero
 * severities are shown; returns "" when there are no findings.
 */
export function summarizeCounts(findings: DraftQAFinding[]): string {
    const { blocking, advisory, info } = countBySeverity(findings);
    const parts: string[] = [];
    if (blocking > 0) parts.push(`${blocking} blocking`);
    if (advisory > 0) parts.push(`${advisory} advisory`);
    if (info > 0) parts.push(`${info} note${info === 1 ? "" : "s"}`);
    return parts.join(" · ");
}

/**
 * A finding is jumpable when it can anchor somewhere in the document (it has a
 * `section_id` or `evidence`) AND the consumer wired an `onJump` handler.
 */
export function isJumpable(
    finding: DraftQAFinding,
    onJump?: (finding: DraftQAFinding) => void,
): boolean {
    return !!onJump && (!!finding.section_id || !!finding.evidence);
}
