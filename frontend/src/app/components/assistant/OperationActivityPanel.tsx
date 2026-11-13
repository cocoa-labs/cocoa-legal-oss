"use client";

import { useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock3,
    Download,
    FileText,
    RotateCcw,
    ShieldCheck,
} from "lucide-react";
import {
    approveAssembleOperation,
    approveOperation,
    listOperations,
    undoOperation,
} from "@/app/lib/cocoLegalApi";
import type { AgentOperation } from "@/app/components/shared/types";

function statusIcon(operation: AgentOperation) {
    if (operation.status === "failed") {
        return <AlertTriangle className="h-3.5 w-3.5 text-red-500" />;
    }
    if (operation.status === "succeeded" || operation.status === "undone") {
        return <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />;
    }
    if (operation.status === "pending_approval") {
        return <ShieldCheck className="h-3.5 w-3.5 text-amber-600" />;
    }
    return <Clock3 className="h-3.5 w-3.5 text-gray-500" />;
}

function formatAction(operation: AgentOperation) {
    return operation.action_type
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}

function canUndo(operation: AgentOperation) {
    return (
        operation.status === "succeeded" &&
        operation.inverse_operation === "restore_source_version" &&
        !!operation.source_version_id &&
        !!operation.result_document_id
    );
}

function canApprove(operation: AgentOperation) {
    return (
        operation.status === "pending_approval" &&
        operation.requires_approval &&
        operation.approval_status === "required"
    );
}

export function OperationActivityPanel({
    projectId,
    documentId,
    chatId,
    onOperationApplied,
    onOpenDocument,
    onExportDocument,
    canChangeOperations = true,
}: {
    projectId?: string | null;
    documentId?: string | null;
    chatId?: string | null;
    onOperationApplied?: (operation: AgentOperation) => void;
    onOpenDocument?: (operation: AgentOperation) => void;
    onExportDocument?: (operation: AgentOperation) => void;
    canChangeOperations?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [operations, setOperations] = useState<AgentOperation[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const filters = useMemo(
        () => ({
            projectId: projectId ?? undefined,
            documentId: documentId ?? undefined,
            chatId: chatId ?? undefined,
            limit: 12,
        }),
        [chatId, documentId, projectId],
    );

    useEffect(() => {
        if (!open && operations.length > 0) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        listOperations(filters)
            .then((next) => {
                if (!cancelled) setOperations(next);
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Could not load activity.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [filters, open, operations.length]);

    const handleUndo = async (operation: AgentOperation) => {
        setBusyId(operation.id);
        setError(null);
        try {
            const undone = await undoOperation(operation.id);
            setOperations((prev) => [
                undone,
                ...prev.map((item) =>
                    item.id === operation.id
                        ? { ...item, status: "undone" as const }
                        : item,
                ),
            ]);
            onOperationApplied?.(undone);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not undo that operation.",
            );
        } finally {
            setBusyId(null);
        }
    };

    const handleApprove = async (operation: AgentOperation) => {
        setBusyId(operation.id);
        setError(null);
        try {
            if (operation.tool_name === "assemble_document") {
                // Async assemble: approving kicks off a DETACHED background job
                // and returns a kickoff payload (not a finished op). This compact
                // log doesn't poll — mark the row running; the worker reconciles
                // it to succeeded and the next refresh shows the terminal record.
                await approveAssembleOperation(operation.id);
                setOperations((prev) =>
                    prev.map((item) =>
                        item.id === operation.id
                            ? { ...item, status: "running" as const }
                            : item,
                    ),
                );
                return;
            }
            const approved = await approveOperation(operation.id);
            setOperations((prev) =>
                prev.map((item) =>
                    item.id === operation.id ? approved : item,
                ),
            );
            if (approved.result_version_id) {
                onOperationApplied?.(approved);
            }
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not approve that operation.",
            );
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="border-t border-gray-200 bg-white">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className="flex h-9 w-full items-center gap-2 px-4 text-left text-xs text-gray-600 hover:bg-gray-50"
            >
                {open ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                )}
                <ShieldCheck className="h-3.5 w-3.5" />
                <span className="font-medium">Chain of custody</span>
                <span className="ml-auto text-gray-400">
                    {loading ? "Loading" : `${operations.length} recent`}
                </span>
            </button>
            {open && (
                <div className="max-h-56 space-y-2 overflow-y-auto border-t border-gray-100 px-4 py-3">
                    {error && (
                        <p className="rounded border border-red-100 bg-red-50 px-2 py-1.5 text-xs text-red-700">
                            {error}
                        </p>
                    )}
                    {!loading && operations.length === 0 && !error && (
                        <p className="text-xs text-gray-400">
                            No recorded operations yet.
                        </p>
                    )}
                    {operations.map((operation) => (
                        <div
                            key={operation.id}
                            className="flex items-start gap-2 rounded border border-gray-100 bg-gray-50 px-2.5 py-2"
                        >
                            <div className="mt-0.5 shrink-0">
                                {statusIcon(operation)}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="truncate text-xs font-medium text-gray-800">
                                        {formatAction(operation)}
                                    </p>
                                    {operation.requires_approval && (
                                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                                            Approval
                                        </span>
                                    )}
                                </div>
                                <p className="mt-0.5 truncate text-[11px] text-gray-500">
                                    {operation.tool_name} · {operation.status} ·{" "}
                                    {formatTime(operation.created_at)}
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                {(operation.result_document_id ||
                                    operation.source_document_id) &&
                                    onOpenDocument && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onOpenDocument(operation)
                                            }
                                            className="inline-flex h-7 items-center gap-1 rounded border border-gray-200 bg-white px-2 text-[11px] font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                                            title="Open the operation document"
                                        >
                                            <FileText className="h-3 w-3" />
                                            Open
                                        </button>
                                    )}
                                {(operation.result_document_id ||
                                    operation.source_document_id) &&
                                    onExportDocument && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onExportDocument(operation)
                                            }
                                            className="inline-flex h-7 items-center gap-1 rounded border border-gray-200 bg-white px-2 text-[11px] font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                                            title="Export the operation document"
                                        >
                                            <Download className="h-3 w-3" />
                                        </button>
                                    )}
                                {canChangeOperations && canApprove(operation) && (
                                    <button
                                        type="button"
                                        onClick={() => handleApprove(operation)}
                                        disabled={busyId === operation.id}
                                        className="inline-flex h-7 items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                                        title="Approve and apply this document operation"
                                    >
                                        <ShieldCheck className="h-3 w-3" />
                                        Approve
                                    </button>
                                )}
                                {canChangeOperations && canUndo(operation) && (
                                    <button
                                        type="button"
                                        onClick={() => handleUndo(operation)}
                                        disabled={busyId === operation.id}
                                        className="inline-flex h-7 items-center gap-1 rounded border border-gray-200 bg-white px-2 text-[11px] font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                                        title="Restore the source version recorded for this operation"
                                    >
                                        <RotateCcw className="h-3 w-3" />
                                        Undo
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
