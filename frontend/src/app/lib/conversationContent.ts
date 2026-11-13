import type { AssistantEvent } from "@/app/components/shared/types";

/** One extractor for live streaming, reload mapping, and request state. */
export function assistantContentFromEvents(
    events: AssistantEvent[] | null | undefined,
): string {
    return (events ?? [])
        .filter(
            (event): event is Extract<AssistantEvent, { type: "content" }> =>
                event.type === "content",
        )
        .map((event) => event.text)
        .join("");
}

export function synchronizeAssistantContent<
    T extends { content: string; events?: AssistantEvent[] },
>(message: T, events: AssistantEvent[]): T {
    return {
        ...message,
        events,
        content: assistantContentFromEvents(events),
    };
}
