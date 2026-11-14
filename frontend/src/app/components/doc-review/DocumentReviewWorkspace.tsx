"use client";

import { documentPacketJobsByMessage } from "../authoring/documentPacketState";

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Ban,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Clock,
    Download,
    FileSignature,
    FileText,
    GitBranch,
    Loader2,
    Plus,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import {
    ACTION_STATE_MUTATED_EVENT,
    deleteChat,
    deleteDocument,
    forkChat,
    getChat,
    getProject,
    uploadProjectDocument,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
    getDocumentUrl,
    getProjectDocumentTree,
    getProjectActionState,
    updateChatSuggestions,
    type DocumentActionState,
    type DerivedDocumentNode,
    type DocumentVersionNode,
    type ProjectDocumentTree,
} from "@/app/lib/cocoaLegalApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import type { LegalProposal } from "@/app/hooks/useAssistantChat";
import { deriveConversationDoc } from "./deriveConversationDoc";
import { captureDisplayedDocumentContext } from "./documentReliability";
import { DOCUMENT_ACCEPT_ATTR } from "@/app/lib/uploadTypes";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { ProposalChip } from "@/app/components/assistant/ProposalChip";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { OperationActivityPanel } from "@/app/components/assistant/OperationActivityPanel";
import { ChatInput } from "@/app/components/assistant/ChatInput";
import type { ChatInputHandle } from "@/app/components/assistant/ChatInput";
import { MatterNav } from "@/app/components/projects/MatterNav";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import { DocView } from "@/app/components/shared/DocView";
import { DocImageView } from "@/app/components/shared/DocImageView";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { DocxView } from "@/app/components/shared/DocxView";
import { SignersModal } from "@/app/components/legal/SignersModal";
import { SignatureStatusCard } from "@/app/components/legal/SignatureStatusCard";
import { createPortal } from "react-dom";
import { CocoaLegalIcon } from "@/components/chat/cocoa-legal-icon";
import { useAppVersionReloadBlocker } from "@/components/AppVersionGuard";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { getGreetingName } from "@/lib/userIdentity";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type {
    CitationQuote,
    AgentOperation,
    CocoaLegalCitationAnnotation,
    CocoaLegalDocument,
    CocoaLegalEditAnnotation,
    CocoaLegalHighlightAnnotation,
    CocoaLegalMessage,
    CocoaLegalProject,
} from "@/app/components/shared/types";
import { expandCitationToEntries } from "@/app/components/shared/types";
import {
    getCocoaLegalDocDragData,
    getCocoaLegalFolderDragData,
    hasCocoaLegalDragPayload,
} from "@/app/lib/dragTypes";
import {
    matterAuthoringHref,
    matterDocReviewHref,
} from "@/app/lib/matterRoutes";

interface DocumentReviewWorkspaceProps {
    projectId: string;
    chatId?: string;
}

type DocTab = {
    documentId: string;
    filename: string;
    quotes?: CitationQuote[];
    versionId?: string | null;
    versionNumber?: number | null;
    refetchKey?: number;
    warning?: string | null;
    scrollTop?: number;
    activeQuoteId?: string | null;
};

type EditScrollTarget = {
    key: string;
    documentId: string;
    inserted_text?: string;
    deleted_text?: string;
    ins_w_id?: string | null;
    del_w_id?: string | null;
};

function isDocxTab(filename: string) {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
function isImageTab(filename: string) {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

/** Most-recent signature envelope for a source document, keyed by document_id. */
type SigEntry = {
    envelopeId: string;
    status: string;
    subject: string | null;
    /** ISO created_at, used to keep the most-recent envelope per document. */
    createdAt: string;
};

/**
 * Status banner appearance for an envelope status. Returns null for statuses
 * not worth a banner (draft) so the pane stays uncluttered.
 */
function signatureBannerMeta(status: string): {
    label: string;
    icon: typeof FileSignature;
    cls: string;
} | null {
    switch (status) {
        case "newer_version_available":
            return {
                label: "Earlier version sent for signature — current version is newer",
                icon: Clock,
                cls: "border-amber-200 bg-amber-50 text-amber-800",
            };
        case "sent":
        case "partially_signed":
            return {
                label: "Out for signature",
                icon: FileSignature,
                cls: "border-amber-200 bg-amber-50 text-amber-800",
            };
        case "completed":
            return {
                label: "Signed & completed",
                icon: CheckCircle2,
                cls: "border-green-200 bg-green-50 text-green-800",
            };
        case "declined":
            return {
                label: "Declined",
                icon: Ban,
                cls: "border-red-200 bg-red-50 text-red-700",
            };
        case "cancelled":
            return {
                label: "Cancelled",
                icon: Clock,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
            };
        case "expired":
            return {
                label: "Expired",
                icon: Clock,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
            };
        case "pending_approval":
            return {
                label: "Pending approval",
                icon: Clock,
                cls: "border-gray-200 bg-gray-50 text-gray-600",
            };
        default:
            return null;
    }
}

function highlightsToQuotes(
    highlights: CocoaLegalHighlightAnnotation[],
): CitationQuote[] {
    return highlights
        .filter((highlight) => highlight.status !== "removed")
        .map((highlight) => ({
            page: highlight.page ?? 1,
            quote: highlight.quote,
            id: highlight.id,
            color: "yellow" as const,
            label: highlight.label,
            occurrenceIndex: highlight.occurrence_index,
        }));
}

const ICON_SIZE = 28;
const GAP = 14;
const EXPLORER_MIN = 160;
const EXPLORER_DEFAULT = 280;
const CHAT_MIN = 320;
const CHAT_DEFAULT = 420;

function AssistantGreeting({ greetingName }: { greetingName: string }) {
    const [loaded, setLoaded] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    useLayoutEffect(() => {
        if (!textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [greetingName]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="relative flex items-center justify-center h-[28px]">
                <div
                    className="absolute h-[30px]"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% - ${iconOffset}px))`
                            : "translateX(-50%)",
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                >
                    <CocoaLegalIcon
                        size={ICON_SIZE}
                        style={{
                            filter:
                                "drop-shadow(0 0 16px rgba(251,191,36,0.22)) brightness(1.65)",
                        }}
                    />
                </div>
                <h1
                    ref={textRef}
                    className="absolute max-w-[calc(100vw-3rem)] truncate text-center text-3xl font-serif font-light text-[var(--app-text-strong)] whitespace-nowrap md:max-w-[320px]"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% + ${textOffset}px))`
                            : "translateX(-50%)",
                        opacity: loaded ? 1 : 0,
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                    }}
                >
                    Hi, {greetingName}
                </h1>
            </div>
        </div>
    );
}

/** Drag-handle divider for resizing panels */
function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
    const dragging = useRef(false);
    const lastX = useRef(0);
    const [isDragging, setIsDragging] = useState(false);

    const onMouseDown = (e: React.MouseEvent) => {
        dragging.current = true;
        setIsDragging(true);
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    useEffect(() => {
        function onMouseMove(e: MouseEvent) {
            if (!dragging.current) return;
            onDrag(e.clientX - lastX.current);
            lastX.current = e.clientX;
        }
        function onMouseUp() {
            if (!dragging.current) return;
            dragging.current = false;
            setIsDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [onDrag]);

    return (
        <div className="relative w-0 shrink-0 z-10">
            <div
                onMouseDown={onMouseDown}
                className="absolute inset-y-0 -left-2 -right-2 cursor-col-resize flex items-stretch justify-center"
            >
                {isDragging && (
                    <div className="w-1 bg-blue-500 transition-colors" />
                )}
            </div>
        </div>
    );
}

export function DocumentReviewWorkspace({
    projectId,
    chatId,
}: DocumentReviewWorkspaceProps) {
    const router = useRouter();
    // Optional deep-link target: `?doc=<id>` opens that specific document on
    // mount (used by "Open document" from the authoring wizard) instead of the
    // generic first-ready-doc auto-open.
    const searchParams = useSearchParams();
    const docParam = searchParams.get("doc");

    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const greetingName = getGreetingName(profile?.displayName);

    const [project, setProject] = useState<CocoaLegalProject | null>(null);
    const [documentTree, setDocumentTree] =
        useState<ProjectDocumentTree | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [chatLoaded, setChatLoaded] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);

    // Panel widths
    const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
    const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);

    // Upload state
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [explorerDragOver, setExplorerDragOver] = useState(false);
    useAppVersionReloadBlocker(uploading, "busy");

    // Tabs
    const [tabs, setTabs] = useState<DocTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activeQuotes, setActiveQuotes] = useState<CitationQuote[] | null>(
        null,
    );
    const [activeQuoteId, setActiveQuoteId] = useState<string | null>(null);
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [revealDocumentId, setRevealDocumentId] = useState<string | null>(null);
    const [editScrollTarget, setEditScrollTarget] =
        useState<EditScrollTarget | null>(null);
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );

    // Host for the non-chat "Send for signature" modal (doc viewer toolbar +
    // explorer affordances both target it).
    const [signFor, setSignFor] = useState<{
        documentId: string;
        filename: string;
    } | null>(null);

    // Live e-signature status, keyed by the SOURCE document_id. Populated by a
    // poll of listSignatures() so the workspace shows whether the open document
    // (and each explorer row) is out for signature / completed without leaving.
    const [sigByDoc, setSigByDoc] = useState<Map<string, SigEntry>>(
        () => new Map(),
    );
    const [actionStateByDoc, setActionStateByDoc] = useState<
        Map<string, DocumentActionState>
    >(() => new Map());

    // Host for the in-place "View status" modal (mirrors `signFor`). Holds the
    // envelope id whose live SignatureStatusCard is shown.
    const [viewEnvelopeId, setViewEnvelopeId] = useState<string | null>(null);

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;
    const currentRole = project?.current_user_role;
    const canMutate =
        currentRole === "owner" ||
        currentRole === "admin" ||
        currentRole === "lawyer" ||
        currentRole === "editor";
    const canExport = Boolean(currentRole && currentRole !== "viewer");
    const canLifecycle = currentRole === "owner" || currentRole === "admin";
    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const tabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const autoOpenedCleanVersionRef = useRef<string | null>(null);
    const autoOpenedInitialDocRef = useRef(false);
    // Debounce the network-heavy refresh after a tracked change is accepted/
    // rejected. A burst of accepts ("Accept all" over many changes, or rapid
    // individual clicks) otherwise fires ~4-5 requests PER change (docx
    // refetch + tracked-change-ids + versions + project + document-tree) and
    // trips the API rate limiter (HTTP 429). We coalesce them into one refresh
    // per document, applying the latest resolved version.
    const docRefreshTimers = useRef<
        Record<string, ReturnType<typeof setTimeout>>
    >({});
    const latestResolvedVersion = useRef<
        Record<
            string,
            { versionId: string | null; versionNumber: number | null }
        >
    >({});
    useEffect(() => {
        const timers = docRefreshTimers.current;
        return () => {
            for (const t of Object.values(timers)) clearTimeout(t);
        };
    }, []);
    // Tracks which chat we've already restored the viewed doc for (keyed by
    // chatId, so each chat restores its own document with or without a remount).
    const restoredForChatRef = useRef<string | null>(null);
    // The loaded chat's fork anchor, used as a fallback when no message carries
    // a version_context snapshot (set in the chat-load effect).
    const chatAnchorRef = useRef<{
        anchor_document_id: string | null;
        anchor_version_id: string | null;
    } | null>(null);

    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const openTabRef = useRef<
        (
            docId: string,
            filename: string,
            quotes?: CitationQuote[],
            versionId?: string | null,
            versionNumber?: number | null,
            activeQuoteId?: string | null,
        ) => void
    >(() => {});
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement | null>(null);
    // Per-message DOM nodes keyed by chat_messages.id, so we can scroll to a
    // specific turn (e.g. the one that produced a version, opened from the
    // Explorer's "view conversation" affordance).
    const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
    const [forkingMessageId, setForkingMessageId] = useState<string | null>(
        null,
    );
    const [minHeight, setMinHeight] = useState("0px");

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        chats,
        saveChat,
        loadChats,
    } = useChatHistoryContext();
    const [initialMessages] = useState<CocoaLegalMessage[]>(newChatMessages ?? []);
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        cancel,
        proposal,
        dismissProposal,
        chatId: liveChatId,
    } = useAssistantChat({
        initialMessages,
        chatId,
        projectId,
        chatBasePath: `/projects/${projectId}/doc-review/chat`,
    });

    // The route prop is undefined until the URL catches up with a chat created
    // during this turn; the hook knows the id as soon as the `chat_id` frame
    // lands. Anything addressed by chat id (suppression writes, the result
    // card's DOCX export) must use the live id or it silently no-ops on a new
    // matter chat's first turn.
    const packetJobsByMessage = documentPacketJobsByMessage(messages);
    const effectiveChatId = chatId ?? liveChatId ?? null;

    const hasLoaded = useRef(false);
    const hasAutoSent = useRef(false);
    const hasInitialScrolled = useRef(false);

    useEffect(() => {
        setSidebarOpen(false);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const refreshProjectState = useCallback(async () => {
        const [loadedProject, loadedTree] = await Promise.all([
            getProject(projectId),
            getProjectDocumentTree(projectId),
        ]);
        setProject(loadedProject);
        setDocumentTree(loadedTree);
        return { loadedProject, loadedTree };
    }, [projectId]);

    useEffect(() => {
        refreshProjectState()
            .then(({ loadedProject }) => {
                if (autoOpenedInitialDocRef.current) return;
                // When a chat is open, the conversation-doc effect decides what
                // to show; don't also auto-open the first project doc (which
                // would drift the viewer away from the conversation).
                if (chatId) return;
                // Deep-link: `?doc=<id>` opens that specific document (e.g. a
                // draft just filed into this matter). Falls back to the first
                // ready doc if the target isn't found yet.
                const targetDoc = docParam
                    ? loadedProject.documents?.find((d) => d.id === docParam)
                    : null;
                const firstDoc =
                    targetDoc ??
                    loadedProject.documents?.find(
                        (doc) => doc.status === "ready",
                    ) ??
                    loadedProject.documents?.[0] ??
                    null;
                if (!firstDoc) return;
                autoOpenedInitialDocRef.current = true;
                openTabRef.current(
                    firstDoc.id,
                    firstDoc.filename,
                    undefined,
                    undefined,
                    firstDoc.latest_version_number ?? null,
                );
            })
            .catch(() => {});
    }, [chatId, docParam, refreshProjectState]);

    // Whenever the assistant mutates project documents — creating a new
    // doc, creating a new version via edit_document, or replicating a doc —
    // refresh the project so the explorer picks up the new/changed files
    // without a manual reload. Keyed by completed mutation events only, so
    // we refetch once the backend has finished persisting the change.
    const projectMutationSignature = useMemo(() => {
        const created: string[] = [];
        const replicated: string[] = [];
        const editedPerDoc: Record<string, number> = {};
        for (const msg of messages) {
            for (const ev of msg.events ?? []) {
                if ("isStreaming" in ev && ev.isStreaming) continue;
                if (ev.type === "doc_created" && ev.document_id) {
                    created.push(
                        `${ev.document_id}:${ev.version_id ?? ""}:${ev.filename}`,
                    );
                    continue;
                }
                if (ev.type === "doc_replicated") {
                    for (const c of ev.copies ?? []) {
                        replicated.push(
                            `${c.document_id}:${c.version_id}:${c.new_filename}`,
                        );
                    }
                    continue;
                }
                if (ev.type === "doc_edited") {
                    editedPerDoc[ev.document_id] = Math.max(
                        editedPerDoc[ev.document_id] ?? 0,
                        (ev.version_number as number | null | undefined) ?? 0,
                    );
                }
            }
        }
        return [
            `created=${created.sort().join(",")}`,
            `replicated=${replicated.sort().join(",")}`,
            `edited=${Object.entries(editedPerDoc)
                .map(([k, v]) => `${k}=${v}`)
                .sort()
                .join(",")}`,
        ].join("|");
    }, [messages]);

    useEffect(() => {
        if (!projectMutationSignature) return;
        refreshProjectState().catch(() => {});
    }, [projectMutationSignature, refreshProjectState]);

    // One consolidated poll supplies delivery, signature, pending-operation,
    // and version freshness state for the whole matter. This captures actions
    // performed in other chats and avoids independent checklist state.
    useEffect(() => {
        let cancelled = false;
        let cursor: string | null = null;
        const load = async () => {
            try {
                const state = await getProjectActionState(projectId, cursor);
                if (cancelled || state.unchanged) return;
                cursor = state.cursor;
                const { documents } = state;
                setActionStateByDoc(
                    new Map(documents.map((state) => [state.document_id, state])),
                );
                const next = new Map<string, SigEntry>();
                for (const state of documents) {
                    const latest = state.signature.versions[0];
                    if (!latest) continue;
                    next.set(state.document_id, {
                        envelopeId: latest.envelope_id,
                        status: state.signature.newer_version_available
                            ? "newer_version_available"
                            : latest.status,
                        subject: null,
                        createdAt: latest.updated_at,
                    });
                }
                setSigByDoc(next);
            } catch {
                // Soft-fail: leave the last good map in place.
            }
        };
        void load();
        const handleMutation = () => void load();
        window.addEventListener(ACTION_STATE_MUTATED_EVENT, handleMutation);
        const timer = setInterval(() => void load(), 15_000);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener(
                ACTION_STATE_MUTATED_EVENT,
                handleMutation,
            );
        };
    }, [projectId, projectMutationSignature]);

    const signatureStatusForDoc = useCallback(
        (docId: string) => sigByDoc.get(docId)?.status,
        [sigByDoc],
    );

    useEffect(() => {
        setCurrentChatId(chatId ?? null);
    }, [chatId, setCurrentChatId]);

    useEffect(() => {
        if (hasLoaded.current) return;
        hasLoaded.current = true;
        if (!chatId) {
            setChatLoaded(true);
            return;
        }
        getChat(chatId)
            .then(({ chat, messages: loaded }) => {
                setChatTitle(chat.title);
                setChatOwnerId(chat.user_id ?? null);
                chatAnchorRef.current = {
                    anchor_document_id: chat.anchor_document_id ?? null,
                    anchor_version_id: chat.anchor_version_id ?? null,
                };
                if (loaded.length > 0) setMessages(loaded);
            })
            .catch(() => router.replace(matterDocReviewHref(projectId)))
            .finally(() => setChatLoaded(true));
    }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keep the viewer on the document this conversation is about. Once the
    // chat's messages and the project have loaded, derive the doc from the
    // latest turn's version_context (or the chat's fork anchor), resolve its
    // filename, and open it — once per chat (keyed by chatId). This replaces
    // the generic first-doc auto-open for chat URLs and prevents viewer↔chat
    // drift; manual tab changes afterward are respected (it fires once). An
    // empty chat (no messages) or an anchor whose doc is gone falls back to the
    // first ready document so the viewer is never blank.
    useEffect(() => {
        if (!chatId || !chatLoaded) return;
        if (restoredForChatRef.current === chatId) return;
        const docs = project?.documents;
        if (!docs || docs.length === 0) return;
        restoredForChatRef.current = chatId;

        const target = deriveConversationDoc(messages, chatAnchorRef.current);
        const targetDoc =
            (target && docs.find((d) => d.id === target.documentId)) || null;
        // Only restore a document the conversation actually engaged — never
        // fall back to the first project doc (that fallback was the doc-01
        // snap). If we can't tell, leave the viewer as-is.
        if (!targetDoc || activeTabId === targetDoc.id) return;

        // Restore the CURRENT version of that document (not the version shown
        // when the message was sent): after edits/accepts, the current version
        // is the result the user wants to see.
        openTabRef.current(
            targetDoc.id,
            targetDoc.filename,
            undefined,
            undefined,
            targetDoc.latest_version_number ?? null,
        );
    }, [chatId, chatLoaded, messages, project, activeTabId]);

    useEffect(() => {
        if (!chatId) return;
        const match = chats?.find((c) => c.id === chatId);
        if (match?.title) setChatTitle(match.title);
    }, [chats, chatId]);

    useEffect(() => {
        if (
            newChatMessages &&
            newChatMessages.length === 1 &&
            newChatMessages[0].role === "user" &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            setNewChatMessages(null);
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    const scrollLatestUserToTop = useCallback(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = messagesContainerRef.current;
                const element = latestUserMessageRef.current;
                if (!container || !element) return;
                container.scrollTo({
                    top: element.offsetTop - 24,
                    behavior: "smooth",
                });
            });
        });
    }, []);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (!chatLoaded || hasInitialScrolled.current || messages.length === 0)
            return;
        const container = messagesContainerRef.current;
        const el = latestUserMessageRef.current;
        if (!container || !el) return;
        hasInitialScrolled.current = true;
        setTimeout(() => {
            container.scrollTo({
                top: el.offsetTop - 16,
                behavior: "auto",
            });
        }, 100);
    }, [chatLoaded, messages.length]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        setMinHeight(
            `${Math.max(0, containerEl.clientHeight - 48 - userEl.offsetHeight - 16)}px`,
        );
    }, [messages.length, latestUserMessageRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!activeTabId) return;
        const el = tabItemRefs.current[activeTabId];
        if (!el) return;
        el.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
            inline: "nearest",
        });
    }, [activeTabId, tabs.length]);

    // Scroll to and briefly highlight a specific message — used when the user
    // opens "the conversation that led to this version" from the Explorer.
    // Re-runs as messages load so it works right after switching chats.
    useEffect(() => {
        if (!focusMessageId) return;
        const container = messagesContainerRef.current;
        const el = messageRefs.current[focusMessageId];
        if (!container || !el) return;
        requestAnimationFrame(() => {
            container.scrollTo({
                top: Math.max(0, el.offsetTop - 24),
                behavior: "smooth",
            });
        });
        const id = focusMessageId;
        const timer = setTimeout(
            () => setFocusMessageId((curr) => (curr === id ? null : curr)),
            2400,
        );
        return () => clearTimeout(timer);
    }, [focusMessageId, messages.length, chatLoaded]);

    // ── Tabs ──────────────────────────────────────────────────────────────────
    function openTab(
        docId: string,
        filename: string,
        quotes?: CitationQuote[],
        versionId?: string | null,
        versionNumber?: number | null,
        activeQuoteIdArg?: string | null,
    ) {
        // Any explicit/derived open disarms the generic "first doc" auto-open,
        // so a late async resolution can't clobber the user's / conversation's
        // document (the viewer-jump bug).
        autoOpenedInitialDocRef.current = true;
        const normalizedQuotes = quotes && quotes.length ? quotes : undefined;
        const existingTab = tabs.find((t) => t.documentId === docId);
        const nextActiveQuoteId =
            activeQuoteIdArg ??
            normalizedQuotes?.find((quote) => quote.id)?.id ??
            existingTab?.activeQuoteId ??
            null;
        const nextActiveQuotes = normalizedQuotes ?? existingTab?.quotes ?? null;
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) {
                return prev.map((t) =>
                    t.documentId === docId
                        ? {
                              ...t,
                              filename,
                              quotes: normalizedQuotes ?? t.quotes,
                              activeQuoteId: nextActiveQuoteId,
                              versionId:
                                  versionId !== undefined
                                      ? versionId
                                      : t.versionId,
                              versionNumber:
                                  versionNumber !== undefined
                                      ? versionNumber
                                      : t.versionNumber,
                          }
                        : t,
                );
            }
            return [
                ...prev,
                {
                    documentId: docId,
                    filename,
                    quotes: normalizedQuotes,
                    versionId,
                    versionNumber,
                    activeQuoteId: nextActiveQuoteId,
                },
            ];
        });
        setActiveTabId(docId);
        setActiveQuotes(nextActiveQuotes);
        setActiveQuoteId(nextActiveQuoteId);
        setSelectedDocId(docId);
    }
    openTabRef.current = openTab;

    function closeTab(docId: string) {
        setTabs((prev) => {
            const next = prev.filter((t) => t.documentId !== docId);
            if (activeTabId === docId) {
                const idx = prev.findIndex((t) => t.documentId === docId);
                const fallback = next[idx] ?? next[idx - 1] ?? null;
                setActiveTabId(fallback?.documentId ?? null);
                setActiveQuotes(fallback?.quotes ?? null);
                setActiveQuoteId(fallback?.activeQuoteId ?? null);
                setSelectedDocId(fallback?.documentId ?? null);
            }
            return next;
        });
    }

    function switchTab(docId: string) {
        const next = tabs.find((t) => t.documentId === docId) ?? null;
        setActiveTabId(docId);
        setActiveQuotes(next?.quotes ?? null);
        setActiveQuoteId(next?.activeQuoteId ?? null);
        setSelectedDocId(docId);
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleSubmit = useCallback(
        (message: CocoaLegalMessage) => {
            // Snapshot every open tab's version so the turn is anchored to the
            // versions on screen (provenance + staleness fix). The active tab
            // is flagged `displayed` and also sent as displayedDoc.
            const { displayedDoc, openDocs } =
                captureDisplayedDocumentContext(tabs, activeTabId);
            if (!displayedDoc)
                return handleChat(message, {
                    openDocs: openDocs.length ? openDocs : undefined,
                });
            return handleChat(message, {
                displayedDoc,
                openDocs: openDocs.length ? openDocs : undefined,
            });
        },
        [activeTabId, tabs, handleChat],
    );

    // Confirming a matter-chat proposal. The run turn must carry the SAME
    // document context an ordinary turn does — the open tabs are the matter's
    // working set, and a run that ignored them would read different documents
    // than the conversation around it.
    const handleRunCapability = useCallback(
        (p: LegalProposal, inputs: { represented_party?: string }) => {
            const { displayedDoc, openDocs } =
                captureDisplayedDocumentContext(tabs, activeTabId);
            const rawDocIds = (
                p.prefilledInputs as { documentIds?: unknown } | undefined
            )?.documentIds;
            const docIds = Array.isArray(rawDocIds)
                ? rawDocIds.filter(
                      (id): id is string =>
                          typeof id === "string" && id.length > 0,
                  )
                : [];
            const runLabel = p.runLabel ?? "Run review";
            void handleChat(
                {
                    role: "user",
                    content: `${runLabel}: ${p.confirmPrompt.replace(/\?$/, "")}`,
                },
                {
                    ...(displayedDoc ? { displayedDoc } : {}),
                    openDocs: openDocs.length ? openDocs : undefined,
                    capabilityRun: {
                        capability_id: p.capabilityId,
                        proposal_id: p.proposalId ?? null,
                        document_ids: docIds,
                        inputs,
                    },
                },
            );
            dismissProposal();
        },
        [activeTabId, tabs, handleChat, dismissProposal],
    );

    // Durable suggestion controls — failures are logged AND rethrown so the
    // chip can keep itself on screen and say the preference did not save.
    const handleDontSuggestHere = useCallback(
        async (p: LegalProposal) => {
            if (!effectiveChatId) return;
            try {
                await updateChatSuggestions(effectiveChatId, {
                    action: "dismiss",
                    capability_id: p.capabilityId,
                    proposal_id: p.proposalId ?? null,
                });
            } catch (err) {
                console.error(
                    "[DocumentReviewWorkspace] dismiss suggestion failed",
                    err,
                );
                throw err;
            }
        },
        [effectiveChatId],
    );

    const handleMuteSuggestions = useCallback(async () => {
        if (!effectiveChatId) return;
        try {
            await updateChatSuggestions(effectiveChatId, {
                action: "suppress",
            });
        } catch (err) {
            console.error(
                "[DocumentReviewWorkspace] mute suggestions failed",
                err,
            );
            throw err;
        }
    }, [effectiveChatId]);

    const handleRetryCapabilityRun = useCallback(
        (args: {
            capabilityId: string;
            proposalId: string | null;
            title: string;
            retry: {
                document_ids: string[];
                inputs: { represented_party: string | null };
            };
        }) => {
            // A retry must read the same working set the original run did, so
            // it carries the identical displayed-document / open-tabs capture
            // handleRunCapability makes.
            const { displayedDoc, openDocs } =
                captureDisplayedDocumentContext(tabs, activeTabId);
            void handleChat(
                { role: "user", content: `Run ${args.title}` },
                {
                    ...(displayedDoc ? { displayedDoc } : {}),
                    openDocs: openDocs.length ? openDocs : undefined,
                    capabilityRun: {
                        capability_id: args.capabilityId,
                        proposal_id: args.proposalId,
                        document_ids: args.retry.document_ids,
                        inputs: args.retry.inputs,
                    },
                },
            );
        },
        [activeTabId, tabs, handleChat],
    );

    const handleDocClick = (doc: CocoaLegalDocument) => {
        openTab(doc.id, doc.filename, undefined, undefined, doc.latest_version_number ?? null);
    };

    const handleVersionClick = (
        doc: CocoaLegalDocument,
        version: DocumentVersionNode,
    ) => {
        openTabRef.current(
            doc.id,
            doc.filename,
            undefined,
            version.id,
            version.version_number ?? null,
        );
    };

    // "View the conversation that produced this version." Opens the version's
    // document, then surfaces the producing turn: within the same chat we
    // scroll to and highlight the message; a different chat (a fork) is loaded.
    const handleVersionProvenanceClick = (
        doc: CocoaLegalDocument,
        version: DocumentVersionNode,
    ) => {
        openTab(
            doc.id,
            doc.filename,
            undefined,
            version.id,
            version.version_number ?? null,
        );
        const prov = version.provenance;
        if (!prov) return;
        if (prov.chat_id && prov.chat_id !== chatId) {
            router.push(
                `/projects/${projectId}/doc-review/chat/${prov.chat_id}`,
            );
            return;
        }
        if (prov.chat_message_id) setFocusMessageId(prov.chat_message_id);
    };

    // "Fork from here": branch the conversation at a given message. Creates a
    // new chat that inherits history up to this turn (anchored to the version
    // shown then), then navigates into the branch.
    const handleForkFromMessage = async (messageId: string | undefined) => {
        if (!messageId || !chatId || forkingMessageId) return;
        setForkingMessageId(messageId);
        try {
            const branch = await forkChat(projectId, chatId, {
                forked_from_message_id: messageId,
            });
            await loadChats();
            router.push(
                `/projects/${projectId}/doc-review/chat/${branch.chat_id}`,
            );
        } catch (err) {
            console.error("[doc-review] fork failed:", err);
            setForkingMessageId(null);
        }
    };

    const handleDerivedDocumentClick = (node: DerivedDocumentNode) => {
        openTab(
            node.document.id,
            node.document.filename,
            undefined,
            node.version?.id ?? null,
            node.version?.version_number ?? node.document.latest_version_number ?? null,
        );
    };

    const handleRevealDocument = (documentId: string) => {
        setRevealDocumentId(documentId);
        setSelectedDocId(documentId);
    };

    const handleExportDocument = async (
        doc: CocoaLegalDocument,
        versionId?: string | null,
    ) => {
        const { url, filename } = await getDocumentUrl(
            doc.id,
            versionId ?? null,
            "export",
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    };

    const handleExportActiveTab = async () => {
        if (!activeTab) return;
        const doc = project?.documents?.find(
            (item) => item.id === activeTab.documentId,
        ) ?? {
            id: activeTab.documentId,
            filename: activeTab.filename,
            project_id: projectId,
            file_type: null,
            storage_path: null,
            pdf_storage_path: null,
            size_bytes: null,
            page_count: null,
            structure_tree: null,
            status: "ready" as const,
            created_at: null,
        };
        await handleExportDocument(doc, activeTab.versionId ?? null);
    };

    const handleSendForSignature = (
        doc: CocoaLegalDocument,
    ) => {
        setSignFor({ documentId: doc.id, filename: doc.filename });
    };

    const handleCitationClick = (citation: CocoaLegalCitationAnnotation) => {
        openTabRef.current(
            citation.document_id,
            citation.filename,
            expandCitationToEntries(citation),
            citation.version_id ?? null,
            citation.version_number ?? null,
        );
    };

    const handleOpenDocument = (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => {
        openTabRef.current(
            args.documentId,
            args.filename,
            undefined,
            args.versionId,
            args.versionNumber,
        );
    };

    const handleHighlightViewClick = (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
        title: string;
        highlights: CocoaLegalHighlightAnnotation[];
        activeHighlightId?: string | null;
    }) => {
        const quotes = highlightsToQuotes(args.highlights);
        openTab(
            args.documentId,
            args.filename,
            quotes,
            args.versionId,
            args.versionNumber,
            args.activeHighlightId ?? quotes[0]?.id ?? null,
        );
    };

    const handleHighlightSetChange = (args: {
        setId: string;
        documentId: string;
        highlights: CocoaLegalHighlightAnnotation[];
    }) => {
        void args.setId;
        const quotes = highlightsToQuotes(args.highlights);
        setTabs((prev) =>
            prev.map((tab) => {
                if (tab.documentId !== args.documentId) return tab;
                const stillActive = tab.activeQuoteId
                    ? quotes.some((quote) => quote.id === tab.activeQuoteId)
                    : false;
                return {
                    ...tab,
                    quotes: quotes.length ? quotes : undefined,
                    activeQuoteId: stillActive
                        ? tab.activeQuoteId
                        : (quotes[0]?.id ?? null),
                };
            }),
        );
        if (activeTabId === args.documentId) {
            setActiveQuotes(quotes.length ? quotes : null);
            setActiveQuoteId((current) =>
                current && quotes.some((quote) => quote.id === current)
                    ? current
                    : (quotes[0]?.id ?? null),
            );
        }
    };

    const handleEditViewClick = (ann: CocoaLegalEditAnnotation, filename: string) => {
        openTab(
            ann.document_id,
            filename,
            undefined,
            ann.version_id ?? null,
            ann.version_number ?? null,
        );
        setEditScrollTarget({
            key: `${ann.edit_id}-${Date.now()}`,
            documentId: ann.document_id,
            inserted_text: ann.inserted_text,
            deleted_text: ann.deleted_text,
            ins_w_id: ann.ins_w_id ?? null,
            del_w_id: ann.del_w_id ?? null,
        });
    };

    const handleEditResolveStart = (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => {
        void args.editId;
        void args.verb;
        setReloadingDocIds((prev) => new Set([...prev, args.documentId]));
    };

    const handleEditResolved = (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        versionNumber?: number | null;
        downloadUrl: string | null;
    }) => {
        // Record the latest resolved version, then debounce the network-heavy
        // refresh (see docRefreshTimers above) so a burst of accepts collapses
        // into ONE preview refetch + ONE project refresh instead of one per
        // change. The optimistic DOM mutation in BulkEditActions keeps the
        // viewer visually current during the burst.
        const docId = args.documentId;
        latestResolvedVersion.current[docId] = {
            versionId: args.versionId ?? null,
            versionNumber: args.versionNumber ?? null,
        };
        const existing = docRefreshTimers.current[docId];
        if (existing) clearTimeout(existing);
        docRefreshTimers.current[docId] = setTimeout(() => {
            delete docRefreshTimers.current[docId];
            const latest = latestResolvedVersion.current[docId];
            delete latestResolvedVersion.current[docId];
            invalidateDocxBytes(docId);
            patchTab(docId, {
                versionId: latest?.versionId ?? undefined,
                versionNumber: latest?.versionNumber ?? null,
                refetchKey: Date.now(),
                warning: null,
            });
            setReloadingDocIds((prev) => {
                if (!prev.has(docId)) return prev;
                const next = new Set(prev);
                next.delete(docId);
                return next;
            });
            refreshProjectState().catch(() => {});
        }, 500);
    };

    const patchTab = (documentId: string, patch: Partial<DocTab>) => {
        setTabs((prev) =>
            prev.map((t) =>
                t.documentId === documentId ? { ...t, ...patch } : t,
            ),
        );
    };

    const handleOperationApplied = (operation: AgentOperation) => {
        const docId =
            operation.result_document_id ?? operation.source_document_id;
        if (!docId) return;
        invalidateDocxBytes(docId);
        refreshProjectState().catch(() => {});
        patchTab(docId, {
            versionId: operation.result_version_id,
            versionNumber: null,
            refetchKey: Date.now(),
            warning: null,
        });
    };

    const handleOpenOperationDocument = (operation: AgentOperation) => {
        const docId =
            operation.result_document_id ?? operation.source_document_id;
        if (!docId) return;
        const doc = project?.documents?.find((item) => item.id === docId);
        openTab(
            docId,
            doc?.filename ?? "Operation document",
            undefined,
            operation.result_version_id ?? operation.source_version_id ?? null,
            null,
        );
    };

    const handleExportOperationDocument = async (operation: AgentOperation) => {
        const docId =
            operation.result_document_id ?? operation.source_document_id;
        if (!docId) return;
        const { url, filename } = await getDocumentUrl(
            docId,
            operation.result_version_id ?? operation.source_version_id ?? null,
            "export",
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
    };

    const handleEditError = (args: { documentId: string; message: string }) => {
        patchTab(args.documentId, { warning: args.message });
        setReloadingDocIds((prev) => {
            if (!prev.has(args.documentId)) return prev;
            const next = new Set(prev);
            next.delete(args.documentId);
            return next;
        });
    };

    const dismissTabWarning = (documentId: string) => {
        patchTab(documentId, { warning: null });
    };

    const handleTabScrollChange = (documentId: string, scrollTop: number) => {
        patchTab(documentId, { scrollTop });
    };

    const handleDocxReady = (documentId: string) => {
        setReloadingDocIds((prev) => {
            if (!prev.has(documentId)) return prev;
            const next = new Set(prev);
            next.delete(documentId);
            return next;
        });
    };

    useEffect(() => {
        const plainEditedEvents = messages
            .flatMap((message) => message.events ?? [])
            .filter(
                (
                    event,
                ): event is Extract<
                    NonNullable<CocoaLegalMessage["events"]>[number],
                    { type: "doc_edited" }
                > =>
                    event.type === "doc_edited" &&
                    !event.isStreaming &&
                    !!event.download_url &&
                    event.annotations.length === 0,
            );
        const latest = plainEditedEvents[plainEditedEvents.length - 1];
        if (!latest) return;
        const key = `${latest.document_id}:${latest.version_id}`;
        if (autoOpenedCleanVersionRef.current === key) return;
        autoOpenedCleanVersionRef.current = key;
        invalidateDocxBytes(latest.document_id);
        openTabRef.current(
            latest.document_id,
            latest.filename,
            undefined,
            latest.version_id,
            latest.version_number ?? null,
        );
        patchTab(latest.document_id, {
            refetchKey: Date.now(),
            warning: null,
        });
    }, [messages]);

    useEffect(() => {
        const createdEvents = messages
            .flatMap((message) => message.events ?? [])
            .filter(
                (
                    event,
                ): event is Extract<
                    NonNullable<CocoaLegalMessage["events"]>[number],
                    { type: "doc_created" }
                > =>
                    event.type === "doc_created" &&
                    !event.isStreaming &&
                    !!event.document_id,
            );
        const latest = createdEvents[createdEvents.length - 1];
        if (!latest?.document_id) return;
        const key = `${latest.document_id}:${latest.version_id ?? ""}`;
        if (autoOpenedCleanVersionRef.current === key) return;
        autoOpenedCleanVersionRef.current = key;
        openTabRef.current(
            latest.document_id,
            latest.filename,
            undefined,
            latest.version_id ?? null,
            latest.version_number ?? null,
        );
    }, [messages]);

    const handleChatDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const docId = getCocoaLegalDocDragData(e.dataTransfer);
        if (!docId) return;
        const doc = project?.documents?.find((d) => d.id === docId);
        if (doc) chatInputRef.current?.addDoc(doc);
    };

    // ── Chat actions ──────────────────────────────────────────────────────────
    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/doc-review/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    async function handleDeleteChat() {
        if (!chatId) {
            router.push(matterDocReviewHref(projectId));
            return;
        }
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setDeletingChat(true);
        try {
            await deleteChat(chatId);
            router.push(matterDocReviewHref(projectId));
        } finally {
            setDeletingChat(false);
        }
    }

    // ── Upload ────────────────────────────────────────────────────────────────
    async function uploadFiles(files: File[]) {
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadProjectDocument(projectId, f)),
            );
            setProject((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    documents: [...(prev.documents ?? []), ...uploaded],
                };
            });
            getProjectDocumentTree(projectId)
                .then(setDocumentTree)
                .catch(() => {});
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const handleExplorerFileDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setExplorerDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
            await uploadFiles(files);
        }
        // Internal doc/folder moves are handled inside ProjectExplorer (stopPropagation)
    };

    // ── Folder handlers ───────────────────────────────────────────────────────
    const handleCreateFolder = async (
        parentId: string | null,
        name: string,
    ) => {
        const folder = await createProjectFolder(
            projectId,
            name,
            parentId ?? undefined,
        );
        setProject((prev) =>
            prev
                ? { ...prev, folders: [...(prev.folders ?? []), folder] }
                : prev,
        );
    };

    const handleRenameFolder = async (folderId: string, name: string) => {
        await renameProjectFolder(projectId, folderId, name);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId ? { ...f, name } : f,
                      ),
                  }
                : prev,
        );
    };

    const handleDeleteFolder = async (folderId: string) => {
        const toDelete = new Set<string>();
        function collectIds(id: string) {
            toDelete.add(id);
            (project?.folders ?? [])
                .filter((f) => f.parent_folder_id === id)
                .forEach((f) => collectIds(f.id));
        }
        collectIds(folderId);
        await deleteProjectFolder(projectId, folderId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).filter(
                          (f) => !toDelete.has(f.id),
                      ),
                      documents: (prev.documents ?? []).map((d) =>
                          d.folder_id && toDelete.has(d.folder_id)
                              ? { ...d, folder_id: null }
                              : d,
                      ),
                  }
                : prev,
        );
    };

    const handleMoveDoc = async (
        docId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).map((d) =>
                          d.id === docId
                              ? { ...d, folder_id: targetFolderId }
                              : d,
                      ),
                  }
                : prev,
        );
        await moveDocumentToFolder(projectId, docId, targetFolderId);
    };

    const handleMoveFolder = async (
        folderId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId
                              ? { ...f, parent_folder_id: targetFolderId }
                              : f,
                      ),
                  }
                : prev,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    };

    const handleDeleteDoc = async (docId: string) => {
        await deleteDocument(docId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).filter(
                          (d) => d.id !== docId,
                      ),
                  }
                : prev,
        );
        setTabs((prev) => prev.filter((t) => t.documentId !== docId));
        if (activeTabId === docId) {
            setActiveTabId(null);
            setActiveQuotes(null);
            setSelectedDocId(null);
            setEditScrollTarget(null);
        }
        getProjectDocumentTree(projectId)
            .then(setDocumentTree)
            .catch(() => {});
    };

    // ── Resize handlers ───────────────────────────────────────────────────────
    const onExplorerDividerDrag = useCallback((dx: number) => {
        setExplorerWidth((w) => Math.max(EXPLORER_MIN, w + dx));
    }, []);

    const onChatDividerDrag = useCallback((dx: number) => {
        setChatWidth((w) => Math.max(CHAT_MIN, w - dx));
    }, []);

    return (
        <div className="flex h-full flex-col bg-[var(--app-shell)] text-[var(--app-text)]">
            {/* Page header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--app-border)] bg-[var(--app-shell-subtle)] px-8 py-4 shadow-[var(--app-elevated-shadow)]">
                <div className="flex min-w-0 items-center gap-2">
                    <AppBackButton variant="dark" />
                    <div className="flex min-w-0 items-center gap-1.5 text-2xl font-medium font-serif">
                        <button
                            className="text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text-strong)]"
                            onClick={() => router.push("/projects")}
                        >
                            Matters
                        </button>
                        <span className="text-[var(--app-text-subtle)]">›</span>
                        {project ? (
                            <button
                                onClick={() =>
                                    router.push(matterDocReviewHref(projectId))
                                }
                                className="truncate text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text-strong)]"
                            >
                                {project.name}
                                {project.cm_number && (
                                    <span className="ml-1 text-[var(--app-text-subtle)]">
                                        (#{project.cm_number})
                                    </span>
                                )}
                            </button>
                        ) : (
                            <div className="h-6 w-32 animate-pulse rounded bg-[var(--app-active)]" />
                        )}
                        <span className="text-[var(--app-text-subtle)]">›</span>
                        <button
                            onClick={() =>
                                router.push(matterDocReviewHref(projectId))
                            }
                            className="text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text-strong)]"
                        >
                            Doc Review
                        </button>
                        <span className="text-[var(--app-text-subtle)]">›</span>
                        {chatLoaded ? (
                            <span className="max-w-xs truncate text-[var(--app-text-strong)]">
                                {chatId
                                    ? (chatTitle ?? "Untitled New Chat")
                                    : "New Review Session"}
                            </span>
                        ) : (
                            <div className="h-6 w-40 animate-pulse rounded bg-[var(--app-active)]" />
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {canMutate ? (
                        <>
                            <button
                                onClick={handleNewChat}
                                disabled={creatingChat}
                                title="New chat"
                                className="flex items-center justify-center rounded-lg p-1.5 text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] disabled:opacity-40"
                            >
                                {creatingChat ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Plus className="h-4 w-4" />
                                )}
                            </button>
                            <button
                                onClick={handleDeleteChat}
                                disabled={deletingChat}
                                title="Delete chat"
                                className="flex items-center justify-center rounded-lg p-1.5 text-[var(--app-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                            >
                                {deletingChat ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Trash2 className="h-4 w-4" />
                                )}
                            </button>
                        </>
                    ) : (
                        <span className="text-xs text-[var(--app-text-subtle)]">
                            Read-only
                        </span>
                    )}
                </div>
            </div>

            <div className="shrink-0 bg-[var(--app-shell-subtle)] px-4 md:px-8">
                <MatterNav
                    projectId={projectId}
                    active="doc-review"
                    variant="dark"
                />
            </div>

            {/* Three-panel body */}
            <div className="flex min-h-0 flex-1 overflow-hidden border-t border-[var(--app-border)]">
                {/* LEFT: Matter Explorer */}
                {!explorerCollapsed && (
                    <>
                        <div
                            style={{ width: explorerWidth }}
                            className="flex shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-panel)]"
                            onDragOver={(e) => {
                                e.preventDefault();
                                // Only show the upload overlay for external file drags, not internal moves
                                const isInternal = hasCocoaLegalDragPayload(
                                    e.dataTransfer,
                                );
                                if (!isInternal && canMutate) setExplorerDragOver(true);
                            }}
                            onDragLeave={(e) => {
                                if (
                                    !e.currentTarget.contains(
                                        e.relatedTarget as Node,
                                    )
                                )
                                    setExplorerDragOver(false);
                            }}
                            onDrop={canMutate ? handleExplorerFileDrop : undefined}
                        >
                            {/* Explorer header */}
                            <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--app-border)] px-3">
                                <span className="text-xs text-[var(--app-text-muted)]">
                                    Explorer
                                </span>
                                <div className="flex items-center gap-1">
                                    {canMutate ? (
                                        <>
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept={DOCUMENT_ACCEPT_ATTR}
                                                multiple
                                                className="hidden"
                                                onChange={(e) =>
                                                    uploadFiles(
                                                        Array.from(
                                                            e.target.files ?? [],
                                                        ),
                                                    )
                                                }
                                            />
                                            <button
                                                onClick={() =>
                                                    fileInputRef.current?.click()
                                                }
                                                disabled={uploading}
                                                title="Upload documents"
                                                className="rounded p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)] disabled:opacity-40"
                                            >
                                                {uploading ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <Upload className="h-3.5 w-3.5" />
                                                )}
                                            </button>
                                        </>
                                    ) : null}
                                    <button
                                        onClick={() =>
                                            setExplorerCollapsed(true)
                                        }
                                        title="Collapse explorer"
                                        className="rounded p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                    >
                                        <ChevronLeft className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>

                            {/* Drop overlay */}
                            <div
                                className={`relative h-full flex-1 overflow-y-auto ${explorerDragOver ? "bg-[var(--app-accent-soft)]" : ""}`}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                }}
                                onDrop={async (e) => {
                                    e.preventDefault();
                                    const docId = getCocoaLegalDocDragData(
                                        e.dataTransfer,
                                    );
                                    const folderId = getCocoaLegalFolderDragData(
                                        e.dataTransfer,
                                    );
                                    if (docId) {
                                        e.stopPropagation();
                                        await handleMoveDoc(docId, null);
                                    } else if (folderId) {
                                        e.stopPropagation();
                                        await handleMoveFolder(folderId, null);
                                    }
                                    // External file drops are not stopped — they bubble to handleExplorerFileDrop
                                }}
                            >
                                {explorerDragOver && (
                                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                                        <p className="text-xs font-medium text-[var(--app-accent)]">
                                            Drop to upload
                                        </p>
                                    </div>
                                )}
                                <ProjectExplorer
                                    projectName={project?.name}
                                    documents={project?.documents ?? []}
                                    folders={project?.folders ?? []}
                                    documentTree={documentTree}
                                    revealDocumentId={revealDocumentId}
                                    selectedDocId={selectedDocId}
                                    onDocClick={handleDocClick}
                                    onVersionClick={handleVersionClick}
                                    onVersionProvenanceClick={
                                        handleVersionProvenanceClick
                                    }
                                    onDerivedDocumentClick={
                                        handleDerivedDocumentClick
                                    }
                                    onExportDocument={canExport ? handleExportDocument : undefined}
                                    onSendForSignature={canMutate ? handleSendForSignature : undefined}
                                    signatureStatusForDoc={
                                        signatureStatusForDoc
                                    }
                                    onCreateFolder={canMutate ? handleCreateFolder : undefined}
                                    onRenameFolder={canMutate ? handleRenameFolder : undefined}
                                    onDeleteFolder={canMutate ? handleDeleteFolder : undefined}
                                    onDeleteDoc={canLifecycle ? handleDeleteDoc : undefined}
                                    onMoveDoc={canMutate ? handleMoveDoc : undefined}
                                    onMoveFolder={canMutate ? handleMoveFolder : undefined}
                                    onDraftDocument={canMutate ? () =>
                                        router.push(matterAuthoringHref(projectId))
                                    : undefined}
                                    variant="dark"
                                />
                            </div>
                        </div>
                        <Divider onDrag={onExplorerDividerDrag} />
                    </>
                )}

                {/* Collapsed explorer toggle */}
                {explorerCollapsed && (
                    <div className="flex shrink-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-panel)]">
                        <div className="flex h-10 shrink-0 items-center justify-center border-b border-[var(--app-border)] px-1">
                            <button
                                onClick={() => setExplorerCollapsed(false)}
                                title="Expand explorer"
                                className="rounded p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            >
                                <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}

                {/* CENTER: Document Panel */}
                <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--app-border)] bg-[var(--app-panel-soft)]">
                    {/* Tab bar */}
                    <div className="flex h-10 min-w-0 shrink-0 items-stretch border-b border-[var(--app-border)]">
                        <div
                            ref={tabBarRef}
                            className="flex min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                        >
                            {tabs.length === 0 ? (
                                <span className="self-center px-4 text-xs text-[var(--app-text-muted)]">
                                    Document Viewer
                                </span>
                            ) : (
                                tabs.map((tab) => {
                                    const isActive =
                                        tab.documentId === activeTabId;
                                    const ext = tab.filename
                                        .split(".")
                                        .pop()
                                        ?.toLowerCase();
                                    const iconColor =
                                        ext === "pdf"
                                            ? "text-red-500"
                                            : ext === "doc" || ext === "docx"
                                              ? "text-blue-500"
                                              : "text-gray-400";
                                    const versionNumber = tab.versionNumber;
                                    const showVersionBadge =
                                        typeof versionNumber === "number" &&
                                        Number.isFinite(versionNumber) &&
                                        versionNumber > 1;
                                    const hasDuplicateName =
                                        tabs.filter(
                                            (candidate) =>
                                                candidate.filename ===
                                                tab.filename,
                                        ).length > 1;
                                    return (
                                        <div
                                            key={tab.documentId}
                                            ref={(el) => {
                                                tabItemRefs.current[
                                                    tab.documentId
                                                ] = el;
                                            }}
                                            onClick={() =>
                                                switchTab(tab.documentId)
                                            }
                                            title={`${tab.filename} · ${tab.documentId.slice(0, 8)}${tab.versionId ? ` · ${tab.versionId.slice(0, 8)}` : ""}${versionNumber ? ` · V${versionNumber}` : ""}`}
                                            className={`group flex h-full max-w-[260px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-[var(--app-border)] px-3 transition-colors ${
                                                isActive
                                                    ? "bg-[var(--app-active-strong)] text-[var(--app-active-foreground)]"
                                                    : "bg-[var(--app-panel)] text-[var(--app-text-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                                            }`}
                                        >
                                            <FileText
                                                className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
                                            />
                                            <span
                                                className={`truncate text-xs ${isActive ? "font-medium text-[var(--app-active-foreground)]" : "text-inherit"}`}
                                            >
                                                {tab.filename}
                                            </span>
                                            {showVersionBadge && (
                                                <span
                                                    className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                                        isActive
                                                            ? "border-[var(--app-border)] bg-[var(--app-active)] text-[var(--app-active-foreground)]"
                                                            : "border-[var(--app-border)] bg-[var(--app-command-muted)] text-[var(--app-text-muted)]"
                                                    }`}
                                                >
                                                    V{versionNumber}
                                                </span>
                                            )}
                                            {hasDuplicateName && (
                                                <span className="shrink-0 rounded border border-[var(--app-border)] px-1 py-px font-mono text-[9px] text-inherit opacity-75">
                                                    {tab.documentId.slice(0, 6)}
                                                </span>
                                            )}
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    closeTab(tab.documentId);
                                                }}
                                                className={`shrink-0 transition-colors ${isActive ? "text-[var(--app-active-foreground)] opacity-70 hover:opacity-100" : "text-[var(--app-text-subtle)] hover:text-[var(--app-text-strong)]"}`}
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                        {activeTab && canExport && (
                            <button
                                type="button"
                                onClick={() => void handleExportActiveTab()}
                                title="Export active document"
                                className="flex shrink-0 items-center gap-1.5 border-l border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            >
                                <Download className="h-3.5 w-3.5" />
                                Export
                            </button>
                        )}
                        {activeTab && canMutate && (
                            <button
                                type="button"
                                onClick={() =>
                                    setSignFor({
                                        documentId: activeTab.documentId,
                                        filename: activeTab.filename,
                                    })
                                }
                                title="Send active document for signature"
                                className="flex shrink-0 items-center gap-1.5 border-l border-[var(--app-border)] px-3 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                            >
                                <FileSignature className="h-3.5 w-3.5" />
                                Send for signature
                            </button>
                        )}
                    </div>
                    {/* Inline signature-status banner for the open document. */}
                    {(() => {
                        const entry = activeTab
                            ? sigByDoc.get(activeTab.documentId)
                            : undefined;
                        const meta = entry
                            ? signatureBannerMeta(entry.status)
                            : null;
                        if (!entry || !meta) return null;
                        const BannerIcon = meta.icon;
                        return (
                            <div
                                className={`flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs font-medium ${meta.cls}`}
                            >
                                <BannerIcon className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{meta.label}</span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setViewEnvelopeId(entry.envelopeId)
                                    }
                                    className="ml-auto shrink-0 rounded border border-current/30 px-2 py-0.5 text-[11px] font-semibold transition-colors hover:bg-black/5"
                                >
                                    View status
                                </button>
                            </div>
                        );
                    })()}
                    {(() => {
                        const state = activeTab
                            ? actionStateByDoc.get(activeTab.documentId)
                            : undefined;
                        if (!state) return null;
                        const current = state.current_version.number
                            ? `V${state.current_version.number}`
                            : "Current version";
                        const sent = state.delivery.sent_versions
                            .map((version) =>
                                version.version_number
                                    ? `V${version.version_number}`
                                    : version.version_id.slice(0, 8),
                            )
                            .join(", ");
                        if (!sent && state.delivery.pending_versions.length === 0)
                            return null;
                        const label = state.delivery.newer_version_available
                            ? `${sent} sent; ${current} not sent — newer version available`
                            : state.delivery.current_version_sent
                              ? `${current} sent by email`
                              : `${current} attached to an email awaiting completion`;
                        return (
                            <div className="flex shrink-0 items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs font-medium text-blue-800">
                                <FileText className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{label}</span>
                            </div>
                        );
                    })()}
                    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                        {activeTab ? (
                            isImageTab(activeTab.filename) ? (
                                <DocImageView
                                    key={activeTab.documentId}
                                    documentId={activeTab.documentId}
                                    filename={activeTab.filename}
                                    rounded={false}
                                    bordered={false}
                                />
                            ) : isDocxTab(activeTab.filename) ? (
                                <DocxView
                                    key={activeTab.documentId}
                                    documentId={activeTab.documentId}
                                    versionId={activeTab.versionId}
                                    refetchKey={activeTab.refetchKey}
                                    quotes={
                                        activeTab.quotes ??
                                        activeQuotes ??
                                        undefined
                                    }
                                    activeQuoteId={
                                        activeTab.activeQuoteId ??
                                        activeQuoteId ??
                                        undefined
                                    }
                                    highlightEdit={
                                        editScrollTarget &&
                                        editScrollTarget.documentId ===
                                            activeTab.documentId
                                            ? editScrollTarget
                                            : null
                                    }
                                    onReady={() =>
                                        handleDocxReady(activeTab.documentId)
                                    }
                                    warning={activeTab.warning ?? null}
                                    onWarningDismiss={() =>
                                        dismissTabWarning(activeTab.documentId)
                                    }
                                    initialScrollTop={
                                        activeTab.scrollTop ?? null
                                    }
                                    onScrollChange={(top) =>
                                        handleTabScrollChange(
                                            activeTab.documentId,
                                            top,
                                        )
                                    }
                                    rounded={false}
                                    bordered={false}
                                />
                            ) : (
                                <DocView
                                    key={activeTab.documentId}
                                    doc={{
                                        document_id: activeTab.documentId,
                                        version_id: activeTab.versionId ?? null,
                                    }}
                                    quotes={
                                        activeTab.quotes ??
                                        activeQuotes ??
                                        undefined
                                    }
                                    activeQuoteId={
                                        activeTab.activeQuoteId ??
                                        activeQuoteId ??
                                        undefined
                                    }
                                    rounded={false}
                                    bordered={false}
                                />
                            )
                        ) : (
                            <div className="flex h-full items-center justify-center bg-[var(--app-panel)] px-8">
                                <div className="text-center space-y-3">
                                    <p className="font-serif text-xl text-[var(--app-text)]">
                                        Click on a document to display here.
                                    </p>
                                    <p className="font-serif text-base text-[var(--app-text-subtle)]">
                                        Pro tip: Drag a document from the
                                        Matter Explorer to the Assistant to
                                        direct it to read or edit.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <Divider onDrag={onChatDividerDrag} />

                {/* RIGHT: Assistant Panel */}
                <div
                    style={{ width: chatWidth }}
                    className="flex shrink-0 flex-col bg-[var(--app-panel)]"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleChatDrop}
                >
                    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-4">
                        <CocoaLegalIcon size={16} />
                        <span className="text-xs font-medium text-[var(--app-text-strong)]">
                            Quill
                        </span>
                    </div>

                    {/* Messages / greeting / shimmer */}
                    {!chatLoaded ? (
                        <div className="flex-1 space-y-4 px-4 py-4">
                            <div className="flex justify-end">
                                <div className="w-3/4 rounded-2xl bg-[var(--app-command-muted)] p-4">
                                    <div className="h-3 w-full animate-[shimmer_2s_ease-in-out_infinite] rounded bg-gradient-to-r from-[var(--app-active)] via-[var(--app-border-strong)] to-[var(--app-active)] bg-[length:200%_100%]" />
                                </div>
                            </div>
                            <div className="space-y-2">
                                {[1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`h-3 animate-[shimmer_2s_ease-in-out_infinite] rounded bg-gradient-to-r from-[var(--app-active)] via-[var(--app-border-strong)] to-[var(--app-active)] bg-[length:200%_100%] ${i === 3 ? "w-4/6" : "w-full"}`}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex-1 flex flex-col min-h-0">
                            <AssistantGreeting greetingName={greetingName} />
                        </div>
                    ) : (
                        <div
                            ref={messagesContainerRef}
                            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
                            style={{ scrollbarGutter: "stable" }}
                        >
                            {messages.some(
                                (m) => m.inherited_from_chat_id,
                            ) && (
                                <div className="flex items-center gap-2 rounded-lg border border-[var(--app-accent)]/40 bg-[var(--app-accent)]/10 px-3 py-2 text-[11px] text-[var(--app-text-muted)]">
                                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--app-accent)]" />
                                    <span>
                                        You&rsquo;re in a branch. Earlier turns
                                        are inherited from the main thread.
                                    </span>
                                </div>
                            )}
                            {(() => {
                                const lastUserIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) =>
                                    msg.role === "user" ? (
                                        <div
                                            key={i}
                                            ref={(el) => {
                                                if (i === lastUserIdx)
                                                    latestUserMessageRef.current =
                                                        el;
                                                if (msg.id)
                                                    messageRefs.current[
                                                        msg.id
                                                    ] = el;
                                            }}
                                            className={`group relative ${
                                                msg.id &&
                                                msg.id === focusMessageId
                                                    ? "rounded-2xl ring-2 ring-[var(--app-accent)] ring-offset-2 transition"
                                                    : ""
                                            } ${
                                                msg.inherited_from_chat_id
                                                    ? "opacity-60"
                                                    : ""
                                            }`}
                                        >
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={msg.files}
                                                capabilityRun={
                                                    msg.capability_run
                                                }
                                            />
                                            {msg.id &&
                                                !msg.inherited_from_chat_id && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            handleForkFromMessage(
                                                                msg.id,
                                                            )
                                                        }
                                                        disabled={
                                                            forkingMessageId !==
                                                            null
                                                        }
                                                        title="Fork the conversation from this message"
                                                        className="absolute right-1 top-1 flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-1.5 py-0.5 text-[10px] text-[var(--app-text-muted)] opacity-0 transition hover:text-[var(--app-text-strong)] group-hover:opacity-100 disabled:opacity-40"
                                                    >
                                                        <GitBranch className="h-3 w-3" />
                                                        {forkingMessageId ===
                                                        msg.id
                                                            ? "Forking…"
                                                            : "Fork"}
                                                    </button>
                                                )}
                                        </div>
                                    ) : (
                                        <div
                                            key={i}
                                            ref={(el) => {
                                                if (msg.id)
                                                    messageRefs.current[
                                                        msg.id
                                                    ] = el;
                                            }}
                                            data-assistant-response-panel
                                            className={`rounded-2xl border bg-white/[0.94] px-4 py-4 text-slate-950 shadow-[0_24px_70px_rgba(0,0,0,0.28)] backdrop-blur-xl ${
                                                msg.id &&
                                                msg.id === focusMessageId
                                                    ? "border-[var(--app-accent)] ring-2 ring-[var(--app-accent)]"
                                                    : "border-white/[0.12]"
                                            }`}
                                        >
                                            <AssistantMessage
                                                content={msg.content ?? ""}
                                                events={msg.events}
                                                documentPacketJobIds={packetJobsByMessage[i]}
                                                chatId={effectiveChatId}
                                                messageId={msg.id ?? null}
                                                surface="matter"
                                                onRetryCapabilityRun={
                                                    handleRetryCapabilityRun
                                                }
                                                isStreaming={
                                                    i === messages.length - 1 &&
                                                    isResponseLoading
                                                }
                                                isError={!!msg.error}
                                                annotations={msg.annotations}
                                                onCitationClick={
                                                    handleCitationClick
                                                }
                                                minHeight={
                                                    i === lastAssistantIdx
                                                        ? minHeight
                                                        : "0px"
                                                }
                                                onEditViewClick={
                                                    handleEditViewClick
                                                }
                                                onOpenDocument={
                                                    handleOpenDocument
                                                }
                                                onRevealDocument={
                                                    handleRevealDocument
                                                }
                                                onHighlightViewClick={
                                                    handleHighlightViewClick
                                                }
                                                onHighlightSetChange={
                                                    handleHighlightSetChange
                                                }
                                                onOperationApplied={
                                                    handleOperationApplied
                                                }
                                                onEditResolveStart={
                                                    handleEditResolveStart
                                                }
                                                onEditResolved={
                                                    handleEditResolved
                                                }
                                                onEditError={handleEditError}
                                                isDocReloading={(docId) =>
                                                    reloadingDocIds.has(docId)
                                                }
                                            />
                                        </div>
                                    ),
                                );
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    )}

                    {/* ChatInput */}
                    <OperationActivityPanel
                        projectId={projectId}
                        documentId={activeTab?.documentId ?? null}
                        chatId={chatId}
                        onOperationApplied={handleOperationApplied}
                        onOpenDocument={handleOpenOperationDocument}
                        onExportDocument={canExport ? handleExportOperationDocument : undefined}
                        canChangeOperations={canMutate}
                    />
                    {canMutate ? <div className="shrink-0 px-4 pb-4">
                        {/* The matter surface has no DisplayWorkflowModal, and
                            handleRunCapability always posts an in-chat
                            capability_run — a "modal" proposal would be refused
                            by the backend with capability_not_runnable_in_chat.
                            So gate on runTarget === "chat" alone here. */}
                        {proposal &&
                            proposal.runTarget === "chat" &&
                            proposal.confidence >= 0.7 && (
                                <ProposalChip
                                    proposal={proposal}
                                    chatId={effectiveChatId}
                                    surface="matter"
                                    onRun={handleRunCapability}
                                    onDismiss={dismissProposal}
                                    onDontSuggestHere={handleDontSuggestHere}
                                    onMute={handleMuteSuggestions}
                                />
                            )}
                        <ChatInput
                            ref={chatInputRef}
                            onSubmit={handleSubmit}
                            onCancel={cancel}
                            isLoading={isResponseLoading}
                            hideAddDocButton
                            projectId={projectId}
                            onDocumentsUploaded={(documents) =>
                                setProject((prev) =>
                                    prev
                                        ? {
                                              ...prev,
                                              documents: [
                                                  ...(prev.documents ?? []),
                                                  ...documents,
                                              ],
                                          }
                                        : prev,
                                )
                            }
                            projectName={project?.name}
                            projectCmNumber={project?.cm_number}
                            variant="command"
                        />
                    </div> : null}
                </div>
            </div>
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
            {signFor && (
                <SignersModal
                    open
                    onClose={() => setSignFor(null)}
                    documentId={signFor.documentId}
                    filename={signFor.filename}
                />
            )}
            {/* In-place signature-status modal — mirrors SignersModal's shell,
                hosting the live SignatureStatusCard (per-signer progress, own
                countersign panel, executed PDF + certificate on completion). */}
            {viewEnvelopeId &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs"
                        onMouseDown={(e) => {
                            if (e.target === e.currentTarget)
                                setViewEnvelopeId(null);
                        }}
                    >
                        <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                            <div className="flex items-center justify-between px-5 py-4">
                                <div className="flex items-center gap-2">
                                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700 ring-1 ring-purple-200">
                                        <FileSignature className="h-3.5 w-3.5" />
                                    </div>
                                    <h2 className="text-sm font-semibold text-gray-900">
                                        Signature status
                                    </h2>
                                </div>
                                <button
                                    onClick={() => setViewEnvelopeId(null)}
                                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                                    title="Close"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto px-5 pb-5">
                                <SignatureStatusCard
                                    envelopeId={viewEnvelopeId}
                                />
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
}
