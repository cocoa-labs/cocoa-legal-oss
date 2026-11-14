"use client";

import {
    AlertTriangle,
    CheckCircle2,
    Download,
    FileText,
    Loader2,
    OctagonX,
    RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { API_BASE } from "@/app/lib/apiBase";
import { retryFailedDocumentGenerationJob } from "@/app/lib/cocoaLegalApi";
import { downloadProtectedFile } from "@/app/lib/protectedDownload";
import { useDocumentGenerationJob } from "@/app/hooks/useDocumentGenerationJob";
import { supabase } from "@/lib/supabase";
import {
    canRetryDocumentPacket,
    documentPacketFailureMessage,
    documentPacketItemIsActive,
} from "./documentPacketState";

function phaseLabel(status: string) {
    if (status === "planning") return "Planning";
    if (status === "drafting") return "Drafting";
    if (status === "assembling") return "Assembling DOCX";
    if (status === "qa") return "Quality review";
    if (status === "ready") return "Ready";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    return "Queued";
}

export function DocumentPacketCard({
    jobId,
    totalDocuments,
}: {
    jobId: string;
    totalDocuments: number;
}) {
    const { job, error, refresh } = useDocumentGenerationJob(jobId);
    const [retrying, setRetrying] = useState(false);
    const [retryError, setRetryError] = useState<string | null>(null);
    const [downloadingItemId, setDownloadingItemId] = useState<string | null>(
        null,
    );
    const [downloadError, setDownloadError] = useState<{
        itemId: string;
        message: string;
    } | null>(null);
    const total = job?.total_items ?? totalDocuments;
    const completed =
        job?.items.filter((item) => item.status === "ready").length ?? 0;
    const terminal =
        job?.status === "completed" ||
        job?.status === "partial" ||
        job?.status === "failed" ||
        job?.status === "cancelled";
    const canRetry = canRetryDocumentPacket(job);

    const retryFailed = async () => {
        setRetrying(true);
        setRetryError(null);
        try {
            await retryFailedDocumentGenerationJob(jobId);
            refresh();
        } catch (cause) {
            setRetryError(
                cause instanceof Error
                    ? cause.message
                    : "Could not retry the failed documents.",
            );
        } finally {
            setRetrying(false);
        }
    };

    const downloadItem = async (
        itemId: string,
        result: { download_url: string; filename: string },
    ) => {
        if (downloadingItemId) return;
        setDownloadingItemId(itemId);
        setDownloadError(null);
        try {
            await downloadProtectedFile({
                apiBase: API_BASE,
                downloadUrl: result.download_url,
                filename: result.filename,
                getAccessToken: async () => {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    return session?.access_token ?? null;
                },
                refreshAccessToken: async () => {
                    const {
                        data: { session },
                    } = await supabase.auth.refreshSession();
                    return session?.access_token ?? null;
                },
            });
        } catch (cause) {
            setDownloadError({
                itemId,
                message:
                    cause instanceof Error
                        ? cause.message
                        : "The document could not be downloaded.",
            });
        } finally {
            setDownloadingItemId(null);
        }
    };

    return (
        <section className="my-3 overflow-hidden rounded-xl border border-gray-200 bg-white font-sans shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3">
                <div>
                    <p className="text-sm font-semibold text-gray-900">
                        Document packet
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                        {completed} of {total} ready
                        {job?.cancellation_requested
                            ? " · stopping after the current save"
                            : ""}
                    </p>
                </div>
                {!terminal ? (
                    <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                ) : job?.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : job?.status === "failed" ? (
                    <OctagonX className="h-4 w-4 text-red-600" />
                ) : (
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                )}
            </div>

            <div className="divide-y divide-gray-100">
                {(job?.items ?? []).map((item) => (
                    <div key={item.id} className="px-4 py-3">
                        <div className="flex items-start gap-3">
                            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="truncate text-sm font-medium text-gray-900">
                                        {item.title}
                                    </p>
                                    <span className="shrink-0 text-xs text-gray-500">
                                        {phaseLabel(item.status)}
                                    </span>
                                </div>
                                {!terminal &&
                                    documentPacketItemIsActive(item) && (
                                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
                                            <div
                                                className="h-full rounded-full bg-amber-500 transition-all"
                                                style={{
                                                    width: `${Math.max(3, item.progress)}%`,
                                                }}
                                            />
                                        </div>
                                    )}
                                {item.qa_status !== "pending" && (
                                    <p className="mt-1 text-xs text-gray-500">
                                        QA: {item.qa_status}
                                        {item.qa_findings.length
                                            ? ` · ${item.qa_findings.length} finding${item.qa_findings.length === 1 ? "" : "s"}`
                                            : ""}
                                    </p>
                                )}
                                {item.word_count != null && (
                                    <p className="mt-1 text-xs text-gray-500">
                                        {item.word_count.toLocaleString()} words
                                        {item.word_budget
                                            ? ` · target ${item.word_budget.target_words.toLocaleString()} · ceiling ${item.word_budget.max_words.toLocaleString()}`
                                            : ""}
                                    </p>
                                )}
                                {item.status === "failed" && (
                                    <p className="mt-1 text-xs leading-5 text-red-600">
                                        {documentPacketFailureMessage(item)}
                                    </p>
                                )}
                                {item.result && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void downloadItem(
                                                item.id,
                                                item.result!,
                                            )
                                        }
                                        disabled={downloadingItemId !== null}
                                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:text-amber-900 disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {downloadingItemId === item.id ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Download className="h-3.5 w-3.5" />
                                        )}
                                        {downloadingItemId === item.id
                                            ? "Downloading…"
                                            : `Download ${item.result.filename}`}
                                    </button>
                                )}
                                {downloadError?.itemId === item.id && (
                                    <p
                                        role="alert"
                                        className="mt-1 text-xs leading-5 text-red-600"
                                    >
                                        {downloadError.message}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                {!job && !error && (
                    <div className="flex items-center gap-2 px-4 py-4 text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading packet status…
                    </div>
                )}
            </div>
            {canRetry && (
                <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
                    <button
                        type="button"
                        onClick={() => void retryFailed()}
                        disabled={retrying}
                        className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {retrying ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Retry failed documents
                    </button>
                    {retryError && (
                        <p className="mt-2 text-xs text-red-700">
                            {retryError}
                        </p>
                    )}
                </div>
            )}
            {job?.stalled && !terminal && (
                <p
                    role="status"
                    className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800"
                >
                    Progress is delayed. Last activity:{" "}
                    {job.last_activity_at
                        ? new Date(job.last_activity_at).toLocaleString()
                        : "unavailable"}
                    . Saved documents remain available.
                </p>
            )}
            {error && (
                <p
                    role="alert"
                    className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700"
                >
                    {error}
                </p>
            )}
        </section>
    );
}
