"use client";

import { useRouter } from "next/navigation";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { InitialView } from "@/app/components/assistant/InitialView";
import { ChatView } from "@/app/components/assistant/ChatView";
import type { CocoLegalMessage } from "@/app/components/shared/types";

export default function AssistantPage() {
    const router = useRouter();
    const {
        messages,
        isResponseLoading,
        handleChat,
        handleNewChat,
        commitRecording,
        cancel,
        chatId,
        proposal,
        dismissProposal,
    } = useAssistantChat();

    async function handleInitialSubmit(message: CocoLegalMessage) {
        const newChatId = await handleNewChat(message);
        if (newChatId) router.push(`/assistant/chat/${newChatId}`);
    }

    if (messages.length === 0) {
        return (
            <InitialView
                onSubmit={(message) => void handleInitialSubmit(message)}
                onRecordAudio={commitRecording}
            />
        );
    }

    return (
        <ChatView
            messages={messages}
            isResponseLoading={isResponseLoading}
            handleChat={handleChat}
            cancel={cancel}
            chatId={chatId ?? null}
            proposal={proposal}
            onDismissProposal={dismissProposal}
            onRecordAudio={commitRecording}
        />
    );
}
