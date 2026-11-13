import assert from "node:assert/strict";
import { claudeThinkingConfig } from "./claude";

// When the caller opts in, every model gets adaptive thinking plus high effort.
// This is the exact shape Claude 4.x+ requires (no fixed token budget).
for (const model of [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-4-6",
]) {
    assert.deepEqual(
        claudeThinkingConfig(model, true),
        {
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
        },
        `${model} should request adaptive thinking when enabled`,
    );
}

// 5-family models run adaptive thinking BY DEFAULT when `thinking` is omitted,
// and max_tokens then caps thinking+text together — which would truncate
// small-budget calls (title generation runs at 64 tokens). Disable explicitly.
for (const model of ["claude-sonnet-5", "claude-opus-5"]) {
    assert.deepEqual(
        claudeThinkingConfig(model, false),
        { thinking: { type: "disabled" } },
        `${model} should disable thinking explicitly when not requested`,
    );
}

// Fable 5 rejects an explicit `thinking: {type: "disabled"}` with a 400 —
// thinking is always on. Send no thinking field at all.
assert.deepEqual(
    claudeThinkingConfig("claude-fable-5", false),
    {},
    "claude-fable-5 must omit the thinking field entirely",
);

// 4.x and older ignore the concern: omitting `thinking` means no thinking.
// Keep their requests byte-identical to avoid any behavior change.
for (const model of [
    "claude-sonnet-4-6",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-haiku-4-5",
]) {
    assert.deepEqual(
        claudeThinkingConfig(model, false),
        {},
        `${model} request shape must be unchanged`,
    );
}

console.log("llm/claude.test.ts: all passed");
