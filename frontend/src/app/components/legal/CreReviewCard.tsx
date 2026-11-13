"use client";

import { useMemo, useState } from "react";
import {
    Building2,
    FileSpreadsheet,
    AlertTriangle,
    FileX,
    ChevronDown,
    ChevronRight,
} from "lucide-react";
import type {
    ColumnConfig,
    CocoLegalDocument,
    TabularCell,
    TabularReview,
} from "../shared/types";
import { preprocessCitations } from "../tabular/citation-utils";
import { RiskBadge } from "./RiskBadge";
import { EscalationDraft } from "./EscalationDraft";
import { CapabilityFooterActions } from "./CapabilityFooterActions";
import {
    flagToBand,
    hasRedFlag,
    hasReviewSignal,
    isFlagged,
    compareFlagSeverityDesc,
    detectCellAdvisory,
    detectReliabilityAdvisory,
    selectKeyLeaseTerms,
    worstFlag,
    FLAG_LAWYER_LABEL,
    type CellFlag,
} from "./creShared";

interface Props {
    review: TabularReview;
    columns: ColumnConfig[];
    cells: TabularCell[];
    documents: CocoLegalDocument[];
    onExportDocx?: () => void;
    onExportXlsx?: () => void;
    onCopy?: () => void;
    onRerun?: () => void;
    onOpen?: () => void;
    /**
     * Jump to a cited place in the source — opens the term's cell with the
     * citation's page/quote highlighted. Wired from TRView to the same cell
     * side-panel the grid uses. Falls back to `onOpen` when not provided.
     */
    onOpenCitation?: (colIndex: number, page: number, quote: string) => void;
    /** Disable one-shot actions while they're running. */
    busy?: { exportDocx?: boolean; exportXlsx?: boolean };
}

const FLAG_DOT: Record<CellFlag, string> = {
    green: "bg-green-500",
    yellow: "bg-amber-400",
    red: "bg-red-500",
    grey: "bg-gray-400",
};

/** Pill styles for the per-term flag chip, in lawyer vocabulary. */
const FLAG_CHIP: Record<CellFlag, string> = {
    green:
        "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
    yellow: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    red: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    grey: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
};

/** First non-empty line of a cell summary with citation markers stripped. */
function abstractValue(summary: string | undefined): {
    text: string;
    citation?: { page: number; quote: string };
} {
    if (!summary) return { text: "—" };
    const { processed, citations } = preprocessCitations(summary);
    const cleaned = processed
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
    const firstLine =
        cleaned.split("\n").find((l) => l.trim())?.replace(/^[-*•]\s+/, "") ??
        cleaned;
    return {
        text: firstLine || "—",
        citation: citations[0],
    };
}

/** A clickable "p. N" chip that jumps to the cited page, or a static tooltip. */
function CitationChip({
    citation,
    onJump,
}: {
    citation?: { page: number; quote: string };
    onJump?: (page: number, quote: string) => void;
}) {
    if (!citation) return null;
    const title = `Page ${citation.page}: "${citation.quote}"`;
    if (!onJump) {
        return (
            <span
                className="mt-0.5 shrink-0 rounded bg-zinc-100 px-1 py-px text-[10px] font-medium text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
                title={title}
            >
                p. {citation.page}
            </span>
        );
    }
    return (
        <button
            type="button"
            onClick={() => onJump(citation.page, citation.quote)}
            title={title}
            className="mt-0.5 shrink-0 rounded bg-zinc-100 px-1 py-px text-[10px] font-medium text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
            p. {citation.page}
        </button>
    );
}

/** Small advisory glyph + tooltip shown on a term row whose source had an issue. */
function AdvisoryIcon({ truncated, noOcr }: { truncated: boolean; noOcr: boolean }) {
    if (!truncated && !noOcr) return null;
    const title = noOcr
        ? "Source couldn't be read (scanned / no text layer) — verify manually."
        : "Source truncated — late-document provisions may not be analyzed.";
    const Icon = noOcr ? FileX : AlertTriangle;
    return (
        <span className="mt-0.5 shrink-0" title={title} aria-label={title}>
            <Icon className="h-3 w-3 text-amber-500" aria-hidden />
        </span>
    );
}

export function CreReviewCard({
    review,
    columns,
    cells,
    documents,
    onExportDocx,
    onExportXlsx,
    onCopy,
    onRerun,
    onOpen,
    onOpenCitation,
    busy,
}: Props) {
    const [showAllTerms, setShowAllTerms] = useState(false);
    const [copied, setCopied] = useState(false);

    // The representative document for a single-asset abstract (the common CRE
    // case). When multiple docs are present, fall back to the first.
    const primaryDocId = documents[0]?.id;

    const cellFor = useMemo(() => {
        const map = new Map<string, TabularCell>();
        for (const c of cells) {
            // Prefer the primary document's cell for each column.
            if (!primaryDocId || c.document_id === primaryDocId) {
                map.set(`${c.column_index}`, c);
            }
        }
        // If the primary doc had no cells, fall back to any cell per column.
        if (map.size === 0) {
            for (const c of cells) {
                if (!map.has(`${c.column_index}`)) map.set(`${c.column_index}`, c);
            }
        }
        return map;
    }, [cells, primaryDocId]);

    const keyTerms = useMemo(() => selectKeyLeaseTerms(columns), [columns]);

    // Worst flag across the displayed document's cells drives the header band.
    const scopedCells = useMemo(
        () =>
            primaryDocId
                ? cells.filter((c) => c.document_id === primaryDocId)
                : cells,
        [cells, primaryDocId],
    );

    // Only show a risk band once the review has real signal. A fresh, un-run
    // review has no flags / no done cells, so a green "Low" badge over a grid
    // of dashes would be misleading — suppress the badge and show an empty
    // state instead.
    const hasSignal = useMemo(() => hasReviewSignal(scopedCells), [scopedCells]);
    const worst = worstFlag(scopedCells);
    const band = flagToBand(worst) ?? "low";
    const isRed = hasRedFlag(scopedCells);

    // Exec summary counts (over scoped cells): how many of the review's columns
    // are done, and how many carry a non-green (flagged) signal.
    const totalTerms = columns.length;
    const doneCount = useMemo(
        () => scopedCells.filter((c) => c.status === "done").length,
        [scopedCells],
    );
    const flaggedCount = useMemo(
        () =>
            scopedCells.filter((c) =>
                isFlagged(c.content?.flag as CellFlag | undefined),
            ).length,
        [scopedCells],
    );

    // Reliability advisory across the displayed document's cells.
    const advisory = useMemo(
        () => detectReliabilityAdvisory(scopedCells),
        [scopedCells],
    );

    // The flagged key terms, deal-breaker → material → gap, pinned on top.
    const keyIssues = useMemo(() => {
        return keyTerms
            .map(({ label, column }) => {
                const cell = cellFor.get(`${column.index}`);
                const flag = cell?.content?.flag as CellFlag | undefined;
                return { label, column, cell, flag };
            })
            .filter((t) => isFlagged(t.flag))
            .sort((a, b) => compareFlagSeverityDesc(a.flag, b.flag));
    }, [keyTerms, cellFor]);

    // Deal / property label: prefer a Tenant — Premises pairing pulled from the
    // abstract, else the review title.
    const dealLabel = useMemo(() => {
        const findCol = (needle: string) =>
            columns.find((c) => c.name.toLowerCase().includes(needle));
        const valueOf = (col?: ColumnConfig) => {
            if (!col) return undefined;
            const cell = cellFor.get(`${col.index}`);
            const v = abstractValue(cell?.content?.summary).text;
            return v && v !== "—" ? v : undefined;
        };
        const tenant = valueOf(findCol("tenant"));
        const premises = valueOf(findCol("premises"));
        const parts = [tenant, premises].filter(Boolean);
        return parts.length ? parts.join(" — ") : review.title;
    }, [columns, cellFor, review.title]);

    const docCount = documents.length;

    function handleCopy() {
        onCopy?.();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    function jumpTo(column: ColumnConfig, page: number, quote: string) {
        if (onOpenCitation) onOpenCitation(column.index, page, quote);
        else onOpen?.();
    }

    return (
        <div className="mx-4 mb-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 md:mx-10">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
                        <Building2 className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {dealLabel}
                        </div>
                        <div className="text-xs text-zinc-500">
                            Lease abstract ·{" "}
                            {docCount === 1
                                ? "1 document"
                                : `${docCount} documents`}
                            {review.represented_party && (
                                <>
                                    {" · "}
                                    <span className="font-medium text-zinc-600 dark:text-zinc-300">
                                        Reviewing as: {review.represented_party}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
                {/* Only show the risk badge once there's real signal. */}
                {hasSignal && (
                    <RiskBadge
                        band={band}
                        nativeLabel={worst ? FLAG_LAWYER_LABEL[worst] : undefined}
                        reason={
                            isRed
                                ? "At least one deal-breaker term flagged"
                                : `Highest flag across the abstract: ${
                                      worst ? FLAG_LAWYER_LABEL[worst] : "none"
                                  }`
                        }
                    />
                )}
            </div>

            {/* Exec summary line — only meaningful once the review has run. */}
            {hasSignal && (
                <div className="mt-2 text-xs text-zinc-500">
                    {doneCount}/{totalTerms} terms reviewed · {flaggedCount}{" "}
                    flagged
                </div>
            )}

            {/* Reliability advisory banner (shipped safety surfacing). */}
            {hasSignal && (advisory.truncated || advisory.noOcr) && (
                <div className="mt-3 space-y-1.5">
                    {advisory.truncated && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span>
                                Some source content was truncated — verify
                                late-document provisions (exhibits, schedules,
                                exception lists).
                            </span>
                        </div>
                    )}
                    {advisory.noOcr && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                            <FileX className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span>
                                A document couldn&apos;t be read (scanned / no
                                text layer) — those terms need manual review.
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Empty state — no risk badge, no dashes-over-green. */}
            {!hasSignal && (
                <div className="mt-3 rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
                    Run the review to populate the lease abstract.
                </div>
            )}

            {/* Key issues — flagged key terms, deal-breakers pinned on top. */}
            {hasSignal && keyIssues.length > 0 && (
                <div className="mt-4">
                    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        Key issues
                    </div>
                    <div className="space-y-1.5">
                        {keyIssues.map(({ label, column, cell, flag }) => {
                            const { text, citation } = abstractValue(
                                cell?.content?.summary,
                            );
                            const cellAdvisory = detectCellAdvisory(
                                cell?.content?.reasoning,
                            );
                            return (
                                <div
                                    key={column.index}
                                    className="flex items-start gap-2 rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 text-xs dark:border-zinc-900 dark:bg-zinc-900/30"
                                >
                                    {flag && (
                                        <span
                                            className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] font-medium ${FLAG_CHIP[flag]}`}
                                        >
                                            {FLAG_LAWYER_LABEL[flag]}
                                        </span>
                                    )}
                                    <span className="mt-0.5 w-24 shrink-0 font-medium text-zinc-500">
                                        {label}
                                    </span>
                                    <span className="min-w-0 flex-1 text-zinc-800 dark:text-zinc-200">
                                        {text}
                                    </span>
                                    <AdvisoryIcon
                                        truncated={cellAdvisory.truncated}
                                        noOcr={cellAdvisory.noOcr}
                                    />
                                    <CitationChip
                                        citation={citation}
                                        onJump={(page, quote) =>
                                            jumpTo(column, page, quote)
                                        }
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Full abstract grid of key lease terms (secondary, collapsible). */}
            {hasSignal && keyTerms.length > 0 && (
                <div className="mt-4">
                    <button
                        type="button"
                        onClick={() => setShowAllTerms((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                    >
                        {showAllTerms ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                        )}
                        All key terms ({keyTerms.length})
                    </button>
                    {showAllTerms && (
                        <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                            {keyTerms.map(({ label, column }) => {
                                const cell = cellFor.get(`${column.index}`);
                                const { text, citation } = abstractValue(
                                    cell?.content?.summary,
                                );
                                const flag = cell?.content?.flag as
                                    | CellFlag
                                    | undefined;
                                const cellAdvisory = detectCellAdvisory(
                                    cell?.content?.reasoning,
                                );
                                return (
                                    <div
                                        key={column.index}
                                        className="flex items-start gap-2 border-b border-zinc-100 py-1 text-xs last:border-b-0 dark:border-zinc-900"
                                    >
                                        <span className="mt-0.5 w-28 shrink-0 font-medium text-zinc-500">
                                            {label}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200">
                                            {text}
                                        </span>
                                        <AdvisoryIcon
                                            truncated={cellAdvisory.truncated}
                                            noOcr={cellAdvisory.noOcr}
                                        />
                                        <CitationChip
                                            citation={citation}
                                            onJump={(page, quote) =>
                                                jumpTo(column, page, quote)
                                            }
                                        />
                                        {flag && (
                                            <span
                                                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${FLAG_DOT[flag]}`}
                                                title={FLAG_LAWYER_LABEL[flag]}
                                                aria-label={FLAG_LAWYER_LABEL[flag]}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Escalation draft surfaces when a deal-breaker is present */}
            {isRed && (
                <div className="mt-4">
                    <EscalationDraft
                        defaultSubject={`Escalation: deal-breaker term in ${dealLabel}`}
                        defaultBody={
                            `A review of "${review.title}" surfaced at least one ` +
                            `deal-breaker (red) term in the lease abstract. ` +
                            `Please review the flagged terms before proceeding.\n\n` +
                            `Flagged terms:\n` +
                            scopedCells
                                .filter(
                                    (c) =>
                                        (c.content?.flag as
                                            | CellFlag
                                            | undefined) === "red",
                                )
                                .map((c) => {
                                    const col = columns.find(
                                        (x) => x.index === c.column_index,
                                    );
                                    const v = abstractValue(
                                        c.content?.summary,
                                    ).text;
                                    return `- ${col?.name ?? "Term"}: ${v}`;
                                })
                                .join("\n")
                        }
                    />
                </div>
            )}

            {/* Footer actions */}
            <div className="mt-1 flex flex-wrap items-center gap-2">
                <CapabilityFooterActions
                    onExportDocx={onExportDocx}
                    onOpenAsDoc={onOpen}
                    onCopy={onCopy ? handleCopy : undefined}
                    onRerun={onRerun}
                    disabled={{ exportDocx: busy?.exportDocx }}
                />
                {copied && (
                    <span className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        Copied
                    </span>
                )}
                {onExportXlsx && (
                    <button
                        onClick={onExportXlsx}
                        disabled={busy?.exportXlsx}
                        className="mt-3 inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-900"
                    >
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                        Export XLSX
                    </button>
                )}
            </div>
        </div>
    );
}
