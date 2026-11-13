"use client";

import Link from "next/link";
import {
    AlertCircle,
    ArrowRight,
    Check,
    FileText,
    Loader2,
    Mic,
    Upload,
} from "lucide-react";
import { useRecordingStatus } from "@/app/hooks/useRecordingStatus";
import { MarkdownContent } from "../shared/MarkdownContent";
import type {
    AssistantEvent,
    Recording,
    RecordingStatus,
} from "../shared/types";

type RecordingSummaryBlock = Extract<
    AssistantEvent,
    { type: "recording_summary" }
>;

interface Props {
    recordingId: string;
    /** Fields known at post time (from the block) — shown before the poll lands. */
    initial?: Partial<Recording>;
    variant?: "live" | "summary";
    /** The recording_summary payload — required for the static `summary` variant. */
    summaryBlock?: RecordingSummaryBlock;
}

const RECORDING_HREF = (id: string) => `/recordings/${id}`;

/** Whole seconds → `mm:ss`. */
function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Flatten summary Markdown to a short plain-text preview for the live card
 * (headings/emphasis/links/code stripped, whitespace collapsed). The durable
 * `summary` variant renders the real Markdown; this is only the teaser.
 */
function toPlainText(md: string): string {
    return md
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[*_~>#|]/g, " ")
        .replace(/^\s*[-+]\s+/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Progress-chip copy for the non-terminal statuses. */
function progressLabel(status: RecordingStatus | undefined): string {
    switch (status) {
        case "transcribing":
            return "Transcribing…";
        case "summarizing":
            return "Summarizing…";
        case "queued":
            return "Queued…";
        default:
            return "Preparing…";
    }
}

function SourceIcon({ source }: { source: Recording["source"] | undefined }) {
    const Icon = source === "upload" ? Upload : Mic;
    return (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600 ring-1 ring-gray-200">
            <Icon className="h-4 w-4" />
        </div>
    );
}

/** Read-only action-item checklist, checked from each item's `done` flag. */
function ActionItemList({
    items,
}: {
    items: Recording["action_items"];
}) {
    if (!items || items.length === 0) return null;
    return (
        <ul className="mt-3 flex flex-col gap-1.5">
            {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-sm">
                    <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            item.done
                                ? "border-emerald-300 bg-emerald-50 text-emerald-600"
                                : "border-gray-300 bg-white text-transparent"
                        }`}
                        aria-hidden="true"
                    >
                        {item.done && <Check className="h-3 w-3" />}
                    </span>
                    <span
                        className={`leading-snug ${
                            item.done
                                ? "text-gray-400 line-through"
                                : "text-gray-800"
                        }`}
                    >
                        {item.text}
                        {(item.owner || item.due) && (
                            <span className="ml-1 text-xs text-gray-400">
                                {[item.owner, item.due]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

const CARD_CLASS =
    "w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 font-sans shadow-sm";

/**
 * Chat-surface card for a recording. `live` polls `useRecordingStatus` and shows
 * capture progress → a summary teaser (or an error); `summary` renders the
 * durable `recording_summary` artifact statically. Rendered inside the white
 * assistant panel, so it uses the gray Document-card palette (mirrors
 * DocDownloadBlock), not the dark shell tokens.
 */
export function RecordingCard({
    recordingId,
    initial,
    variant = "live",
    summaryBlock,
}: Props) {
    if (variant === "summary") {
        return (
            <SummaryCard recordingId={recordingId} block={summaryBlock} initial={initial} />
        );
    }
    return <LiveCard recordingId={recordingId} initial={initial} />;
}

// ---------------------------------------------------------------------------
// Live variant — polls until terminal
// ---------------------------------------------------------------------------

function LiveCard({
    recordingId,
    initial,
}: {
    recordingId: string;
    initial?: Partial<Recording>;
}) {
    const { recording, error } = useRecordingStatus(recordingId);

    // Prefer the freshest poll payload; fall back to the fields the block
    // carried so the card shows a title/icon before the first fetch lands.
    const title = recording?.title ?? initial?.title ?? "Recording";
    const source = recording?.source ?? initial?.source;
    const durationSeconds =
        recording?.duration_seconds ?? initial?.duration_seconds ?? null;
    const status = recording?.status;
    const isFailed = status === "failed";
    const isReady = status === "ready";

    const preview = recording?.summary_md
        ? toPlainText(recording.summary_md)
        : "";
    const actionCount = recording?.action_items?.length ?? 0;

    return (
        <div className={CARD_CLASS}>
            <div className="flex items-start gap-3">
                <SourceIcon source={source} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 truncate text-base font-serif leading-snug text-gray-900">
                            {title}
                        </p>
                        {typeof durationSeconds === "number" && (
                            <span className="shrink-0 tabular-nums text-xs font-medium text-gray-400">
                                {formatDuration(durationSeconds)}
                            </span>
                        )}
                    </div>

                    {/* Non-terminal: labeled progress chip with a subtle spinner. */}
                    {!isReady && !isFailed && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-500">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {progressLabel(status)}
                        </div>
                    )}

                    {/* Ready: summary teaser + action-item count + open link. */}
                    {isReady && (
                        <>
                            {preview && (
                                <p className="mt-1.5 text-sm leading-6 text-gray-600 line-clamp-3">
                                    {preview}
                                </p>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                                {actionCount > 0 && (
                                    <span className="text-xs font-medium text-gray-400">
                                        {actionCount} action item
                                        {actionCount === 1 ? "" : "s"}
                                    </span>
                                )}
                                <Link
                                    href={RECORDING_HREF(recordingId)}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                                >
                                    Open recording
                                    <ArrowRight className="h-3 w-3" />
                                </Link>
                            </div>
                        </>
                    )}

                    {/* Failed: error line + details link. */}
                    {isFailed && (
                        <div className="mt-2">
                            <p className="flex items-start gap-1.5 text-sm leading-snug text-red-600">
                                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <span>
                                    {recording?.error ??
                                        "This recording could not be processed."}
                                </span>
                            </p>
                            <Link
                                href={RECORDING_HREF(recordingId)}
                                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700"
                            >
                                View details
                                <ArrowRight className="h-3 w-3" />
                            </Link>
                        </div>
                    )}

                    {/* Transient fetch error while still polling (keeps last state). */}
                    {!isFailed && !recording && error && (
                        <p className="mt-2 text-xs text-amber-600">
                            Still preparing — retrying…
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Summary variant — static durable artifact
// ---------------------------------------------------------------------------

function SummaryCard({
    recordingId,
    block,
    initial,
}: {
    recordingId: string;
    block?: RecordingSummaryBlock;
    initial?: Partial<Recording>;
}) {
    const title = block?.title ?? initial?.title ?? "Recording summary";
    const summaryMd = block?.summary_md ?? initial?.summary_md ?? "";
    const actionItems = block?.action_items ?? initial?.action_items ?? [];
    const transcriptDocId =
        block?.transcript_document_id ??
        initial?.transcript_document_id ??
        null;

    return (
        <div className="w-full rounded-lg border border-gray-200 bg-white px-4 py-4 font-sans shadow-sm">
            <div className="flex items-center gap-2.5">
                <SourceIcon source={initial?.source} />
                <p className="min-w-0 flex-1 truncate text-lg font-serif font-semibold text-gray-900">
                    {title}
                </p>
            </div>

            {summaryMd && (
                <div className="mt-3">
                    {/* Same renderer AssistantMessage uses for assistant prose. */}
                    <MarkdownContent text={summaryMd} citationsList={[]} />
                </div>
            )}

            {actionItems.length > 0 && (
                <div className="mt-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                        Action items
                    </p>
                    <ActionItemList items={actionItems} />
                </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-100 pt-3">
                <Link
                    href={RECORDING_HREF(recordingId)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                    Open recording
                    <ArrowRight className="h-3 w-3" />
                </Link>
                {transcriptDocId && (
                    <Link
                        href={RECORDING_HREF(recordingId)}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
                        title="View the transcript PDF on the recording page"
                    >
                        <FileText className="h-3.5 w-3.5" />
                        Transcript PDF
                    </Link>
                )}
            </div>
        </div>
    );
}
