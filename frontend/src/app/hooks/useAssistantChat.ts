"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    streamChat,
    streamProjectChat,
    createRecording,
    getChat,
    cancelDocumentGenerationJob,
} from "@/app/lib/cocoLegalApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import type {
    AssistantEvent,
    CocoLegalCitationAnnotation,
    CocoLegalMessage,
} from "@/app/components/shared/types";
import { normalizeDocEditedEvent } from "@/app/components/doc-review/documentReliability";
import { synchronizeAssistantContent } from "@/app/lib/conversationContent";
import {
    assistantCommitMatches,
    assistantTerminalNeedsRecovery,
    type AssistantCommitIntegrity,
} from "@/app/lib/assistantResponseIntegrity";
import {
    appendAssistantContentDelta,
    assistantContentDisplaySnapshot,
    finalizeAssistantContent,
    finalizeAssistantStreamEvents,
    lastAssistantContentIndex,
} from "@/app/lib/assistantStreamAccumulator";
import { recordAssistantStreamMetric } from "@/app/lib/assistantReliabilityTelemetry";

/**
 * A capability proposal pushed by the backend intent router via the
 * `legal_proposal` SSE event. Mirrors IntentProposal in
 * backend/src/lib/legalIntentRouter.ts. Surfaced as a small inline,
 * non-modal suggestion while the normal answer keeps streaming; confirming
 * launches the capability's workflow, dismissing leaves the answer in place.
 */
export type LegalProposal = {
    capabilityId: string;
    confidence: number;
    confirmPrompt: string;
    prefilledInputs?: Record<string, unknown>;
    /** Minted by the orchestrator so a confirm ties back to this proposal. */
    proposalId?: string;
    /** The capability's title. */
    title?: string;
    /** The capability's fixed run label — never model-authored. */
    runLabel?: string;
    /** Where a confirmed run executes: in this chat, or in the workflow modal. */
    runTarget?: "chat" | "modal";
    /** Which detection layer produced this proposal. */
    source?: "llm" | "lexical";
    /** Inputs the chip must collect before the run can start. */
    intake?: "represented_party"[];
};

/**
 * A confirmed capability run posted alongside the user's turn. Mirrors the
 * `capability_run` request field `parseCapabilityRun` accepts in
 * backend/src/lib/chatMessages.ts.
 */
export type CapabilityRunOpt = {
    capability_id: string;
    proposal_id?: string | null;
    document_ids?: string[];
    inputs?: { represented_party?: string | null };
};

interface UseAssistantChatOptions {
    initialMessages?: CocoLegalMessage[];
    chatId?: string;
    projectId?: string;
    chatBasePath?: string;
}

const TERMINAL_GENERATION_STATUSES = new Set([
    "completed",
    "background",
    "incomplete",
    "failed",
    "cancelled",
    "refused",
]);

function waitForReconciliation(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function useAssistantChat({
    initialMessages = [],
    chatId: initialChatId,
    projectId,
    chatBasePath,
}: UseAssistantChatOptions = {}) {
    const router = useRouter();
    const {
        replaceChatId,
        loadChats,
        setCurrentChatId,
        saveChat,
        setNewChatMessages,
    } = useChatHistoryContext();
    const { generate: generateTitle } = useGenerateChatTitle();

    const [messages, setMessages] = useState<CocoLegalMessage[]>(initialMessages);
    const [isResponseLoading, setIsResponseLoading] = useState(false);
    const [isLoadingCitations, setIsLoadingCitations] = useState(false);
    const [proposal, setProposal] = useState<LegalProposal | null>(null);
    const [chatId, setChatId] = useState<string | undefined>(initialChatId);

    const abortControllerRef = useRef<AbortController | null>(null);
    const activeDocumentJobIdsRef = useRef<Set<string>>(new Set());

    const dripIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripTargetRef = useRef<string>("");
    const dripDisplayLenRef = useRef<number>(0);
    const eventsRef = useRef<AssistantEvent[]>([]);
    const DRIP_CHARS_PER_TICK = 8;

    const stopDrip = () => {
        if (dripIntervalRef.current !== null) {
            clearInterval(dripIntervalRef.current);
            dripIntervalRef.current = null;
        }
    };

    const updateLastContentEvent = (
        prev: CocoLegalMessage[],
        text: string,
        isStreaming?: boolean,
    ): CocoLegalMessage[] => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role !== "assistant") return prev;
        const events = last.events ?? [];
        const index = lastAssistantContentIndex(events);
        if (index < 0) return prev;
        const prior = events[index];
        if (
            prior.type === "content" &&
            prior.text === text &&
            !!prior.isStreaming === !!isStreaming
        ) {
            return prev;
        }
        const newEvents = assistantContentDisplaySnapshot(
            events,
            text,
            !!isStreaming,
        );
        updated[updated.length - 1] = synchronizeAssistantContent(
            last,
            newEvents,
        );
        return updated;
    };

    /**
     * Finalize any in-flight streaming content event and reset the drip
     * counters so the next content_delta starts a fresh block. Called
     * before any non-content event is appended, so interleaved content /
     * reasoning / tool events stay in chronological order — without the
     * later content block inheriting the earlier block's accumulated text.
     */
    const finalizeStreamingContent = () => {
        stopDrip();
        const events = eventsRef.current;
        const finalEvents = finalizeAssistantContent(events);
        if (finalEvents !== events) {
            eventsRef.current = finalEvents;
            const snapshot = [...eventsRef.current];
            setMessages((prev) => {
                const updated = [...prev];
                const lastMsg = updated[updated.length - 1];
                if (lastMsg?.role === "assistant") {
                    updated[updated.length - 1] = synchronizeAssistantContent(
                        lastMsg,
                        snapshot,
                    );
                }
                return updated;
            });
        }
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
    };

    const commitCanonicalStream = () => {
        stopDrip();
        eventsRef.current = finalizeAssistantStreamEvents(eventsRef.current);
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = synchronizeAssistantContent(
                    last,
                    snapshot,
                );
            }
            return updated;
        });
    };

    // If the model transitions from reasoning into content/tool without a
    // reasoning_block_end (or the events arrive out of order), the prior
    // reasoning event would otherwise stay flagged isStreaming forever.
    const finalizeStreamingReasoning = () => {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        if (last?.type !== "reasoning" || !last.isStreaming) return;
        eventsRef.current = [
            ...events.slice(0, -1),
            { type: "reasoning", text: last.text },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") {
                updated[updated.length - 1] = {
                    ...lastMsg,
                    events: snapshot,
                };
            }
            return updated;
        });
    };

    const startDrip = () => {
        if (dripIntervalRef.current !== null) return;
        dripIntervalRef.current = setInterval(() => {
            const target = dripTargetRef.current;
            const displayLen = dripDisplayLenRef.current;
            if (displayLen >= target.length) {
                stopDrip();
                return;
            }

            const newLen = Math.min(
                displayLen + DRIP_CHARS_PER_TICK,
                target.length,
            );
            dripDisplayLenRef.current = newLen;
            const visibleText = target.slice(0, newLen);
            setMessages((prev) =>
                updateLastContentEvent(prev, visibleText, true),
            );

            if (newLen >= target.length) {
                stopDrip();
            }
        }, 16);
    };

    useEffect(() => {
        return () => stopDrip();
    }, []);

    const cancel = () => {
        const activeJobs = [...activeDocumentJobIdsRef.current];
        if (activeJobs.length) {
            void Promise.allSettled(
                activeJobs.map((jobId) => cancelDocumentGenerationJob(jobId)),
            );
        }
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsResponseLoading(false);
            setIsLoadingCitations(false);
        }
    };

    const dismissProposal = () => setProposal(null);

    // Transient placeholder events (tool_call_start, thinking) fill the
    // latency gap between real SSE events so the wrapper doesn't look stuck.
    // Anytime a real event arrives, drop any streaming placeholder first.
    const isStreamingPlaceholder = (e: AssistantEvent) =>
        (e.type === "tool_call_start" ||
            e.type === "tool_input_progress" ||
            e.type === "thinking") &&
        !!e.isStreaming;

    const clearStreamingPlaceholders = () => {
        const before = eventsRef.current;
        const after = before.filter((e) => !isStreamingPlaceholder(e));
        if (after.length === before.length) return;
        eventsRef.current = after;
        const snapshot = [...after];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const pushThinkingPlaceholder = () => {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
        if (last && isStreamingPlaceholder(last)) return;
        eventsRef.current = [
            ...events,
            { type: "thinking" as const, isStreaming: true },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") {
                updated[updated.length - 1] = { ...lastMsg, events: snapshot };
            }
            return updated;
        });
    };

    const pushEvent = (event: AssistantEvent) => {
        finalizeStreamingContent();
        finalizeStreamingReasoning();
        // A real event, or a more specific placeholder such as
        // tool_call_start, should replace any generic "Thinking..." line.
        const next = eventsRef.current.filter(
            (e) => !isStreamingPlaceholder(e),
        );
        eventsRef.current = [...next, event];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const updateMatchingEvent = (
        predicate: (e: AssistantEvent) => boolean,
        updater: (e: AssistantEvent) => AssistantEvent,
    ) => {
        const events = eventsRef.current;
        const idx = [...events]
            .map((_, i) => i)
            .reverse()
            .find((i) => predicate(events[i]));
        if (idx === undefined) return;
        const newEvents = [...events];
        newEvents[idx] = updater(events[idx]);
        eventsRef.current = newEvents;
        const snapshot = [...newEvents];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const handleChat = async (
        message: CocoLegalMessage,
        opts?: {
            displayedDoc?: {
                filename: string;
                documentId: string;
                versionId?: string | null;
                versionNumber?: number | null;
            } | null;
            openDocs?: {
                document_id: string;
                version_id?: string | null;
                version_number?: number | null;
                displayed?: boolean;
            }[];
            /** Image bound by the "Edit" affordance, sent as this turn's edit source. */
            editImageSource?: {
                document_id?: string | null;
                attachment_id?: string | null;
            } | null;
            /** Confirmed capability run this turn executes (proposal chip). */
            capabilityRun?: CapabilityRunOpt;
        },
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        setIsResponseLoading(true);
        // Clear any prior turn's suggestion before this turn streams.
        setProposal(null);

        const lastMessage = messages[messages.length - 1];
        const isMessageAlreadyAdded =
            lastMessage &&
            lastMessage.role === "user" &&
            lastMessage.content === message.content;

        // Carry the confirmed run on the optimistic turn too, so the "Capability
        // run" pill shows the moment the user confirms — not only after the
        // reload that reads chat_messages.capability_run back.
        const turnMessage: CocoLegalMessage = opts?.capabilityRun
            ? {
                  ...message,
                  capability_run: {
                      capability_id: opts.capabilityRun.capability_id,
                      proposal_id: opts.capabilityRun.proposal_id ?? null,
                      document_ids: opts.capabilityRun.document_ids ?? [],
                      inputs: {
                          represented_party:
                              opts.capabilityRun.inputs?.represented_party ??
                              null,
                      },
                  },
              }
            : message;

        const newMessages: CocoLegalMessage[] = isMessageAlreadyAdded
            ? messages
            : [...messages, turnMessage];

        setMessages([
            ...newMessages,
            { role: "assistant", content: "", annotations: [], events: [] },
        ]);

        let streamedChatId: string | null = null;
        let streamedAssistantMessageId: string | null = null;
        let committedIntegrity: AssistantCommitIntegrity | null = null;
        let sawGenerationFinish = false;
        let sawDone = false;

        stopDrip();
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        eventsRef.current = [];
        activeDocumentJobIdsRef.current = new Set();

        try {
            const controller = new AbortController();
            abortControllerRef.current = controller;

            const currentTurn = {
                content: message.content,
                files: message.files,
                workflow: message.workflow,
            };

            const model = message.model;

            // Browser timezone for temporal grounding — lets the backend show
            // Quill "now" in the user's local zone. Same Intl call the calendar
            // feature already uses. Guarded so a non-DOM environment can't throw.
            let clientTimeZone: string | undefined;
            try {
                clientTimeZone =
                    Intl.DateTimeFormat().resolvedOptions().timeZone;
            } catch {
                clientTimeZone = undefined;
            }

            const displayedDoc = opts?.displayedDoc ?? null;

            // Pull the user's attachments from the just-submitted message.
            // These are the files dragged into / picked from the chat input
            // for this turn (separate from the running history of past
            // attachments). Sent as a request-level field so the backend
            // can call them out specifically in the system prompt.
            const attachedDocs = (
                message.files?.filter((f) => !!f.document_id) ?? []
            ).map((f) => ({
                filename: f.filename,
                document_id: f.document_id as string,
            }));

            const response = await (projectId
                ? streamProjectChat({
                      projectId,
                      message: currentTurn,
                      chat_id: chatId,
                      model,
                      client_time_zone: clientTimeZone,
                      displayed_doc: displayedDoc
                          ? {
                                filename: displayedDoc.filename,
                                document_id: displayedDoc.documentId,
                                version_id: displayedDoc.versionId ?? null,
                                version_number:
                                    displayedDoc.versionNumber ?? null,
                            }
                          : undefined,
                      open_docs: opts?.openDocs,
                      attached_documents:
                          attachedDocs.length > 0 ? attachedDocs : undefined,
                      edit_image_source: opts?.editImageSource ?? undefined,
                      capability_run: opts?.capabilityRun ?? undefined,
                      signal: controller.signal,
                  })
                : streamChat({
                      message: currentTurn,
                      chat_id: chatId,
                      model,
                      client_time_zone: clientTimeZone,
                      edit_image_source: opts?.editImageSource ?? undefined,
                      capability_run: opts?.capabilityRun ?? undefined,
                      signal: controller.signal,
                  }));

            if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as {
                    detail?: unknown;
                    message?: unknown;
                } | null;
                const detail =
                    typeof payload?.detail === "string"
                        ? payload.detail
                        : typeof payload?.message === "string"
                          ? payload.message
                          : `Request failed with HTTP ${response.status}`;
                throw new Error(detail);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";
            // A backend `error` event can't throw from inside the per-line
            // try — the broad catch below swallows it and the turn ends
            // silently. Record it and rethrow after the loop instead.
            let streamError: Error | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data:")) continue;

                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === "[DONE]") {
                        sawDone = true;
                        continue;
                    }

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.type === "chat_id") {
                            streamedChatId = data.chatId;
                            if (typeof data.assistant_message_id === "string") {
                                streamedAssistantMessageId =
                                    data.assistant_message_id;
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            id: data.assistant_message_id,
                                        };
                                    }
                                    return updated;
                                });
                            }
                            setChatId(data.chatId);
                            setCurrentChatId(data.chatId);
                            continue;
                        }

                        if (
                            data.type === "error" ||
                            data.type === "persistence_error"
                        ) {
                            const message =
                                typeof data.message === "string" &&
                                data.message.trim()
                                    ? data.message.trim()
                                    : typeof data.error === "string" &&
                                        data.error.trim()
                                      ? data.error.trim()
                                      : "The assistant stream failed.";
                            streamError = new Error(message);
                            continue;
                        }

                        if (data.type === "content_done") {
                            setIsLoadingCitations(true);
                            continue;
                        }

                        if (data.type === "content_delta") {
                            const text = data.text as string;

                            // Real content is streaming — retire any
                            // "Thinking…" / "Running…" placeholders, and
                            // finalize any in-flight reasoning block so it
                            // doesn't get stuck rendering as streaming.
                            clearStreamingPlaceholders();
                            finalizeStreamingReasoning();

                            // Ensure a streaming content event exists. If
                            // the last event isn't already a streaming
                            // content block, start a fresh one — and reset
                            // the drip so we don't inherit a previous
                            // block's accumulated text.
                            const appended = appendAssistantContentDelta(
                                eventsRef.current,
                                text,
                            );
                            eventsRef.current = appended.events;
                            dripTargetRef.current = appended.blockText;
                            if (appended.startedBlock) {
                                dripDisplayLenRef.current = 0;
                                const snapshot =
                                    assistantContentDisplaySnapshot(
                                        eventsRef.current,
                                        "",
                                        true,
                                    );
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            }

                            startDrip();
                            continue;
                        }

                        if (data.type === "reasoning_delta") {
                            const text = data.text as string;
                            let events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text + text,
                                        isStreaming: true,
                                    },
                                ];
                            } else {
                                // New reasoning block — finalize any in-flight
                                // content event first so the next content_delta
                                // starts a fresh block at the correct position.
                                finalizeStreamingContent();
                                clearStreamingPlaceholders();
                                events = eventsRef.current;
                                eventsRef.current = [
                                    ...events,
                                    {
                                        type: "reasoning" as const,
                                        text,
                                        isStreaming: true,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_block_end") {
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "tool_call_start") {
                            // Transient placeholder so the client immediately
                            // shows activity after Claude ends a turn with
                            // tool_use. Replaced by the real tool event
                            // (doc_edited_start, doc_read_start, …) if one
                            // arrives; otherwise it lingers as a "Working…"
                            // indicator until the next iteration streams.
                            pushEvent({
                                type: "tool_call_start",
                                name: (data.name as string) ?? "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "heartbeat") {
                            const last =
                                eventsRef.current[eventsRef.current.length - 1];
                            if (
                                !(
                                    (last?.type === "content" ||
                                        last?.type === "reasoning") &&
                                    last.isStreaming
                                )
                            ) {
                                pushEvent({
                                    type: "tool_input_progress",
                                    name: "",
                                    total_chars: 0,
                                    elapsed_ms:
                                        typeof data.elapsed_ms === "number"
                                            ? data.elapsed_ms
                                            : 0,
                                    isStreaming: true,
                                });
                            }
                            continue;
                        }

                        if (data.type === "tool_input_progress") {
                            const progress: Extract<
                                AssistantEvent,
                                { type: "tool_input_progress" }
                            > = {
                                type: "tool_input_progress",
                                name:
                                    typeof data.name === "string"
                                        ? data.name
                                        : "",
                                total_chars:
                                    typeof data.total_chars === "number"
                                        ? data.total_chars
                                        : 0,
                                elapsed_ms:
                                    typeof data.elapsed_ms === "number"
                                        ? data.elapsed_ms
                                        : 0,
                                isStreaming: true,
                            };
                            const existing = eventsRef.current.some(
                                (event) =>
                                    event.type === "tool_input_progress" &&
                                    event.isStreaming,
                            );
                            if (existing) {
                                updateMatchingEvent(
                                    (event) =>
                                        event.type === "tool_input_progress" &&
                                        !!event.isStreaming,
                                    () => progress,
                                );
                            } else {
                                pushEvent(progress);
                            }
                            continue;
                        }

                        if (
                            data.type === "document_job_started" ||
                            data.type === "document_job_status"
                        ) {
                            if (typeof data.job_id !== "string") continue;
                            if (data.type === "document_job_started")
                                activeDocumentJobIdsRef.current.add(
                                    data.job_id,
                                );
                            window.dispatchEvent(
                                new CustomEvent(
                                    "document-generation-job-updated",
                                    {
                                        detail: data.job_id,
                                    },
                                ),
                            );
                            pushEvent({
                                type: data.type,
                                job_id: data.job_id,
                                total_documents:
                                    typeof data.total_documents === "number"
                                        ? data.total_documents
                                        : 1,
                            });
                            continue;
                        }

                        if (data.type === "generation_finish") {
                            sawGenerationFinish = true;
                            const reason = data.finish_reason;
                            if (
                                typeof data.assistant_message_id === "string" &&
                                typeof data.requested_model_id === "string" &&
                                typeof data.final_model_id === "string" &&
                                typeof data.visible_text_utf8_bytes ===
                                    "number" &&
                                typeof data.visible_text_sha256 === "string"
                            ) {
                                streamedAssistantMessageId =
                                    data.assistant_message_id;
                                committedIntegrity = {
                                    assistantMessageId:
                                        data.assistant_message_id,
                                    requestedModelId: data.requested_model_id,
                                    finalModelId: data.final_model_id,
                                    visibleTextUtf8Bytes:
                                        data.visible_text_utf8_bytes,
                                    visibleTextSha256: data.visible_text_sha256,
                                };
                            }
                            // "completed" is the common path and renders
                            // nothing — pushing it would only finalize the
                            // streaming content early and mint a phantom
                            // one-step card. Mirrors the refresh-path
                            // normalizer in cocoLegalApi.getChat().
                            if (
                                reason === "max_output" ||
                                reason === "context_limit" ||
                                reason === "refused" ||
                                reason === "cancelled" ||
                                reason === "iteration_limit" ||
                                reason === "error"
                            ) {
                                pushEvent({
                                    type: "generation_finish",
                                    finish_reason: reason,
                                });
                            }
                            continue;
                        }

                        if (data.type === "model_fallback") {
                            const reason = data.reason;
                            if (
                                typeof data.requested_model_id !== "string" ||
                                typeof data.final_model_id !== "string" ||
                                typeof data.attempt_count !== "number" ||
                                (reason !== "empty_final_answer" &&
                                    reason !== "provider_error" &&
                                    reason !== "max_output" &&
                                    reason !== "context_limit")
                            ) {
                                continue;
                            }
                            pushEvent({
                                type: "model_fallback",
                                requested_model_id: data.requested_model_id,
                                final_model_id: data.final_model_id,
                                attempt_count: data.attempt_count,
                                reason,
                            });
                            continue;
                        }

                        if (data.type === "workflow_applied") {
                            pushEvent({
                                type: "workflow_applied",
                                workflow_id: data.workflow_id as string,
                                title: data.title as string,
                            });
                            continue;
                        }

                        // Matter / case lookups. These MUST be handled here
                        // even though they carry no interactive payload: the
                        // reload path (cocoLegalApi.getChat) casts the persisted
                        // events straight through, so an event dropped by this
                        // chain shows a step live and a *different* step count
                        // after a refresh — and, unrendered, contributes an
                        // empty row to its "Completed in N steps" group.
                        if (data.type === "matter_search") {
                            pushEvent({
                                type: "matter_search",
                                query:
                                    typeof data.query === "string" &&
                                    data.query.trim()
                                        ? (data.query as string)
                                        : null,
                                count:
                                    typeof data.count === "number"
                                        ? (data.count as number)
                                        : 0,
                                matters: Array.isArray(data.matters)
                                    ? (data.matters as unknown[])
                                          .map((m) => {
                                              const row = (m ?? {}) as {
                                                  matter_id?: unknown;
                                                  name?: unknown;
                                              };
                                              return {
                                                  matter_id:
                                                      typeof row.matter_id ===
                                                      "string"
                                                          ? row.matter_id
                                                          : "",
                                                  name:
                                                      typeof row.name ===
                                                      "string"
                                                          ? row.name
                                                          : "",
                                              };
                                          })
                                          .filter((m) => m.name.length > 0)
                                    : [],
                            });
                            continue;
                        }

                        if (data.type === "matter_documents_loaded") {
                            pushEvent({
                                type: "matter_documents_loaded",
                                matter_id:
                                    typeof data.matter_id === "string"
                                        ? (data.matter_id as string)
                                        : "",
                                matter_name:
                                    typeof data.matter_name === "string"
                                        ? (data.matter_name as string)
                                        : "",
                                document_count:
                                    typeof data.document_count === "number"
                                        ? (data.document_count as number)
                                        : 0,
                                ...(typeof data.readable_count === "number"
                                    ? {
                                          readable_count:
                                              data.readable_count as number,
                                      }
                                    : {}),
                                truncated: !!data.truncated,
                            });
                            continue;
                        }

                        if (data.type === "case_search") {
                            pushEvent({
                                type: "case_search",
                                query:
                                    typeof data.query === "string" &&
                                    data.query.trim()
                                        ? (data.query as string)
                                        : null,
                                count:
                                    typeof data.count === "number"
                                        ? (data.count as number)
                                        : 0,
                                ...(typeof data.error === "string" &&
                                data.error.trim()
                                    ? { error: data.error as string }
                                    : {}),
                            });
                            continue;
                        }

                        if (data.type === "image_generated") {
                            // A generated/edited image — pushEvent retires the
                            // "Creating image…" tool_call_start spinner and adds
                            // the inline GeneratedImageCard (fetched by doc id).
                            pushEvent({
                                type: "image_generated",
                                document_id: data.document_id as string,
                                filename: data.filename as string,
                                prompt:
                                    typeof data.prompt === "string"
                                        ? data.prompt
                                        : undefined,
                                kind:
                                    data.kind === "edit" ? "edit" : "generate",
                            });
                            continue;
                        }

                        if (data.type === "legal_proposal") {
                            // Non-modal: surface the suggestion while content
                            // keeps streaming. Confirming is handled by the
                            // caller (ChatView) via the gallery workflow-launch
                            // path; dismissing is a no-op that leaves the
                            // normal answer untouched.
                            const p = (data as { proposal?: LegalProposal })
                                .proposal;
                            if (p && typeof p.capabilityId === "string") {
                                setProposal(p);
                            }
                            continue;
                        }

                        if (data.type === "capability_result") {
                            // Persisted verbatim in the assistant message's
                            // content array by the backend, so pushing the
                            // frame through unchanged is exactly what a later
                            // reload (getChat) will render. Validation already
                            // happened at the tool boundary.
                            pushEvent(data as AssistantEvent);
                            continue;
                        }

                        if (data.type === "email_pending") {
                            // Approval-gated outbound email. Surfaced as an
                            // inline approval card in the message stream; the
                            // card itself calls approve/cancel. Send stays
                            // human-gated.
                            if (typeof data.email_id !== "string") continue;
                            pushEvent({
                                type: "email_pending",
                                email_id: data.email_id as string,
                                operation_id:
                                    typeof data.operation_id === "string"
                                        ? (data.operation_id as string)
                                        : null,
                                to: Array.isArray(data.to)
                                    ? (data.to as unknown[]).filter(
                                          (x): x is string =>
                                              typeof x === "string",
                                      )
                                    : [],
                                cc: Array.isArray(data.cc)
                                    ? (data.cc as unknown[]).filter(
                                          (x): x is string =>
                                              typeof x === "string",
                                      )
                                    : [],
                                subject:
                                    typeof data.subject === "string"
                                        ? (data.subject as string)
                                        : "",
                                body_preview:
                                    typeof data.body_preview === "string"
                                        ? (data.body_preview as string)
                                        : "",
                                attachments: Array.isArray(data.attachments)
                                    ? (data.attachments as Extract<
                                          AssistantEvent,
                                          { type: "email_pending" }
                                      >["attachments"])
                                    : [],
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "signature_pending") {
                            // Approval-gated e-signature envelope. Surfaced as
                            // an inline approval card; the card calls
                            // approve/cancel. Emailing signing links stays
                            // human-gated.
                            if (typeof data.envelope_id !== "string") continue;
                            pushEvent({
                                type: "signature_pending",
                                envelope_id: data.envelope_id as string,
                                operation_id:
                                    typeof data.operation_id === "string"
                                        ? (data.operation_id as string)
                                        : null,
                                document_id:
                                    typeof data.document_id === "string"
                                        ? (data.document_id as string)
                                        : "",
                                document_name:
                                    typeof data.document_name === "string"
                                        ? (data.document_name as string)
                                        : "",
                                subject:
                                    typeof data.subject === "string"
                                        ? (data.subject as string)
                                        : "",
                                signers: Array.isArray(data.signers)
                                    ? (data.signers as Extract<
                                          AssistantEvent,
                                          { type: "signature_pending" }
                                      >["signers"])
                                    : [],
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "legal_search") {
                            pushEvent({
                                type: "legal_search",
                                query: (data.query as string) ?? "",
                                providers: Array.isArray(data.providers)
                                    ? (data.providers as Extract<
                                          AssistantEvent,
                                          { type: "legal_search" }
                                      >["providers"])
                                    : [],
                                result_count:
                                    typeof data.result_count === "number"
                                        ? (data.result_count as number)
                                        : 0,
                                warnings: Array.isArray(data.warnings)
                                    ? (data.warnings as string[]).filter(
                                          (item) => typeof item === "string",
                                      )
                                    : [],
                                results: Array.isArray(data.results)
                                    ? (data.results as Extract<
                                          AssistantEvent,
                                          { type: "legal_search" }
                                      >["results"])
                                    : [],
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "operation_created") {
                            const operation =
                                data.operation &&
                                typeof data.operation === "object"
                                    ? (data.operation as Extract<
                                          AssistantEvent,
                                          { type: "operation_created" }
                                      >["operation"])
                                    : null;
                            if (!operation) continue;
                            pushEvent({
                                type: "operation_created",
                                operation,
                                filename:
                                    typeof data.filename === "string"
                                        ? (data.filename as string)
                                        : undefined,
                                document_id:
                                    typeof data.document_id === "string"
                                        ? (data.document_id as string)
                                        : undefined,
                                summary:
                                    typeof data.summary === "string"
                                        ? (data.summary as string)
                                        : undefined,
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "template_created") {
                            // A firm template was generated + persisted by the
                            // chat `generate_template` tool. Rendered inline as
                            // a "template created" affordance.
                            if (typeof data.template_id !== "string") continue;
                            pushEvent({
                                type: "template_created",
                                template_id: data.template_id as string,
                                title:
                                    typeof data.title === "string"
                                        ? (data.title as string)
                                        : "Untitled template",
                                doc_type:
                                    typeof data.doc_type === "string"
                                        ? (data.doc_type as string)
                                        : "",
                                version_number:
                                    typeof data.version_number === "number"
                                        ? (data.version_number as number)
                                        : 1,
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "draft_qa") {
                            // Defensive: the assembled-draft QA result is
                            // normally delivered via the approve response (the
                            // assemble operation's metadata), not the chat
                            // stream. Parse it anyway so a future server change
                            // that streams it renders without a client update.
                            pushEvent({
                                type: "draft_qa",
                                findings: Array.isArray(data.findings)
                                    ? (data.findings as Extract<
                                          AssistantEvent,
                                          { type: "draft_qa" }
                                      >["findings"])
                                    : [],
                                status:
                                    data.status === "advisory" ||
                                    data.status === "blocked"
                                        ? (data.status as
                                              | "advisory"
                                              | "blocked")
                                        : "passed",
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_highlighted_start") {
                            pushEvent({
                                type: "doc_highlighted",
                                highlight_set_id: "",
                                document_id:
                                    typeof data.document_id === "string"
                                        ? (data.document_id as string)
                                        : "",
                                version_id: null,
                                version_number: null,
                                filename: data.filename as string,
                                title:
                                    typeof data.title === "string"
                                        ? (data.title as string)
                                        : "Document highlights",
                                total: 0,
                                groups: [],
                                highlights: [],
                                failed_matches: [],
                                truncated: false,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_highlighted") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_highlighted" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_highlighted",
                                    highlight_set_id:
                                        (data.highlight_set_id as string) ?? "",
                                    document_id:
                                        (data.document_id as string) ?? "",
                                    version_id:
                                        typeof data.version_id === "string"
                                            ? (data.version_id as string)
                                            : null,
                                    version_number:
                                        typeof data.version_number === "number"
                                            ? (data.version_number as number)
                                            : null,
                                    filename: data.filename as string,
                                    title:
                                        (data.title as string) ??
                                        "Document highlights",
                                    total:
                                        typeof data.total === "number"
                                            ? (data.total as number)
                                            : 0,
                                    groups: Array.isArray(data.groups)
                                        ? (data.groups as Extract<
                                              AssistantEvent,
                                              { type: "doc_highlighted" }
                                          >["groups"])
                                        : [],
                                    highlights: Array.isArray(data.highlights)
                                        ? (data.highlights as Extract<
                                              AssistantEvent,
                                              { type: "doc_highlighted" }
                                          >["highlights"])
                                        : [],
                                    failed_matches: Array.isArray(
                                        data.failed_matches,
                                    )
                                        ? (data.failed_matches as Extract<
                                              AssistantEvent,
                                              { type: "doc_highlighted" }
                                          >["failed_matches"])
                                        : [],
                                    truncated: !!data.truncated,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_read_start") {
                            pushEvent({
                                type: "doc_read",
                                filename: data.filename as string,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_read") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_read" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({ ...e, isStreaming: false }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_find_start") {
                            pushEvent({
                                type: "doc_find",
                                filename: data.filename as string,
                                query: (data.query as string) ?? "",
                                total_matches: 0,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_find") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_find" &&
                                    e.filename === data.filename &&
                                    e.query === (data.query as string) &&
                                    !!e.isStreaming,
                                (e) => ({
                                    ...e,
                                    isStreaming: false,
                                    total_matches:
                                        typeof data.total_matches === "number"
                                            ? (data.total_matches as number)
                                            : (
                                                  e as {
                                                      type: "doc_find";
                                                      total_matches: number;
                                                  }
                                              ).total_matches,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_created_start") {
                            pushEvent({
                                type: "doc_created",
                                filename: data.filename as string,
                                download_url: "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_download") {
                            pushEvent({
                                type: "doc_download",
                                filename: data.filename as string,
                                download_url: data.download_url as string,
                            });
                            continue;
                        }

                        if (data.type === "doc_created") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_created" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => {
                                    const next: Extract<
                                        AssistantEvent,
                                        { type: "doc_created" }
                                    > = {
                                        type: "doc_created",
                                        filename: (e as { filename: string })
                                            .filename,
                                        download_url:
                                            data.download_url as string,
                                        isStreaming: false,
                                    };
                                    if (typeof data.document_id === "string") {
                                        next.document_id =
                                            data.document_id as string;
                                    }
                                    if (typeof data.version_id === "string") {
                                        next.version_id =
                                            data.version_id as string;
                                    }
                                    if (
                                        typeof data.version_number === "number"
                                    ) {
                                        next.version_number =
                                            data.version_number as number;
                                    }
                                    return next;
                                },
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_replicate_start") {
                            pushEvent({
                                type: "doc_replicated",
                                filename: data.filename as string,
                                count:
                                    typeof data.count === "number"
                                        ? (data.count as number)
                                        : 1,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_replicated") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_replicated" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_replicated",
                                    filename: data.filename as string,
                                    count:
                                        typeof data.count === "number"
                                            ? (data.count as number)
                                            : Array.isArray(data.copies)
                                              ? (data.copies as unknown[])
                                                    .length
                                              : 1,
                                    copies: Array.isArray(data.copies)
                                        ? (data.copies as {
                                              new_filename: string;
                                              document_id: string;
                                              version_id: string;
                                          }[])
                                        : undefined,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_edited_start") {
                            pushEvent({
                                type: "doc_edited",
                                filename: data.filename as string,
                                document_id: "",
                                version_id: "",
                                download_url: "",
                                annotations: [],
                                target:
                                    data.target &&
                                    typeof data.target === "object"
                                        ? (data.target as {
                                              document_id: string;
                                              version_id: string | null;
                                              version_number: number | null;
                                          })
                                        : undefined,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_edited") {
                            updateMatchingEvent(
                                (e) => {
                                    if (
                                        e.type !== "doc_edited" ||
                                        !e.isStreaming
                                    ) {
                                        return false;
                                    }
                                    if (
                                        e.target?.document_id &&
                                        typeof data.document_id === "string" &&
                                        data.document_id
                                    ) {
                                        return (
                                            e.target.document_id ===
                                            data.document_id
                                        );
                                    }
                                    return e.filename === data.filename;
                                },
                                () => normalizeDocEditedEvent(data),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "citations") {
                            // End-of-stream signal — scrub any lingering
                            // placeholders so they don't persist into the
                            // finalised message.
                            clearStreamingPlaceholders();
                            const incoming = (data.citations ??
                                []) as CocoLegalCitationAnnotation[];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        annotations: incoming,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }
                    } catch (e) {
                        console.warn(
                            "[useAssistantChat] failed to parse SSE line:",
                            trimmed,
                            e,
                        );
                    }
                }
            }

            // The stream is over, so no placeholder can still be bridging to
            // a next event. A normal turn is already scrubbed by the citations
            // handler, which the backend emits just before generation_finish —
            // this covers the paths where citations never arrives: a stream
            // truncated by a proxy or idle cutoff, and the error path below.
            // Runs before flushDrip so the final text write lands last.
            commitCanonicalStream();
            // Flush first so any streamed text survives, then hand the
            // backend error to the outer catch, which attaches it to the
            // last assistant message.
            if (streamError) throw streamError;

            const finalChatId = streamedChatId || chatId || null;
            const needsIntegrityRepair = committedIntegrity
                ? !(await assistantCommitMatches(
                      eventsRef.current,
                      committedIntegrity,
                  ))
                : false;
            const needsTerminalRecovery = assistantTerminalNeedsRecovery({
                sawGenerationFinish,
                sawDone,
                hasAssistantMessageId: streamedAssistantMessageId !== null,
                hasCommittedIntegrity: committedIntegrity !== null,
            });

            const streamSurface = projectId ? "matter" : "main";
            if (needsIntegrityRepair) {
                recordAssistantStreamMetric(
                    "integrity_mismatch",
                    streamSurface,
                );
            }
            if (needsTerminalRecovery) {
                recordAssistantStreamMetric("premature_eof", streamSurface);
            }

            if (needsIntegrityRepair || needsTerminalRecovery) {
                if (!finalChatId || !streamedAssistantMessageId) {
                    throw new Error(
                        "The response stream ended before its saved result could be verified. Please retry.",
                    );
                }

                let persisted: CocoLegalMessage | undefined;
                const attempts = needsTerminalRecovery ? 4 : 1;
                for (let attempt = 0; attempt < attempts; attempt++) {
                    const detail = await getChat(finalChatId);
                    persisted = detail.messages.find(
                        (candidate) =>
                            candidate.id === streamedAssistantMessageId &&
                            candidate.role === "assistant",
                    );
                    if (
                        persisted &&
                        TERMINAL_GENERATION_STATUSES.has(
                            persisted.generation_status ?? "",
                        )
                    ) {
                        break;
                    }
                    persisted = undefined;
                    if (attempt < attempts - 1) {
                        await waitForReconciliation(250 * 2 ** attempt);
                    }
                }

                if (!persisted) {
                    recordAssistantStreamMetric(
                        "reconciliation_failure",
                        streamSurface,
                    );
                    throw new Error(
                        "The response was interrupted before completion. Your saved partial response was preserved; please retry.",
                    );
                }

                eventsRef.current = persisted.events ?? [];
                dripTargetRef.current = persisted.content;
                dripDisplayLenRef.current = persisted.content.length;
                setMessages((prev) => {
                    const updated = [...prev];
                    for (let index = updated.length - 1; index >= 0; index--) {
                        const candidate = updated[index];
                        if (
                            candidate.role === "assistant" &&
                            (candidate.id === streamedAssistantMessageId ||
                                index === updated.length - 1)
                        ) {
                            updated[index] = persisted as CocoLegalMessage;
                            break;
                        }
                    }
                    return updated;
                });
                console.info("[assistant-stream-integrity] reconciled", {
                    reason: needsIntegrityRepair
                        ? "content_mismatch"
                        : "missing_terminal_event",
                    sawDone,
                });
                recordAssistantStreamMetric(
                    "reconciliation_success",
                    streamSurface,
                );
            }
            setIsResponseLoading(false);
            setIsLoadingCitations(false);

            if (finalChatId && finalChatId !== chatId) {
                if (chatId) {
                    replaceChatId(
                        chatId,
                        finalChatId,
                        message.content.trim().slice(0, 120) || "New Chat",
                    );
                }
                setCurrentChatId(finalChatId);
                const resolvedChatBasePath =
                    chatBasePath ??
                    (projectId
                        ? `/projects/${projectId}/assistant/chat`
                        : `/assistant/chat`);
                router.replace(`${resolvedChatBasePath}/${finalChatId}`);
            }

            await loadChats();

            const finalChatIdForTitle = streamedChatId || chatId || null;
            if (finalChatIdForTitle && newMessages.length === 1) {
                const titleParts = [message.content];
                if (message.workflow)
                    titleParts.push(`Workflow: ${message.workflow.title}`);
                if (message.files?.length)
                    titleParts.push(
                        `Files: ${message.files.map((f) => f.filename).join(", ")}`,
                    );
                void generateTitle(finalChatIdForTitle, titleParts.join("\n"));
            }

            return streamedChatId || null;
        } catch (error: unknown) {
            commitCanonicalStream();
            if (error instanceof Error && error.name === "AbortError") {
                // The server owns cancellation state. Keep any packet card and
                // partial output already received; reload/polling reconciles the
                // persisted cancelled/partial lifecycle.
                void loadChats();
            } else {
                stopDrip();
                const errorMessage =
                    error instanceof Error && error.message
                        ? error.message
                        : "Sorry, something went wrong.";
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        updated[updated.length - 1] = {
                            ...last,
                            error: errorMessage,
                        };
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            error: errorMessage,
                        },
                    ];
                });
            }

            setIsResponseLoading(false);
            setIsLoadingCitations(false);
            return null;
        } finally {
            abortControllerRef.current = null;
        }
    };

    const handleNewChat = async (
        message: CocoLegalMessage,
        projectId?: string,
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        setMessages([message]);
        setNewChatMessages([message]);

        const newChatId = await saveChat(projectId);
        if (newChatId) {
            setChatId(newChatId);
            setCurrentChatId(newChatId);
        }

        return newChatId;
    };

    /**
     * Commit a captured/uploaded recording into THIS conversation and surface the
     * durable card the backend inserts. This is the locked recordings UX (no
     * composer chip, no user-message ref): create the recording, then refresh the
     * message list so the `recording_card` shows immediately.
     *
     * Seam #1 (chat id): reuse the live `chatId` when the conversation already
     * exists; otherwise materialize one exactly the way the app does —
     * `saveChat` → `POST /chat/create` (also prepends it to the sidebar history).
     * A recording MUST ride a `chat_id` so the pipeline can post the card + the
     * later summary back onto this thread.
     *
     * Seam #2 (refresh): re-fetch the thread with `getChat` (now carrying the
     * card) and swap it in — `setMessages` in place when we're already on the
     * conversation, or hand it to the [id] page via `setNewChatMessages` + route
     * when we just materialized the chat from the zero-state composer (mirrors
     * `handleNewChat`, and avoids an empty-thread reload race on the new page).
     *
     * Throws on failure so the caller can surface it via the composer's existing
     * error affordance (recorder onComplete rejections are otherwise unhandled).
     */
    const commitRecording = async (input: {
        blob: Blob;
        filename: string;
        source: "mic" | "upload";
        durationSeconds?: number;
    }): Promise<void> => {
        const existingChatId = chatId;
        let targetChatId = existingChatId ?? null;
        if (!targetChatId) {
            targetChatId = await saveChat(projectId);
            if (!targetChatId) {
                throw new Error(
                    "Couldn't start a conversation for this recording.",
                );
            }
            setChatId(targetChatId);
            setCurrentChatId(targetChatId);
        }

        await createRecording({
            file: input.blob,
            filename: input.filename,
            source: input.source,
            consent: true,
            chatId: targetChatId,
            projectId,
            durationSeconds: input.durationSeconds,
        });

        const { messages: reloaded } = await getChat(targetChatId);

        if (existingChatId) {
            // Already on this conversation (ChatView mounted): replace the
            // rendered list in place so the card appears without navigating.
            setMessages(reloaded);
            void loadChats();
            return;
        }

        // Zero-state composer (InitialView): seed the [id] page with the loaded
        // thread and route to it, so the card lands without a getChat race.
        setNewChatMessages(reloaded);
        void loadChats();
        const resolvedChatBasePath =
            chatBasePath ??
            (projectId
                ? `/projects/${projectId}/assistant/chat`
                : `/assistant/chat`);
        router.replace(`${resolvedChatBasePath}/${targetChatId}`);
    };

    return {
        messages,
        isResponseLoading,
        setIsResponseLoading,
        isLoadingCitations,
        handleChat,
        handleNewChat,
        commitRecording,
        setMessages,
        cancel,
        chatId,
        proposal,
        dismissProposal,
    };
}
