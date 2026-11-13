"use client";

import { ChevronRight, Link2, Receipt, ShieldCheck, Zap } from "lucide-react";
import type { AutomationRun } from "@/app/lib/cocoLegalApi";
import {
    runNeedsCaseConfirm,
    runStatusBadge,
    runSummary,
    timeAgo,
    workflowKindLabel,
} from "./piShared";

function KindIcon({ kind }: { kind: AutomationRun["workflow_kind"] }) {
    if (kind === "claim_correspondence")
        return <ShieldCheck className="h-3.5 w-3.5" />;
    if (kind === "vendor_invoice") return <Receipt className="h-3.5 w-3.5" />;
    return <Zap className="h-3.5 w-3.5" />;
}

/** Compact 0–1 confidence meter (bar + percentage). */
export function ConfidenceMeter({ value }: { value: number | null }) {
    if (value === null || !Number.isFinite(value)) return null;
    const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
    const tone =
        pct >= 90 ? "bg-green-500" : pct >= 70 ? "bg-amber-500" : "bg-red-500";
    return (
        <span
            className="inline-flex items-center gap-1.5"
            title={`Aggregate extraction confidence ${pct}%`}
        >
            <span className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--app-border)]">
                <span
                    className={`block h-full rounded-full ${tone}`}
                    style={{ width: `${pct}%` }}
                />
            </span>
            <span className="text-[11px] tabular-nums text-[var(--app-text-subtle)]">
                {pct}%
            </span>
        </span>
    );
}

/**
 * One automation run in the queue list: workflow kind, status, the staged
 * proposal's summary line, case-match state, aggregate confidence and age.
 * Triage runs surface their triage_reason; failed runs their error.
 */
export function AutomationRunCard({
    run,
    onOpen,
}: {
    run: AutomationRun;
    onOpen: () => void;
}) {
    const badge = runStatusBadge(run.status);
    const summary = runSummary(run);
    const needsCaseConfirm = runNeedsCaseConfirm(run);
    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-left transition-colors hover:bg-[var(--app-hover)]"
            >
                <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200">
                        <KindIcon kind={run.workflow_kind} />
                    </div>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text-strong)]">
                        {workflowKindLabel(run.workflow_kind)}
                    </span>
                    <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}
                    >
                        {badge.label}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-text-subtle)]" />
                </div>

                {summary && (
                    <p className="mt-1.5 truncate pl-8 text-xs text-[var(--app-text-muted)]">
                        {summary}
                    </p>
                )}

                <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-8 text-[11px] text-[var(--app-text-subtle)]">
                    {run.case_id ? (
                        <span className="inline-flex items-center gap-1">
                            <Link2 className="h-3 w-3" />
                            {run.match_method === "manual"
                                ? "Assigned case"
                                : "Matched case"}
                        </span>
                    ) : (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-600">
                            Unmatched
                        </span>
                    )}
                    {needsCaseConfirm && run.status === "staged" && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900">
                            Case match needs confirmation
                        </span>
                    )}
                    <ConfidenceMeter value={run.confidence} />
                    <span className="ml-auto">{timeAgo(run.created_at)}</span>
                </div>

                {run.status === "triage" && run.triage_reason && (
                    <p className="mt-1.5 pl-8 text-[11px] text-red-700">
                        {run.triage_reason}
                    </p>
                )}
                {run.status === "failed" && run.error && (
                    <p className="mt-1.5 truncate pl-8 text-[11px] text-red-700">
                        {run.error}
                    </p>
                )}
            </button>
        </li>
    );
}
