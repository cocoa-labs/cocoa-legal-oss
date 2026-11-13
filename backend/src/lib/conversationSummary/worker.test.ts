import assert from "node:assert/strict";
import { compactConversationSummaryEntries } from "./worker";

const entries = Array.from({ length: 100 }, (_, entryIndex) => ({
    text: `entry ${entryIndex} ${"x".repeat(600)}`,
    source_message_ids: Array.from(
        { length: 30 },
        (_, sourceIndex) => `message-${entryIndex}-${sourceIndex}`,
    ),
}));

const compacted = compactConversationSummaryEntries(entries);
assert.ok(compacted.length <= 64);
assert.ok(compacted.every((entry) => entry.text.length <= 501));
assert.ok(
    compacted.every((entry) => entry.source_message_ids.length <= 12),
);
assert.match(compacted[0]?.text ?? "", /Earlier episodes/);

console.log("conversationSummary/worker.test.ts: all passed");
