"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Upload,
    Loader2,
    AlertCircle,
    ShieldCheck,
    ChevronDown,
    ChevronRight,
    Folder,
    FolderOpen,
    FolderPlus,
} from "lucide-react";
import {
    getProject,
    deleteDocument,
    createTabularReview,
    updateProject,
    listProjectChats,
    deleteChat,
    renameChat,
    listTabularReviews,
    deleteTabularReview,
    updateTabularReview,
    getDocumentUrl,
    downloadDocumentsZip,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    renameProjectDocument,
    listDocumentVersions,
    uploadDocumentVersion,
    uploadProjectDocument,
    renameDocumentVersion,
    finalizeCleanDocument,
    getProjectPeople,
    inviteProjectMember,
    updateProjectMemberRole,
    removeProjectMember,
    getProjectBetaPolicy,
    updateProjectBetaPolicy,
    type BetaPolicy,
    type CocoLegalDocumentVersion,
} from "@/app/lib/cocoLegalApi";
import type {
    CocoLegalDocument,
    CocoLegalFolder,
    CocoLegalProject,
    CocoLegalChat,
    CocoLegalWorkflow,
    TabularReview,
} from "@/app/components/shared/types";
import { ToolbarTabs } from "@/app/components/shared/ToolbarTabs";
import {
    closeRowActionMenus,
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import {
    AddDocumentsModal,
    invalidateDirectoryCache,
} from "@/app/components/shared/AddDocumentsModal";
import { PeopleModal } from "@/app/components/shared/PeopleModal";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { useAuth } from "@/contexts/AuthContext";
import { UploadNewVersionModal } from "@/app/components/shared/UploadNewVersionModal";
import { DocViewModal } from "@/app/components/shared/DocViewModal";
import { AddNewTRModal } from "@/app/components/tabular/AddNewTRModal";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
    CHECK_W,
    DOC_NAME_COL_W,
    DocIcon,
    DocVersionHistory,
    formatBytes,
    formatDate,
    ProjectPageHeader,
    ProjectPageSkeleton,
    treeControlCellStyle,
    treeNameCellStyle,
    type ProjectContextMenu,
    type ProjectTab,
} from "./ProjectPageParts";
import { ProjectAssistantTab } from "./ProjectAssistantTab";
import { ProjectReviewsTab } from "./ProjectReviewsTab";
import { MatterNav } from "./MatterNav";
import { MatterTasksPanel } from "./MatterTasksPanel";
import { ControlledBetaPolicySummary } from "../legal/ControlledBetaPolicySummary";
import { projectBetaGate } from "@/app/lib/betaPolicyGate";
import {
    COCO_LEGAL_DOC_DRAG_TYPE,
    COCO_LEGAL_FOLDER_DRAG_TYPE,
    getCocoLegalDocDragData,
    getCocoLegalFolderDragData,
    hasCocoLegalDragPayload,
} from "@/app/lib/dragTypes";

interface Props {
    projectId: string;
    initialTab?: ProjectTab;
}

export function ProjectPage({ projectId, initialTab = "documents" }: Props) {
    const [project, setProject] = useState<CocoLegalProject | null>(null);
    const [folders, setFolders] = useState<CocoLegalFolder[]>([]);
    const [chats, setChats] = useState<CocoLegalChat[]>([]);
    const [projectReviews, setProjectReviews] = useState<TabularReview[]>([]);
    const [loading, setLoading] = useState(true);
    const searchParams = useSearchParams();
    const tabParam = searchParams.get("tab");
    const tab: ProjectTab =
        tabParam === "assistant" || tabParam === "reviews"
            ? tabParam
            : initialTab;
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [peopleModalOpen, setPeopleModalOpen] = useState(false);
    const [betaPolicy, setBetaPolicy] = useState<BetaPolicy | null>(null);
    const [betaEmails, setBetaEmails] = useState("");
    const [betaDomains, setBetaDomains] = useState("");
    const [betaPolicySaving, setBetaPolicySaving] = useState(false);
    const [betaPolicyError, setBetaPolicyError] = useState<string | null>(null);
    const [betaPolicyAcknowledged, setBetaPolicyAcknowledged] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const { user } = useAuth();
    const [uploadVersionDoc, setUploadVersionDoc] =
        useState<CocoLegalDocument | null>(null);
    const [viewingDoc, setViewingDoc] = useState<CocoLegalDocument | null>(null);
    const [viewingDocVersion, setViewingDocVersion] = useState<{
        id: string;
        label: string;
    } | null>(null);
    const [creatingChat, setCreatingChat] = useState(false);
    const [creatingReview, setCreatingReview] = useState(false);
    const [newTRModalOpen, setNewTRModalOpen] = useState(false);

    // Per-tab selection
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
    const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);

    // Version-history expansion (per-doc). versionsByDocId caches fetched
    // versions so toggling closed + open again doesn't refetch. loadingIds
    // drives the inline spinner in the version cell while a fetch is in
    // flight.
    const [expandedVersionDocIds, setExpandedVersionDocIds] = useState<
        Set<string>
    >(() => new Set());
    const [versionsByDocId, setVersionsByDocId] = useState<
        Map<string, CocoLegalDocumentVersion[]>
    >(() => new Map());
    const [loadingVersionDocIds, setLoadingVersionDocIds] = useState<
        Set<string>
    >(() => new Set());
    const [decisionVersionDocIds, setDecisionVersionDocIds] = useState<
        Set<string>
    >(() => new Set());
    const [finalizingCleanDocIds, setFinalizingCleanDocIds] = useState<
        Set<string>
    >(() => new Set());
    const [documentActionError, setDocumentActionError] = useState<string | null>(
        null,
    );

    async function fetchVersionsForDoc(docId: string, includeDecisions: boolean) {
        const res = await listDocumentVersions(docId, { includeDecisions });
        setVersionsByDocId((prev) => {
            const next = new Map(prev);
            next.set(docId, res.versions);
            return next;
        });
        return res;
    }

    const toggleVersions = async (docId: string) => {
        const already = expandedVersionDocIds.has(docId);
        if (already) {
            setExpandedVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
            return;
        }
        // Opening — expand immediately so the user sees a loading state.
        setExpandedVersionDocIds((prev) => new Set([...prev, docId]));
        if (versionsByDocId.has(docId)) return;
        setLoadingVersionDocIds((prev) => new Set([...prev, docId]));
        try {
            await fetchVersionsForDoc(docId, decisionVersionDocIds.has(docId));
        } catch (e) {
            console.error("listDocumentVersions failed", e);
        } finally {
            setLoadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
        }
    };

    async function toggleDecisionVersions(docId: string) {
        const includeDecisions = !decisionVersionDocIds.has(docId);
        setDecisionVersionDocIds((prev) => {
            const next = new Set(prev);
            if (includeDecisions) next.add(docId);
            else next.delete(docId);
            return next;
        });
        setLoadingVersionDocIds((prev) => new Set([...prev, docId]));
        try {
            await fetchVersionsForDoc(docId, includeDecisions);
        } catch (e) {
            console.error("listDocumentVersions failed", e);
        } finally {
            setLoadingVersionDocIds((prev) => {
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
        }
    }

    async function downloadDocVersion(
        docId: string,
        versionId: string,
        filename: string,
    ) {
        try {
            const resolved = await getDocumentUrl(docId, versionId, "export");
            const a = document.createElement("a");
            a.href = resolved.url;
            // Prefer the backend's resolved filename (which honours the
            // version's display_name). Fall back to the passed filename
            // if for some reason it's missing.
            a.download = resolved.filename || filename;
            a.click();
        } catch (e) {
            console.error("downloadDocVersion failed", e);
        }
    }

    /**
     * Trigger a file picker and upload the chosen file as a new version of
     * the given document. On success, refresh the project (for the doc's
     * latest_version_number) and re-fetch the version list so the history
     * panel shows the new row.
     */
    function handleUploadNewVersion(doc: CocoLegalDocument) {
        setUploadVersionDoc(doc);
    }

    async function submitNewVersion(
        doc: CocoLegalDocument,
        file: File,
        displayName: string,
    ) {
        try {
            await uploadDocumentVersion(doc.id, file, displayName);
            // Refresh project so doc.latest_version_number and filename advance.
            const updated = await getProject(projectId);
            setProject(updated);
            // Re-fetch versions for this doc (invalidate cache first).
            setVersionsByDocId((prev) => {
                const next = new Map(prev);
                next.delete(doc.id);
                return next;
            });
            // Ensure the history panel is expanded so the user sees it.
            setExpandedVersionDocIds((prev) => new Set([...prev, doc.id]));
            await fetchVersionsForDoc(doc.id, decisionVersionDocIds.has(doc.id));
        } catch (e) {
            console.error("uploadDocumentVersion failed", e);
        }
    }

    /**
     * Patch a version's display_name and update the local cache in place.
     */
    async function handleRenameVersion(
        docId: string,
        versionId: string,
        displayName: string | null,
    ) {
        try {
            const updated = await renameDocumentVersion(
                docId,
                versionId,
                displayName,
            );
            setVersionsByDocId((prev) => {
                const list = prev.get(docId);
                if (!list) return prev;
                const next = new Map(prev);
                next.set(
                    docId,
                    list.map((v) => (v.id === versionId ? updated : v)),
                );
                return next;
            });
        } catch (e) {
            console.error("renameDocumentVersion failed", e);
        }
    }

    function getErrorDetail(e: unknown): string {
        const raw = e instanceof Error ? e.message : String(e);
        try {
            const parsed = JSON.parse(raw) as { detail?: string };
            return parsed.detail ?? raw;
        } catch {
            return raw;
        }
    }

    async function handleFinalizeClean(doc: CocoLegalDocument) {
        if (finalizingCleanDocIds.has(doc.id)) return;
        setDocumentActionError(null);
        setFinalizingCleanDocIds((prev) => new Set([...prev, doc.id]));
        try {
            const result = await finalizeCleanDocument(doc.id);
            const updated = await getProject(projectId);
            setProject(updated);
            setExpandedVersionDocIds((prev) => new Set([...prev, doc.id]));
            await fetchVersionsForDoc(doc.id, decisionVersionDocIds.has(doc.id));
            setViewingDocVersion({
                id: result.version_id,
                label:
                    typeof result.version_number === "number"
                        ? `V${result.version_number}`
                        : "Clean Final",
            });
            setViewingDoc(doc);
        } catch (e) {
            setDocumentActionError(getErrorDetail(e));
        } finally {
            setFinalizingCleanDocIds((prev) => {
                const next = new Set(prev);
                next.delete(doc.id);
                return next;
            });
        }
    }

    // Inline rename for chats and reviews
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameChatValue, setRenameChatValue] = useState("");
    const [renamingReviewId, setRenamingReviewId] = useState<string | null>(null);
    const [renameReviewValue, setRenameReviewValue] = useState("");
    const [renamingDocumentId, setRenamingDocumentId] = useState<string | null>(null);
    const [renameDocumentValue, setRenameDocumentValue] = useState("");

    // Folder state
    const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
    // undefined = not creating; null = creating at root; string = creating inside that folder id
    const [creatingFolderIn, setCreatingFolderIn] = useState<string | null | undefined>(undefined);
    const [newFolderName, setNewFolderName] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
    const [renameFolderValue, setRenameFolderValue] = useState("");
    const [contextMenu, setContextMenu] =
        useState<ProjectContextMenu | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const newFolderInputRef = useRef<HTMLDivElement | null>(null);
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
    const [dragOverRoot, setDragOverRoot] = useState(false);
    const [dragOverFileRoot, setDragOverFileRoot] = useState(false);
    const [uploadingDroppedFilenames, setUploadingDroppedFilenames] = useState<
        string[]
    >([]);

    // Actions dropdown
    const [actionsOpen, setActionsOpen] = useState(false);
    const actionsRef = useRef<HTMLDivElement>(null);
    const [search, setSearch] = useState("");

    const router = useRouter();
    const { saveChat } = useChatHistoryContext();

    function handleTabChange(newTab: ProjectTab) {
        if (newTab === "assistant") {
            router.push(`/projects/${projectId}/doc-review`);
            return;
        }
        const base = `/projects/${projectId}`;
        const url = newTab === "documents" ? base : `${base}?tab=${newTab}`;
        router.push(url);
    }

    useEffect(() => {
        Promise.all([
            getProject(projectId),
            listProjectChats(projectId).catch(() => [] as CocoLegalChat[]),
            listTabularReviews(projectId).catch(() => []),
            getProjectBetaPolicy(projectId).catch(() => null),
        ])
            .then(([proj, projectChats, projectReviews, policy]) => {
                setProject(proj);
                const loadedFolders = proj.folders ?? [];
                setFolders(loadedFolders);
                setExpandedFolderIds(new Set(loadedFolders.map((f) => f.id)));
                setChats(projectChats);
                setProjectReviews(projectReviews);
                setBetaPolicy(policy);
                setBetaEmails(policy?.allowed_recipient_emails.join(", ") ?? "");
                setBetaDomains(policy?.allowed_recipient_domains.join(", ") ?? "");
            })
            .finally(() => setLoading(false));
    }, [projectId]);

    async function saveBetaPolicy(acceptDataPolicy: boolean) {
        setBetaPolicySaving(true);
        setBetaPolicyError(null);
        const parse = (value: string) =>
            value
                .split(/[\s,]+/)
                .map((entry) => entry.trim().toLowerCase())
                .filter(Boolean);
        try {
            const updated = await updateProjectBetaPolicy(projectId, {
                accept_data_policy: acceptDataPolicy || undefined,
                policy_acknowledged:
                    acceptDataPolicy && betaPolicyAcknowledged
                        ? true
                        : undefined,
                allowed_recipient_emails: parse(betaEmails),
                allowed_recipient_domains: parse(betaDomains),
            });
            setBetaPolicy(updated);
            setBetaPolicyAcknowledged(false);
            setBetaEmails(updated.allowed_recipient_emails.join(", "));
            setBetaDomains(updated.allowed_recipient_domains.join(", "));
        } catch (reason) {
            setBetaPolicyError(
                reason instanceof Error
                    ? reason.message
                    : "Could not update the controlled-beta policy.",
            );
        } finally {
            setBetaPolicySaving(false);
        }
    }

    // Reset selection and close dropdowns when tab changes
    useEffect(() => {
        setSelectedDocIds([]);
        setSelectedChatIds([]);
        setSelectedReviewIds([]);
        setActionsOpen(false);
        setContextMenu(null);
    }, [tab]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (actionsRef.current && !actionsRef.current.contains(e.target as Node))
                setActionsOpen(false);
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node))
                setContextMenu(null);
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);

    // Clear all drag state when any drag operation ends
    useEffect(() => {
        function handleDragEnd() {
            setDragOverFolderId(null);
            setDragOverRoot(false);
            setDragOverFileRoot(false);
        }
        document.addEventListener("dragend", handleDragEnd);
        return () => document.removeEventListener("dragend", handleDragEnd);
    }, []);

    // Scroll new-folder input into view whenever it appears
    useEffect(() => {
        if (creatingFolderIn !== undefined) {
            newFolderInputRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }, [creatingFolderIn]);

    // ── Folder handlers ───────────────────────────────────────────────────────

    function toggleFolder(id: string) {
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    async function handleCreateFolder(parentId: string | null) {
        const name = newFolderName.trim();
        setNewFolderName("");
        if (!name) { setCreatingFolderIn(undefined); return; }

        // Immediately hide the input and show an optimistic folder row
        setCreatingFolderIn(undefined);
        const tempId = `temp-${Date.now()}`;
        const optimistic: CocoLegalFolder = {
            id: tempId,
            project_id: projectId,
            user_id: "",
            name,
            parent_folder_id: parentId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        setFolders((prev) => [...prev, optimistic]);
        setExpandedFolderIds((prev) => new Set([...prev, tempId]));
        if (parentId) setExpandedFolderIds((prev) => new Set([...prev, parentId]));

        // Replace with real folder from API
        const folder = await createProjectFolder(projectId, name, parentId ?? undefined);
        setFolders((prev) => prev.map((f) => f.id === tempId ? folder : f));
        setExpandedFolderIds((prev) => {
            const next = new Set(prev);
            next.delete(tempId);
            next.add(folder.id);
            return next;
        });
    }

    async function handleRenameFolder(folderId: string) {
        const name = renameFolderValue.trim();
        setRenamingFolderId(null);
        if (!name) return;
        setFolders((prev) => prev.map((f) => f.id === folderId ? { ...f, name } : f));
        await renameProjectFolder(projectId, folderId, name);
    }

    async function handleDeleteFolder(folderId: string) {
        // Collect all subfolder IDs that will cascade-delete
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            folders.filter((f) => f.parent_folder_id === id).forEach((f) => collectIds(f.id));
        }
        collectIds(folderId);

        setFolders((prev) => prev.filter((f) => !toDelete.has(f.id)));
        setProject((prev) =>
            prev ? {
                ...prev,
                documents: (prev.documents ?? []).map((d) =>
                    d.folder_id && toDelete.has(d.folder_id) ? { ...d, folder_id: null } : d,
                ),
            } : prev,
        );
        await deleteProjectFolder(projectId, folderId);
    }

    // ── Doc/chat/review handlers ──────────────────────────────────────────────

    function handleDocsSelected(newDocs: CocoLegalDocument[]) {
        setProject((prev) =>
            prev ? {
                ...prev,
                documents: [
                    ...(prev.documents || []),
                    ...newDocs.filter((d) => !prev.documents?.some((e) => e.id === d.id)),
                ],
            } : prev,
        );
    }

    async function handleRemoveDocFromFolder(docId: string) {
        setProject((prev) => prev ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
                d.id === docId ? { ...d, folder_id: null } : d,
            ),
        } : prev);
        await moveDocumentToFolder(projectId, docId, null);
    }

    async function submitDocumentRename(docId: string) {
        const trimmed = renameDocumentValue.trim();
        setRenamingDocumentId(null);
        if (!trimmed) return;
        const previous = project?.documents?.find((d) => d.id === docId);
        if (!previous || trimmed === previous.filename) return;

        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).map((d) =>
                          d.id === docId
                              ? {
                                    ...d,
                                    filename: trimmed,
                                    updated_at: new Date().toISOString(),
                                }
                              : d,
                      ),
                  }
                : prev,
        );
        try {
            const updated = await renameProjectDocument(projectId, docId, trimmed);
            setProject((prev) =>
                prev
                    ? {
                          ...prev,
                          documents: (prev.documents ?? []).map((d) =>
                              d.id === docId ? { ...d, ...updated } : d,
                          ),
                      }
                    : prev,
            );
        } catch (e) {
            console.error("renameProjectDocument failed", e);
            setProject((prev) =>
                prev && previous
                    ? {
                          ...prev,
                          documents: (prev.documents ?? []).map((d) =>
                              d.id === docId ? previous : d,
                          ),
                      }
                    : prev,
            );
        }
    }

    async function handleRemoveDoc(docId: string) {
        const doc = project?.documents?.find((d) => d.id === docId);
        // Backend only lets the doc creator delete. Warn the requester
        // instead of letting the request 404 silently.
        if (doc && user?.id && doc.user_id && doc.user_id !== user.id) {
            setOwnerOnlyAction("delete this document");
            return;
        }
        await deleteDocument(docId);
        setProject((prev) =>
            prev ? { ...prev, documents: prev.documents?.filter((d) => d.id !== docId) || [] } : prev,
        );
    }

    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/doc-review/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    function handleNewReview() {
        const docs = project?.documents?.filter((d) => d.status === "ready") || [];
        if (docs.length === 0) return;
        setNewTRModalOpen(true);
    }

    async function handleCreateReview(
        title: string,
        _projectId?: string,
        documentIds?: string[],
        columnsConfig?: CocoLegalWorkflow["columns_config"],
    ) {
        setCreatingReview(true);
        try {
            const docs = project?.documents?.filter((d) => d.status === "ready") || [];
            const review = await createTabularReview({
                title: title || undefined,
                document_ids: documentIds ?? docs.map((d) => d.id),
                columns_config: columnsConfig ?? [],
                project_id: projectId,
            });
            router.push(`/projects/${projectId}/tabular-reviews/${review.id}`);
        } finally {
            setCreatingReview(false);
        }
    }

    async function handleTitleCommit(newName: string) {
        if (!newName || newName === project?.name) return;
        // Server-side this would 404 silently for non-owners; surface a
        // clear permission warning instead.
        if (project && project.is_owner === false) {
            setOwnerOnlyAction("rename this matter");
            return;
        }
        setProject((prev) => (prev ? { ...prev, name: newName } : prev));
        await updateProject(projectId, { name: newName });
    }

    async function submitChatRename(chatId: string) {
        const trimmed = renameChatValue.trim();
        setRenamingChatId(null);
        if (!trimmed) return;
        const chat = chats.find((c) => c.id === chatId);
        if (chat && user?.id && chat.user_id !== user.id) {
            setOwnerOnlyAction("rename this chat");
            return;
        }
        setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, title: trimmed } : c)));
        await renameChat(chatId, trimmed);
    }

    async function submitReviewRename(reviewId: string) {
        const trimmed = renameReviewValue.trim();
        setRenamingReviewId(null);
        if (!trimmed) return;
        const review = projectReviews.find((r) => r.id === reviewId);
        if (review && user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("rename this tabular review");
            return;
        }
        setProjectReviews((prev) => prev.map((r) => (r.id === reviewId ? { ...r, title: trimmed } : r)));
        await updateTabularReview(reviewId, { title: trimmed });
    }

    async function downloadDoc(docId: string) {
        const { url, filename } = await getDocumentUrl(docId, null, "export");
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    }

    async function handleDownloadSelectedDocs() {
        setActionsOpen(false);
        const ids = [...selectedDocIds];
        if (ids.length === 1) { await downloadDoc(ids[0]); return; }
        const blob = await downloadDocumentsZip(ids);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "documents.zip";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async function handleRemoveSelectedFromFolder() {
        const ids = selectedDocIds.filter((id) => docs.find((d) => d.id === id)?.folder_id != null);
        setActionsOpen(false);
        if (ids.length === 0) return;
        setProject((prev) => prev ? {
            ...prev,
            documents: (prev.documents ?? []).map((d) =>
                ids.includes(d.id) ? { ...d, folder_id: null } : d,
            ),
        } : prev);
        await Promise.all(ids.map((id) => moveDocumentToFolder(projectId, id, null).catch(() => {})));
    }

    async function handleDeleteSelectedDocs() {
        const ids = [...selectedDocIds];
        setActionsOpen(false);
        // Filter to docs the requester owns (server-side gate).
        const owned = ids.filter((id) => {
            const d = project?.documents?.find((dd) => dd.id === id);
            return !d || !d.user_id || !user?.id || d.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedDocIds([]);
        await Promise.all(owned.map((id) => deleteDocument(id).catch(() => {})));
        setProject((prev) =>
            prev ? { ...prev, documents: prev.documents?.filter((d) => !owned.includes(d.id)) || [] } : prev,
        );
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected documents — only the document creator can delete a document`,
            );
        }
    }

    async function handleDeleteSelectedChats() {
        const ids = [...selectedChatIds];
        setActionsOpen(false);
        const owned = ids.filter((id) => {
            const c = chats.find((cc) => cc.id === id);
            return !c || !user?.id || c.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedChatIds([]);
        await Promise.all(owned.map((id) => deleteChat(id).catch(() => {})));
        setChats((prev) => prev.filter((c) => !owned.includes(c.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected chats — only the chat creator can delete a chat`,
            );
        }
    }

    async function handleDeleteSelectedReviews() {
        const ids = [...selectedReviewIds];
        setActionsOpen(false);
        const owned = ids.filter((id) => {
            const r = projectReviews.find((rr) => rr.id === id);
            return !r || !user?.id || r.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedReviewIds([]);
        await Promise.all(owned.map((id) => deleteTabularReview(id).catch(() => {})));
        setProjectReviews((prev) => prev.filter((r) => !owned.includes(r.id)));
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected reviews — only the review creator can delete a review`,
            );
        }
    }

    async function handleDeleteChatRow(chat: CocoLegalChat) {
        if (user?.id && chat.user_id !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        await deleteChat(chat.id);
        setChats((prev) => prev.filter((c) => c.id !== chat.id));
    }

    async function handleDeleteReviewRow(review: TabularReview) {
        if (user?.id && review.user_id !== user.id) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        await deleteTabularReview(review.id);
        setProjectReviews((prev) => prev.filter((r) => r.id !== review.id));
    }

    // ── Drag & drop ───────────────────────────────────────────────────────────

    function wouldCreateCycle(movingId: string, targetId: string): boolean {
        // Returns true if targetId is movingId or a descendant of it
        let cur: CocoLegalFolder | undefined = folders.find((f) => f.id === targetId);
        while (cur) {
            if (cur.id === movingId) return true;
            if (!cur.parent_folder_id) break;
            cur = folders.find((f) => f.id === cur!.parent_folder_id);
        }
        return false;
    }

    function hasMovePayload(dt: DataTransfer): boolean {
        return hasCocoLegalDragPayload(dt);
    }

    function hasFilePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).includes("Files");
    }

    async function handleDropProjectFiles(files: File[]) {
        if (files.length === 0) return;
        setUploadingDroppedFilenames(files.map((file) => file.name));
        try {
            const uploaded = await Promise.all(
                files.map((file) => uploadProjectDocument(projectId, file)),
            );
            invalidateDirectoryCache();
            handleDocsSelected(uploaded);
        } catch (err) {
            console.error("Project document drop upload failed", err);
        } finally {
            setUploadingDroppedFilenames([]);
        }
    }

    async function handleDropOnFolder(targetFolderId: string | null, dt: DataTransfer) {
        if (!hasMovePayload(dt)) return;
        const docId = getCocoLegalDocDragData(dt);
        const subFolderId = getCocoLegalFolderDragData(dt);
        if (docId) {
            const doc = (project?.documents ?? []).find((d) => d.id === docId);
            if (!doc || (doc.folder_id ?? null) === targetFolderId) return;
            setProject((prev) => prev ? {
                ...prev,
                documents: (prev.documents ?? []).map((d) =>
                    d.id === docId ? { ...d, folder_id: targetFolderId } : d,
                ),
            } : prev);
            await moveDocumentToFolder(projectId, docId, targetFolderId);
        } else if (subFolderId && subFolderId !== targetFolderId) {
            if (targetFolderId !== null && wouldCreateCycle(subFolderId, targetFolderId)) return;
            const folder = folders.find((f) => f.id === subFolderId);
            if (!folder || (folder.parent_folder_id ?? null) === targetFolderId) return;
            setFolders((prev) => prev.map((f) =>
                f.id === subFolderId ? { ...f, parent_folder_id: targetFolderId } : f,
            ));
            await moveSubfolderToFolder(projectId, subFolderId, targetFolderId);
        }
    }

    const currentRole = project?.current_user_role;
    const canMutate =
        currentRole === "owner" ||
        currentRole === "admin" ||
        currentRole === "lawyer" ||
        currentRole === "editor";
    const canExport = Boolean(currentRole && currentRole !== "viewer");
    const canLifecycle = currentRole === "owner" || currentRole === "admin";

    // ── Tree rendering ────────────────────────────────────────────────────────

    function renderFolderInput(parentId: string | null, depth: number) {
        if (creatingFolderIn !== parentId) return null;
        return (
            <div
                ref={newFolderInputRef}
                className="group flex items-center h-10 pr-8 border-b border-gray-50"
                key={`new-folder-${parentId ?? "root"}`}
            >
                <div
                    className={`sticky left-0 z-[60] ${CHECK_W} bg-white p-2 flex items-center justify-center self-stretch`}
                    style={treeControlCellStyle(depth)}
                >
                    <ChevronRight className="h-3.5 w-3.5 text-gray-300 shrink-0" />
                </div>
                <div
                    className={`sticky left-8 z-[60] ${DOC_NAME_COL_W} bg-white p-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <div className="flex items-center gap-1.5">
                        <FolderPlus className="h-4 w-4 text-amber-400 shrink-0" />
                        <input
                            autoFocus
                            className="flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void handleCreateFolder(parentId);
                                if (e.key === "Escape") { setCreatingFolderIn(undefined); setNewFolderName(""); }
                            }}
                            onBlur={() => void handleCreateFolder(parentId)}
                        />
                    </div>
                </div>
                <div className="ml-auto w-20 shrink-0" />
                <div className="w-24 shrink-0" />
                <div className="w-20 shrink-0" />
                <div className="w-32 shrink-0" />
                <div className="w-32 shrink-0" />
                <div className="w-8 shrink-0" />
            </div>
        );
    }

    function renderUploadingDocumentRows(depth: number) {
        return uploadingDroppedFilenames.map((filename) => (
            <div
                key={`uploading-doc-${filename}`}
                className="group flex items-center h-10 pr-8 border-b border-gray-50"
            >
                <div
                    className={`sticky left-0 z-[60] ${CHECK_W} bg-white p-2 flex items-center justify-center self-stretch`}
                    style={treeControlCellStyle(depth)}
                >
                    <input
                        type="checkbox"
                        disabled
                        className="h-2.5 w-2.5 rounded border-gray-200 cursor-default accent-black disabled:opacity-100"
                    />
                </div>
                <div
                    className={`sticky left-8 z-[60] ${DOC_NAME_COL_W} bg-white p-2`}
                    style={treeNameCellStyle(depth)}
                >
                    <div className="flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />
                        <span className="text-sm text-gray-400 truncate">
                            {filename}
                        </span>
                    </div>
                </div>
                <div className="ml-auto w-20 shrink-0 text-xs text-gray-300 uppercase truncate">
                    {filename.includes(".") ? filename.split(".").pop() : "file"}
                </div>
                <div className="w-24 shrink-0 text-sm text-gray-300">
                    Uploading
                </div>
                <div className="w-20 shrink-0 text-sm text-gray-300">—</div>
                <div className="w-32 shrink-0 text-sm text-gray-300">—</div>
                <div className="w-32 shrink-0 text-sm text-gray-300">—</div>
                <div className="w-8 shrink-0" />
            </div>
        ));
    }

    function renderLevel(parentId: string | null, depth: number) {
        const childFolders = folders
            .filter((f) => f.parent_folder_id === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
        const childDocs = (project?.documents ?? []).filter((d) => (d.folder_id ?? null) === parentId);

        return (
            <>
                {parentId === null && renderUploadingDocumentRows(depth)}
                {/* Files first */}
                {childDocs.map((doc) => {
                    const isProcessing = doc.status === "pending" || doc.status === "processing";
                    const isError = doc.status === "error";
                    const isVersionsOpen = expandedVersionDocIds.has(doc.id);
                    const hasVersions =
                        typeof doc.latest_version_number === "number" &&
                        doc.latest_version_number >= 1;
                    return (
                        <div key={`doc-${doc.id}`}>
                            <div
                                draggable={renamingDocumentId !== doc.id}
                                onDragStart={(e) => {
                                    if (renamingDocumentId === doc.id) {
                                        e.preventDefault();
                                        return;
                                    }
                                    e.dataTransfer.setData(COCO_LEGAL_DOC_DRAG_TYPE, doc.id);
                                    e.dataTransfer.effectAllowed = "move";
                                }}
                                onClick={() => {
                                    setViewingDocVersion(null);
                                    setViewingDoc(doc);
                                }}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closeRowActionMenus();
                                    setContextMenu({
                                        x: e.clientX,
                                        y: e.clientY,
                                        docId: doc.id,
                                        folderId: null,
                                        showFolderActions: false,
                                    });
                                }}
                            className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                            >
                                {(() => {
                                    const rowBg = selectedDocIds.includes(doc.id)
                                        ? "bg-gray-50"
                                        : "bg-white";
                                    return (
                                        <>
                                <div
                                    className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-gray-50`}
                                    style={treeControlCellStyle(depth)}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedDocIds.includes(doc.id)}
                                        onChange={() =>
                                            setSelectedDocIds((prev) =>
                                                prev.includes(doc.id)
                                                    ? prev.filter((x) => x !== doc.id)
                                                    : [...prev, doc.id],
                                            )
                                        }
                                        className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                    />
                                </div>
                                <div className={`sticky left-8 z-[60] ${DOC_NAME_COL_W} bg-white p-2 group-hover:bg-gray-50`} style={treeNameCellStyle(depth)}>
                                <div className="flex items-center gap-2">
                                    {isProcessing ? (
                                        <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />
                                    ) : isError ? (
                                        <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                                    ) : (
                                        <DocIcon fileType={doc.file_type} />
                                    )}
                                    {renamingDocumentId === doc.id ? (
                                        <input
                                            autoFocus
                                            className="min-w-0 flex-1 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"
                                            value={renameDocumentValue}
                                            onClick={(e) => e.stopPropagation()}
                                            onDragStart={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onChange={(e) =>
                                                setRenameDocumentValue(
                                                    e.target.value,
                                                )
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter")
                                                    void submitDocumentRename(
                                                        doc.id,
                                                    );
                                                if (e.key === "Escape") {
                                                    setRenamingDocumentId(null);
                                                    setRenameDocumentValue("");
                                                }
                                            }}
                                            onBlur={() =>
                                                void submitDocumentRename(
                                                    doc.id,
                                                )
                                            }
                                        />
                                    ) : (
                                        <span className="text-sm text-gray-800 truncate">{doc.filename}</span>
                                    )}
                                </div>
                                </div>
                                <div className="ml-auto w-20 shrink-0 text-xs text-gray-500 uppercase truncate">
                                    {doc.file_type ?? <span className="text-gray-300">—</span>}
                                </div>
                                <div className="w-24 shrink-0 text-sm text-gray-500 truncate">
                                    {doc.size_bytes != null ? formatBytes(doc.size_bytes) : <span className="text-gray-300">—</span>}
                                </div>
                                <div
                                    className="w-20 shrink-0 text-sm text-gray-500 flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {hasVersions ? (
                                        <button
                                            onClick={() => void toggleVersions(doc.id)}
                                            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100 transition-colors"
                                        >
                                            <span>{doc.latest_version_number}</span>
                                            {isVersionsOpen ? (
                                                <ChevronDown className="h-3 w-3 text-gray-400" />
                                            ) : (
                                                <ChevronRight className="h-3 w-3 text-gray-400" />
                                            )}
                                        </button>
                                    ) : (
                                        <span className="text-gray-300 pl-1">—</span>
                                    )}
                                </div>
                                <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                    {doc.created_at ? formatDate(doc.created_at) : <span className="text-gray-300">—</span>}
                                </div>
                                <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                    {doc.updated_at ? formatDate(doc.updated_at) : <span className="text-gray-300">—</span>}
                                </div>
                                <div className="w-8 shrink-0 flex justify-end">
                                    {!isProcessing && (
                                        <RowActions
                                            onRename={canMutate ? () => {
                                                setRenameDocumentValue(doc.filename);
                                                setRenamingDocumentId(doc.id);
                                            } : undefined}
                                            renameLabel="Rename document"
                                            onDownload={canExport ? () => downloadDoc(doc.id) : undefined}
                                            onShowAllVersions={
                                                hasVersions && !isVersionsOpen
                                                    ? () => void toggleVersions(doc.id)
                                                    : undefined
                                            }
                                            onUploadNewVersion={canMutate ? () =>
                                                void handleUploadNewVersion(doc)
                                            : undefined}
                                            onFinalizeClean={
                                                canMutate && doc.file_type === "docx"
                                                    ? () => void handleFinalizeClean(doc)
                                                    : undefined
                                            }
                                            onRemoveFromFolder={canMutate && doc.folder_id ? () => handleRemoveDocFromFolder(doc.id) : undefined}
                                            onDelete={canLifecycle ? () => handleRemoveDoc(doc.id) : undefined}
                                        />
                                    )}
                                </div>
                                        </>
                                    );
                                })()}
                            </div>
                            {isVersionsOpen && (
                                <DocVersionHistory
                                    docId={doc.id}
                                    filename={doc.filename}
                                    loading={loadingVersionDocIds.has(doc.id)}
                                    versions={versionsByDocId.get(doc.id) ?? []}
                                    depth={depth}
                                    onDownloadVersion={canExport ? downloadDocVersion : undefined}
                                    onOpenVersion={(versionId, label) => {
                                        setViewingDocVersion({ id: versionId, label });
                                        setViewingDoc(doc);
                                    }}
                                    onRenameVersion={canMutate ? (versionId, displayName) =>
                                        handleRenameVersion(doc.id, versionId, displayName)
                                    : undefined}
                                    includeDecisions={decisionVersionDocIds.has(doc.id)}
                                    onToggleDecisions={() =>
                                        void toggleDecisionVersions(doc.id)
                                    }
                                />
                            )}
                        </div>
                    );
                })}

                {/* Subfolders after files, sorted alphabetically */}
                {childFolders.map((folder) => {
                    const isExpanded = expandedFolderIds.has(folder.id);
                    const isRenaming = renamingFolderId === folder.id;
                    return (
                        <div key={`folder-${folder.id}`}>
                            <div
                                draggable={!isRenaming}
                                onDragStart={(e) => {
                                    if (isRenaming) {
                                        e.preventDefault();
                                        return;
                                    }
                                    e.dataTransfer.setData(COCO_LEGAL_FOLDER_DRAG_TYPE, folder.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    e.stopPropagation();
                                }}
                                onDragOver={(e) => {
                                    if (!hasMovePayload(e.dataTransfer)) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(folder.id);
                                }}
                                onDragLeave={(e) => { e.stopPropagation(); setDragOverFolderId(null); }}
                                onDrop={async (e) => {
                                    if (!hasMovePayload(e.dataTransfer)) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDragOverFolderId(null);
                                    setDragOverRoot(false);
                                    await handleDropOnFolder(folder.id, e.dataTransfer);
                                }}
                                onClick={() => toggleFolder(folder.id)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closeRowActionMenus();
                                    setContextMenu({ x: e.clientX, y: e.clientY, folderId: folder.id, showFolderActions: true });
                                }}
                                className={`group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors ${isRenaming ? "" : "select-none"} ${dragOverFolderId === folder.id ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : ""}`}
                            >
                                <div className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${dragOverFolderId === folder.id ? "bg-blue-50" : "bg-white"} group-hover:bg-gray-50 self-stretch`} style={treeControlCellStyle(depth)}>
                                    {isExpanded
                                        ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                        : <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                    }
                                </div>
                                <div className={`sticky left-8 z-[60] ${DOC_NAME_COL_W} p-2 ${dragOverFolderId === folder.id ? "bg-blue-50" : "bg-white"} group-hover:bg-gray-50`} style={treeNameCellStyle(depth)}>
                                <div className="flex items-center gap-1.5">
                                    {isExpanded
                                        ? <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
                                        : <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                                    }
                                    {isRenaming ? (
                                        <input
                                            autoFocus
                                            className="flex-1 min-w-0 text-sm text-gray-800 bg-transparent outline-none"
                                            value={renameFolderValue}
                                            onDragStart={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onChange={(e) => setRenameFolderValue(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") void handleRenameFolder(folder.id);
                                                if (e.key === "Escape") setRenamingFolderId(null);
                                            }}
                                            onBlur={() => void handleRenameFolder(folder.id)}
                                            onClick={(e) => e.stopPropagation()}
                                        />
                                    ) : (
                                        <span className="text-sm text-gray-800 truncate">{folder.name}</span>
                                    )}
                                </div>
                                </div>
                                <div className="ml-auto w-20 shrink-0 text-xs text-gray-300">—</div>
                                <div className="w-24 shrink-0 text-sm text-gray-300">—</div>
                                <div className="w-20 shrink-0 text-sm text-gray-300">—</div>
                                <div className="w-32 shrink-0 text-sm text-gray-300">—</div>
                                <div className="w-32 shrink-0 text-sm text-gray-300">—</div>
                                <div
                                    className="w-8 shrink-0 flex justify-end"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {canMutate ? (
                                        <RowActions
                                            onRename={() => {
                                                setRenameFolderValue(folder.name);
                                                setRenamingFolderId(folder.id);
                                            }}
                                            onDelete={() => handleDeleteFolder(folder.id)}
                                        />
                                    ) : null}
                                </div>
                            </div>
                            {isExpanded && renderLevel(folder.id, depth + 1)}
                        </div>
                    );
                })}

                {/* New-folder input row at the bottom of this level */}
                {renderFolderInput(parentId, depth)}
            </>
        );
    }

    // ── Loading skeleton ──────────────────────────────────────────────────────

    if (loading) return <ProjectPageSkeleton />;

    if (!project) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-gray-400">Matter not found</p>
            </div>
        );
    }

    const docs = project.documents || [];
    const q = search.toLowerCase();
    const filteredDocs = q ? docs.filter((d) => d.filename.toLowerCase().includes(q)) : docs;
    const filteredChats = q ? chats.filter((c) => (c.title ?? "").toLowerCase().includes(q)) : chats;
    const filteredReviews = q ? projectReviews.filter((r) => (r.title ?? "").toLowerCase().includes(q)) : projectReviews;

    const allDocsSelected = filteredDocs.length > 0 && filteredDocs.every((d) => selectedDocIds.includes(d.id));
    const someDocsSelected = !allDocsSelected && filteredDocs.some((d) => selectedDocIds.includes(d.id));
    const allChatsSelected = filteredChats.length > 0 && filteredChats.every((c) => selectedChatIds.includes(c.id));
    const someChatsSelected = !allChatsSelected && filteredChats.some((c) => selectedChatIds.includes(c.id));
    const allReviewsSelected = filteredReviews.length > 0 && filteredReviews.every((r) => selectedReviewIds.includes(r.id));
    const someReviewsSelected = !allReviewsSelected && filteredReviews.some((r) => selectedReviewIds.includes(r.id));

    const currentSelectionCount =
        tab === "documents" ? selectedDocIds.length :
        tab === "assistant" ? selectedChatIds.length :
        selectedReviewIds.length;

    const handleDeleteSelected =
        tab === "documents" ? handleDeleteSelectedDocs :
        tab === "assistant" ? handleDeleteSelectedChats :
        handleDeleteSelectedReviews;

    const hasSelectionAction =
        tab === "documents" ? canExport || canMutate || canLifecycle : canMutate;
    const actionsDropdown = currentSelectionCount > 0 && hasSelectionAction ? (
        <div ref={actionsRef} className="relative">
            <button
                onClick={() => setActionsOpen((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 transition-colors"
            >
                Actions
                <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {actionsOpen && (
                <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-gray-100 bg-white shadow-lg z-[120] overflow-hidden">
                    {tab === "documents" && canExport && (
                        <button
                            onClick={handleDownloadSelectedDocs}
                            className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            Download
                        </button>
                    )}
                    {tab === "documents" && canMutate && selectedDocIds.some((id) => docs.find((d) => d.id === id)?.folder_id != null) && (
                        <button
                            onClick={handleRemoveSelectedFromFolder}
                            className="w-full px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                        >
                            Remove from subfolder
                        </button>
                    )}
                    {(tab === "documents" ? canLifecycle : canMutate) ? (
                        <button
                            onClick={handleDeleteSelected}
                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                        >
                            Delete
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    ) : null;

    const toolbarActions = (
        <div className="flex items-center gap-5">
            {actionsDropdown}
            {tab === "documents" && canMutate && (
                <>
                    <button
                        onClick={() => { setCreatingFolderIn(null); setNewFolderName(""); }}
                        className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        <FolderPlus className="h-3.5 w-3.5" />
                        Add Subfolder
                    </button>
                    <button
                        onClick={() => {
                            if (!projectBetaGate(betaPolicy).uploadsBlocked)
                                setAddDocsOpen(true);
                            else
                                setBetaPolicyError(
                                    "The synthetic/redacted-data policy must be accepted before uploads are enabled.",
                                );
                        }}
                        aria-disabled={projectBetaGate(betaPolicy).uploadsBlocked}
                        className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
                    >
                        <Upload className="h-3.5 w-3.5" />
                        Add Documents
                    </button>
                </>
            )}
        </div>
    );

    return (
        <div className="flex-1 overflow-y-auto bg-white flex flex-col h-full">
            <ProjectPageHeader
                project={project}
                tab={tab}
                search={search}
                creatingChat={creatingChat}
                creatingReview={creatingReview}
                docsCount={docs.length}
                onBackToProjects={() => router.push("/projects")}
                onOpenDocuments={() => router.push(`/projects/${projectId}`)}
                onTitleCommit={handleTitleCommit}
                onSearchChange={setSearch}
                onOpenPeople={() => setPeopleModalOpen(true)}
                onNewChat={canMutate ? handleNewChat : undefined}
                onNewReview={canMutate ? handleNewReview : undefined}
                canRenameMatter={canLifecycle}
            />

            {betaPolicy && projectBetaGate(betaPolicy).showPanel ? (
                <section className="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950">
                    <div className="flex items-start gap-3">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-medium">
                                    Controlled beta · synthetic or redacted documents only
                                </p>
                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium">
                                    {betaPolicy.accepted
                                        ? "Policy accepted"
                                        : "Action required"}
                                </span>
                            </div>
                            <div className="mt-2">
                                <ControlledBetaPolicySummary
                                    compact
                                    showAccountLink
                                />
                            </div>
                            {project.current_user_role === "owner" ||
                            project.current_user_role === "admin" ? (
                                <div className="mt-3 grid gap-2 md:grid-cols-2">
                                    <label className="text-[11px] font-medium text-amber-900">
                                        Approved calendar/signature addresses
                                        <input
                                            value={betaEmails}
                                            onChange={(event) =>
                                                setBetaEmails(event.target.value)
                                            }
                                            placeholder="tester@example.com"
                                            className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-normal text-gray-800 outline-none focus:border-amber-400"
                                        />
                                    </label>
                                    <label className="text-[11px] font-medium text-amber-900">
                                        Approved calendar/signature domains
                                        <input
                                            value={betaDomains}
                                            onChange={(event) =>
                                                setBetaDomains(event.target.value)
                                            }
                                            placeholder="pilot-firm.test"
                                            className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-normal text-gray-800 outline-none focus:border-amber-400"
                                        />
                                    </label>
                                    {!betaPolicy.accepted ? (
                                        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-white/80 p-2.5 text-xs leading-5 md:col-span-2">
                                            <input
                                                type="checkbox"
                                                checked={betaPolicyAcknowledged}
                                                onChange={(event) =>
                                                    setBetaPolicyAcknowledged(
                                                        event.target.checked,
                                                    )
                                                }
                                                className="mt-0.5 h-4 w-4 shrink-0 accent-amber-950"
                                            />
                                            <span>
                                                I am authorized to accept this policy
                                                for my organization, and I agree to
                                                the controlled-beta restrictions above.
                                            </span>
                                        </label>
                                    ) : null}
                                    <div className="flex items-center gap-2 md:col-span-2">
                                        <button
                                            type="button"
                                            disabled={
                                                betaPolicySaving ||
                                                (!betaPolicy.accepted &&
                                                    !betaPolicyAcknowledged)
                                            }
                                            onClick={() =>
                                                void saveBetaPolicy(!betaPolicy.accepted)
                                            }
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-950 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                                        >
                                            {betaPolicySaving ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : null}
                                            {betaPolicy.accepted
                                                ? "Save beta participants"
                                                : "Accept policy and enable uploads"}
                                        </button>
                                    </div>
                                </div>
                            ) : !betaPolicy.accepted ? (
                                <p className="mt-2 text-xs font-medium">
                                    An organization owner or admin must accept this policy.
                                </p>
                            ) : null}
                            {betaPolicyError ? (
                                <p className="mt-2 text-xs text-red-700">
                                    {betaPolicyError}
                                </p>
                            ) : null}
                        </div>
                    </div>
                </section>
            ) : null}

            <MatterTasksPanel
                projectId={projectId}
                currentRole={project.current_user_role}
            />

            <MatterNav
                projectId={projectId}
                active={
                    tab === "assistant"
                        ? "doc-review"
                        : tab === "reviews"
                          ? "reviews"
                          : "documents"
                }
            />

            <ToolbarTabs
                tabs={[
                    { id: "documents", label: "Documents" },
                    { id: "assistant", label: "Doc Review" },
                    { id: "reviews", label: "Review Tables" },
                ]}
                active={tab}
                onChange={handleTabChange}
                actions={
                    <>
                        {toolbarActions}
                    </>
                }
            />

            {/* Table content */}
            <div className="w-full flex-1 min-h-0 overflow-x-auto">
            <div className="min-w-max flex min-h-full flex-col">

                {/* Tab: Documents */}
                {tab === "documents" && (
                    <div className="flex-1 flex flex-col min-h-0">
                        {documentActionError && (
                            <div className="mx-4 my-2 flex items-center justify-between rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700 md:mx-10">
                                <span>{documentActionError}</span>
                                <button
                                    type="button"
                                    onClick={() => setDocumentActionError(null)}
                                    className="rounded px-1 text-red-500 hover:bg-red-100 hover:text-red-700"
                                >
                                    Dismiss
                                </button>
                            </div>
                        )}
                        {/* Table header */}
                        <div className="flex items-center h-8 pr-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none shrink-0">
                            <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-white flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-white`}>
                                <input
                                    type="checkbox"
                                    checked={allDocsSelected}
                                    ref={(el) => { if (el) el.indeterminate = someDocsSelected; }}
                                    onChange={() => {
                                        if (allDocsSelected) setSelectedDocIds([]);
                                        else setSelectedDocIds(filteredDocs.map((d) => d.id));
                                    }}
                                    className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                />
                            </div>
                            <div className={`sticky left-8 z-[60] ${DOC_NAME_COL_W} bg-white pl-2 text-left`}>
                                Name
                            </div>
                            <div className="ml-auto w-20 shrink-0 text-left">Type</div>
                            <div className="w-24 shrink-0 text-left">Size</div>
                            <div className="w-20 shrink-0 text-left">Version</div>
                            <div className="w-32 shrink-0 text-left">Created</div>
                            <div className="w-32 shrink-0 text-left">Updated</div>
                            <div className="w-8 shrink-0" />
                        </div>

                        {/* Blue ring wraps everything below the header when root-dropping */}
                        <div
                            className="flex-1 flex flex-col min-h-0 relative"
                            onDragOver={(e) => {
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "copy";
                                setDragOverFileRoot(true);
                            }}
                            onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                    setDragOverFileRoot(false);
                                }
                            }}
                            onDrop={(e) => {
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverFileRoot(false);
                                setDragOverRoot(false);
                                setDragOverFolderId(null);
                                void handleDropProjectFiles(
                                    Array.from(e.dataTransfer.files),
                                );
                            }}
                        >
                            {dragOverRoot && dragOverFolderId === null && (
                                <div className="absolute inset-0 border-2 border-blue-400 pointer-events-none z-[80]" />
                            )}
                            {dragOverFileRoot && (
                                <div className="absolute inset-0 z-[90] border-2 border-blue-400 bg-blue-50/40 pointer-events-none" />
                            )}

                        {/* Empty state */}
                        {docs.length === 0 &&
                        folders.length === 0 &&
                        uploadingDroppedFilenames.length === 0 ? (
                            <div
                                onClick={() => setAddDocsOpen(true)}
                                className="flex-1 flex cursor-pointer flex-col items-center justify-center py-24 text-center"
                            >
                                <Upload className="h-8 w-8 text-gray-200 mb-3" />
                                <p className="text-sm text-gray-400">Drop PDF or DOCX files here</p>
                            </div>
                        ) : (
                            <div
                                className="flex-1 flex flex-col"
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    closeRowActionMenus();
                                    setContextMenu({ x: e.clientX, y: e.clientY, folderId: null, showFolderActions: false });
                                }}
                                onClick={() => setContextMenu(null)}
                                onDragOver={(e) => {
                                    if (!hasMovePayload(e.dataTransfer)) return;
                                    e.preventDefault();
                                    setDragOverRoot(true);
                                }}
                                onDragLeave={(e) => {
                                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                        setDragOverRoot(false);
                                    }
                                }}
                                onDrop={async (e) => {
                                    if (!hasMovePayload(e.dataTransfer)) return;
                                    e.preventDefault();
                                    setDragOverRoot(false);
                                    setDragOverFolderId(null);
                                    await handleDropOnFolder(null, e.dataTransfer);
                                }}
                            >
                                {/* Search: flat list; no search: folder tree */}
                                {q ? (
                                    <>
                                        {renderUploadingDocumentRows(0)}
                                        {filteredDocs.map((doc) => {
                                            const isProcessing = doc.status === "pending" || doc.status === "processing";
                                            const isError = doc.status === "error";
                                            const isVersionsOpen = expandedVersionDocIds.has(doc.id);
                                            const hasVersions =
                                                typeof doc.latest_version_number === "number" &&
                                                doc.latest_version_number >= 1;
                                            return (
                                                <div key={doc.id}>
                                                <div
                                                    onClick={() => {
                                    setViewingDocVersion(null);
                                    setViewingDoc(doc);
                                }}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        closeRowActionMenus();
                                                        setContextMenu({
                                                            x: e.clientX,
                                                            y: e.clientY,
                                                            docId: doc.id,
                                                            folderId: null,
                                                            showFolderActions: false,
                                                        });
                                                    }}
                                                    className="group flex items-center h-10 pr-8 border-b border-gray-50 hover:bg-gray-50 cursor-pointer transition-colors"
                                                >
                                                    <div className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${selectedDocIds.includes(doc.id) ? "bg-gray-50" : "bg-white"} group-hover:bg-gray-50`} onClick={(e) => e.stopPropagation()}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedDocIds.includes(doc.id)}
                                                            onChange={() => setSelectedDocIds((prev) => prev.includes(doc.id) ? prev.filter((x) => x !== doc.id) : [...prev, doc.id])}
                                                            className="h-2.5 w-2.5 rounded border-gray-200 cursor-pointer accent-black"
                                                        />
                                                    </div>
                                                    <div className={`sticky left-8 z-[60] ${DOC_NAME_COL_W} bg-white p-2 group-hover:bg-gray-50`}>
                                                    <div className="flex items-center gap-2">
                                                        {isProcessing ? <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" /> : isError ? <AlertCircle className="h-4 w-4 text-red-500 shrink-0" /> : <DocIcon fileType={doc.file_type} />}
                                                        {renamingDocumentId === doc.id ? (
                                                            <input
                                                                autoFocus
                                                                className="min-w-0 flex-1 text-sm text-gray-800 bg-transparent outline-none border-b border-gray-300"
                                                                value={renameDocumentValue}
                                                                onClick={(e) => e.stopPropagation()}
                                                                onDragStart={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                }}
                                                                onChange={(e) =>
                                                                    setRenameDocumentValue(
                                                                        e.target.value,
                                                                    )
                                                                }
                                                                onKeyDown={(e) => {
                                                                    if (e.key === "Enter")
                                                                        void submitDocumentRename(
                                                                            doc.id,
                                                                        );
                                                                    if (e.key === "Escape") {
                                                                        setRenamingDocumentId(null);
                                                                        setRenameDocumentValue("");
                                                                    }
                                                                }}
                                                                onBlur={() =>
                                                                    void submitDocumentRename(
                                                                        doc.id,
                                                                    )
                                                                }
                                                            />
                                                        ) : (
                                                            <span className="text-sm text-gray-800 truncate">{doc.filename}</span>
                                                        )}
                                                    </div>
                                                    </div>
                                                    <div className="ml-auto w-20 shrink-0 text-xs text-gray-500 uppercase truncate">{doc.file_type ?? <span className="text-gray-300">—</span>}</div>
                                                    <div className="w-24 shrink-0 text-sm text-gray-500 truncate">{doc.size_bytes != null ? formatBytes(doc.size_bytes) : <span className="text-gray-300">—</span>}</div>
                                                    <div
                                                        className="w-20 shrink-0 text-sm text-gray-500 flex items-center gap-1"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        {hasVersions ? (
                                                            <button
                                                                onClick={() => void toggleVersions(doc.id)}
                                                                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-gray-100 transition-colors"
                                                            >
                                                                <span>{doc.latest_version_number}</span>
                                                                {isVersionsOpen ? (
                                                                    <ChevronDown className="h-3 w-3 text-gray-400" />
                                                                ) : (
                                                                    <ChevronRight className="h-3 w-3 text-gray-400" />
                                                                )}
                                                            </button>
                                                        ) : (
                                                            <span className="text-gray-300 pl-1">—</span>
                                                        )}
                                                    </div>
                                                    <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                                        {doc.created_at ? formatDate(doc.created_at) : <span className="text-gray-300">—</span>}
                                                    </div>
                                                    <div className="w-32 shrink-0 text-sm text-gray-500 truncate">
                                                        {doc.updated_at ? formatDate(doc.updated_at) : <span className="text-gray-300">—</span>}
                                                    </div>
                                                    <div className="w-8 shrink-0 flex justify-end">
                                                        {!isProcessing && (
                                                            <RowActions
                                                                onRename={canMutate ? () => {
                                                                    setRenameDocumentValue(doc.filename);
                                                                    setRenamingDocumentId(doc.id);
                                                                } : undefined}
                                                                renameLabel="Rename document"
                                                                onDownload={canExport ? () => downloadDoc(doc.id) : undefined}
                                                                onShowAllVersions={
                                                                    hasVersions && !isVersionsOpen
                                                                        ? () => void toggleVersions(doc.id)
                                                                        : undefined
                                                                }
                                                                onUploadNewVersion={canMutate ? () =>
                                                                    void handleUploadNewVersion(doc)
                                                                : undefined}
                                                                onFinalizeClean={
                                                                    canMutate && doc.file_type === "docx"
                                                                        ? () => void handleFinalizeClean(doc)
                                                                        : undefined
                                                                }
                                                                onDelete={canLifecycle ? () => handleRemoveDoc(doc.id) : undefined}
                                                            />
                                                        )}
                                                    </div>
                                                </div>
                                                {isVersionsOpen && (
                                                    <DocVersionHistory
                                                        docId={doc.id}
                                                        filename={doc.filename}
                                                        loading={loadingVersionDocIds.has(doc.id)}
                                                        versions={versionsByDocId.get(doc.id) ?? []}
                                                        onDownloadVersion={canExport ? downloadDocVersion : undefined}
                                                        onOpenVersion={(versionId, label) => {
                                                            setViewingDocVersion({ id: versionId, label });
                                                            setViewingDoc(doc);
                                                        }}
                                                        onRenameVersion={canMutate ? (versionId, displayName) =>
                                                            handleRenameVersion(doc.id, versionId, displayName)
                                                        : undefined}
                                                        includeDecisions={decisionVersionDocIds.has(doc.id)}
                                                        onToggleDecisions={() =>
                                                            void toggleDecisionVersions(doc.id)
                                                        }
                                                    />
                                                )}
                                                </div>
                                            );
                                        })}
                                    </>
                                ) : (
                                    renderLevel(null, 0)
                                )}
                                {/* Spacer — fills remaining height and extends the root drop zone */}
                                <div className="flex-1 min-h-16" />
                            </div>
                        )}

                        {/* Context menu */}
                        {contextMenu &&
                            (() => {
                                const menuDoc = contextMenu.docId
                                    ? docs.find((doc) => doc.id === contextMenu.docId)
                                    : null;
                                const menuDocHasVersions =
                                    typeof menuDoc?.latest_version_number === "number" &&
                                    menuDoc.latest_version_number >= 1;
                                const menuDocVersionsOpen = menuDoc
                                    ? expandedVersionDocIds.has(menuDoc.id)
                                    : false;

                                return (
                                    <div
                                        ref={contextMenuRef}
                                        className="fixed z-[120] w-48 rounded-xl border border-gray-100 bg-white shadow-lg overflow-hidden"
                                        style={{ top: contextMenu.y, left: contextMenu.x }}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {menuDoc ? (
                                            <RowActionMenuItems
                                                onClose={() => setContextMenu(null)}
                                                onRename={canMutate ? () => {
                                                    setRenameDocumentValue(menuDoc.filename);
                                                    setRenamingDocumentId(menuDoc.id);
                                                } : undefined}
                                                renameLabel="Rename document"
                                                onDownload={canExport ? () => downloadDoc(menuDoc.id) : undefined}
                                                onShowAllVersions={
                                                    menuDocHasVersions && !menuDocVersionsOpen
                                                        ? () => void toggleVersions(menuDoc.id)
                                                        : undefined
                                                }
                                                onUploadNewVersion={canMutate ? () =>
                                                    void handleUploadNewVersion(menuDoc)
                                                : undefined}
                                                onFinalizeClean={
                                                    canMutate && menuDoc.file_type === "docx"
                                                        ? () => void handleFinalizeClean(menuDoc)
                                                        : undefined
                                                }
                                                onRemoveFromFolder={
                                                    canMutate && menuDoc.folder_id
                                                        ? () =>
                                                              void handleRemoveDocFromFolder(
                                                                  menuDoc.id,
                                                              )
                                                        : undefined
                                                }
                                                onDelete={canLifecycle ? () =>
                                                    void handleRemoveDoc(menuDoc.id)
                                                : undefined}
                                            />
                                        ) : (
                                            <RowActionMenuItems
                                                onClose={() => setContextMenu(null)}
                                                onNewSubfolder={canMutate ? () => {
                                                    setCreatingFolderIn(
                                                        contextMenu.folderId,
                                                    );
                                                    setNewFolderName("");
                                                    if (contextMenu.folderId) {
                                                        setExpandedFolderIds(
                                                            (prev) =>
                                                                new Set([
                                                                    ...prev,
                                                                    contextMenu.folderId!,
                                                                ]),
                                                        );
                                                    }
                                                } : undefined}
                                                newSubfolderLabel={
                                                    contextMenu.showFolderActions
                                                        ? "New subfolder inside"
                                                        : "New subfolder"
                                                }
                                                onRename={
                                                    canMutate &&
                                                    contextMenu.showFolderActions &&
                                                    contextMenu.folderId
                                                        ? () => {
                                                              const f =
                                                                  folders.find(
                                                                      (x) =>
                                                                          x.id ===
                                                                          contextMenu.folderId,
                                                                  );
                                                              setRenameFolderValue(
                                                                  f?.name ?? "",
                                                              );
                                                              setRenamingFolderId(
                                                                  contextMenu.folderId!,
                                                              );
                                                          }
                                                        : undefined
                                                }
                                                renameLabel="Rename folder"
                                                onDelete={
                                                    canMutate &&
                                                    contextMenu.showFolderActions &&
                                                    contextMenu.folderId
                                                        ? () =>
                                                              handleDeleteFolder(
                                                                  contextMenu.folderId!,
                                                              )
                                                        : undefined
                                                }
                                                deleteLabel="Delete folder"
                                            />
                                        )}
                                    </div>
                                );
                            })()}

                        </div>{/* end blue ring wrapper */}
                    </div>
                )}

                {/* Tab: Assistant */}
                {tab === "assistant" && (
                    <ProjectAssistantTab
                        chats={chats}
                        filteredChats={filteredChats}
                        selectedChatIds={selectedChatIds}
                        allChatsSelected={allChatsSelected}
                        someChatsSelected={someChatsSelected}
                        renamingChatId={renamingChatId}
                        renameChatValue={renameChatValue}
                        currentUserId={user?.id}
                        onCreateChat={handleNewChat}
                        onOpenChat={(chatId) =>
                            router.push(
                                `/projects/${projectId}/doc-review/chat/${chatId}`,
                            )
                        }
                        onDeleteChat={handleDeleteChatRow}
                        onOwnerOnlyAction={setOwnerOnlyAction}
                        submitChatRename={submitChatRename}
                        setSelectedChatIds={setSelectedChatIds}
                        setRenamingChatId={setRenamingChatId}
                        setRenameChatValue={setRenameChatValue}
                    />
                )}

                {/* Tab: Reviews */}
                {tab === "reviews" && (
                    <ProjectReviewsTab
                        docs={docs}
                        reviews={projectReviews}
                        filteredReviews={filteredReviews}
                        selectedReviewIds={selectedReviewIds}
                        allReviewsSelected={allReviewsSelected}
                        someReviewsSelected={someReviewsSelected}
                        renamingReviewId={renamingReviewId}
                        renameReviewValue={renameReviewValue}
                        creatingReview={creatingReview}
                        currentUserId={user?.id}
                        onCreateReview={handleNewReview}
                        onOpenReview={(reviewId) =>
                            router.push(
                                `/projects/${projectId}/tabular-reviews/${reviewId}`,
                            )
                        }
                        onDeleteReview={handleDeleteReviewRow}
                        onOwnerOnlyAction={setOwnerOnlyAction}
                        submitReviewRename={submitReviewRename}
                        setSelectedReviewIds={setSelectedReviewIds}
                        setRenamingReviewId={setRenamingReviewId}
                        setRenameReviewValue={setRenameReviewValue}
                    />
                )}
            </div>
            </div>

            <AddDocumentsModal
                open={addDocsOpen}
                onClose={() => setAddDocsOpen(false)}
                onSelect={handleDocsSelected}
                breadcrumb={["Matters", project.name + (project.cm_number ? ` (${project.cm_number})` : ""), "Add Documents"]}
                projectId={projectId}
            />

            <UploadNewVersionModal
                open={!!uploadVersionDoc}
                doc={uploadVersionDoc}
                onClose={() => setUploadVersionDoc(null)}
                onSubmit={(file, displayName) =>
                    submitNewVersion(uploadVersionDoc!, file, displayName)
                }
            />

            <DocViewModal
                doc={viewingDoc}
                versionId={viewingDocVersion?.id ?? null}
                versionLabel={viewingDocVersion?.label ?? null}
                onClose={() => {
                    setViewingDoc(null);
                    setViewingDocVersion(null);
                }}
                onDelete={(doc) => handleRemoveDoc(doc.id)}
            />

            <AddNewTRModal
                open={newTRModalOpen}
                onClose={() => setNewTRModalOpen(false)}
                onAdd={handleCreateReview}
                projectDocs={project?.documents?.filter((d) => d.status === "ready")}
                projectName={project?.name}
                projectCmNumber={project?.cm_number}
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <PeopleModal
                open={peopleModalOpen}
                onClose={() => setPeopleModalOpen(false)}
                resource={project}
                fetchPeople={getProjectPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    "Matters",
                    project
                        ? project.name +
                          (project.cm_number ? ` (${project.cm_number})` : "")
                        : "",
                    "People",
                ]}
                onInvite={(email, role) =>
                    inviteProjectMember(projectId, email, role).then(() => {})
                }
                onRoleChange={(membershipId, role) =>
                    updateProjectMemberRole(
                        projectId,
                        membershipId,
                        role,
                    ).then(() => {})
                }
                onRemove={(membershipId) =>
                    removeProjectMember(projectId, membershipId)
                }
            />
        </div>
    );
}
