import type { AssistantEvent } from "@/app/components/shared/types";

export function lastAssistantContentIndex(events: AssistantEvent[]): number {
    for (let index = events.length - 1; index >= 0; index--) {
        if (events[index].type === "content") return index;
    }
    return -1;
}

/**
 * Append provider prose to the canonical event log. This log always contains
 * every byte received; typing animation must only ever operate on a derived
 * display snapshot.
 */
export function appendAssistantContentDelta(
    events: AssistantEvent[],
    delta: string,
): { events: AssistantEvent[]; blockText: string; startedBlock: boolean } {
    const last = events[events.length - 1];
    if (last?.type === "content" && last.isStreaming) {
        const blockText = last.text + delta;
        return {
            events: [
                ...events.slice(0, -1),
                { type: "content", text: blockText, isStreaming: true },
            ],
            blockText,
            startedBlock: false,
        };
    }

    return {
        events: [
            ...events,
            { type: "content", text: delta, isStreaming: true },
        ],
        blockText: delta,
        startedBlock: true,
    };
}

/** Finalize the last canonical content block without changing its text. */
export function finalizeAssistantContent(
    events: AssistantEvent[],
): AssistantEvent[] {
    const last = events[events.length - 1];
    if (last?.type !== "content" || !last.isStreaming) return events;
    return [...events.slice(0, -1), { type: "content", text: last.text }];
}

/**
 * Produce the terminal canonical event log in one pass. Transient activity
 * placeholders are never persisted as completed work, while streamed prose
 * and reasoning retain their complete text with presentation flags removed.
 */
export function finalizeAssistantStreamEvents(
    events: AssistantEvent[],
): AssistantEvent[] {
    return events
        .filter(
            (event) =>
                !(
                    (event.type === "tool_call_start" ||
                        event.type === "tool_input_progress" ||
                        event.type === "thinking") &&
                    event.isStreaming
                ),
        )
        .map((event) => {
            if (event.type === "content" && event.isStreaming) {
                return { type: "content" as const, text: event.text };
            }
            if (event.type === "reasoning" && event.isStreaming) {
                return { type: "reasoning" as const, text: event.text };
            }
            return event;
        });
}

/**
 * Create presentation state for the typing effect. The canonical event array
 * is never mutated or shortened by this function.
 */
export function assistantContentDisplaySnapshot(
    canonicalEvents: AssistantEvent[],
    visibleText: string,
    isStreaming: boolean,
): AssistantEvent[] {
    const index = lastAssistantContentIndex(canonicalEvents);
    if (index < 0) return canonicalEvents;
    const snapshot = [...canonicalEvents];
    snapshot[index] = isStreaming
        ? { type: "content", text: visibleText, isStreaming: true }
        : { type: "content", text: visibleText };
    return snapshot;
}
