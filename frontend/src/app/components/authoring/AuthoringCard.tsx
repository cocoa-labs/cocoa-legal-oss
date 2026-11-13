"use client";

import { useState } from "react";
import {
    AlertOctagon,
    ChevronDown,
    Download,
    FileText,
    Loader2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { API_BASE } from "@/app/lib/apiBase";
import { useAuthoringJob } from "@/app/hooks/useAuthoringJob";
import type { DraftQAFinding } from "../shared/types";
import { AssemblyProgressBlock } from "./AssemblyProgressBlock";
import { DraftQABlock } from "./DraftQABlock";
import {
    STATUS_STYLES,
    mapJobQaStatus,
    summarizeCounts,
    type QaStatus,
} from "./qaShared";

interface OpenArgs {
    documentId: string;
    versionId?: string;
    filename: string;
}

interface Props {
    documentId?: string;
    filename?: string;
    versionId?: string;
    versionNumber?: number;
    downloadUrl?: string;
    qaStatus?: QaStatus;
    qaFindings?: DraftQAFinding[];
    /**
     * When set, the card OWNS the post-approval polling: it drives its UI off
     * `useAuthoringJob(jobId)` — assembling → qa progress, then the produced
     * document + QA on `ready`, or an error on `failed`/`stalled`. Used by the
     * chat-approve flow (assemble_document), where the result isn't known until
     * the background job finishes. When omitted, the card is presentational and
     * renders the result passed via the props above (wizard review / workspace).
     */
    jobId?: string | null;
    /** Retry affordance for the poll-mode failed/stalled state (chat approve). */
    onRetry?: () => void;
    onOpen?: (args: OpenArgs) => void;
}

/**
 * Chat result card for an assembled document (the authoring capability's
 * `resultCard: "AuthoringCard"`).
 *
 * Two modes:
 *  - **Static** (no `jobId`): presentational — renders the document handle + QA
 *    passed via props. Used by the wizard's Review step and the workspace.
 *  - **Polling** (`jobId` set): self-contained — polls the background assembly
 *    job and renders assembling/qa progress, then the produced document + QA on
 *    `ready`, or the error (with a retry) on `failed`/`stalled`. Used by the
 *    chat-approve flow, where the result isn't known until the job completes.
 */
export function AuthoringCard({
    documentId,
    filename,
    versionId,
    versionNumber,
    downloadUrl,
    qaStatus,
    qaFindings,
    jobId,
    onRetry,
    onOpen,
}: Props) {
    // Static mode (no job to poll) — render straight from props once we have a
    // document handle. (useAuthoringJob(null) below is a no-op in this mode.)
    const { job, error: pollError } = useAuthoringJob(jobId ?? null);

    if (!jobId) {
        if (!documentId || !filename) return null;
        return (
            <AuthoringResultCard
                documentId={documentId}
                filename={filename}
                versionId={versionId}
                versionNumber={versionNumber}
                downloadUrl={downloadUrl}
                qaStatus={qaStatus}
                qaFindings={qaFindings}
                onOpen={onOpen}
            />
        );
    }

    // Polling mode. Terminal "ready" → render the produced doc + QA from the
    // job's result. "failed"/"stalled" (or a hard poll error) → error + retry.
    // Otherwise → assembling/qa progress. Never an endless spinner: every
    // terminal/stalled branch resolves to a result or an error.
    if (job?.status === "ready" && job.result) {
        return (
            <AuthoringResultCard
                documentId={job.result.document_id}
                filename={job.result.filename || "Document"}
                versionId={job.result.version_id || undefined}
                downloadUrl={job.result.download_url || undefined}
                qaStatus={mapJobQaStatus(job.qa_status) ?? "passed"}
                qaFindings={job.qa_findings ?? []}
                onOpen={onOpen}
            />
        );
    }

    const failed =
        job?.status === "failed" || job?.stalled === true || !!pollError;
    if (failed) {
        const message =
            job?.error ||
            (job?.stalled
                ? "Assembly is taking longer than expected and may have stalled."
                : pollError) ||
            "The document could not be assembled.";
        return (
            <div className="w-full overflow-hidden rounded-lg border border-red-200 bg-red-50/70 px-4 py-3 font-sans text-sm text-red-700">
                <div className="flex items-start gap-2">
                    <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <p className="font-medium">Assembly didn&rsquo;t finish</p>
                        <p className="mt-0.5 text-xs leading-5 text-red-600">
                            {message}
                        </p>
                        {onRetry && (
                            <button
                                type="button"
                                onClick={onRetry}
                                className="mt-2 inline-flex items-center rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
                            >
                                Try again
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // assembling / qa (or the very first poll before the job row resolves).
    return (
        <div className="w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 font-sans shadow-sm">
            <AssemblyProgressBlock
                isStreaming
                label={
                    job?.status === "qa"
                        ? "Running checks…"
                        : "Assembling document…"
                }
            />
        </div>
    );
}

/**
 * The presentational result card: a FileText icon + filename + "Drafted" label,
 * an Open button, and an optional token-authenticated download — so it sits
 * naturally in the chat stream. When QA results are supplied it embeds a
 * DraftQABlock below: inline when there are only a couple of findings, otherwise
 * behind a "View QA" toggle. (Download is a direct fetch, no app data layer.)
 */
function AuthoringResultCard({
    documentId,
    filename,
    versionId,
    versionNumber,
    downloadUrl,
    qaStatus,
    qaFindings,
    onOpen,
}: {
    documentId: string;
    filename: string;
    versionId?: string;
    versionNumber?: number;
    downloadUrl?: string;
    qaStatus?: QaStatus;
    qaFindings?: DraftQAFinding[];
    onOpen?: (args: OpenArgs) => void;
}) {
    const hasVersion =
        typeof versionNumber === "number" &&
        Number.isFinite(versionNumber) &&
        versionNumber > 0;
    const extMatch = filename.match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1].toUpperCase() : "FILE";
    const basename = extMatch ? filename.slice(0, -extMatch[0].length) : filename;

    const findings = qaFindings ?? [];
    // Show QA whenever a status is known (even with zero findings — "passed"
    // renders the all-clear line) or when there are findings to surface.
    const showQa = !!qaStatus || findings.length > 0;
    const effectiveStatus: QaStatus = qaStatus ?? "passed";
    // Inline a short result; collapse a long one behind a toggle.
    const [qaOpen, setQaOpen] = useState(findings.length <= 2);

    // Only backend-relative URLs are downloaded with the bearer token, so a
    // token can't leak to an off-origin absolute URL from tool output.
    const href =
        downloadUrl && downloadUrl.startsWith("/")
            ? `${API_BASE}${downloadUrl}`
            : null;
    const [busy, setBusy] = useState(false);

    const handleDownload = async (e?: {
        stopPropagation?: () => void;
        preventDefault?: () => void;
    }) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        if (busy || !href) return;
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const resp = await fetch(href, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } finally {
            setBusy(false);
        }
    };

    const qaStyle = showQa ? STATUS_STYLES[effectiveStatus] : null;
    const qaCount = summarizeCounts(findings);

    return (
        <div className="w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50 font-sans shadow-sm">
            <div className="flex items-stretch">
                <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600 ring-1 ring-gray-200">
                        <FileText className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1 py-0.5">
                        <p className="text-xs font-medium text-gray-500">
                            Drafted
                        </p>
                        <div className="flex min-w-0 items-center gap-2">
                            <p className="text-wrap text-base font-serif leading-snug text-gray-900">
                                {basename}
                            </p>
                            {hasVersion && (
                                <span className="inline-flex shrink-0 items-center rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                                    V{versionNumber}
                                </span>
                            )}
                        </div>
                        <p className="mt-1 text-xs leading-4 text-gray-500">
                            {ext} file
                        </p>
                    </div>
                </div>
                {onOpen && (
                    <button
                        type="button"
                        onClick={() =>
                            onOpen({ documentId, versionId, filename })
                        }
                        className="flex shrink-0 cursor-pointer items-center border-l border-gray-200 bg-white px-4 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 sm:px-5"
                        title="Open document"
                    >
                        <span className="text-xs font-medium">Open</span>
                    </button>
                )}
                {href &&
                    (busy ? (
                        <div
                            aria-disabled
                            className="flex shrink-0 cursor-not-allowed items-center gap-2 border-l border-gray-200 bg-white px-4 text-gray-400 sm:px-5"
                        >
                            <Loader2 size={13} className="animate-spin" />
                            <span className="hidden text-xs font-medium sm:inline">
                                Download
                            </span>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={handleDownload}
                            className="flex shrink-0 cursor-pointer items-center gap-2 border-l border-gray-200 bg-white px-4 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 sm:px-5"
                            title="Download file"
                        >
                            <Download size={13} />
                            <span className="hidden text-xs font-medium sm:inline">
                                Download
                            </span>
                        </button>
                    ))}
            </div>

            {showQa && (
                <div className="border-t border-gray-200 bg-white px-3 py-2.5">
                    <button
                        type="button"
                        onClick={() => setQaOpen((v) => !v)}
                        className="flex w-full items-center gap-2"
                        aria-expanded={qaOpen}
                    >
                        {qaStyle && (
                            <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${qaStyle.pill}`}
                            >
                                {qaStyle.label}
                            </span>
                        )}
                        <span className="text-xs text-gray-500">
                            {findings.length > 0
                                ? `View QA (${findings.length} finding${findings.length === 1 ? "" : "s"}${qaCount ? ` · ${qaCount}` : ""})`
                                : "View QA"}
                        </span>
                        <ChevronDown
                            className={`ml-auto h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 ${qaOpen ? "" : "-rotate-90"}`}
                        />
                    </button>
                    {qaOpen && (
                        <div className="mt-2.5">
                            <DraftQABlock
                                findings={findings}
                                status={effectiveStatus}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
