import assert from "node:assert/strict";
import {
    DEFAULT_MAIN_MODEL,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
    FEATURED_MODELS,
    capabilitiesForModel,
    providerForModel,
    resolveModel,
} from "./models";
import { OPENROUTER_FALLBACK_CAPABILITIES } from "./openrouterCatalog";

// The older ids stay registered on purpose: document_generation_jobs rows
// store a free-form model_id, and the worker calls capabilitiesForModel on it
// at execution time. Deregistering an id would throw mid-job for anything
// already queued, so this registry is append-only.
for (const model of [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
]) {
    assert.equal(capabilitiesForModel(model).maxOutputTokens, 128_000, model);
}
for (const model of [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4-mini",
]) {
    assert.equal(capabilitiesForModel(model).maxOutputTokens, 128_000, model);
}
assert.equal(capabilitiesForModel("claude-sonnet-5").inputTokens, 1_000_000);
assert.equal(capabilitiesForModel("gpt-5.6-sol").inputTokens, 1_050_000);

// Product runtime defaults (CLAUDE.md model policy).
assert.equal(DEFAULT_MAIN_MODEL, "claude-sonnet-5");
assert.equal(DEFAULT_TITLE_MODEL, "claude-sonnet-5");
assert.equal(DEFAULT_TABULAR_MODEL, "claude-sonnet-5");

// Newly registered ids must survive validation; unknown ones fall back.
assert.equal(resolveModel("claude-sonnet-5", "fallback"), "claude-sonnet-5");
assert.equal(resolveModel("gpt-5.6-terra", "fallback"), "gpt-5.6-terra");
assert.equal(resolveModel("not-a-model", "fallback"), "fallback");
for (const model of ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]) {
    assert.equal(capabilitiesForModel(model).maxOutputTokens, 65_536, model);
}
assert.throws(() => capabilitiesForModel("unknown-model"), /capabilit/i);

// --- provider inference ----------------------------------------------------
assert.equal(providerForModel("claude-sonnet-5"), "claude");
assert.equal(providerForModel("gemini-3-flash-preview"), "gemini");
assert.equal(providerForModel("gpt-5.6-terra"), "openai");
// Any vendor-namespaced id routes to OpenRouter. Native ids never contain a
// slash, so this check runs first without shadowing them.
assert.equal(providerForModel("anthropic/claude-sonnet-5"), "openrouter");
assert.equal(providerForModel("meta-llama/llama-4-maverick"), "openrouter");
assert.equal(providerForModel("x-ai/grok-4"), "openrouter");
assert.throws(() => providerForModel("not-a-model"), /Unknown model id/);

// --- capabilities for OpenRouter ids ---------------------------------------
// A slash-namespaced id must resolve rather than throw: document_generation_
// jobs rows persist model_id and the worker clamps against it mid-job.
assert.deepEqual(
    capabilitiesForModel("vendor/some-model"),
    OPENROUTER_FALLBACK_CAPABILITIES,
);

// --- validation -------------------------------------------------------------
// With a cold catalog, slash ids are accepted permissively.
assert.equal(
    resolveModel("anthropic/claude-sonnet-5", "fallback"),
    "anthropic/claude-sonnet-5",
);
assert.equal(resolveModel("still-not-a-model", "fallback"), "fallback");

// --- featured list ----------------------------------------------------------
assert.ok(FEATURED_MODELS.length > 0);
for (const entry of FEATURED_MODELS) {
    assert.equal(
        resolveModel(entry.id, ""),
        entry.id,
        `featured model ${entry.id} must be registered`,
    );
    assert.ok(entry.label && entry.group, `featured ${entry.id} needs metadata`);
}

console.log("llm/models.test.ts: all passed");
