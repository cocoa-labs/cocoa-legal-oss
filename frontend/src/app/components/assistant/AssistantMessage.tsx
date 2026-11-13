"use client";

import { useRef, useEffect, useState } from "react";
import { API_BASE } from "@/app/lib/apiBase";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    Copy,
    Check,
    ChevronDown,
    Download,
    ExternalLink,
    FileText,
    Highlighter,
    ListTree,
    Loader2,
    Search,
    ShieldCheck,
} from "lucide-react";
import { CocoLegalIcon } from "@/components/chat/coco-legal-icon";
import { MarkdownContent } from "../shared/MarkdownContent";
import { RecordingCard } from "../recordings/RecordingCard";
import type {
    AssistantEvent,
    CapabilityResultEvent,
    CocoLegalCitationAnnotation,
    CocoLegalEditAnnotation,
    CocoLegalHighlightAnnotation,
    DraftQAFinding,
} from "../shared/types";
import { resolveCapabilityResultCard } from "../legal/cards";
import { EditCard, applyOptimisticResolution } from "./EditCard";
import { EmailApprovalCard } from "../legal/EmailApprovalCard";
import { EmailReceivedCard } from "../legal/EmailReceivedCard";
import { SignatureApprovalCard } from "../legal/SignatureApprovalCard";
import { EventApprovalCard } from "../legal/EventApprovalCard";
import { AuthoringCard } from "../authoring/AuthoringCard";
import { DocumentPacketCard } from "../authoring/DocumentPacketCard";
import { GeneratedImageCard } from "./GeneratedImageCard";
import { DraftQABlock } from "../authoring/DraftQABlock";
import type { QaStatus } from "../authoring/qaShared";
import { documentPacketEvents } from "../authoring/documentPacketState";
import { normalizeDocumentActionProse } from "@/app/lib/documentActionProse";
import { PreResponseWrapper } from "../shared/PreResponseWrapper";
import { supabase } from "@/lib/supabase";
import {
    applyDocumentHighlightSet,
    approveAssembleOperation,
    approveOperation,
    updateDocumentHighlightStatus,
} from "@/app/lib/cocoLegalApi";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";

function toolCallLabel(name: string): string {
    if (name === "draft_documents") return "Scheduling document packet...";
    if (name === "generate_docx") return "Creating document...";
    if (name === "create_clean_document") return "Creating clean document...";
    if (name === "edit_document") return "Editing document...";
    if (name === "read_document") return "Reading document...";
    if (name === "fetch_documents") return "Reading documents...";
    if (name === "find_in_document") return "Searching document...";
    if (name === "highlight_document") return "Creating highlights...";
    if (name === "remove_document_highlights") return "Removing highlights...";
    if (name === "replicate_document") return "Copying document...";
    if (name === "read_workflow") return "Loading workflow...";
    if (name === "list_workflows") return "Loading workflows...";
    if (name === "list_documents") return "Loading documents...";
    if (name === "legal_search") return "Researching legal sources...";
    if (name === "list_matters") return "Searching matters...";
    if (name === "get_matter_documents") return "Loading matter documents...";
    if (name === "search_cases") return "Searching cases...";
    if (name === "read_case") return "Reading case...";
    if (name === "generate_image") return "Creating image...";
    if (name === "edit_image") return "Editing image...";
    return name ? `Running ${name}...` : "Working...";
}

/**
 * Card rendered above the per-edit EditCards when a message produced
 * multiple tracked-change proposals. Lets the user resolve every pending
 * edit in one click by firing the per-edit accept/reject endpoint for each
 * pending annotation and forwarding each response to `onResolved` so the
 * parent can bump the viewer version, persist override URLs, etc.
 *
 * This intentionally doesn't apply the optimistic DOM mutation that
 * EditCard does — bulk operations touch many edits at once and the real
 * re-render from the latest version will reconcile within a second or so.
 */
function BulkEditActions({
    pending,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: {
        annotation: CocoLegalEditAnnotation;
        filename: string;
    }[];
    onViewClick?: (ann: CocoLegalEditAnnotation, filename: string) => void;
    onResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}) {
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [progress, setProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);

    if (pending.length === 0) return null;

    const handleAll = async (verb: "accept" | "reject") => {
        if (busy) return;
        setBusy(verb);
        setProgress({ done: 0, total: pending.length });
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            // Sequential so the per-document version counter advances in a
            // predictable order and the viewer doesn't race between bumps.
            let done = 0;
            for (const { annotation } of pending) {
                onResolveStart?.({
                    editId: annotation.edit_id,
                    documentId: annotation.document_id,
                    verb,
                });
                // Optimistically mutate the DOM so the viewer reflects the
                // resolution immediately. Revert if the backend call fails.
                let revert: (() => void) | null = null;
                try {
                    revert = applyOptimisticResolution(annotation, verb);
                } catch (e) {
                    console.error(
                        "[BulkEditActions] optimistic update threw",
                        e,
                    );
                }
                try {
                    const resp = await fetch(
                        `${API_BASE}/single-documents/${annotation.document_id}/edits/${annotation.edit_id}/${verb}`,
                        {
                            method: "POST",
                            headers: token
                                ? { Authorization: `Bearer ${token}` }
                                : undefined,
                        },
                    );
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = (await resp.json()) as {
                        ok: boolean;
                        status?: "accepted" | "rejected";
                        version_id: string | null;
                        download_url: string | null;
                    };
                    const nextStatus =
                        data.status ??
                        (verb === "accept" ? "accepted" : "rejected");
                    onResolved?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        status: nextStatus,
                        versionId: data.version_id,
                        downloadUrl: data.download_url,
                    });
                } catch (e) {
                    console.error("[BulkEditActions] resolve failed", e);
                    try {
                        revert?.();
                    } catch (revertErr) {
                        console.error(
                            "[BulkEditActions] revert threw",
                            revertErr,
                        );
                    }
                    onError?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        versionId: annotation.version_id ?? null,
                        message:
                            verb === "accept"
                                ? "Couldn't save one or more accepts."
                                : "Couldn't save one or more rejects.",
                    });
                }
                done++;
                setProgress({ done, total: pending.length });
            }
        } finally {
            setBusy(null);
            setProgress(null);
        }
    };

    // Optional: show a tiny "View first" action so bulk doesn't lose the
    // in-viewer scroll-to behaviour entirely.
    const first = pending[0];

    return (
        <div className="flex items-center gap-2">
            <button
                onClick={() => handleAll("accept")}
                disabled={!!busy}
                className="px-2 py-1 text-xs rounded border border-gray-900 bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 inline-flex items-center gap-1"
            >
                {busy === "accept" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Accept all
            </button>
            <button
                onClick={() => handleAll("reject")}
                disabled={!!busy}
                className="px-2 py-1 text-xs rounded border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50 inline-flex items-center gap-1"
            >
                {busy === "reject" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Reject all
            </button>
            {progress && (
                <span className="text-xs font-serif text-gray-500">
                    {progress.done}/{progress.total}
                </span>
            )}
            {onViewClick && first && (
                <button
                    onClick={() =>
                        onViewClick(first.annotation, first.filename)
                    }
                    disabled={!!busy}
                    className="ml-auto px-2 py-1 text-xs rounded border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                    View
                </button>
            )}
        </div>
    );
}

/**
 * Wraps the bulk accept/reject card and the per-edit EditCards in a single
 * minimisable container. The bulk actions and summary stay visible in the
 * header; the individual cards collapse via the chevron toggle.
 */
function EditCardsSection({
    pending,
    filenameByDocId,
    cards,
    resolvedCount,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: {
        annotation: CocoLegalEditAnnotation;
        filename: string;
    }[];
    filenameByDocId: Map<string, string>;
    cards: React.ReactNode[];
    resolvedCount: number;
    onViewClick?: (ann: CocoLegalEditAnnotation, filename: string) => void;
    onResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}) {
    const [isOpen, setIsOpen] = useState(true);
    if (cards.length === 0) return null;

    const docCount = filenameByDocId.size;
    const summary =
        pending.length > 0
            ? docCount > 1
                ? `${pending.length} tracked changes across ${docCount} documents`
                : `${pending.length} tracked ${pending.length === 1 ? "change" : "changes"}`
            : docCount > 1
              ? `${resolvedCount} resolved tracked changes across ${docCount} documents`
              : `${resolvedCount} resolved tracked ${resolvedCount === 1 ? "change" : "changes"}`;

    return (
        <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
            {/* Row 1: summary + chevron */}
            <div className="flex items-center gap-2 px-3 pt-3">
                <p className="flex-1 min-w-0 text-sm font-serif text-gray-700 truncate">
                    {summary}
                </p>
                <button
                    onClick={() => setIsOpen((v) => !v)}
                    aria-label={isOpen ? "Collapse edits" : "Expand edits"}
                    className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors"
                >
                    <ChevronDown
                        className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                </button>
            </div>
            {/* Row 2: bulk action buttons */}
            {pending.length > 0 && (
                <div className="px-3 pt-3">
                    <BulkEditActions
                        pending={pending}
                        onViewClick={onViewClick}
                        onResolveStart={onResolveStart}
                        onResolved={onResolved}
                        onError={onError}
                    />
                </div>
            )}
            {/* Row 3: collapsible cards list */}
            {isOpen && (
                <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
                    {cards}
                </div>
            )}
            {!isOpen && <div className="pb-3" />}
        </div>
    );
}

// ---------------------------------------------------------------------------
// ResponseStatus
// ---------------------------------------------------------------------------

type StatusState = "active" | "error" | null;

function ResponseStatus({ status }: { status: StatusState }) {
    const [showDone, setShowDone] = useState(false);
    const [doneVisible, setDoneVisible] = useState(false);
    const wasActiveRef = useRef(false);

    const isActive = status === "active";
    const isError = status === "error";

    useEffect(() => {
        if (wasActiveRef.current && !isActive) {
            const start = setTimeout(() => {
                setShowDone(true);
                setDoneVisible(true);
            }, 0);
            const finish = setTimeout(() => setDoneVisible(false), 1500);
            wasActiveRef.current = isActive;
            return () => {
                clearTimeout(start);
                clearTimeout(finish);
            };
        } else if (!wasActiveRef.current && isActive) {
            const reset = setTimeout(() => {
                setShowDone(false);
                setDoneVisible(false);
            }, 0);
            wasActiveRef.current = isActive;
            return () => clearTimeout(reset);
        }
        wasActiveRef.current = isActive;
    }, [isActive]);

    return (
        <div className="w-full h-9 flex items-center mb-2">
            <CocoLegalIcon
                spin={isActive}
                done={showDone && doneVisible}
                error={isError}
                cocoLegal={!isError && !(showDone && doneVisible)}
                size={22}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// Event block components
// ---------------------------------------------------------------------------

const THINKING_PHRASES = [
    "Thinking...",
    "Pondering...",
    "Analyzing...",
    "Reviewing...",
    "Reasoning...",
];

function ReasoningBlock({
    text,
    isStreaming,
    showConnector,
}: {
    text: string;
    isStreaming: boolean;
    showConnector?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [thinkingIndex, setThinkingIndex] = useState(0);

    useEffect(() => {
        if (!isStreaming) return;
        const interval = setInterval(() => {
            setThinkingIndex((i) => (i + 1) % THINKING_PHRASES.length);
        }, 2000);
        return () => clearInterval(interval);
    }, [isStreaming]);

    const showContent = isOpen || isStreaming;

    return (
        <div className="relative">
            {showConnector && (
                <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            <button
                onClick={() => !isStreaming && setIsOpen((v) => !v)}
                className="flex items-center text-sm font-serif text-gray-500 hover:text-gray-600 transition-colors"
            >
                {isStreaming ? (
                    <div className="w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
                ) : (
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />
                )}
                <span className="font-medium ml-2">
                    {isStreaming
                        ? THINKING_PHRASES[thinkingIndex]
                        : "Thought process"}
                </span>
                {!isStreaming && (
                    <ChevronDown
                        size={10}
                        className={`ml-1 self-center transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                )}
            </button>
            {showContent && (
                <div className="mt-2 ml-[14px] text-sm font-serif text-gray-400 prose prose-sm max-w-none [&>*]:text-gray-400 [&>*]:text-sm">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            code: ({ node, ...props }) => {
                                void node;
                                return (
                                    <code
                                        className="font-serif text-gray-600"
                                        {...props}
                                    />
                                );
                            },
                        }}
                    >
                        {text}
                    </ReactMarkdown>
                </div>
            )}
        </div>
    );
}

function DocReadBlock({
    filename,
    onClick,
    showConnector,
    isStreaming,
}: {
    filename: string;
    onClick?: () => void;
    showConnector?: boolean;
    isStreaming?: boolean;
}) {
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            {isStreaming ? (
                <div className="mt-2 w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
            ) : (
                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">
                    {isStreaming ? "Reading" : "Read"}
                </span>{" "}
                {isStreaming ? (
                    <span>{filename}...</span>
                ) : onClick ? (
                    <button
                        onClick={onClick}
                        className="text-left hover:text-gray-700 transition-colors cursor-pointer"
                    >
                        {filename}
                    </button>
                ) : (
                    <span>{filename}</span>
                )}
            </div>
        </div>
    );
}

function DocFindBlock({
    filename,
    query,
    totalMatches,
    isStreaming,
    showConnector,
}: {
    filename: string;
    query: string;
    totalMatches: number;
    isStreaming?: boolean;
    showConnector?: boolean;
}) {
    const label = isStreaming ? "Finding" : "Found";
    const matchSuffix = isStreaming
        ? ""
        : ` (${totalMatches} ${totalMatches === 1 ? "match" : "matches"})`;
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            {isStreaming ? (
                <div className="mt-2 w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
            ) : (
                <div
                    className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${totalMatches > 0 ? "bg-green-400" : "bg-gray-300"}`}
                />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">{label}</span>{" "}
                <span>
                    &ldquo;{query}&rdquo;{matchSuffix}
                    <span className="ml-1 text-gray-400">in {filename}</span>
                    {isStreaming && "..."}
                </span>
            </div>
        </div>
    );
}

function DocCreatedBlock({
    filename,
    showConnector,
    isStreaming,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
}) {
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            {isStreaming ? (
                <div className="mt-2 w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
            ) : (
                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">
                    {isStreaming ? "Creating" : "Created"}
                </span>{" "}
                <span>{isStreaming ? `${filename}...` : filename}</span>
            </div>
        </div>
    );
}

function DocReplicatedBlock({
    filename,
    count,
    showConnector,
    isStreaming,
    hasError,
}: {
    filename: string;
    /**
     * How many consecutive replicates of this same source got collapsed
     * into this block. ≥ 1; only rendered when > 1.
     */
    count: number;
    showConnector?: boolean;
    isStreaming?: boolean;
    hasError?: boolean;
}) {
    const label = isStreaming ? "Replicating" : "Replicated";
    const suffix =
        !isStreaming && count > 1
            ? ` ${count} times`
            : isStreaming
              ? "..."
              : "";
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            {isStreaming ? (
                <div className="mt-2 w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
            ) : (
                <div
                    className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${hasError ? "bg-red-400" : "bg-green-400"}`}
                />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">{label}</span>{" "}
                <span>
                    {filename}
                    {suffix}
                </span>
            </div>
        </div>
    );
}

function DocDownloadBlock({
    filename,
    download_url,
    onOpen,
    onReveal,
    isReloading = false,
    versionNumber,
    statusLabel = "Ready to download",
    description,
}: {
    filename: string;
    download_url: string;
    onOpen?: () => void;
    onReveal?: () => void;
    isReloading?: boolean;
    versionNumber?: number | null;
    statusLabel?: string;
    description?: string;
}) {
    const hasVersion =
        typeof versionNumber === "number" &&
        Number.isFinite(versionNumber) &&
        versionNumber > 0;
    const extMatch = filename.match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1].toUpperCase() : "FILE";
    const rawBasename = extMatch
        ? filename.slice(0, -extMatch[0].length)
        : filename;
    // Strip any legacy "[Edited V3]" suffix that may still be baked into
    // older saved download filenames — the version is surfaced as a
    // separate tag now.
    const basename = rawBasename.replace(/\s*\[Edited V\d+\]\s*$/, "").trim();
    // Only backend-relative URLs are accepted. The download fetch carries
    // the user's bearer token, so any absolute URL from tool output is
    // refused to keep the token from leaking off-origin.
    const isSafeHref = download_url.startsWith("/");
    const href = isSafeHref ? `${API_BASE}${download_url}` : null;
    const [busy, setBusy] = useState(false);

    const handleDownload = async (e?: {
        stopPropagation?: () => void;
        preventDefault?: () => void;
    }) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        if (busy || isReloading || !href) return;
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

    const spinning = busy || isReloading;

    const body = (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                <Check className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1 py-0.5">
                <p className="text-xs font-medium text-emerald-700">
                    {statusLabel}
                </p>
                <div className="flex items-center gap-2 min-w-0">
                    <p className="text-base font-serif text-gray-900 text-wrap leading-snug">
                        {basename}
                    </p>
                    {hasVersion && (
                        <span className="shrink-0 inline-flex items-center rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            V{versionNumber}
                        </span>
                    )}
                </div>
                <p className="mt-1 text-xs leading-4 text-gray-500">
                    {description ?? `${ext} file`}
                </p>
            </div>
        </div>
    );

    const downloadIcon = spinning ? (
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
    );

    const revealIcon = onReveal ? (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                onReveal();
            }}
            className="shrink-0 flex items-center border-l border-gray-200 px-3 bg-white text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors cursor-pointer"
            title="Reveal in Explorer"
        >
            <ListTree size={13} />
        </button>
    ) : null;

    if (onOpen) {
        return (
            <div className="flex items-stretch border border-gray-200 rounded-lg overflow-hidden w-full font-sans bg-gray-50 shadow-sm">
                <button
                    type="button"
                    onClick={onOpen}
                    className="flex items-stretch flex-1 min-w-0 text-left hover:bg-gray-100 transition-colors cursor-pointer"
                    title="Open document"
                >
                    {body}
                </button>
                {revealIcon}
                {downloadIcon}
            </div>
        );
    }

    if (spinning) {
        return (
            <div className="flex items-stretch border border-gray-200 rounded-lg overflow-hidden w-full font-sans bg-gray-50 shadow-sm">
                {body}
                {revealIcon}
                {downloadIcon}
            </div>
        );
    }

    return (
        <div className="flex items-stretch border border-gray-200 rounded-lg overflow-hidden w-full font-sans bg-gray-50 shadow-sm">
            <button
                type="button"
                onClick={handleDownload}
                className="flex items-stretch flex-1 min-w-0 text-left hover:bg-gray-100 transition-colors cursor-pointer"
                title="Download file"
            >
                {body}
            </button>
            {revealIcon}
            {downloadIcon}
        </div>
    );
}

function WorkflowAppliedBlock({
    title,
    showConnector,
    onClick,
}: {
    title: string;
    showConnector?: boolean;
    onClick?: () => void;
}) {
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            <div className="mt-2 w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">Applied Workflow</span>{" "}
                {onClick ? (
                    <button
                        onClick={onClick}
                        className="text-left hover:text-gray-700 transition-colors cursor-pointer"
                    >
                        {title}
                    </button>
                ) : (
                    <span>{title}</span>
                )}
            </div>
        </div>
    );
}

/**
 * `list_matters` — a matter lookup. Modelled on DocFindBlock: the leading dot
 * is green when the lookup found something and grey when it came back empty,
 * so a fruitless lookup reads as a deliberate step rather than a blank row.
 */
function MatterSearchBlock({
    query,
    count,
    matters,
    showConnector,
}: {
    query: string | null;
    count: number;
    /** A sample of the matches — may be shorter than `count`. */
    matters: { matter_id: string; name: string }[];
    showConnector?: boolean;
}) {
    const names = matters.map((m) => m.name).filter(Boolean);
    // Names are a capped sample, so only present them as the full answer
    // when we actually have one entry per match.
    const nameList =
        names.length > 0
            ? `: ${names.join(", ")}${names.length < count ? "…" : ""}`
            : "";
    const summary =
        count === 0 ? "(no matches)" : `(${count} found${nameList})`;
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            <div
                className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${count > 0 ? "bg-green-400" : "bg-gray-300"}`}
            />
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">
                    {query ? "Searched matters" : "Listed matters"}
                </span>{" "}
                <span>
                    {query && <>&ldquo;{query}&rdquo; </>}
                    {summary}
                </span>
            </div>
        </div>
    );
}

/** `get_matter_documents` — the matter's documents are now readable. */
function MatterDocumentsLoadedBlock({
    matterName,
    documentCount,
    readableCount,
    truncated,
    showConnector,
}: {
    matterName: string;
    /** Every document filed in the matter (what the matter list shows). */
    documentCount: number;
    /** How many were actually opened — absent on older persisted events. */
    readableCount?: number;
    truncated: boolean;
    showConnector?: boolean;
}) {
    // The card must not claim it loaded documents it only counted: when the
    // matter holds more than came back, say "4 of 6".
    const loaded = readableCount ?? documentCount;
    const docWord = documentCount === 1 ? "document" : "documents";
    const countLabel =
        loaded < documentCount ? `${loaded} of ${documentCount}` : `${loaded}`;
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            <div
                className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${loaded > 0 ? "bg-green-400" : "bg-gray-300"}`}
            />
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">Loaded matter documents</span>{" "}
                <span>
                    {countLabel} {docWord}
                    {matterName && (
                        <span className="ml-1 text-gray-400">
                            from {matterName}
                        </span>
                    )}
                    {truncated && (
                        <span className="ml-1 text-gray-400">
                            (partial listing)
                        </span>
                    )}
                </span>
            </div>
        </div>
    );
}

/** `search_cases` — the personal-injury case registry lookup. */
function CaseSearchBlock({
    query,
    count,
    error,
    showConnector,
}: {
    query: string | null;
    count: number;
    /** Set when the lookup failed — never render that as "no matches". */
    error?: string;
    showConnector?: boolean;
}) {
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            <div
                className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${
                    error
                        ? "bg-amber-400"
                        : count > 0
                          ? "bg-green-400"
                          : "bg-gray-300"
                }`}
            />
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">
                    {query ? "Searched PI cases" : "Listed PI cases"}
                </span>{" "}
                <span>
                    {query && <>&ldquo;{query}&rdquo; </>}
                    {error
                        ? "(lookup failed)"
                        : count === 0
                          ? "(no matches)"
                          : `(${count} found)`}
                </span>
            </div>
        </div>
    );
}

function LegalSearchBlock({
    query,
    providers,
    resultCount,
    warnings,
    results,
    showConnector,
}: {
    query: string;
    providers: string[];
    resultCount: number;
    warnings: string[];
    results: Extract<AssistantEvent, { type: "legal_search" }>["results"];
    showConnector?: boolean;
}) {
    return (
        <div className="relative">
            {showConnector && (
                <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
            )}
            <div className="flex items-start text-sm font-serif text-gray-500">
                <div className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600 ring-1 ring-blue-100">
                    <Search className="h-3 w-3" />
                </div>
                <div className="ml-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-gray-700">
                            Legal research
                        </span>
                        <span className="text-gray-400">
                            {resultCount} source{resultCount === 1 ? "" : "s"}
                        </span>
                        {providers.length > 0 && (
                            <span className="text-gray-400">
                                via {providers.join(", ")}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-gray-400 line-clamp-2">
                        {query}
                    </p>
                    {results.length > 0 && (
                        <div className="mt-3 space-y-2 rounded-lg border border-gray-200 bg-white p-3 font-sans">
                            {results.slice(0, 5).map((result) => (
                                <a
                                    key={`${result.provider}-${result.url}`}
                                    href={result.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="group block rounded-md border border-gray-100 bg-gray-50 px-3 py-2 transition-colors hover:border-blue-200 hover:bg-blue-50/60"
                                >
                                    <div className="flex items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-gray-500">
                                                <span className="rounded bg-white px-1.5 py-0.5 text-gray-700 ring-1 ring-gray-200">
                                                    {result.sourceType}
                                                </span>
                                                <span>
                                                    {(
                                                        result.providers ?? [
                                                            result.provider,
                                                        ]
                                                    ).join(", ")}
                                                </span>
                                                <span>
                                                    {Math.round(
                                                        result.confidence * 100,
                                                    )}
                                                    % confidence
                                                </span>
                                            </div>
                                            <p className="mt-1 truncate text-sm font-medium text-gray-900 group-hover:text-blue-700">
                                                {result.title}
                                            </p>
                                            {(result.snippet ||
                                                result.highlights?.[0]) && (
                                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                                                    {result.snippet ??
                                                        result.highlights?.[0]}
                                                </p>
                                            )}
                                        </div>
                                        <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-gray-300 group-hover:text-blue-500" />
                                    </div>
                                </a>
                            ))}
                        </div>
                    )}
                    {warnings.length > 0 && (
                        <p className="mt-2 text-xs text-amber-600">
                            {warnings.join(" ")}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Read the assemble_document result off an approved operation's loosely-typed
 * metadata. The approve endpoint reconciles the authored doc + QA payload onto
 * the operation (operations.ts), so result_document_id / result_version_id carry
 * the new doc and metadata carries { qa_status, qa_findings, download_url,
 * filename, version_number }. Returns null until the assemble op has succeeded
 * with a result document.
 */
function readAuthoringResult(
    operation: Extract<
        AssistantEvent,
        { type: "operation_created" }
    >["operation"],
): {
    documentId: string;
    versionId?: string;
    filename: string;
    versionNumber?: number;
    downloadUrl?: string;
    qaStatus?: QaStatus;
    qaFindings: DraftQAFinding[];
} | null {
    if (operation.tool_name !== "assemble_document") return null;
    if (operation.status !== "succeeded") return null;
    if (!operation.result_document_id) return null;
    const meta = (operation.metadata ?? {}) as Record<string, unknown>;
    const qaStatusRaw = meta.qa_status;
    const qaStatus: QaStatus | undefined =
        qaStatusRaw === "passed" ||
        qaStatusRaw === "advisory" ||
        qaStatusRaw === "blocked"
            ? qaStatusRaw
            : undefined;
    return {
        documentId: operation.result_document_id,
        versionId: operation.result_version_id ?? undefined,
        filename:
            typeof meta.filename === "string" && meta.filename
                ? meta.filename
                : "Assembled document.docx",
        versionNumber:
            typeof meta.version_number === "number"
                ? meta.version_number
                : undefined,
        downloadUrl:
            typeof meta.download_url === "string"
                ? meta.download_url
                : undefined,
        qaStatus,
        qaFindings: Array.isArray(meta.qa_findings)
            ? (meta.qa_findings as DraftQAFinding[])
            : [],
    };
}

function OperationCreatedBlock({
    event,
    showConnector,
    onOperationApplied,
    onOpenDocument,
}: {
    event: Extract<AssistantEvent, { type: "operation_created" }>;
    showConnector?: boolean;
    onOperationApplied?: (
        operation: Extract<
            AssistantEvent,
            { type: "operation_created" }
        >["operation"],
    ) => void;
    onOpenDocument?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => void;
}) {
    const [operation, setOperation] = useState(event.operation);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // For an approved assemble_document op, the heavy work runs as a DETACHED
    // background job: approving returns a job id, and this card OWNS the poll
    // (via AuthoringCard's poll mode) — assembling → qa → produced doc + QA, or
    // an error. Set when approved THIS session.
    const [assembleJobId, setAssembleJobId] = useState<string | null>(null);
    const isAssemble = operation.tool_name === "assemble_document";
    const pending =
        operation.status === "pending_approval" &&
        operation.approval_status === "required";
    // An assemble op already reconciled onto the operation (e.g. on a history
    // reload after the worker finished) carries the authored doc + QA on its
    // metadata; surface that statically. While polling a fresh approve, the live
    // job result is rendered by AuthoringCard instead.
    const authoringResult = readAuthoringResult(operation);

    const approve = async () => {
        if (!pending || busy) return;
        setBusy(true);
        setError(null);
        try {
            if (isAssemble) {
                // Async assemble: kick off the detached job and hand its id to
                // the poll-aware AuthoringCard. The op stays "running" until the
                // worker reconciles it; we don't block on the result here.
                const { job_id } = await approveAssembleOperation(operation.id);
                setAssembleJobId(job_id);
                setOperation((prev) => ({ ...prev, status: "running" }));
                return;
            }
            const approved = await approveOperation(operation.id);
            setOperation(approved);
            const docId =
                approved.result_document_id ?? approved.source_document_id;
            if (docId) invalidateDocxBytes(docId);
            if (approved.result_version_id) onOperationApplied?.(approved);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not approve this operation.",
            );
        } finally {
            setBusy(false);
        }
    };

    // The assemble op is "in progress" once we've kicked off the job (and stays
    // so until the poll resolves). Drives the button copy/disabled state.
    const assembleInFlight = isAssemble && assembleJobId !== null;
    const onOpenAuthored = onOpenDocument
        ? (args: {
              documentId: string;
              versionId?: string;
              filename: string;
          }) => {
              // Fresh bytes for the just-produced doc before the viewer opens.
              invalidateDocxBytes(args.documentId);
              onOpenDocument({
                  documentId: args.documentId,
                  filename: args.filename,
                  versionId: args.versionId ?? null,
                  versionNumber: authoringResult?.versionNumber ?? null,
              });
          }
        : undefined;

    return (
        <div className="relative">
            {showConnector && (
                <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
            )}
            <div className="flex items-start text-sm font-serif text-gray-500">
                <div className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200">
                    <ShieldCheck className="h-3 w-3" />
                </div>
                <div className="ml-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-gray-700">
                            Approval required
                        </span>
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                            {operation.status.replace(/_/g, " ")}
                        </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-400 line-clamp-2">
                        {event.summary ??
                            operation.action_type.replace(/_/g, " ")}
                    </p>
                    {/* Hide the approval affordance once an assemble job is in
                        flight — the poll card below owns all live state (and
                        re-arms via its retry on failure). */}
                    {!assembleInFlight && (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 font-sans">
                            <p className="text-xs leading-5 text-amber-950">
                                This document-changing action has been prepared
                                but has not been applied yet.
                                {event.filename
                                    ? ` Document: ${event.filename}.`
                                    : ""}
                            </p>
                            {error && (
                                <p className="mt-2 text-xs leading-5 text-red-700">
                                    {error}
                                </p>
                            )}
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={approve}
                                    disabled={!pending || busy}
                                    className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                                >
                                    {busy ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : operation.status === "succeeded" ? (
                                        <Check className="h-3.5 w-3.5" />
                                    ) : (
                                        <ShieldCheck className="h-3.5 w-3.5" />
                                    )}
                                    {operation.status === "succeeded"
                                        ? "Applied"
                                        : "Approve and apply"}
                                </button>
                            </div>
                        </div>
                    )}
                    {/* Assembled-draft result. Fresh approve this session →
                        AuthoringCard polls the background job (assembling → qa →
                        produced doc + QA, or an error). History reload of a
                        finished op → render the reconciled result statically. */}
                    {assembleJobId ? (
                        <div className="mt-3">
                            <AuthoringCard
                                jobId={assembleJobId}
                                onRetry={() => {
                                    // Re-arm: clear the job so the card drops back
                                    // to the approve affordance, then re-approve.
                                    setAssembleJobId(null);
                                    setOperation((prev) => ({
                                        ...prev,
                                        status: "pending_approval",
                                        approval_status: "required",
                                    }));
                                }}
                                onOpen={onOpenAuthored}
                            />
                        </div>
                    ) : (
                        authoringResult && (
                            <div className="mt-3">
                                <AuthoringCard
                                    documentId={authoringResult.documentId}
                                    versionId={authoringResult.versionId}
                                    filename={authoringResult.filename}
                                    versionNumber={
                                        authoringResult.versionNumber
                                    }
                                    downloadUrl={authoringResult.downloadUrl}
                                    qaStatus={authoringResult.qaStatus}
                                    qaFindings={authoringResult.qaFindings}
                                    onOpen={onOpenAuthored}
                                />
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>
    );
}

type HighlightEvent = Extract<AssistantEvent, { type: "doc_highlighted" }>;

function DocHighlightsBlock({
    event,
    showConnector,
    onView,
    onChanged,
}: {
    event: HighlightEvent;
    showConnector?: boolean;
    onView?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
        title: string;
        highlights: CocoLegalHighlightAnnotation[];
        activeHighlightId?: string | null;
    }) => void;
    onChanged?: (args: {
        setId: string;
        documentId: string;
        highlights: CocoLegalHighlightAnnotation[];
    }) => void;
}) {
    const [highlights, setHighlights] = useState(event.highlights);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);
    const [applyError, setApplyError] = useState<string | null>(null);
    const [applyResult, setApplyResult] = useState<{
        versionId: string;
        versionNumber: number;
        appliedCount: number;
        errors: { quote: string; occurrence_index: number; reason: string }[];
    } | null>(null);
    const autoOpenedSetRef = useRef<string | null>(null);

    useEffect(() => {
        setHighlights(event.highlights);
        setApplyError(null);
        setApplyResult(null);
    }, [event.highlight_set_id, event.highlights]);

    const keptHighlights = highlights.filter((h) => h.status !== "removed");
    const removedCount = highlights.length - keptHighlights.length;
    const allKeptApplied =
        keptHighlights.length > 0 &&
        keptHighlights.every((highlight) => highlight.status === "applied");
    const isDocx = /\.(docx|doc)$/i.test(event.filename);
    const currentVersionId = applyResult?.versionId ?? event.version_id ?? null;
    const currentVersionNumber =
        applyResult?.versionNumber ?? event.version_number ?? null;
    const groups = (() => {
        const counts = new Map<string, number>();
        for (const h of keptHighlights) {
            counts.set(h.label, (counts.get(h.label) ?? 0) + 1);
        }
        return [...counts.entries()].map(([label, count]) => ({
            label,
            count,
        }));
    })();

    const notifyChanged = (next: CocoLegalHighlightAnnotation[]) => {
        onChanged?.({
            setId: event.highlight_set_id,
            documentId: event.document_id,
            highlights: next,
        });
    };

    const openHighlight = (highlight?: CocoLegalHighlightAnnotation | null) => {
        onView?.({
            documentId: event.document_id,
            filename: event.filename,
            versionId: currentVersionId,
            versionNumber: currentVersionNumber,
            title: event.title,
            highlights,
            activeHighlightId: highlight?.id ?? null,
        });
    };

    useEffect(() => {
        if (event.isStreaming || !onView || event.highlights.length === 0) {
            return;
        }
        const key =
            event.highlight_set_id ||
            `${event.document_id}:${event.title}:${event.total}`;
        if (autoOpenedSetRef.current === key) return;
        autoOpenedSetRef.current = key;
        const firstKept =
            event.highlights.find((h) => h.status !== "removed") ??
            event.highlights[0];
        onView({
            documentId: event.document_id,
            filename: event.filename,
            versionId: event.version_id ?? null,
            versionNumber: event.version_number ?? null,
            title: event.title,
            highlights: event.highlights,
            activeHighlightId: firstKept?.id ?? null,
        });
    }, [
        event.document_id,
        event.filename,
        event.highlight_set_id,
        event.highlights,
        event.isStreaming,
        event.title,
        event.total,
        event.version_id,
        event.version_number,
        onView,
    ]);

    const setHighlightStatus = async (
        highlight: CocoLegalHighlightAnnotation,
        status: "kept" | "removed",
    ) => {
        if (!event.highlight_set_id || busyId) return;
        setBusyId(highlight.id);
        setApplyError(null);
        const previous = highlights;
        const optimistic = highlights.map((h) =>
            h.id === highlight.id ? { ...h, status } : h,
        );
        setHighlights(optimistic);
        notifyChanged(optimistic);
        try {
            const { highlight: saved } = await updateDocumentHighlightStatus(
                event.document_id,
                event.highlight_set_id,
                highlight.id,
                status,
            );
            const next = optimistic.map((h) =>
                h.id === highlight.id ? saved : h,
            );
            setHighlights(next);
            notifyChanged(next);
        } catch {
            setHighlights(previous);
            notifyChanged(previous);
            setApplyError("Could not update that highlight. Please retry.");
        } finally {
            setBusyId(null);
        }
    };

    const applyHighlights = async () => {
        if (!isDocx || applying || keptHighlights.length === 0) return;
        setApplying(true);
        setApplyError(null);
        try {
            const result = await applyDocumentHighlightSet(
                event.document_id,
                event.highlight_set_id,
                keptHighlights,
            );
            invalidateDocxBytes(event.document_id);
            const appliedIds = new Set(
                result.applied_highlight_ids?.length
                    ? result.applied_highlight_ids
                    : keptHighlights
                          .slice(0, result.applied_count)
                          .map((h) => h.id),
            );
            const next = highlights.map((h) =>
                appliedIds.has(h.id)
                    ? {
                          ...h,
                          version_id: result.version_id,
                          status: "applied" as const,
                      }
                    : h,
            );
            setHighlights(next);
            notifyChanged(next);
            setApplyResult({
                versionId: result.version_id,
                versionNumber: result.version_number,
                appliedCount: result.applied_count,
                errors: result.errors,
            });
            onView?.({
                documentId: event.document_id,
                filename: event.filename,
                versionId: result.version_id,
                versionNumber: result.version_number,
                title: event.title,
                highlights: next,
                activeHighlightId: next.find((h) => h.status !== "removed")?.id,
            });
        } catch (err) {
            setApplyError(
                err instanceof Error
                    ? err.message
                    : "Could not apply highlights to the DOCX.",
            );
        } finally {
            setApplying(false);
        }
    };

    return (
        <div className="relative">
            {showConnector && (
                <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
            )}
            <div className="flex items-start text-sm font-serif text-gray-500">
                <div className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-yellow-50 text-yellow-700 ring-1 ring-yellow-200">
                    {event.isStreaming ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                        <Highlighter className="h-3 w-3" />
                    )}
                </div>
                <div className="ml-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-gray-700">
                            {event.isStreaming
                                ? "Finding highlights"
                                : "Highlights found"}
                        </span>
                        <span className="text-gray-400">
                            {keptHighlights.length} kept
                        </span>
                        {removedCount > 0 && (
                            <span className="text-gray-400">
                                {removedCount} removed
                            </span>
                        )}
                        {applyResult && (
                            <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-[11px] font-medium text-yellow-900">
                                V{applyResult.versionNumber}
                            </span>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-gray-400 line-clamp-2">
                        {event.title} in {event.filename}
                    </p>

                    <div className="mt-3 rounded-lg border border-yellow-200 bg-yellow-50/70 p-3 font-sans">
                        {groups.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {groups.map((group) => (
                                    <button
                                        type="button"
                                        key={group.label}
                                        onClick={() => openHighlight()}
                                        className="rounded-full border border-yellow-200 bg-white px-2 py-1 text-[11px] font-medium text-yellow-950 hover:bg-yellow-100"
                                    >
                                        {group.label}: {group.count}
                                    </button>
                                ))}
                            </div>
                        )}

                        {highlights.length > 0 ? (
                            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                                {highlights.map((highlight, index) => {
                                    const removed =
                                        highlight.status === "removed";
                                    const busy = busyId === highlight.id;
                                    return (
                                        <div
                                            key={highlight.id}
                                            className={`rounded-md border px-3 py-2 transition-colors ${
                                                removed
                                                    ? "border-gray-200 bg-white/70 opacity-60"
                                                    : "border-yellow-200 bg-white"
                                            }`}
                                        >
                                            <div className="flex items-start gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        openHighlight(highlight)
                                                    }
                                                    disabled={removed}
                                                    className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                                                >
                                                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-gray-500">
                                                        <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-yellow-950">
                                                            {highlight.label}
                                                        </span>
                                                        <span>
                                                            #{index + 1}
                                                        </span>
                                                        {highlight.page && (
                                                            <span>
                                                                Page{" "}
                                                                {highlight.page}
                                                            </span>
                                                        )}
                                                        {highlight.status ===
                                                            "applied" && (
                                                            <span className="text-green-700">
                                                                Applied
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="mt-1 text-sm leading-5 text-gray-900">
                                                        &ldquo;{highlight.quote}
                                                        &rdquo;
                                                    </p>
                                                    {highlight.context && (
                                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
                                                            {highlight.context}
                                                        </p>
                                                    )}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setHighlightStatus(
                                                            highlight,
                                                            removed
                                                                ? "kept"
                                                                : "removed",
                                                        )
                                                    }
                                                    disabled={busy || applying}
                                                    className={`shrink-0 rounded border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                                                        removed
                                                            ? "border-gray-200 bg-white text-gray-700 hover:bg-gray-100"
                                                            : "border-yellow-300 bg-yellow-100 text-yellow-950 hover:bg-yellow-200"
                                                    }`}
                                                >
                                                    {busy ? (
                                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    ) : removed ? (
                                                        "Keep"
                                                    ) : (
                                                        "Remove"
                                                    )}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="mt-3 text-xs text-gray-500">
                                {event.isStreaming
                                    ? "Preparing exact document anchors..."
                                    : "No validated highlight anchors were saved."}
                            </p>
                        )}

                        {(event.truncated ||
                            event.failed_matches.length > 0 ||
                            applyError ||
                            applyResult?.errors.length) && (
                            <div className="mt-3 space-y-1 text-xs text-amber-700">
                                {event.truncated && (
                                    <p>
                                        Results were capped at 200 highlights
                                        for review.
                                    </p>
                                )}
                                {event.failed_matches
                                    .slice(0, 3)
                                    .map((fail) => (
                                        <p key={`${fail.label}-${fail.query}`}>
                                            Could not match {fail.label}:{" "}
                                            {fail.reason}
                                        </p>
                                    ))}
                                {applyResult?.errors.slice(0, 2).map((err) => (
                                    <p
                                        key={`${err.quote}-${err.occurrence_index}`}
                                    >
                                        Could not apply &ldquo;{err.quote}
                                        &rdquo;: {err.reason}
                                    </p>
                                ))}
                                {applyError && <p>{applyError}</p>}
                            </div>
                        )}

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => openHighlight(keptHighlights[0])}
                                disabled={keptHighlights.length === 0}
                                className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Review in document
                            </button>
                            <button
                                type="button"
                                onClick={applyHighlights}
                                disabled={
                                    !isDocx ||
                                    applying ||
                                    keptHighlights.length === 0 ||
                                    allKeptApplied ||
                                    !!event.isStreaming
                                }
                                className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                                title={
                                    isDocx
                                        ? undefined
                                        : "Native Word highlights are available for DOCX files only."
                                }
                            >
                                {applying && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                )}
                                {allKeptApplied
                                    ? "Highlights applied to DOCX"
                                    : "Apply kept highlights to DOCX"}
                            </button>
                            {!isDocx && (
                                <span className="text-xs text-gray-500">
                                    PDF export is viewer-only in this version.
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function TemplateCreatedBlock({
    title,
    docType,
    showConnector,
}: {
    title: string;
    docType: string;
    showConnector?: boolean;
}) {
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">Template created:</span>{" "}
                <span>
                    {title}
                    {docType ? ` (${docType})` : ""}
                </span>
            </div>
        </div>
    );
}

function DocEditedBlock({
    filename,
    showConnector,
    isStreaming,
    hasError,
    error,
    errorCode,
    retryable,
    target,
    resolution,
    candidates,
    isCleanOutput,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
    hasError?: boolean;
    error?: string;
    errorCode?: string;
    retryable?: boolean;
    target?: { version_id: string | null; version_number: number | null };
    resolution?: Record<string, unknown>;
    candidates?: Record<string, unknown>[];
    isCleanOutput?: boolean;
}) {
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && (
                <div className="absolute left-0 top-0 bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
            )}
            {isStreaming ? (
                <div className="mt-2 w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
            ) : hasError ? (
                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
            ) : (
                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                <span className="font-medium">
                    {isStreaming
                        ? isCleanOutput
                            ? "Preparing clean copy"
                            : "Editing"
                        : hasError
                          ? isCleanOutput
                              ? "Clean copy not created"
                              : "Edit not applied"
                          : isCleanOutput
                            ? "Clean copy ready"
                            : "Edited"}
                </span>{" "}
                <span>{isStreaming ? `${filename}...` : filename}</span>
                {hasError && error && (
                    <div className="mt-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 font-sans text-xs text-red-800">
                        <div>{error}</div>
                        <div className="mt-1 text-[11px] text-red-700/80">
                            {errorCode ? `${errorCode} · ` : ""}
                            {target?.version_number
                                ? `Target V${target.version_number}`
                                : target?.version_id
                                  ? `Target ${target.version_id.slice(0, 8)}`
                                  : "No target version"}
                            {retryable ? " · Retryable" : ""}
                        </div>
                        {Array.isArray(resolution?.choices) && (
                            <div className="mt-1">
                                Choose:{" "}
                                {(resolution.choices as string[]).join(", ")}.
                            </div>
                        )}
                        {!!candidates?.length && (
                            <ul className="mt-1 list-disc pl-4">
                                {candidates.map((candidate, index) => (
                                    <li
                                        key={String(
                                            candidate.document_id ?? index,
                                        )}
                                    >
                                        {String(
                                            candidate.filename ?? "Document",
                                        )}{" "}
                                        ·{" "}
                                        {String(
                                            candidate.document_id ?? "",
                                        ).slice(0, 8)}
                                        {typeof candidate.version_number ===
                                        "number"
                                            ? ` · V${candidate.version_number}`
                                            : ""}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Citation preprocessing
// ---------------------------------------------------------------------------

function preprocessCitations(
    text: string,
    annotations: CocoLegalCitationAnnotation[],
    citationsList: CocoLegalCitationAnnotation[],
): string {
    // Replace [N] or [N, M, ...] inline markers with internal §idx§ tokens backed by annotations
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const ann = annotations.find((a) => a.ref === ref);
            if (!ann) return [];
            const idx = citationsList.length;
            citationsList.push(ann);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
    content: string;
    events?: AssistantEvent[];
    documentPacketJobIds?: ReadonlySet<string>;
    isStreaming?: boolean;
    isError?: boolean;
    /** Human-readable error text rendered alongside the red Coco Legal icon. */
    errorMessage?: string;
    annotations?: CocoLegalCitationAnnotation[];
    onCitationClick?: (citation: CocoLegalCitationAnnotation) => void;
    minHeight?: string;
    onWorkflowClick?: (workflowId: string) => void;
    onEditViewClick?: (ann: CocoLegalEditAnnotation, filename: string) => void;
    onHighlightViewClick?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
        title: string;
        highlights: CocoLegalHighlightAnnotation[];
        activeHighlightId?: string | null;
    }) => void;
    onHighlightSetChange?: (args: {
        setId: string;
        documentId: string;
        highlights: CocoLegalHighlightAnnotation[];
    }) => void;
    onOperationApplied?: (
        operation: Extract<
            AssistantEvent,
            { type: "operation_created" }
        >["operation"],
    ) => void;
    /**
     * Opens the editor panel for a document without auto-highlighting any
     * specific edit. Used by the download card click — opening a doc to
     * read/download shouldn't jump the viewer to the first edit.
     */
    onOpenDocument?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => void;
    onRevealDocument?: (documentId: string) => void;
    /**
     * Fires immediately when the user clicks Accept / Reject (single card
     * or the bulk "Accept all" / "Reject all"), before the backend call.
     * Parents use this to flip download cards / editor viewers into a
     * "saving" state for the duration of the round-trip.
     */
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    isDocReloading?: (documentId: string) => boolean;
    /**
     * True while an accept/reject request for this specific edit is in
     * flight. Used to disable just that edit's Accept/Reject controls
     * (sibling edits on the same doc stay clickable).
     */
    isEditReloading?: (editId: string) => boolean;
    /**
     * External override for individual edit statuses. When present, an
     * EditCard looks up its edit_id here and treats the mapped value
     * ("accepted" / "rejected") as authoritative — used so bulk-resolved
     * edits flip their per-card UI without per-card clicks.
     */
    resolvedEditStatuses?: Record<string, "accepted" | "rejected">;
    /** Start a text-instruction edit of a generated image (binds it as the source). */
    onEditImage?: (documentId: string, filename: string) => void;
    /** Regenerate a generated image from its original prompt. */
    onRegenerateImage?: (prompt: string) => void;
    /** Attach a generated image to a new email draft. */
    onAttachImageToEmail?: (documentId: string, filename: string) => void;
    /** Chat + message ids — the address of a capability result's DOCX export. */
    chatId?: string | null;
    messageId?: string | null;
    /** Which surface this message renders on (capability telemetry only). */
    surface?: "chat" | "matter";
    /** Re-run a failed capability result with the inputs it recorded. */
    onRetryCapabilityRun?: (args: {
        capabilityId: string;
        proposalId: string | null;
        title: string;
        retry: NonNullable<CapabilityResultEvent["retry"]>;
    }) => void;
}

export function AssistantMessage({
    content,
    events: eventsProp,
    documentPacketJobIds,
    isStreaming = false,
    isError = false,
    errorMessage,
    annotations = [],
    onCitationClick,
    minHeight = "0px",
    onWorkflowClick,
    onEditViewClick,
    onHighlightViewClick,
    onHighlightSetChange,
    onOperationApplied,
    onOpenDocument,
    onRevealDocument,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    isDocReloading,
    isEditReloading,
    resolvedEditStatuses,
    onEditImage,
    onRegenerateImage,
    onAttachImageToEmail,
    chatId = null,
    messageId = null,
    surface = "chat",
    onRetryCapabilityRun,
}: Props) {
    // T4 carry-forward (double-render suppression): a `recording_summary`
    // message ALSO carries a plain { type:"content", text: summary_md } lead-in
    // block (backend recordings/postToChat.ts) so pre-T12 clients still show the
    // summary. Now that the recording_summary block renders natively, drop that
    // duplicate content block — matched by EXACT text so any unrelated prose in
    // the same message survives. Filtered once here, at the message→block
    // boundary, so every downstream consumer (groups, processedTexts, the
    // download-card scans) sees the de-duped list.
    const recordingSummaryText = (eventsProp ?? []).find(
        (e): e is Extract<AssistantEvent, { type: "recording_summary" }> =>
            e.type === "recording_summary",
    )?.summary_md;
    const events =
        recordingSummaryText !== undefined
            ? (eventsProp ?? []).filter(
                  (e) =>
                      !(
                          e.type === "content" &&
                          e.text === recordingSummaryText
                      ),
              )
            : eventsProp;
    const contentDivRef = useRef<HTMLDivElement | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    // Per-document override of the download URL, set as Accept/Reject resolves
    // each tracked change and produces a new version.
    const [resolvedOverrides, setResolvedOverrides] = useState<
        Record<string, string>
    >({});

    const handleEditResolved = (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        console.log("[AssistantMessage] handleEditResolved", args);
        if (args.downloadUrl) {
            setResolvedOverrides((prev) => ({
                ...prev,
                [args.documentId]: args.downloadUrl as string,
            }));
        }
        onEditResolved?.(args);
    };

    const status: StatusState = isError
        ? "error"
        : isStreaming
          ? "active"
          : null;

    // Pre-process citations for all content events. Each [N] marker resolves
    // to exactly one annotation (models are instructed to use shared refs
    // only for cross-page continuations via the [[PAGE_BREAK]] sentinel).
    const citationsList: CocoLegalCitationAnnotation[] = [];
    const processedTexts: string[] = [];
    if (events) {
        for (const event of events) {
            processedTexts.push(
                event.type === "content"
                    ? preprocessCitations(
                          normalizeDocumentActionProse(event.text),
                          annotations,
                          citationsList,
                      )
                    : "",
            );
        }
    }
    const handleCopy = async () => {
        try {
            let html = "";
            let plainText = "";
            if (contentDivRef.current) {
                const clone = contentDivRef.current.cloneNode(
                    true,
                ) as HTMLElement;
                html = clone.innerHTML;
                plainText = clone.textContent || "";
            }
            const item = new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([plainText], { type: "text/plain" }),
            });
            await navigator.clipboard.write([item]);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch {
            // ignore
        }
    };

    const lastContentIdx = events
        ? events.reduce(
              (last, e, idx) => (e.type === "content" ? idx : last),
              -1,
          )
        : -1;

    // Walk events in chronological order and group consecutive non-content
    // events into their own PreResponseWrapper. Content events render
    // between wrappers, so reasoning/tool chatter that arrives after the
    // model has already streamed some prose gets its own wrapper.
    type EventGroup =
        | { kind: "pre"; events: AssistantEvent[]; indices: number[] }
        | {
              kind: "content";
              event: Extract<AssistantEvent, { type: "content" }>;
              index: number;
          };

    const groups: EventGroup[] = [];
    if (events) {
        let current: Extract<EventGroup, { kind: "pre" }> | null = null;
        events.forEach((e, i) => {
            // A "completed" generation_finish renders null, so letting it
            // into a group would mint an empty "Completed in 1 step" card.
            if (
                e.type === "generation_finish" &&
                e.finish_reason === "completed"
            ) {
                return;
            }
            // Generated images render below the prose as an artifact card,
            // not as a trace step — PreResponseWrapper unmounts its children
            // when it collapses, which used to hide the image entirely.
            if (
                e.type === "document_job_started" ||
                e.type === "document_job_status"
            )
                return;
            if (e.type === "image_generated") {
                return;
            }
            // Same reason for the capability result card: it is the turn's
            // artifact, not a trace step, and the collapsing wrapper would
            // unmount it.
            if (e.type === "capability_result") {
                return;
            }
            if (e.type === "content") {
                if (current) {
                    groups.push(current);
                    current = null;
                }
                groups.push({ kind: "content", event: e, index: i });
            } else {
                if (!current)
                    current = { kind: "pre", events: [], indices: [] };
                current.events.push(e);
                current.indices.push(i);
            }
        });
        if (current) groups.push(current);
    }

    const hasContentAfter = (groupIdx: number): boolean => {
        for (let i = groupIdx + 1; i < groups.length; i++) {
            const g = groups[i];
            if (g.kind === "content" && g.event.text.length > 0) return true;
        }
        return false;
    };

    const renderEvent = (
        event: AssistantEvent,
        i: number,
        allEvents: AssistantEvent[],
        globalIdx: number,
    ) => {
        const nextEvent = allEvents[i + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";

        if (event.type === "content") {
            const isLastContent = globalIdx === lastContentIdx;
            const processed = processedTexts[globalIdx];
            return (
                <div key={globalIdx}>
                    <MarkdownContent
                        text={processed}
                        citationsList={citationsList}
                        onCitationClick={onCitationClick}
                        divRef={isLastContent ? contentDivRef : undefined}
                    />
                </div>
            );
        }
        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={globalIdx}
                    text={event.text}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "tool_call_start") {
            return (
                <div
                    key={globalIdx}
                    className="flex items-center text-sm font-serif text-gray-500 relative"
                >
                    {showConnector && (
                        <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
                    )}
                    <div className="w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
                    <span className="font-medium ml-2">
                        {toolCallLabel(event.name)}
                    </span>
                </div>
            );
        }
        if (event.type === "tool_input_progress") {
            const seconds = Math.max(1, Math.round(event.elapsed_ms / 1000));
            return (
                <div
                    key={globalIdx}
                    className="relative flex items-center text-sm font-serif text-gray-500"
                >
                    {showConnector && (
                        <div className="absolute bottom-0 left-[2.5px] top-[13px] h-[calc(100%+11px)] w-px bg-gray-300" />
                    )}
                    <div className="h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-gray-400 border-t-transparent" />
                    <span className="ml-2 font-medium">
                        Preparing document content… {seconds}s
                    </span>
                </div>
            );
        }
        if (event.type === "generation_finish") {
            if (event.finish_reason === "completed") return null;
            const message =
                event.finish_reason === "cancelled"
                    ? "Generation was cancelled. Completed packet documents were retained."
                    : event.finish_reason === "refused"
                      ? "The selected model refused this request. No alternate model was used."
                      : event.finish_reason === "context_limit"
                        ? "The request exceeded the selected model’s context limit."
                        : event.finish_reason === "max_output"
                          ? "The response reached the selected model’s output limit before completion."
                          : "Generation ended before it could complete.";
            return (
                <div
                    key={globalIdx}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-sans text-xs text-amber-800"
                >
                    {message}
                </div>
            );
        }
        if (event.type === "model_fallback") {
            return (
                <div
                    key={globalIdx}
                    className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-sans text-xs text-amber-800"
                >
                    The selected model ({event.requested_model_id}) could not
                    complete this turn. Quill continued with{" "}
                    {event.final_model_id}
                    {event.attempt_count > 1
                        ? ` after ${event.attempt_count} attempts.`
                        : "."}
                </div>
            );
        }
        if (event.type === "thinking") {
            return (
                <div
                    key={globalIdx}
                    className="flex items-center text-sm font-serif text-gray-500 relative"
                >
                    {showConnector && (
                        <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
                    )}
                    <div className="w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
                    <span className="ml-2">Thinking...</span>
                </div>
            );
        }
        if (event.type === "doc_read") {
            const ann = annotations.find((a) => a.filename === event.filename);
            return (
                <DocReadBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    onClick={
                        !event.isStreaming && ann && onCitationClick
                            ? () => onCitationClick(ann)
                            : undefined
                    }
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_find") {
            return (
                <DocFindBlock
                    key={globalIdx}
                    filename={event.filename}
                    query={event.query}
                    totalMatches={event.total_matches}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_created") {
            return (
                <DocCreatedBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_replicated") {
            // The backend now does N copies in one tool call and reports
            // count + copies on a single event, so no consecutive-event
            // aggregation needed.
            return (
                <DocReplicatedBlock
                    key={globalIdx}
                    filename={event.filename}
                    count={event.count}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_highlighted") {
            return (
                <DocHighlightsBlock
                    key={globalIdx}
                    event={event}
                    showConnector={showConnector}
                    onView={onHighlightViewClick}
                    onChanged={onHighlightSetChange}
                />
            );
        }
        if (event.type === "doc_edited") {
            return (
                <DocEditedBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    hasError={!!event.error}
                    error={event.error}
                    errorCode={event.error_code}
                    retryable={event.retryable}
                    target={event.target}
                    resolution={event.resolution}
                    candidates={event.candidates}
                    isCleanOutput={event.annotations.length === 0}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "workflow_applied") {
            return (
                <WorkflowAppliedBlock
                    key={globalIdx}
                    title={event.title}
                    showConnector={showConnector}
                    onClick={
                        onWorkflowClick
                            ? () => onWorkflowClick(event.workflow_id)
                            : undefined
                    }
                />
            );
        }
        if (event.type === "legal_search") {
            return (
                <LegalSearchBlock
                    key={globalIdx}
                    query={event.query}
                    providers={event.providers}
                    resultCount={event.result_count}
                    warnings={event.warnings}
                    results={event.results}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "matter_search") {
            return (
                <MatterSearchBlock
                    key={globalIdx}
                    query={event.query}
                    count={event.count}
                    matters={event.matters ?? []}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "matter_documents_loaded") {
            return (
                <MatterDocumentsLoadedBlock
                    key={globalIdx}
                    matterName={event.matter_name}
                    documentCount={event.document_count}
                    readableCount={event.readable_count}
                    truncated={!!event.truncated}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "case_search") {
            return (
                <CaseSearchBlock
                    key={globalIdx}
                    query={event.query}
                    count={event.count}
                    error={event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "operation_created") {
            // generate_template is requiresApproval:false and is already
            // surfaced by its own `template_created` event (TemplateCreatedBlock).
            // Rendering the generic OperationCreatedBlock for it would show a
            // contradictory "Approval required / not applied yet" card with a
            // permanently-disabled "Approve and apply" button, so skip it here.
            // Approval-gated ops (assemble_document, send_email, etc.) still render.
            if (event.operation.tool_name === "generate_template") {
                return null;
            }
            return (
                <OperationCreatedBlock
                    key={globalIdx}
                    event={event}
                    showConnector={showConnector}
                    onOperationApplied={onOperationApplied}
                    onOpenDocument={onOpenDocument}
                />
            );
        }
        if (event.type === "email_received") {
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <EmailReceivedCard event={event} />
                </div>
            );
        }
        if (event.type === "email_pending") {
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <EmailApprovalCard event={event} />
                </div>
            );
        }
        if (event.type === "signature_pending") {
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <SignatureApprovalCard event={event} />
                </div>
            );
        }
        if (event.type === "calendar_pending") {
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <EventApprovalCard event={event} />
                </div>
            );
        }
        if (event.type === "template_created") {
            return (
                <TemplateCreatedBlock
                    key={globalIdx}
                    title={event.title}
                    docType={event.doc_type}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "draft_qa") {
            // Defensive path: QA normally arrives via the assemble approval
            // response (rendered by OperationCreatedBlock's AuthoringCard), but
            // render a standalone block if it ever streams on the chat path.
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <DraftQABlock
                        findings={event.findings}
                        status={event.status}
                    />
                </div>
            );
        }
        if (event.type === "recording_card") {
            // Capture-time durable card; the live RecordingCard polls status
            // from recording_id until the summary is ready (or it fails).
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <RecordingCard
                        variant="live"
                        recordingId={event.recording_id}
                        initial={{
                            title: event.title,
                            source: event.source,
                        }}
                    />
                </div>
            );
        }
        if (event.type === "recording_summary") {
            // Ready-time durable artifact rendered statically from the block.
            // (Its duplicate lead-in content block was suppressed above.)
            return (
                <div key={globalIdx} className="relative">
                    {showConnector && (
                        <div className="absolute left-0 top-[13px] h-[calc(100%+11px)] w-[1px] bg-gray-300" />
                    )}
                    <RecordingCard
                        variant="summary"
                        recordingId={event.recording_id}
                        summaryBlock={event}
                        initial={{ title: event.title }}
                    />
                </div>
            );
        }
        // Unknown/forward-compat block types render nothing, so messages that
        // predate these types (or carry a future block) never break.
        return null;
    };

    return (
        <div style={{ minHeight }}>
            <ResponseStatus status={status} />
            <div className="w-full font-inter relative mt-2">
                {events && events.length > 0 ? (
                    <div className="flex flex-col gap-4">
                        {groups.map((g, gIdx) => {
                            if (g.kind === "content") {
                                const isLastContent =
                                    g.index === lastContentIdx;
                                return (
                                    <div key={`c-${g.index}`}>
                                        <MarkdownContent
                                            text={processedTexts[g.index]}
                                            citationsList={citationsList}
                                            onCitationClick={onCitationClick}
                                            divRef={
                                                isLastContent
                                                    ? contentDivRef
                                                    : undefined
                                            }
                                        />
                                    </div>
                                );
                            }
                            const subsequentContent = hasContentAfter(gIdx);
                            const hasPendingApproval = g.events.some(
                                (event) =>
                                    (event.type === "operation_created" &&
                                        event.operation.status ===
                                            "pending_approval" &&
                                        event.operation.approval_status ===
                                            "required") ||
                                    event.type === "email_pending" ||
                                    event.type === "signature_pending" ||
                                    event.type === "calendar_pending",
                            );
                            const hasPersistentNotice = g.events.some(
                                (event) => event.type === "model_fallback",
                            );
                            const wrapperIsStreaming = g.events.some(
                                (event) =>
                                    "isStreaming" in event &&
                                    !!event.isStreaming,
                            );
                            return (
                                <PreResponseWrapper
                                    key={`p-${g.indices[0]}`}
                                    stepCount={g.events.length}
                                    shouldMinimize={
                                        subsequentContent &&
                                        !hasPendingApproval &&
                                        !hasPersistentNotice
                                    }
                                    isStreaming={wrapperIsStreaming}
                                >
                                    {g.events.map((event, i) =>
                                        renderEvent(
                                            event,
                                            i,
                                            g.events,
                                            g.indices[i],
                                        ),
                                    )}
                                </PreResponseWrapper>
                            );
                        })}
                        {/* Bulk accept/reject + per-edit cards — below the
                            response content, only after streaming stops,
                            rendered above the download card. */}
                        {!isStreaming &&
                            (() => {
                                const editedEvents = events.filter(
                                    (e) =>
                                        e.type === "doc_edited" &&
                                        !e.isStreaming,
                                ) as Extract<
                                    AssistantEvent,
                                    { type: "doc_edited" }
                                >[];
                                const pending: {
                                    annotation: CocoLegalEditAnnotation;
                                    filename: string;
                                }[] = [];
                                const filenameByDocId = new Map<
                                    string,
                                    string
                                >();
                                // Effective status = external override if any, else the annotation's DB status.
                                const statusOf = (ann: CocoLegalEditAnnotation) =>
                                    resolvedEditStatuses?.[ann.edit_id] ??
                                    ann.status;
                                for (const e of editedEvents) {
                                    filenameByDocId.set(
                                        e.document_id,
                                        e.filename,
                                    );
                                    for (const ann of e.annotations) {
                                        if (statusOf(ann) === "pending") {
                                            pending.push({
                                                annotation: ann,
                                                filename: e.filename,
                                            });
                                        }
                                    }
                                }
                                const cards = editedEvents.flatMap((e) =>
                                    e.annotations.map((ann) => (
                                        <EditCard
                                            key={`editcard-${ann.edit_id}`}
                                            annotation={ann}
                                            resolvedStatus={
                                                resolvedEditStatuses?.[
                                                    ann.edit_id
                                                ]
                                            }
                                            isReloading={
                                                isEditReloading?.(
                                                    ann.edit_id,
                                                ) ?? false
                                            }
                                            onViewClick={(a) =>
                                                onEditViewClick?.(a, e.filename)
                                            }
                                            onResolveStart={onEditResolveStart}
                                            onResolved={handleEditResolved}
                                            onError={onEditError}
                                        />
                                    )),
                                );
                                const resolvedCount = editedEvents.reduce(
                                    (acc, e) =>
                                        acc +
                                        e.annotations.filter(
                                            (a) => statusOf(a) !== "pending",
                                        ).length,
                                    0,
                                );
                                // If there's only one edit total, skip the
                                // minimisable wrapper / bulk-actions UI and
                                // render the bare EditCard — no value in
                                // bulk controls for a single item.
                                if (cards.length <= 1) {
                                    return cards;
                                }
                                return (
                                    <EditCardsSection
                                        pending={pending}
                                        filenameByDocId={filenameByDocId}
                                        cards={cards}
                                        resolvedCount={resolvedCount}
                                        onViewClick={onEditViewClick}
                                        onResolveStart={onEditResolveStart}
                                        onResolved={handleEditResolved}
                                        onError={onEditError}
                                    />
                                );
                            })()}
                    </div>
                ) : content ? (
                    <MarkdownContent
                        text={normalizeDocumentActionProse(content)}
                        citationsList={citationsList}
                        onCitationClick={onCitationClick}
                        divRef={contentDivRef}
                    />
                ) : null}

                {isError && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-serif text-red-700">
                        <span className="leading-snug">
                            {errorMessage ?? "Sorry, something went wrong."}
                        </span>
                    </div>
                )}

                {/* Capability result cards — the headline artifact of a run
                    turn, promoted out of the reasoning trace for the same
                    reason as images: PreResponseWrapper unmounts its children
                    when it collapses, which would hide the card entirely.
                    Rendered whether or not the stream is still open — the
                    event is only emitted once the result is validated and
                    persisted, so it is never a placeholder. */}
                {events &&
                    (() => {
                        const seen = new Set<string>();
                        const results = events.filter(
                            (e): e is CapabilityResultEvent => {
                                if (e.type !== "capability_result")
                                    return false;
                                if (seen.has(e.result_id)) return false;
                                seen.add(e.result_id);
                                return true;
                            },
                        );
                        if (results.length === 0) return null;
                        return (
                            <div className="flex flex-col gap-4 mt-3 mb-3">
                                {results.map((e) => {
                                    const Card = resolveCapabilityResultCard(
                                        e.capability_id,
                                    );
                                    return (
                                        <Card
                                            key={`capability-${e.result_id}`}
                                            event={e}
                                            chatId={chatId}
                                            messageId={messageId}
                                            surface={surface}
                                            onRetry={
                                                onRetryCapabilityRun
                                                    ? (retry) =>
                                                          onRetryCapabilityRun({
                                                              capabilityId:
                                                                  e.capability_id,
                                                              proposalId:
                                                                  e.proposal_id,
                                                              title: e.title,
                                                              retry,
                                                          })
                                                    : undefined
                                            }
                                        />
                                    );
                                })}
                            </div>
                        );
                    })()}

                {events &&
                    documentPacketEvents(events)
                        .filter(
                            (packet) =>
                                !documentPacketJobIds ||
                                documentPacketJobIds.has(packet.job_id),
                        )
                        .map((packet) => (
                            <DocumentPacketCard
                                key={`packet-${packet.job_id}`}
                                jobId={packet.job_id}
                                totalDocuments={packet.total_documents}
                            />
                        ))}
                {(events?.some(
                    (event) =>
                        event.type === "content" &&
                        normalizeDocumentActionProse(event.text) !== event.text,
                ) ||
                    (!events?.length &&
                        normalizeDocumentActionProse(content ?? "") !==
                            (content ?? ""))) && (
                    <p
                        role="status"
                        className="my-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-sans text-amber-900"
                    >
                        This historical reply contains an unverified scheduling
                        claim. Text in a reply does not start documents; the
                        saved packet cards show the actual work.
                    </p>
                )}

                {/* Generated/edited images — promoted out of the reasoning
                    trace so they stay visible once it auto-collapses, and
                    placed above the doc download cards since the image is the
                    turn's headline artifact. Deliberately NOT gated on
                    !isStreaming (unlike the doc cards, which wait on a
                    download_url the backend fills in late): image_generated is
                    never a placeholder, so it carries a usable document_id the
                    moment it arrives. */}
                {events &&
                    (() => {
                        const seen = new Set<string>();
                        const images = events.filter(
                            (
                                e,
                            ): e is Extract<
                                AssistantEvent,
                                { type: "image_generated" }
                            > => {
                                if (e.type !== "image_generated") return false;
                                // Every generate/edit mints a fresh document,
                                // so this only guards duplicate React keys —
                                // regenerates and edits all get their own card.
                                if (seen.has(e.document_id)) return false;
                                seen.add(e.document_id);
                                return true;
                            },
                        );
                        if (images.length === 0) return null;
                        return (
                            <div className="flex flex-col gap-4 mt-3 mb-3">
                                {images.map((e) => {
                                    const prompt = e.prompt;
                                    return (
                                        <GeneratedImageCard
                                            key={`image-${e.document_id}`}
                                            documentId={e.document_id}
                                            filename={e.filename}
                                            kind={e.kind}
                                            onEdit={
                                                onEditImage
                                                    ? () =>
                                                          onEditImage(
                                                              e.document_id,
                                                              e.filename,
                                                          )
                                                    : undefined
                                            }
                                            onRegenerate={
                                                onRegenerateImage && prompt
                                                    ? () =>
                                                          onRegenerateImage(
                                                              prompt,
                                                          )
                                                    : undefined
                                            }
                                            onAttachToEmail={
                                                onAttachImageToEmail
                                                    ? () =>
                                                          onAttachImageToEmail(
                                                              e.document_id,
                                                              e.filename,
                                                          )
                                                    : undefined
                                            }
                                        />
                                    );
                                })}
                            </div>
                        );
                    })()}

                {/* Download card for each edited doc — only after streaming
                    stops, and deduped per document (keep the latest edit). */}
                {events &&
                    !isStreaming &&
                    (() => {
                        const edited = events.filter(
                            (
                                e,
                            ): e is Extract<
                                AssistantEvent,
                                { type: "doc_edited" }
                            > =>
                                e.type === "doc_edited" &&
                                !e.isStreaming &&
                                !!e.download_url,
                        );
                        const latestByDoc = new Map<
                            string,
                            (typeof edited)[number]
                        >();
                        for (const e of edited)
                            latestByDoc.set(e.document_id, e);
                        return Array.from(latestByDoc.values()).map((e) => {
                            const isCleanOutput = e.annotations.length === 0;
                            return (
                                <div
                                    key={`edited-download-${e.document_id}`}
                                    className="flex flex-col gap-2 mt-2 mb-3"
                                >
                                    <DocDownloadBlock
                                        filename={e.filename}
                                        download_url={
                                            resolvedOverrides[e.document_id] ??
                                            e.download_url
                                        }
                                        versionNumber={e.version_number ?? null}
                                        statusLabel={
                                            isCleanOutput
                                                ? "Clean DOCX ready"
                                                : e.layout_reflowed
                                                  ? "Layout normalized · Edited DOCX ready"
                                                  : "Edited DOCX ready"
                                        }
                                        description={
                                            isCleanOutput
                                                ? "Ready to open or download"
                                                : e.layout_qa_status ===
                                                    "passed"
                                                  ? "Tracked-change version · layout verified"
                                                  : "Tracked-change version"
                                        }
                                        onOpen={
                                            onOpenDocument
                                                ? () =>
                                                      onOpenDocument({
                                                          documentId:
                                                              e.document_id,
                                                          filename: e.filename,
                                                          versionId:
                                                              e.version_id ??
                                                              null,
                                                          versionNumber:
                                                              e.version_number ??
                                                              null,
                                                      })
                                                : onEditViewClick &&
                                                    e.annotations[0]
                                                  ? () =>
                                                        onEditViewClick(
                                                            e.annotations[0],
                                                            e.filename,
                                                        )
                                                  : undefined
                                        }
                                        onReveal={
                                            onRevealDocument
                                                ? () =>
                                                      onRevealDocument(
                                                          e.document_id,
                                                      )
                                                : undefined
                                        }
                                        isReloading={
                                            isDocReloading?.(e.document_id) ??
                                            false
                                        }
                                    />
                                </div>
                            );
                        });
                    })()}

                {/* Download cards for created docs — generated docs now
                    persist as first-class documents, so clicking opens
                    them in the DocPanel (like edited docs). */}
                {events &&
                    !isStreaming &&
                    events.some(
                        (e) => e.type === "doc_created" && e.download_url,
                    ) && (
                        <div className="flex flex-col gap-2 mt-2 mb-3">
                            {(
                                events.filter(
                                    (e) =>
                                        e.type === "doc_created" &&
                                        e.download_url,
                                ) as Extract<
                                    AssistantEvent,
                                    { type: "doc_created" }
                                >[]
                            ).map((e, i) => {
                                const documentId = e.document_id;
                                const versionId = e.version_id ?? null;
                                const versionNumber = e.version_number ?? null;
                                const canOpen =
                                    !!onOpenDocument && !!documentId;
                                return (
                                    <DocDownloadBlock
                                        key={i}
                                        filename={e.filename}
                                        download_url={e.download_url}
                                        versionNumber={versionNumber}
                                        statusLabel="Document ready"
                                        description="Generated DOCX file"
                                        onOpen={
                                            canOpen
                                                ? () =>
                                                      onOpenDocument!({
                                                          documentId:
                                                              documentId!,
                                                          filename: e.filename,
                                                          versionId,
                                                          versionNumber,
                                                      })
                                                : undefined
                                        }
                                        onReveal={
                                            onRevealDocument && documentId
                                                ? () =>
                                                      onRevealDocument(
                                                          documentId,
                                                      )
                                                : undefined
                                        }
                                    />
                                );
                            })}
                        </div>
                    )}

                {/* Copy button */}
                <div className="flex items-center gap-2 pt-2 pb-4 md:pb-8 font-sans justify-start">
                    {!isStreaming && (
                        <button
                            className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                            onClick={handleCopy}
                        >
                            {isCopied ? (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
