"use client";

import { useEffect, useRef, useState } from "react";
import {
    Download,
    MessageSquareText,
    FileText,
    File,
    FileSignature,
    Image as ImageIcon,
    Folder,
    FolderOpen,
    ChevronRight,
    ChevronDown,
    FileOutput,
    History,
    FolderPlus,
    PenLine,
    Trash2,
} from "lucide-react";
import type { CocoaLegalDocument, CocoaLegalFolder } from "@/app/components/shared/types";
import { VersionChip } from "@/app/components/shared/VersionChip";
import type {
    DerivedDocumentNode,
    DocumentTreeNode,
    DocumentVersionNode,
    ProjectDocumentTree,
} from "@/app/lib/cocoaLegalApi";
import {
    COCOA_LEGAL_DOC_DRAG_TYPE,
    COCOA_LEGAL_FOLDER_DRAG_TYPE,
    getCocoaLegalDocDragData,
    getCocoaLegalFolderDragData,
    hasCocoaLegalDragPayload,
} from "@/app/lib/dragTypes";

interface Props {
    projectName?: string | null;
    documents: CocoaLegalDocument[];
    folders?: CocoaLegalFolder[];
    variant?: "light" | "dark";
    selectedDocId?: string | null;
    documentTree?: ProjectDocumentTree | null;
    revealDocumentId?: string | null;
    onDocClick: (doc: CocoaLegalDocument) => void;
    onVersionClick?: (
        doc: CocoaLegalDocument,
        version: DocumentVersionNode,
    ) => void;
    /**
     * View the conversation turn that produced a version. Rendered as a small
     * affordance on version rows that carry provenance.
     */
    onVersionProvenanceClick?: (
        doc: CocoaLegalDocument,
        version: DocumentVersionNode,
    ) => void;
    onDerivedDocumentClick?: (node: DerivedDocumentNode) => void;
    onExportDocument?: (doc: CocoaLegalDocument, versionId?: string | null) => void;
    onSendForSignature?: (doc: CocoaLegalDocument, versionId?: string | null) => void;
    /**
     * Returns the current e-signature envelope status for a source document id
     * (e.g. "sent", "completed"), or undefined when the document isn't out for
     * signature. When provided, a small status pill renders on the row.
     */
    signatureStatusForDoc?: (docId: string) => string | undefined;
    onCreateFolder?: (parentFolderId: string | null, name: string) => Promise<void>;
    onRenameFolder?: (folderId: string, name: string) => Promise<void>;
    onDeleteFolder?: (folderId: string) => Promise<void>;
    onDeleteDoc?: (docId: string) => Promise<void>;
    onMoveDoc?: (docId: string, targetFolderId: string | null) => Promise<void>;
    onMoveFolder?: (folderId: string, targetFolderId: string | null) => Promise<void>;
    /**
     * Route to the matter's authoring ("Draft") workspace. When provided, a
     * small "Draft document" affordance renders on the project-root row. The
     * host owns the navigation (it knows the projectId), so the explorer stays
     * project-id-agnostic.
     */
    onDraftDocument?: () => void;
}

function DocIcon({ fileType }: { fileType: string | null }) {
    if (fileType === "pdf")
        return <FileText className="h-3.5 w-3.5 text-red-500 shrink-0" />;
    if (fileType === "docx" || fileType === "doc")
        return <File className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
    if (fileType && ["png", "jpg", "jpeg", "webp", "gif"].includes(fileType.toLowerCase()))
        return <ImageIcon className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
    return <File className="h-3.5 w-3.5 text-gray-400 shrink-0" />;
}

/**
 * Subtle per-row signature pill. Returns null for statuses that shouldn't be
 * surfaced on the tree (draft / pending_approval) so the row stays quiet until
 * an envelope is actually out for signature.
 */
function SignatureRowPill({ status }: { status: string }) {
    const meta: { label: string; dot: string; text: string } | null =
        status === "completed"
            ? { label: "Signed", dot: "bg-green-500", text: "text-green-600" }
            : status === "sent" || status === "partially_signed"
              ? {
                    label: "Out for signature",
                    dot: "bg-amber-500",
                    text: "text-amber-600",
                }
              : status === "declined"
                ? { label: "Declined", dot: "bg-red-500", text: "text-red-600" }
                : status === "cancelled" || status === "expired"
                  ? {
                        label: status === "expired" ? "Expired" : "Cancelled",
                        dot: "bg-gray-400",
                        text: "text-gray-400",
                    }
                  : null;
    if (!meta) return null;
    return (
        <span
            title={meta.label}
            className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-medium ${meta.text}`}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            <span className="hidden xl:inline">{meta.label}</span>
        </span>
    );
}

type ContextMenuState = {
    x: number;
    y: number;
    parentId: string | null;      // folder to create inside (null = root)
    folderId?: string;             // set if right-clicked on a specific folder
    docId?: string;                // set if right-clicked on a specific document
};

export function ProjectExplorer({
    projectName,
    documents,
    folders = [],
    variant = "light",
    selectedDocId,
    documentTree,
    revealDocumentId,
    onDocClick,
    onVersionClick,
    onVersionProvenanceClick,
    onDerivedDocumentClick,
    onExportDocument,
    onSendForSignature,
    signatureStatusForDoc,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onDeleteDoc,
    onMoveDoc,
    onMoveFolder,
    onDraftDocument,
}: Props) {
    const dark = variant === "dark";
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const newFolderInputRef = useRef<HTMLInputElement>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const treeByDocId = new Map<string, DocumentTreeNode>(
        (documentTree?.documents ?? []).map((node) => [
            node.document.id,
            node,
        ]),
    );
    const derivedDocumentIds = new Set(
        (documentTree?.documents ?? [])
            .filter((node) => node.is_derived)
            .map((node) => node.document.id),
    );

    let revealedSourceDocId: string | null = null;
    const revealedFolderIds = new Set<string>();
    if (revealDocumentId) {
        const doc = documents.find((item) => item.id === revealDocumentId);
        let sourceDocId = doc?.id ?? revealDocumentId;
        for (const node of documentTree?.documents ?? []) {
            if (
                node.derived_documents.some(
                    (derived) =>
                        derived.document.id === revealDocumentId,
                )
            ) {
                sourceDocId = node.document.id;
                break;
            }
        }
        const sourceDoc = documents.find((item) => item.id === sourceDocId);
        let folderId = sourceDoc?.folder_id ?? null;
        while (folderId) {
            revealedFolderIds.add(folderId);
            const folder = folders.find((item) => item.id === folderId);
            folderId = folder?.parent_folder_id ?? null;
        }
        revealedSourceDocId = sourceDocId;
    }

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);

    // Clear all drag state when drag ends
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);

    function toggleFolder(id: string) {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function toggleDoc(id: string) {
        const key = `doc:${id}`;
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }

    function versionLabel(version: DocumentVersionNode) {
        if (version.display_name?.trim()) return version.display_name.trim();
        if (typeof version.version_number === "number") {
            return `V${version.version_number}`;
        }
        return version.source.replaceAll("_", " ");
    }

    function sourceLabel(source: string) {
        if (source === "clean_final") return "Clean final";
        if (source === "assistant_highlight") return "Highlights";
        if (source === "assistant_edit") return "Redline";
        if (source === "assistant_undo") return "Restored";
        if (source === "user_upload") return "Uploaded";
        if (source === "generated") return "Generated";
        return source.replaceAll("_", " ");
    }

    function derivationLabel(kind: string) {
        if (kind === "highlighted_review") return "Highlighted review";
        if (kind === "clean_final") return "Clean final";
        if (kind === "summary") return "Summary";
        if (kind === "replicated_document") return "Copy";
        return "Generated";
    }

    function layoutQaLabel(version: DocumentVersionNode | null | undefined) {
        if (!version?.layout_qa_status) return null;
        if (version.layout_qa_status === "passed") {
            return { label: "Layout verified", className: "text-emerald-600" };
        }
        if (version.layout_qa_status === "failed") {
            return { label: "Layout blocked", className: "text-red-600" };
        }
        if (version.layout_qa_status === "unverified") {
            return { label: "Verifying layout", className: "text-amber-600" };
        }
        return { label: "Source", className: "text-[var(--app-text-subtle)]" };
    }

    async function commitNewFolder(parentId: string | null) {
        const name = newFolderName.trim();
        // Empty name → leave the input in place. Users dismiss with Escape.
        // This guards against a React StrictMode race where the simulated
        // unmount fires a blur that would otherwise immediately collapse
        // the freshly-mounted input.
        if (!name) return;
        setCreatingIn(undefined);
        setNewFolderName("");
        if (!onCreateFolder) return;
        await onCreateFolder(parentId, name);
        if (parentId) setExpandedIds((prev) => new Set([...prev, parentId]));
    }

    async function commitRename(folderId: string) {
        const name = renameValue.trim();
        setRenamingId(null);
        if (!name || !onRenameFolder) return;
        await onRenameFolder(folderId, name);
    }

    function openContextMenu(
        e: React.MouseEvent,
        parentId: string | null,
        folderId?: string,
        docId?: string,
    ) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, parentId, folderId, docId });
    }

    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        let cur: CocoaLegalFolder | undefined = folders.find((f) => f.id === targetId);
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }

    async function handleDropOnTarget(targetFolderId: string | null, e: React.DragEvent) {
        const docId = getCocoaLegalDocDragData(e.dataTransfer);
        const movingFolderId = getCocoaLegalFolderDragData(e.dataTransfer);

        if (docId && onMoveDoc) {
            const doc = documents.find((d) => d.id === docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            await onMoveDoc(docId, targetFolderId);
        } else if (movingFolderId && movingFolderId !== targetFolderId && onMoveFolder) {
            if (targetFolderId !== null && wouldCreateCycle(movingFolderId, targetFolderId)) return;
            const folder = folders.find((f) => f.id === movingFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId) return;
            await onMoveFolder(movingFolderId, targetFolderId);
        }
    }

    function isInternalDrag(e: React.DragEvent): boolean {
        return hasCocoaLegalDragPayload(e.dataTransfer);
    }

    function renderLevel(parentId: string | null, depth: number): React.ReactNode {
        const basePadding = 28 + (depth - 1) * 16; // pl-7 at depth 1, +16px per level
        const childFolders = folders
            .filter((f) => f.parent_folder_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocs = documents.filter(
            (d) =>
                (d.folder_id ?? null) === parentId &&
                !derivedDocumentIds.has(d.id),
        );

        return (
            <>
                {/* Inline new-folder input */}
                {creatingIn === parentId && (
                    <li
                        className="flex items-center gap-1.5 py-1.5 pr-2 select-none"
                        style={{ paddingLeft: basePadding }}
                    >
                        <ChevronRight className="h-3 w-3 text-gray-300 shrink-0" />
                        <FolderPlus className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                        <input
                            ref={newFolderInputRef}
                            autoFocus
                            className={`flex-1 min-w-0 text-xs bg-transparent outline-none border-b ${
                                dark
                                    ? "border-[var(--app-border)] text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)]"
                                    : "border-gray-300 text-gray-800"
                            }`}
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void commitNewFolder(parentId);
                                if (e.key === "Escape") { setCreatingIn(undefined); setNewFolderName(""); }
                            }}
                            onBlur={() => void commitNewFolder(parentId)}
                        />
                    </li>
                )}

                {/* Child folders */}
                {childFolders.map((folder) => {
                    const isExpanded =
                        expandedIds.has(folder.id) ||
                        revealedFolderIds.has(folder.id);
                    const isRenaming = renamingId === folder.id;
                    const isDragTarget = dragOverFolderId === folder.id;
                    return (
                        <li key={`f-${folder.id}`}>
                            <div
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData(COCOA_LEGAL_FOLDER_DRAG_TYPE, folder.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(folder.id);
                                    setDragOverRoot(false);
                                }}
                                onDragLeave={(e) => {
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    if (isInternalDrag(e)) {
                                        e.stopPropagation();
                                        setDragOverFolderId(null);
                                        setDragOverRoot(false);
                                        await handleDropOnTarget(folder.id, e);
                                    }
                                }}
                                className={`flex items-center gap-1.5 py-1.5 pr-2 rounded-sm cursor-pointer select-none transition-colors group ${
                                    isDragTarget
                                        ? dark
                                            ? "bg-[var(--app-accent-soft)] ring-1 ring-inset ring-[var(--app-border-strong)]"
                                            : "bg-blue-50 ring-1 ring-inset ring-blue-200"
                                        : dark
                                          ? "hover:bg-[var(--app-hover)]"
                                          : "hover:bg-gray-50"
                                }`}
                                style={{ paddingLeft: basePadding }}
                                onClick={() => toggleFolder(folder.id)}
                                onContextMenu={(e) =>
                                    openContextMenu(e, folder.id, folder.id)
                                }
                            >
                                {isExpanded
                                    ? <ChevronDown className="h-3 w-3 text-gray-400 shrink-0" />
                                    : <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
                                }
                                {isExpanded
                                    ? <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                    : <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                }
                                {isRenaming ? (
                                    <input
                                        autoFocus
                                        className={`flex-1 min-w-0 text-xs bg-transparent outline-none border-b ${
                                            dark
                                                ? "border-[var(--app-border)] text-[var(--app-text-strong)]"
                                                : "border-gray-300 text-gray-800"
                                        }`}
                                        value={renameValue}
                                        onChange={(e) => setRenameValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") void commitRename(folder.id);
                                            if (e.key === "Escape") setRenamingId(null);
                                        }}
                                        onBlur={() => void commitRename(folder.id)}
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                ) : (
                                    <span
                                        className={`text-xs truncate ${
                                            dark
                                                ? "text-[var(--app-text-muted)]"
                                                : "text-gray-600"
                                        }`}
                                    >
                                        {folder.name}
                                    </span>
                                )}
                            </div>
                            {isExpanded && (
                                <ul>{renderLevel(folder.id, depth + 1)}</ul>
                            )}
                        </li>
                    );
                })}

                {/* Child documents */}
                {childDocs.map((doc) => {
                    const isSelected = doc.id === selectedDocId;
                    const treeNode = treeByDocId.get(doc.id);
                    const versions = treeNode?.versions ?? [];
                    const derived = treeNode?.derived_documents ?? [];
                    const hasTreeChildren =
                        versions.length > 0 || derived.length > 0;
                    const isDocExpanded =
                        expandedIds.has(`doc:${doc.id}`) ||
                        revealedSourceDocId === doc.id;
                    const activeVersion = versions.find(
                        (version) => version.id === doc.current_version_id,
                    );
                    const activeLayoutQa = layoutQaLabel(activeVersion);
                    const activeLayoutBlocked =
                        activeVersion?.layout_qa_status === "failed";
                    const activeLayoutVerifying =
                        activeVersion?.layout_qa_status === "unverified";
                    return (
                        <li key={`d-${doc.id}`}>
                            <div
                                draggable
                                onDragStart={(e) => {
                                    e.dataTransfer.setData(COCOA_LEGAL_DOC_DRAG_TYPE, doc.id);
                                    e.dataTransfer.effectAllowed = "move";
                                }}
                                onDragOver={(e) => e.stopPropagation()} // don't let doc rows affect root drag state
                                onClick={() => onDocClick(doc)}
                                onContextMenu={(e) =>
                                    openContextMenu(
                                        e,
                                        doc.folder_id ?? null,
                                        undefined,
                                        doc.id,
                                    )
                                }
                                className={`group flex items-center gap-1.5 py-1.5 pr-2 rounded-sm cursor-pointer select-none transition-colors ${
                                    isSelected
                                        ? dark
                                            ? "bg-[var(--app-accent-soft)] text-[var(--app-text-strong)] ring-1 ring-inset ring-[var(--app-border-strong)]"
                                            : "bg-gray-100 text-gray-900"
                                        : dark
                                          ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                          : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                                }`}
                                style={{ paddingLeft: basePadding }}
                            >
                                {hasTreeChildren ? (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleDoc(doc.id);
                                        }}
                                        title={
                                            isDocExpanded
                                                ? "Collapse versions"
                                                : "Show versions"
                                        }
                                        className="rounded p-0.5 text-gray-400 hover:bg-black/5 hover:text-gray-700 dark:hover:text-gray-200"
                                    >
                                        {isDocExpanded ? (
                                            <ChevronDown className="h-3 w-3" />
                                        ) : (
                                            <ChevronRight className="h-3 w-3" />
                                        )}
                                    </button>
                                ) : (
                                    <span className="w-4 shrink-0" />
                                )}
                                <DocIcon fileType={doc.file_type} />
                                <span className="min-w-0 flex-1 truncate text-xs">
                                    {doc.filename}
                                </span>
                                {(() => {
                                    const sigStatus =
                                        signatureStatusForDoc?.(doc.id);
                                    return sigStatus ? (
                                        <SignatureRowPill status={sigStatus} />
                                    ) : null;
                                })()}
                                <VersionChip n={doc.latest_version_number} />
                                {activeLayoutQa && (
                                    <span
                                        className={`hidden text-[9px] xl:inline ${activeLayoutQa.className}`}
                                    >
                                        {activeLayoutQa.label}
                                    </span>
                                )}
                                {onSendForSignature &&
                                    !activeLayoutBlocked &&
                                    !activeLayoutVerifying && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSendForSignature(doc, null);
                                        }}
                                        title="Send for signature"
                                        className="ml-auto rounded p-1 text-[var(--app-text-subtle)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                    >
                                        <FileSignature className="h-3.5 w-3.5" />
                                    </button>
                                )}
                                {onExportDocument &&
                                    !activeLayoutBlocked &&
                                    !activeLayoutVerifying && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onExportDocument(doc, null);
                                        }}
                                        title="Export document"
                                        className={`${onSendForSignature ? "" : "ml-auto "}rounded p-1 text-[var(--app-text-subtle)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]`}
                                    >
                                        <Download className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                            {isDocExpanded && versions.length > 0 && (
                                <ul>
                                    <li
                                        className={`flex items-center gap-1.5 py-1 pr-2 text-[11px] ${
                                            dark
                                                ? "text-[var(--app-text-subtle)]"
                                                : "text-gray-400"
                                        }`}
                                        style={{ paddingLeft: basePadding + 24 }}
                                    >
                                        <History className="h-3 w-3" />
                                        Versions
                                    </li>
                                    {versions.map((version) => {
                                        const isCurrent =
                                            version.id ===
                                            doc.current_version_id;
                                        const versionLayoutQa =
                                            layoutQaLabel(version);
                                        const versionLayoutBlocked =
                                            version.layout_qa_status === "failed";
                                        const versionLayoutVerifying =
                                            version.layout_qa_status ===
                                            "unverified";
                                        return (
                                            <li
                                                key={`v-${version.id}`}
                                                onClick={() =>
                                                    onVersionClick?.(
                                                        doc,
                                                        version,
                                                    )
                                                }
                                                className={`group flex cursor-pointer items-center gap-1.5 rounded-sm py-1.5 pr-2 text-xs transition-colors ${
                                                    dark
                                                        ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                        : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                                                }`}
                                                style={{
                                                    paddingLeft:
                                                        basePadding + 40,
                                                }}
                                            >
                                                <FileText className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                                                <span className="min-w-0 flex-1 truncate">
                                                    {versionLabel(version)}
                                                </span>
                                                {typeof version.version_number ===
                                                    "number" && (
                                                    <span className="rounded border border-[var(--app-border)] px-1 py-px text-[9px]">
                                                        V{version.version_number}
                                                    </span>
                                                )}
                                                {isCurrent && (
                                                    <span className="text-[9px] uppercase tracking-wide text-[var(--app-accent)]">
                                                        Current
                                                    </span>
                                                )}
                                                <span className="hidden truncate text-[10px] text-[var(--app-text-subtle)] xl:inline">
                                                    {sourceLabel(version.source)}
                                                </span>
                                                {versionLayoutQa && (
                                                    <span
                                                        className={`hidden truncate text-[9px] 2xl:inline ${versionLayoutQa.className}`}
                                                    >
                                                        {versionLayoutQa.label}
                                                    </span>
                                                )}
                                                {onVersionProvenanceClick &&
                                                    version.provenance && (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                onVersionProvenanceClick(
                                                                    doc,
                                                                    version,
                                                                );
                                                            }}
                                                            title="View the conversation that produced this version"
                                                            className="ml-auto rounded p-1 text-[var(--app-text-subtle)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                        >
                                                            <MessageSquareText className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                                {onExportDocument &&
                                                    !versionLayoutBlocked &&
                                                    !versionLayoutVerifying && (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onExportDocument(
                                                                doc,
                                                                version.id,
                                                            );
                                                        }}
                                                        title="Export this version"
                                                        className="ml-auto rounded p-1 text-[var(--app-text-subtle)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                    >
                                                        <Download className="h-3.5 w-3.5" />
                                                    </button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            {isDocExpanded && derived.length > 0 && (
                                <ul>
                                    <li
                                        className={`flex items-center gap-1.5 py-1 pr-2 text-[11px] ${
                                            dark
                                                ? "text-[var(--app-text-subtle)]"
                                                : "text-gray-400"
                                        }`}
                                        style={{ paddingLeft: basePadding + 24 }}
                                    >
                                        <FileOutput className="h-3 w-3" />
                                        Created from this document
                                    </li>
                                    {derived.map((node) => (
                                        <li
                                            key={`derived-${node.document.id}`}
                                            draggable
                                            onDragStart={(e) => {
                                                e.dataTransfer.setData(
                                                    COCOA_LEGAL_DOC_DRAG_TYPE,
                                                    node.document.id,
                                                );
                                                e.dataTransfer.effectAllowed =
                                                    "move";
                                            }}
                                            onClick={() =>
                                                onDerivedDocumentClick?.(node) ??
                                                onDocClick(node.document)
                                            }
                                            className={`group flex cursor-pointer items-center gap-1.5 rounded-sm py-1.5 pr-2 text-xs transition-colors ${
                                                dark
                                                    ? "text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                    : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                                            }`}
                                            style={{
                                                paddingLeft: basePadding + 40,
                                            }}
                                        >
                                            <DocIcon
                                                fileType={
                                                    node.document.file_type
                                                }
                                            />
                                            <span className="min-w-0 flex-1 truncate">
                                                {node.document.filename}
                                            </span>
                                            <span className="hidden truncate text-[10px] text-[var(--app-text-subtle)] xl:inline">
                                                {derivationLabel(
                                                    node.derivation_kind,
                                                )}
                                            </span>
                                            {layoutQaLabel(node.version) && (
                                                <span
                                                    className={`hidden truncate text-[9px] 2xl:inline ${layoutQaLabel(node.version)?.className ?? ""}`}
                                                >
                                                    {layoutQaLabel(node.version)
                                                        ?.label}
                                                </span>
                                            )}
                                            {onExportDocument &&
                                                node.version?.layout_qa_status !==
                                                    "failed" &&
                                                node.version?.layout_qa_status !==
                                                    "unverified" && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onExportDocument(
                                                            node.document,
                                                            node.version?.id ??
                                                                null,
                                                        );
                                                    }}
                                                    title="Export generated document"
                                                    className="ml-auto rounded p-1 text-[var(--app-text-subtle)] opacity-0 transition group-hover:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                                >
                                                    <Download className="h-3.5 w-3.5" />
                                                </button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </>
        );
    }

    return (
        <ul
            className={`p-1 relative h-full ${dragOverRoot && dragOverFolderId === null ? "ring-2 ring-blue-400 ring-inset" : ""}`}
            onContextMenu={(e) => {
                // Only fires if not stopped by a child
                openContextMenu(e, null);
            }}
            onDragOver={(e) => {
                e.preventDefault();
                setDragOverRoot(true);
            }}
            onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverRoot(false);
                }
            }}
            onDrop={async (e) => {
                e.preventDefault();
                if (isInternalDrag(e)) {
                    e.stopPropagation();
                    setDragOverRoot(false);
                    setDragOverFolderId(null);
                    await handleDropOnTarget(null, e);
                }
                // External file drops bubble up to the parent panel's onDrop (upload handler)
            }}
        >
            {/* Project root row */}
            {projectName && (
                <li
                    className="flex items-center gap-2 px-2 py-1.5 select-none"
                    onContextMenu={(e) => { e.stopPropagation(); openContextMenu(e, null); }}
                >
                    <FolderOpen className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                    <span
                        className={`text-xs truncate ${
                            dark ? "text-[var(--app-text-muted)]" : "text-gray-500"
                        }`}
                    >
                        {projectName}
                    </span>
                    {onDraftDocument && (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDraftDocument();
                            }}
                            title="Draft a document for this matter"
                            className={`ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                                dark
                                    ? "text-[var(--app-text-subtle)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                    : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                            }`}
                        >
                            <PenLine className="h-3 w-3" />
                            <span className="hidden xl:inline">Draft</span>
                        </button>
                    )}
                </li>
            )}

            {/* Tree (depth 1 = direct children of root).
                Root-level new-folder input is rendered here by renderLevel
                when creatingIn === null — no separate top-level block. */}
            {renderLevel(null, 1)}

            {/* Empty state */}
            {documents.length === 0 && folders.length === 0 && creatingIn === undefined && (
                <li
                    className={`px-4 py-2 text-xs ${
                        dark ? "text-[var(--app-text-subtle)]" : "text-gray-400"
                    }`}
                >
                    No documents in this project.
                </li>
            )}

            {/* Context menu */}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className="fixed z-50 w-44 rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden text-xs"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    {onCreateFolder && (
                        <button
                            className="w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                            onClick={() => {
                                setContextMenu(null);
                                if (contextMenu.parentId) {
                                    setExpandedIds((prev) =>
                                        new Set([...prev, contextMenu.parentId!]),
                                    );
                                }
                                setCreatingIn(contextMenu.parentId);
                                setNewFolderName("");
                            }}
                        >
                            <FolderPlus className="h-3.5 w-3.5 text-gray-400" />
                            New subfolder
                        </button>
                    )}
                    {contextMenu.folderId && onRenameFolder && (
                        <button
                            className="w-full px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
                            onClick={() => {
                                const f = folders.find((x) => x.id === contextMenu.folderId);
                                setRenameValue(f?.name ?? "");
                                setRenamingId(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        >
                            Rename
                        </button>
                    )}
                    {contextMenu.folderId && onDeleteFolder && (
                        <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                            onClick={() => {
                                onDeleteFolder(contextMenu.folderId!);
                                setContextMenu(null);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            Delete folder
                        </button>
                    )}
                    {contextMenu.docId &&
                        onSendForSignature &&
                        (() => {
                            const doc = documents.find(
                                (d) => d.id === contextMenu.docId,
                            );
                            if (!doc) return null;
                            const node = treeByDocId.get(doc.id);
                            const activeVersion = node?.versions.find(
                                (version) =>
                                    version.id === doc.current_version_id,
                            );
                            if (
                                activeVersion?.layout_qa_status === "failed" ||
                                activeVersion?.layout_qa_status === "unverified"
                            ) {
                                return null;
                            }
                            return (
                                <button
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-50"
                                    onClick={() => {
                                        onSendForSignature(doc, null);
                                        setContextMenu(null);
                                    }}
                                >
                                    <FileSignature className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                    Send for signature
                                </button>
                            );
                        })()}
                    {contextMenu.docId && onDeleteDoc && (
                        <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50"
                            onClick={() => {
                                void onDeleteDoc(contextMenu.docId!);
                                setContextMenu(null);
                            }}
                        >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" />
                            Delete file
                        </button>
                    )}
                </div>
            )}
        </ul>
    );
}
