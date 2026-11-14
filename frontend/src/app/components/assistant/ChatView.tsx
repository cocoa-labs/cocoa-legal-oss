"use client";

import { documentPacketJobsByMessage } from "../authoring/documentPacketState";

import { useCallback, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { ArrowDown, Image as ImageIcon, Inbox, X } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { ProposalChip } from "./ProposalChip";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import { AppBackButton } from "@/app/components/shared/AppBackButton";
import { CocoaCommandBackdrop } from "@/app/components/shared/CocoaCommandBackdrop";
import {
    AssistantSidePanel,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { DisplayWorkflowModal } from "../workflows/DisplayWorkflowModal";
import { BUILT_IN_WORKFLOWS } from "../workflows/builtinWorkflows";
import { capabilityIdToWorkflowId } from "../legal/creShared";
import { updateChatSuggestions } from "@/app/lib/cocoaLegalApi";
import type {
    AssistantEvent,
    CocoaLegalCitationAnnotation,
    CocoaLegalEditAnnotation,
    CocoaLegalHighlightAnnotation,
    CocoaLegalMessage,
    CocoaLegalWorkflow,
} from "../shared/types";
import type {
    CapabilityRunOpt,
    LegalProposal,
} from "@/app/hooks/useAssistantChat";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";

/** Display name from a "Name <addr>" header, falling back to the raw value. */
function senderName(from: string | null | undefined): string {
    if (!from) return "the sender";
    return from.replace(/<[^>]*>/, "").trim() || from;
}

interface Props {
    messages: CocoaLegalMessage[];
    isResponseLoading: boolean;
    handleChat: (
        message: CocoaLegalMessage,
        opts?: {
            editImageSource?: {
                document_id?: string | null;
                attachment_id?: string | null;
            } | null;
            capabilityRun?: CapabilityRunOpt;
        },
    ) => Promise<string | null>;
    cancel: () => void;
    /** Id of the conversation on screen — null until the first turn persists. */
    chatId?: string | null;
    /** Inline (non-modal) capability suggestion from the intent router. */
    proposal?: LegalProposal | null;
    onDismissProposal?: () => void;
    /**
     * The inbound reply the user clicked to open this conversation — shown as a
     * dismissible context banner above the composer so they see what Quill is
     * replying to. Set only when arriving from the Inbox (?inbound).
     */
    inboundContext?: Extract<AssistantEvent, { type: "email_received" }> | null;
    onDismissInbound?: () => void;
    /** Commit a composer mic capture / audio upload — `useAssistantChat.commitRecording`. */
    onRecordAudio?: (input: {
        blob: Blob;
        filename: string;
        source: "mic" | "upload";
        durationSeconds?: number;
    }) => Promise<void>;
}

export function ChatView({
    messages,
    isResponseLoading,
    handleChat,
    cancel,
    chatId = null,
    proposal,
    onDismissProposal,
    inboundContext,
    onDismissInbound,
    onRecordAudio,
}: Props) {
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    // The CRE workflow to launch when the user confirms an intent proposal.
    // Confirming opens the SAME DisplayWorkflowModal the gallery uses, so the
    // configure → createTabularReview / start-chat path is reused verbatim.
    const [proposalWorkflow, setProposalWorkflow] =
        useState<CocoaLegalWorkflow | null>(null);
    // Document id(s) the user just attached, carried on the proposal so the
    // modal opens with the lease already selected (Create Review enabled at
    // once). Captured at confirm time and handed to DisplayWorkflowModal.
    const [proposalDocIds, setProposalDocIds] = useState<string[]>([]);
    // Image the user chose to edit via a GeneratedImageCard's "Edit" button.
    // Shown as a composer chip; on the next send it's threaded as the turn's
    // edit_image_source so edit_image targets exactly this image.
    const [editingImage, setEditingImage] = useState<{
        documentId: string;
        filename: string;
    } | null>(null);

    // Regenerate: re-send the original prompt so the agent calls generate_image
    // again (a fresh take). Attach-to-email: ask the agent to attach the image
    // document to a new (approval-gated) email draft. Edit: bind the image as
    // the next turn's source and surface the composer chip.
    const handleRegenerateImage = useCallback(
        (prompt: string) => {
            void handleChat({ role: "user", content: prompt });
        },
        [handleChat],
    );
    const handleAttachImageToEmail = useCallback(
        (documentId: string, filename: string) => {
            void handleChat({
                role: "user",
                content: `Please attach the image "${filename}" (image document_id: ${documentId}) to a new email draft so I can review and send it.`,
            });
        },
        [handleChat],
    );
    const handleEditImage = useCallback(
        (documentId: string, filename: string) => {
            setEditingImage({ documentId, filename });
        },
        [],
    );

    // Confirming a proposal takes one of two paths. A `modal` run (and a
    // legacy proposal with no runTarget that maps to a CRE workflow) opens the
    // same gallery workflow modal it always has. A `chat` run posts an ordinary
    // turn carrying `capability_run`, and the answer comes back as a
    // capability_result card in this conversation.
    const handleRunProposal = useCallback(
        (p: LegalProposal, inputs: { represented_party?: string }) => {
            // Pull the attached document id(s) off the proposal's
            // prefilledInputs (shape: { documentIds: string[] }), filtered to
            // non-empty strings.
            const rawDocIds = (
                p.prefilledInputs as { documentIds?: unknown } | undefined
            )?.documentIds;
            const docIds = Array.isArray(rawDocIds)
                ? rawDocIds.filter(
                      (id): id is string =>
                          typeof id === "string" && id.length > 0,
                  )
                : [];

            if (p.runTarget === "chat") {
                const runLabel = p.runLabel ?? "Run review";
                void handleChat(
                    {
                        role: "user",
                        content: `${runLabel}: ${p.confirmPrompt.replace(/\?$/, "")}`,
                    },
                    {
                        capabilityRun: {
                            capability_id: p.capabilityId,
                            proposal_id: p.proposalId ?? null,
                            document_ids: docIds,
                            inputs,
                        },
                    },
                );
                onDismissProposal?.();
                return;
            }

            const workflowId = capabilityIdToWorkflowId(p.capabilityId);
            const workflow = workflowId
                ? (BUILT_IN_WORKFLOWS.find((w) => w.id === workflowId) ?? null)
                : null;
            if (workflow) {
                setProposalDocIds(docIds);
                setProposalWorkflow(workflow);
            }
            onDismissProposal?.();
        },
        [handleChat, onDismissProposal],
    );

    // Durable suggestion controls. A failure is logged AND rethrown: the chip
    // owns the recovery UI, and swallowing the error here would hide the chip
    // as if the preference had stuck when nothing was written.
    const handleDontSuggestHere = useCallback(
        async (p: LegalProposal) => {
            if (!chatId) return;
            try {
                await updateChatSuggestions(chatId, {
                    action: "dismiss",
                    capability_id: p.capabilityId,
                    proposal_id: p.proposalId ?? null,
                });
            } catch (err) {
                console.error("[ChatView] dismiss suggestion failed", err);
                throw err;
            }
        },
        [chatId],
    );

    const handleMuteSuggestions = useCallback(async () => {
        if (!chatId) return;
        try {
            await updateChatSuggestions(chatId, { action: "suppress" });
        } catch (err) {
            console.error("[ChatView] mute suggestions failed", err);
            throw err;
        }
    }, [chatId]);

    // Re-run a failed capability result with exactly the inputs it recorded.
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
            void handleChat(
                { role: "user", content: `Run ${args.title}` },
                {
                    capabilityRun: {
                        capability_id: args.capabilityId,
                        proposal_id: args.proposalId,
                        document_ids: args.retry.document_ids,
                        inputs: args.retry.inputs,
                    },
                },
            );
        },
        [handleChat],
    );
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocPanel) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen } = useSidebar();


    const showPanel = useCallback(() => {
        setPanelMounted(true);
        setSidebarOpen(false);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => setPanelVisible(true)),
        );
    }, [setSidebarOpen]);

    const closeAllTabs = useCallback(() => {
        setPanelVisible(false);
        setTimeout(() => {
            setTabs([]);
            setActiveTabId(null);
            setPanelMounted(false);
            setSidebarOpen(true);
        }, 300);
    }, [setSidebarOpen]);

    const closeTab = useCallback(
        (id: string) => {
            setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (next.length === 0) {
                    setPanelVisible(false);
                    setTimeout(() => {
                        setActiveTabId(null);
                        setPanelMounted(false);
                        setSidebarOpen(true);
                    }, 300);
                    return next;
                }
                if (activeTabId === id) {
                    const idx = prev.findIndex((t) => t.id === id);
                    const neighbour = next[idx] ?? next[idx - 1] ?? next[0];
                    setActiveTabId(neighbour?.id ?? null);
                }
                return next;
            });
        },
        [activeTabId, setSidebarOpen],
    );

    /**
     * One tab per document. If a tab for `tab.documentId` already exists,
     * the panel stays mounted and only the header-relevant fields swap
     * (kind, citation/edit, version, filename). Per-tab UI state — the
     * dismissable warning and the saved scroll position — is preserved
     * so switching headers doesn't blow away viewer state. If no tab
     * exists for the document, a new one is appended.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => {
                const idx = prev.findIndex(
                    (t) => t.documentId === tab.documentId,
                );
                if (idx >= 0) {
                    const existing = prev[idx];
                    const copy = prev.slice();
                    copy[idx] = {
                        ...tab,
                        id: existing.id,
                        warning: existing.warning,
                        initialScrollTop: existing.initialScrollTop,
                    };
                    return copy;
                }
                return [...prev, tab];
            });
            setActiveTabId(tab.id);
            showPanel();
        },
        [showPanel],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        (citation: CocoaLegalCitationAnnotation) => {
            upsertTab({
                kind: "citation",
                id: citation.document_id,
                documentId: citation.document_id,
                filename: citation.filename,
                versionId: citation.version_id ?? null,
                versionNumber: citation.version_number ?? null,
                citation,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a single tracked change. Called from
     * AssistantMessage when the user clicks an EditCard's View button.
     */
    const openEditor = useCallback(
        (ann: CocoaLegalEditAnnotation, filename: string) => {
            upsertTab({
                kind: "edit",
                id: ann.document_id,
                documentId: ann.document_id,
                filename,
                versionId: ann.version_id ?? null,
                versionNumber: ann.version_number ?? null,
                edit: ann,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a document without targeting a specific
     * citation/edit — used by the download-card click.
     */
    const openDocument = useCallback(
        (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
        }) => {
            upsertTab({
                kind: "document",
                id: args.documentId,
                documentId: args.documentId,
                filename: args.filename,
                versionId: args.versionId,
                versionNumber: args.versionNumber,
            });
        },
        [upsertTab],
    );

    const openHighlights = useCallback(
        (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
            title: string;
            highlights: CocoaLegalHighlightAnnotation[];
            activeHighlightId?: string | null;
        }) => {
            upsertTab({
                kind: "highlight",
                id: args.documentId,
                documentId: args.documentId,
                filename: args.filename,
                versionId: args.versionId,
                versionNumber: args.versionNumber,
                title: args.title,
                highlights: args.highlights,
                activeHighlightId: args.activeHighlightId ?? null,
            });
        },
        [upsertTab],
    );

    const handleHighlightSetChange = useCallback(
        (args: {
            setId: string;
            documentId: string;
            highlights: CocoaLegalHighlightAnnotation[];
        }) => {
            setTabs((prev) =>
                prev.map((tab) =>
                    tab.kind === "highlight" &&
                    tab.documentId === args.documentId
                        ? { ...tab, highlights: args.highlights }
                        : tab,
                ),
            );
        },
        [],
    );

    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});

    const handleEditResolveStart = useCallback(
        (args: {
            editId: string;
            documentId: string;
            verb: "accept" | "reject";
        }) => {
            setReloadingDocIds((prev) => {
                if (prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.add(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            // Propagate the new decision snapshot onto open tabs for this
            // document. user_accept/user_reject snapshots are intentionally
            // unnumbered, so the tab's versionNumber clears while versionId
            // moves to the immutable bytes returned by the backend.
            setTabs((prev) =>
                prev.map((t) => {
                    if (t.documentId !== args.documentId) return t;
                    const next = {
                        ...t,
                        versionId: args.versionId ?? t.versionId,
                        versionNumber: null,
                    };
                    if (next.kind === "edit" && next.edit.edit_id === args.editId) {
                        return {
                            ...next,
                            edit: { ...next.edit, status: args.status },
                        };
                    }
                    return next;
                }),
            );
            // Accept/reject mutates bytes for this document's current
            // version; drop the cache so the next DocxView render (or an
            // explicit re-open) fetches the fresh file.
            invalidateDocxBytes(args.documentId);
        },
        [],
    );


    const patchTab = useCallback(
        (
            tabId: string,
            patch: Partial<Pick<AssistantSidePanelTab, "warning" | "initialScrollTop">>,
        ) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx < 0) return prev;
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], ...patch };
                return copy;
            });
        },
        [],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            // Surface the warning on every tab tied to this document.
            setTabs((prev) =>
                prev.map((t) =>
                    t.documentId === args.documentId
                        ? { ...t, warning: args.message }
                        : t,
                ),
            );
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
        },
        [],
    );

    const handleWarningDismiss = useCallback(
        (tabId: string) => {
            patchTab(tabId, { warning: null });
        },
        [patchTab],
    );

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    const packetJobsByMessage = documentPacketJobsByMessage(messages);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<HTMLDivElement>(null);
    const hasScrolledRef = useRef(false);
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [inputHeight, setInputHeight] = useState(0);
    const [minHeight, setMinHeight] = useState("0px");

    useEffect(() => {
        const el = chatInputRef.current;
        if (!el) return;
        const observer = new ResizeObserver(() =>
            setInputHeight(el.offsetHeight),
        );
        observer.observe(el);
        setInputHeight(el.offsetHeight);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (latestUserMessageRef.current) {
            const headerHeight = window.innerWidth < 768 ? 56 : 0;
            const gap = window.innerWidth < 768 ? 16 : 24;
            const paddingBottom = 128;
            const marginBottom = 48;
            const userMessageHeight = latestUserMessageRef.current.offsetHeight;
            setMinHeight(
                `calc(100dvh - ${headerHeight + gap + userMessageHeight + paddingBottom + marginBottom}px)`,
            );
        }
    }, [messages.length]);

    const updateScrollButton = useCallback(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        const isScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 10;
        setShowScrollButton(isScrolledUp && c.scrollHeight > c.clientHeight);
    }, []);

    useEffect(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        c.addEventListener("scroll", updateScrollButton);
        const frame = requestAnimationFrame(updateScrollButton);
        return () => {
            cancelAnimationFrame(frame);
            c.removeEventListener("scroll", updateScrollButton);
        };
    }, [messages, updateScrollButton]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

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
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        if (messages.length === 0) {
            hasScrolledRef.current = false;
            queueMicrotask(() => setMessagesVisible(false));
        } else if (!hasScrolledRef.current) {
            const userMsgCount = messages.filter(
                (m) => m.role === "user",
            ).length;
            if (
                userMsgCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                setTimeout(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (container && element) {
                        container.scrollTo({
                            top: element.offsetTop - 24,
                            behavior: "instant",
                        });
                    }
                    hasScrolledRef.current = true;
                    setMessagesVisible(true);
                }, 100);
            } else {
                hasScrolledRef.current = true;
                queueMicrotask(() => setMessagesVisible(true));
            }
        }
    }, [messages]);

    useEffect(() => {
        if (panelMounted && window.innerWidth < 768) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [panelMounted]);

    return (
        <div
            data-assistant-chat-shell
            className="h-full w-full flex relative overflow-hidden bg-[var(--app-shell)] text-[var(--app-text)]"
        >
            <CocoaCommandBackdrop variant="chat" />
            <AppBackButton
                variant="dark"
                className="absolute left-4 top-4 z-20 md:left-6 md:top-6"
            />
            {/* Chat column */}
            <div className="relative z-10 flex h-full flex-1 flex-col">
                {/* Scrollable messages */}
                <div
                    ref={messagesContainerRef}
                    className="flex-1 w-full overflow-y-auto"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    <div className="w-full max-w-4xl mx-auto pb-36 px-6 md:px-8 pt-5 md:pt-8 min-h-full flex flex-col relative">
                        {!messagesVisible && (
                            <div className="space-y-6 w-full">
                                <div className="flex justify-end">
                                    <div className="w-2/5 rounded-2xl border border-[var(--app-border)] bg-[var(--app-command-muted)] p-4 backdrop-blur-md">
                                        <div className="h-4 bg-gradient-to-r from-[var(--app-active)] via-[var(--app-border-strong)] to-[var(--app-active)] bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {[1, 2, 3, 4].map((i) => (
                                        <div
                                            key={i}
                                            className={`h-4 bg-gradient-to-r from-[var(--app-active)] via-[var(--app-border-strong)] to-[var(--app-active)] bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                        <div
                            className="space-y-6 transition-opacity duration-150"
                            style={{ opacity: messagesVisible ? 1 : 0 }}
                        >
                            {(() => {
                                const lastUserIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) => (
                                    <div
                                        key={i}
                                        ref={
                                            i === lastUserIndex
                                                ? latestUserMessageRef
                                                : null
                                        }
                                    >
                                        {msg.role === "user" ? (
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={msg.files}
                                                workflow={msg.workflow}
                                                capabilityRun={
                                                    msg.capability_run
                                                }
                                                variant="command"
                                            />
                                        ) : (
                                            <div
                                                data-assistant-response-panel
                                                className="rounded-2xl border border-white/[0.12] bg-white/[0.94] px-5 py-5 text-slate-950 shadow-[0_30px_90px_rgba(0,0,0,0.34)] backdrop-blur-xl md:px-6"
                                            >
                                                <AssistantMessage
                                                    content={msg.content ?? ""}
                                                    events={msg.events}
                                                    documentPacketJobIds={packetJobsByMessage[i]}
                                                    chatId={chatId}
                                                    messageId={msg.id ?? null}
                                                    surface="chat"
                                                    onRetryCapabilityRun={
                                                        handleRetryCapabilityRun
                                                    }
                                                    isStreaming={
                                                        i ===
                                                            messages.length -
                                                                1 &&
                                                        isResponseLoading
                                                    }
                                                    isError={!!msg.error}
                                                    errorMessage={
                                                        typeof msg.error ===
                                                        "string"
                                                            ? msg.error
                                                            : undefined
                                                    }
                                                    annotations={
                                                        msg.annotations
                                                    }
                                                    onCitationClick={
                                                        openCitation
                                                    }
                                                    minHeight={
                                                        i === lastAssistantIndex
                                                            ? minHeight
                                                            : "0px"
                                                    }
                                                    onWorkflowClick={(id) => {
                                                        setWorkflowModalInitialId(
                                                            id,
                                                        );
                                                        setWorkflowModalOpen(
                                                            true,
                                                        );
                                                    }}
                                                    onEditViewClick={openEditor}
                                                    onHighlightViewClick={
                                                        openHighlights
                                                    }
                                                    onHighlightSetChange={
                                                        handleHighlightSetChange
                                                    }
                                                    onOpenDocument={
                                                        openDocument
                                                    }
                                                    onEditResolveStart={
                                                        handleEditResolveStart
                                                    }
                                                    onEditResolved={
                                                        handleEditResolved
                                                    }
                                                    onEditError={
                                                        handleEditError
                                                    }
                                                    isDocReloading={(docId) =>
                                                        reloadingDocIds.has(
                                                            docId,
                                                        )
                                                    }
                                                    isEditReloading={(editId) =>
                                                        reloadingEditIds.has(
                                                            editId,
                                                        )
                                                    }
                                                    resolvedEditStatuses={
                                                        resolvedEditStatuses
                                                    }
                                                    onEditImage={
                                                        handleEditImage
                                                    }
                                                    onRegenerateImage={
                                                        handleRegenerateImage
                                                    }
                                                    onAttachImageToEmail={
                                                        handleAttachImageToEmail
                                                    }
                                                />
                                            </div>
                                        )}
                                    </div>
                                ));
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>

                {/* Scroll to bottom button */}
                {showScrollButton && (
                    <div
                        className="absolute left-1/2 -translate-x-1/2 z-19"
                        style={{ bottom: inputHeight + 12 }}
                    >
                        <button
                            onClick={scrollToBottom}
                            className="p-2 rounded-full border border-[var(--app-border)] bg-[var(--app-command)] shadow-lg backdrop-blur-md cursor-pointer"
                        >
                            <ArrowDown className="h-6 w-6 text-[var(--app-text-muted)]" />
                        </button>
                    </div>
                )}

                {/* Chat input */}
                <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-44"
                    style={{
                        background:
                            "linear-gradient(to top, var(--app-shell), color-mix(in srgb, var(--app-shell) 88%, transparent), transparent)",
                    }}
                />
                <div
                    ref={chatInputRef}
                    className="absolute bottom-0 left-0 right-0 w-full z-30"
                >
                    <div className="w-full max-w-4xl mx-auto px-4 md:px-6">
                        <div className="w-full">
                            {inboundContext && (
                                <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-command-muted)] px-3 py-2 text-sm backdrop-blur-md">
                                    <span className="flex min-w-0 items-center gap-2 text-[var(--app-text)]">
                                        <Inbox className="h-3.5 w-3.5 shrink-0 text-[var(--app-warm)]" />
                                        <span className="truncate">
                                            Replying to{" "}
                                            <span className="font-medium">
                                                {senderName(
                                                    inboundContext.from_address,
                                                )}
                                            </span>
                                            {inboundContext.subject
                                                ? ` · ${inboundContext.subject}`
                                                : ""}
                                        </span>
                                    </span>
                                    <span className="flex shrink-0 items-center gap-2">
                                        <Link
                                            href={`/inbox/${inboundContext.email_id}`}
                                            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
                                        >
                                            View full email
                                        </Link>
                                        {onDismissInbound && (
                                            <button
                                                type="button"
                                                onClick={onDismissInbound}
                                                aria-label="Dismiss"
                                                className="rounded-md p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </span>
                                </div>
                            )}
                            {/* Only suggestions we can actually act on, and
                                only above the confidence floor — precision
                                over recall. */}
                            {proposal &&
                                (proposal.runTarget === "chat" ||
                                    capabilityIdToWorkflowId(
                                        proposal.capabilityId,
                                    )) &&
                                proposal.confidence >= 0.7 && (
                                    <ProposalChip
                                        proposal={proposal}
                                        chatId={chatId}
                                        surface="chat"
                                        onRun={handleRunProposal}
                                        onDismiss={() => onDismissProposal?.()}
                                        onDontSuggestHere={
                                            handleDontSuggestHere
                                        }
                                        onMute={handleMuteSuggestions}
                                    />
                                )}
                            {editingImage && (
                                <div className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-command-muted)] px-3 py-2 text-sm backdrop-blur-md">
                                    <span className="flex min-w-0 items-center gap-2 text-[var(--app-text)]">
                                        <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-warm)]" />
                                        <span className="truncate">
                                            Editing{" "}
                                            <span className="font-medium">
                                                {editingImage.filename}
                                            </span>{" "}
                                            — describe the change below
                                        </span>
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setEditingImage(null)}
                                        aria-label="Cancel image edit"
                                        className="rounded-md p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            )}
                            <ChatInput
                                onSubmit={(message) => {
                                    const src = editingImage;
                                    setEditingImage(null);
                                    return handleChat(
                                        message,
                                        src
                                            ? {
                                                  editImageSource: {
                                                      document_id: src.documentId,
                                                  },
                                              }
                                            : undefined,
                                    );
                                }}
                                onCancel={cancel}
                                isLoading={isResponseLoading}
                                variant="command"
                                onRecordAudio={onRecordAudio}
                            />
                            <div className="py-3 text-center">
                                <p className="text-xs text-[var(--app-text-subtle)]">
                                    AI can make mistakes. Answers are not legal
                                    advice.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {/* Launched when the user confirms an intent proposal — the same
                gallery workflow modal (select → configure → run). The attached
                document(s) are pre-selected so Create Review is ready at once. */}
            <DisplayWorkflowModal
                workflows={BUILT_IN_WORKFLOWS}
                workflow={proposalWorkflow}
                prefillDocumentIds={proposalDocIds}
                onClose={() => {
                    setProposalWorkflow(null);
                    setProposalDocIds([]);
                }}
            />

            {panelMounted && (
                <div
                    className={`fixed md:relative inset-0 md:inset-auto md:h-full md:flex-shrink-0 z-40 md:z-auto transition-transform duration-300 ease-in-out ${panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        isEditorReloading={(documentId) =>
                            reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={handleWarningDismiss}
                        onScrollChange={handleScrollChange}
                    />
                </div>
            )}
        </div>
    );
}
