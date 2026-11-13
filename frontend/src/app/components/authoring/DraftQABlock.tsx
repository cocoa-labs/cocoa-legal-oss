"use client";

import { AlertOctagon, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DraftQAFinding } from "../shared/types";
import {
    SEVERITY_DOT,
    STATUS_STYLES,
    groupFindings,
    isJumpable,
    summarizeCounts,
    type QaStatus,
} from "./qaShared";

interface Props {
    findings: DraftQAFinding[];
    status: QaStatus;
    onJump?: (finding: DraftQAFinding) => void;
}

/**
 * Compact four-guardrail QA result for inline chat (embedded in AuthoringCard /
 * the `draft_qa` event) and the wizard's review step. Presentational only —
 * findings are grouped by guardrail with a status pill + severity dots. A row
 * becomes a button (jump-to-section) when the finding anchors somewhere and
 * `onJump` is supplied. The taller workspace side-rail variant
 * (DraftFindingsPanel) shares the same labels/colors and the FindingRow /
 * StatusPill subcomponents exported here.
 */
export function DraftQABlock({ findings, status, onJump }: Props) {
    // The "all clear" shorthand: nothing flagged and the run passed.
    if (findings.length === 0 && status === "passed") {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 font-sans text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <span>All four checks passed.</span>
            </div>
        );
    }

    const groups = groupFindings(findings);

    return (
        <div className="rounded-lg border border-gray-200 bg-white font-sans">
            <div className="border-b border-gray-100 px-3 py-2">
                <QaStatusHeader findings={findings} status={status} />
            </div>
            <div className="flex flex-col divide-y divide-gray-100">
                {groups.map((group) => (
                    <div key={group.guardrail} className="px-3 py-2.5">
                        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                            {group.label}
                        </p>
                        <div className="flex flex-col gap-1.5">
                            {group.findings.map((finding, i) => (
                                <FindingRow
                                    key={`${group.guardrail}-${i}`}
                                    finding={finding}
                                    onJump={onJump}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

/**
 * Status pill + count summary. Shared by the compact block and the side-rail's
 * sticky header. `iconForStatus` keeps the leading glyph consistent across both.
 */
export function QaStatusHeader({
    findings,
    status,
}: {
    findings: DraftQAFinding[];
    status: QaStatus;
}) {
    const style = STATUS_STYLES[status];
    const counts = summarizeCounts(findings);
    const Icon =
        status === "blocked"
            ? AlertOctagon
            : status === "advisory"
              ? AlertTriangle
              : CheckCircle2;
    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${style.pill}`}
            >
                <Icon className="h-3.5 w-3.5" />
                {style.label}
            </span>
            {counts && (
                <span className={`text-xs font-medium ${style.countText}`}>
                    {counts}
                </span>
            )}
        </div>
    );
}

/**
 * One QA finding: a severity dot, the message, and optional muted
 * suggestion/evidence. Rendered as a button (calling `onJump`) when the finding
 * anchors to a section/evidence and a handler is provided; otherwise a static
 * row. Shared verbatim by DraftQABlock and DraftFindingsPanel.
 */
export function FindingRow({
    finding,
    onJump,
}: {
    finding: DraftQAFinding;
    onJump?: (finding: DraftQAFinding) => void;
}) {
    const jumpable = isJumpable(finding, onJump);
    const dot = SEVERITY_DOT[finding.severity];

    const inner = (
        <>
            <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
                aria-hidden
            />
            <span className="min-w-0 flex-1">
                <span className="block text-sm leading-snug text-gray-800">
                    {finding.message}
                </span>
                {finding.suggestion && (
                    <span className="mt-0.5 block text-xs leading-snug text-gray-500">
                        Suggestion: {finding.suggestion}
                    </span>
                )}
                {finding.evidence && (
                    <span className="mt-0.5 block truncate text-xs leading-snug text-gray-400">
                        &ldquo;{finding.evidence}&rdquo;
                    </span>
                )}
            </span>
        </>
    );

    if (jumpable) {
        return (
            <button
                type="button"
                onClick={() => onJump?.(finding)}
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-gray-50"
                title="Jump to this section"
            >
                {inner}
            </button>
        );
    }

    return <div className="flex items-start gap-2 px-1.5 py-1">{inner}</div>;
}
