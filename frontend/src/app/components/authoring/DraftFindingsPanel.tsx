"use client";

import { CheckCircle2 } from "lucide-react";
import type { DraftQAFinding } from "../shared/types";
import { FindingRow, QaStatusHeader } from "./DraftQABlock";
import { groupFindings, type QaStatus } from "./qaShared";

interface Props {
    findings: DraftQAFinding[];
    status: QaStatus;
    onJump?: (finding: DraftQAFinding) => void;
    className?: string;
}

/**
 * Taller side-rail variant of the QA results for the matter workspace (T23).
 * Same grouping/severity logic and labels/colors as DraftQABlock (it reuses the
 * exported QaStatusHeader + FindingRow), but laid out as a vertically
 * scrollable rail with a sticky header so the status pill + counts stay in view
 * while scanning a long findings list. `className` lets the workspace size the
 * rail (height/width). Presentational only.
 */
export function DraftFindingsPanel({
    findings,
    status,
    onJump,
    className,
}: Props) {
    const groups = groupFindings(findings);
    const allClear = findings.length === 0 && status === "passed";

    return (
        <div
            className={`flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white font-sans ${className ?? ""}`}
        >
            <div className="sticky top-0 z-10 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-white/80">
                <h3 className="mb-1.5 text-sm font-semibold text-gray-700">
                    Draft QA
                </h3>
                <QaStatusHeader findings={findings} status={status} />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {allClear ? (
                    <div className="flex items-center gap-2 px-4 py-4 text-sm text-emerald-800">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                        <span>All four checks passed.</span>
                    </div>
                ) : findings.length === 0 ? (
                    <p className="px-4 py-4 text-sm text-gray-500">
                        No findings to display.
                    </p>
                ) : (
                    <div className="flex flex-col divide-y divide-gray-100">
                        {groups.map((group) => (
                            <section key={group.guardrail} className="px-4 py-3">
                                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                                    {group.label}
                                </p>
                                <div className="flex flex-col gap-2">
                                    {group.findings.map((finding, i) => (
                                        <FindingRow
                                            key={`${group.guardrail}-${i}`}
                                            finding={finding}
                                            onJump={onJump}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
