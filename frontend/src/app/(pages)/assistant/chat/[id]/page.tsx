"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { ChatView } from "@/app/components/assistant/ChatView";
import { getChat, getEmail } from "@/app/lib/cocoLegalApi";
import type {
    AssistantEvent,
    CocoLegalMessage,
} from "@/app/components/shared/types";

type EmailReceivedEvent = Extract<AssistantEvent, { type: "email_received" }>;

/**
 * True when the conversation already holds a reply draft for THIS specific
 * inbound — so we don't auto-draft a duplicate on re-click/reload. Scoped to the
 * inbound id on purpose: a conversation that merely *sent* an earlier email has a
 * `send_email` draft, which must NOT count as "already replied to this reply".
 *   - a reply draft persists as an `email_pending` event carrying
 *     in_reply_to_email_id === this inbound's id (reply_to_email);
 *   - ingest-time auto-draft also surfaces an `email_received` card with this id;
 *   - legacy reply drafts persisted as an `operation_created` (reply_to_email)
 *     whose arguments.in_reply_to_email_id is this id.
 */
function hasReplyDraftFor(
    messages: CocoLegalMessage[],
    inboundId: string,
): boolean {
    return messages.some((m) =>
        (m.events ?? []).some(
            (e) =>
                (e.type === "email_pending" &&
                    e.in_reply_to_email_id === inboundId) ||
                (e.type === "email_received" && e.email_id === inboundId) ||
                (e.type === "operation_created" &&
                    e.operation.tool_name === "reply_to_email" &&
                    e.operation.arguments?.in_reply_to_email_id === inboundId),
        ),
    );
}

const AUTO_DRAFT_SEED =
    "A reply just came in on this thread — please read it and draft a response for my review.";

function AssistantChatPageInner() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const id = params.id as string;
    const inboundId = searchParams.get("inbound");

    const { setCurrentChatId, newChatMessages, setNewChatMessages } =
        useChatHistoryContext();

    const initialMessages = newChatMessages ?? [];
    const {
        messages,
        isResponseLoading,
        handleChat,
        setMessages,
        commitRecording,
        cancel,
        proposal,
        dismissProposal,
    } = useAssistantChat({ initialMessages, chatId: id });

    const hasAutoSent = useRef(false);
    const hasLoaded = useRef(false);
    const hasAutoDraftedRef = useRef(false);

    // The inbound reply the user clicked to get here — shown as a context banner
    // above the composer so they can see what Quill is replying to. Stored
    // TAGGED with the ?inbound id it was fetched for (plus a dismissed flag);
    // the banner itself is derived below, so "?inbound went away" needs no
    // state reset at all — it simply stops matching.
    const [inboundEmail, setInboundEmail] = useState<{
        id: string;
        dismissed: boolean;
        event: EmailReceivedEvent;
    } | null>(null);

    useEffect(() => {
        setCurrentChatId(id);
    }, [id, setCurrentChatId]);

    useEffect(() => {
        if (initialMessages.length > 0) {
            if (newChatMessages) setNewChatMessages(null);
            return;
        }
        if (hasLoaded.current || messages.length > 0) return;
        hasLoaded.current = true;

        getChat(id)
            .then(({ messages: loaded }) => {
                if (loaded.length > 0) {
                    setMessages(loaded);
                } else {
                    router.replace("/assistant");
                }
            })
            .catch(() => router.replace("/assistant"));
    }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

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
            void handleChat(newChatMessages[0]);
        }
    }, [newChatMessages, messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fetch the clicked inbound reply for the context banner. The effect only
    // talks to the external system (the API); every setState here runs in an
    // async resolution callback, never synchronously in the effect body.
    useEffect(() => {
        if (!inboundId) return;
        let cancelled = false;
        getEmail(inboundId)
            .then(({ email }) => {
                if (cancelled) return;
                setInboundEmail({
                    id: inboundId,
                    dismissed: false,
                    event: {
                        type: "email_received",
                        email_id: email.id,
                        from_address: email.from_address,
                        subject: email.subject,
                        body_preview:
                            email.body_preview ??
                            (email.body_text
                                ? email.body_text.slice(0, 400)
                                : null),
                        received_at: email.received_at,
                        attachments: email.attachments ?? [],
                    },
                });
            })
            .catch(() => {
                /* banner is best-effort; ignore */
            });
        return () => {
            cancelled = true;
        };
    }, [inboundId]);

    // Derived: show the fetched banner only while it matches the CURRENT
    // ?inbound id and hasn't been dismissed. A stale fetch (id changed) or a
    // cleared query param yields null with no reset effect needed.
    const inboundContext =
        inboundId !== null &&
        inboundEmail !== null &&
        inboundEmail.id === inboundId &&
        !inboundEmail.dismissed
            ? inboundEmail.event
            : null;

    // Auto-draft on arrival: when the user arrives from the inbox (?inbound), ask
    // Quill once to draft a reply — unless a reply to THIS inbound already exists.
    // Guards: a per-mount ref + a precise scan (the accurate "does a reply to this
    // inbound already exist?" signal); enrichWithPriorEvents also tells the model
    // not to re-draft a pending reply, as a final backstop. (No sessionStorage —
    // the precise scan is the real idempotency signal, and it allows a retry if a
    // draft fails to be created.)
    useEffect(() => {
        if (!inboundId) return;
        if (newChatMessages) return; // don't collide with the InitialView path
        if (messages.length === 0) return; // wait for the conversation to load
        if (isResponseLoading) return;
        if (hasAutoDraftedRef.current) return;

        if (hasReplyDraftFor(messages, inboundId)) {
            hasAutoDraftedRef.current = true;
            return;
        }

        hasAutoDraftedRef.current = true;
        void handleChat({ role: "user", content: AUTO_DRAFT_SEED });
    }, [inboundId, messages.length, newChatMessages, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <ChatView
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            chatId={id}
            proposal={proposal}
            onDismissProposal={dismissProposal}
            onRecordAudio={commitRecording}
            inboundContext={inboundContext}
            onDismissInbound={() =>
                setInboundEmail((prev) =>
                    prev ? { ...prev, dismissed: true } : prev,
                )
            }
        />
    );
}

export default function AssistantChatPage() {
    return (
        <Suspense fallback={null}>
            <AssistantChatPageInner />
        </Suspense>
    );
}
