import type { AssistantEvent } from "@/app/components/shared/types";
import { assistantContentFromEvents } from "@/app/lib/conversationContent";

export type AssistantCommitIntegrity = {
    assistantMessageId: string;
    requestedModelId: string;
    finalModelId: string;
    visibleTextUtf8Bytes: number;
    visibleTextSha256: string;
};

export async function assistantResponseIntegrity(
    events: AssistantEvent[] | null | undefined,
): Promise<{ visibleTextUtf8Bytes: number; visibleTextSha256: string }> {
    const bytes = new TextEncoder().encode(assistantContentFromEvents(events));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const visibleTextSha256 = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
        visibleTextUtf8Bytes: bytes.byteLength,
        visibleTextSha256,
    };
}

export async function assistantCommitMatches(
    events: AssistantEvent[] | null | undefined,
    committed: AssistantCommitIntegrity,
): Promise<boolean> {
    const local = await assistantResponseIntegrity(events);
    return (
        local.visibleTextUtf8Bytes === committed.visibleTextUtf8Bytes &&
        local.visibleTextSha256 === committed.visibleTextSha256
    );
}

export function assistantTerminalNeedsRecovery(input: {
    sawGenerationFinish: boolean;
    sawDone: boolean;
    hasAssistantMessageId: boolean;
    hasCommittedIntegrity: boolean;
}): boolean {
    if (!input.sawGenerationFinish) return true;
    return (
        input.hasAssistantMessageId &&
        (!input.sawDone || !input.hasCommittedIntegrity)
    );
}
