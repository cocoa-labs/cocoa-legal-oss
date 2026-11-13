import assert from "node:assert/strict";

import type { AssistantEvent } from "@/app/components/shared/types";
import {
    appendAssistantContentDelta,
    assistantContentDisplaySnapshot,
    finalizeAssistantContent,
    finalizeAssistantStreamEvents,
} from "./assistantStreamAccumulator";
import {
    assistantCommitMatches,
    assistantTerminalNeedsRecovery,
} from "./assistantResponseIntegrity";

{
    const appended = appendAssistantContentDelta([], "Entire answer");
    const beforeFirstAnimationTick = assistantContentDisplaySnapshot(
        appended.events,
        "",
        true,
    );
    const finalized = finalizeAssistantContent(appended.events);

    assert.equal(beforeFirstAnimationTick[0].type, "content");
    assert.equal(
        beforeFirstAnimationTick[0].type === "content"
            ? beforeFirstAnimationTick[0].text
            : null,
        "",
    );
    assert.deepEqual(finalized, [{ type: "content", text: "Entire answer" }]);
}

{
    const finalized = finalizeAssistantStreamEvents([
        { type: "thinking", isStreaming: true },
        { type: "reasoning", text: "Complete reasoning", isStreaming: true },
        {
            type: "tool_input_progress",
            name: "",
            total_chars: 0,
            elapsed_ms: 1,
            isStreaming: true,
        },
        { type: "content", text: "Complete answer", isStreaming: true },
    ]);
    assert.deepEqual(finalized, [
        { type: "reasoning", text: "Complete reasoning" },
        { type: "content", text: "Complete answer" },
    ]);
}

{
    let events: AssistantEvent[] = [];
    events = appendAssistantContentDelta(events, "First ").events;
    events = appendAssistantContentDelta(events, "block").events;
    events = finalizeAssistantContent(events);
    events.push({ type: "reasoning", text: "Checked source" });
    events = appendAssistantContentDelta(events, "Final answer").events;
    events = finalizeAssistantContent(events);

    assert.deepEqual(events, [
        { type: "content", text: "First block" },
        { type: "reasoning", text: "Checked source" },
        { type: "content", text: "Final answer" },
    ]);
}

assert.equal(
    assistantTerminalNeedsRecovery({
        sawGenerationFinish: false,
        sawDone: false,
        hasAssistantMessageId: true,
        hasCommittedIntegrity: false,
    }),
    true,
);
assert.equal(
    assistantTerminalNeedsRecovery({
        sawGenerationFinish: true,
        sawDone: false,
        hasAssistantMessageId: true,
        hasCommittedIntegrity: true,
    }),
    true,
);
assert.equal(
    assistantTerminalNeedsRecovery({
        sawGenerationFinish: true,
        sawDone: true,
        hasAssistantMessageId: true,
        hasCommittedIntegrity: true,
    }),
    false,
);

console.log("assistantStreamAccumulator tests passed");

async function testIntegrity() {
    const text = "Byte-identical café response";
    const digest = Array.from(
        new Uint8Array(
            await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(text),
            ),
        ),
    )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    assert.equal(
        await assistantCommitMatches([{ type: "content", text }], {
            assistantMessageId: "message-1",
            requestedModelId: "requested",
            finalModelId: "final",
            visibleTextUtf8Bytes: new TextEncoder().encode(text).byteLength,
            visibleTextSha256: digest,
        }),
        true,
    );
    assert.equal(
        await assistantCommitMatches([{ type: "content", text: `${text}!` }], {
            assistantMessageId: "message-1",
            requestedModelId: "requested",
            finalModelId: "final",
            visibleTextUtf8Bytes: new TextEncoder().encode(text).byteLength,
            visibleTextSha256: digest,
        }),
        false,
    );
}

void testIntegrity()
    .then(() => console.log("assistant response integrity tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
