import type { Provider, UserApiKeys } from "./types";
import {
    isOpenRouterModelAllowed,
    openrouterCapabilities,
} from "./openrouterCatalog";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// These lists are append-only. Superseded ids stay registered because
// document_generation_jobs rows persist a free-form model_id and the worker
// resolves it through capabilitiesForModel() at execution time — removing an
// id would throw mid-job for anything already queued.
//
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4-mini",
] as const;

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-5", "claude-sonnet-4-6"] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.6-terra", "gpt-5.4-mini"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings. `[0]` is consumed by resolveTitleModel().
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.6-luna", "gpt-5.4-nano"] as const;

// Project directive: the product runtime default is claude-sonnet-5
// (cost-effective) for all server-side LLM applications — main, title, and
// tabular. See CLAUDE.md at the repo root for the policy. Opus 5, Fable 5, and
// the other tiers remain selectable for users who explicitly opt in via
// account settings / the client picker.
export const DEFAULT_MAIN_MODEL = "claude-sonnet-5";
export const DEFAULT_TITLE_MODEL = "claude-sonnet-5";
export const DEFAULT_TABULAR_MODEL = "claude-sonnet-5";

// Key-availability fallback, walked before a request is ever sent. Two sibling
// lists serve different purposes and are deliberately not derived from this
// one: mainChatRuntimeCandidates (lib/chatTools.ts) retries after a runtime
// failure, and PREFERRED_AVAILABLE_MODELS (frontend lib/modelAvailability.ts)
// picks the client's auto-switch target. Update all three together.
const MAIN_MODEL_FALLBACK_ORDER = [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-sonnet-4-6",
    "gpt-5.6-terra",
    "gpt-5.4-mini",
    "gemini-3-flash-preview",
] as const;

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

// The natively-supported models surfaced as the picker's top section, ahead of
// the OpenRouter catalog. Mirrored by MODELS in the client's ModelToggle.tsx,
// which serves as its offline fallback — keep the two in sync.
export const FEATURED_MODELS: {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI";
}[] = [
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "OpenAI" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", group: "OpenAI" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", group: "OpenAI" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
];

export type ModelCapabilities = {
    inputTokens: number;
    maxOutputTokens: number;
};

// Provider-published synchronous API ceilings. Keeping these beside the
// canonical model registry prevents the adapters from drifting back to one
// undersized global constant. `maxOutputTokens` is a ceiling, not a requested
// spend: providers charge only for tokens actually generated.
// Sonnet 5 and the rest of the 5 family tokenize the same text into roughly
// 30% more tokens than the 4.x models did — budget input accordingly when
// comparing usage across generations.
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
    "claude-fable-5": { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
    "claude-opus-5": { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
    "claude-sonnet-5": { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
    "claude-opus-4-8": { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
    "claude-opus-4-7": { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
    "claude-sonnet-4-6": { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
    "claude-haiku-4-5": { inputTokens: 200_000, maxOutputTokens: 64_000 },
    "gemini-3.1-pro-preview": {
        inputTokens: 1_048_576,
        maxOutputTokens: 65_536,
    },
    "gemini-3-flash-preview": {
        inputTokens: 1_048_576,
        maxOutputTokens: 65_536,
    },
    "gemini-3.1-flash-lite-preview": {
        inputTokens: 1_048_576,
        maxOutputTokens: 65_536,
    },
    "gpt-5.6-sol": { inputTokens: 1_050_000, maxOutputTokens: 128_000 },
    "gpt-5.6-terra": { inputTokens: 1_050_000, maxOutputTokens: 128_000 },
    "gpt-5.6-luna": { inputTokens: 1_050_000, maxOutputTokens: 128_000 },
    "gpt-5.5": { inputTokens: 1_050_000, maxOutputTokens: 128_000 },
    "gpt-5.4-mini": { inputTokens: 400_000, maxOutputTokens: 128_000 },
    "gpt-5.4-nano": { inputTokens: 400_000, maxOutputTokens: 128_000 },
};

export function capabilitiesForModel(model: string): ModelCapabilities {
    // OpenRouter ids are catalog-driven rather than hand-registered. This
    // lookup is synchronous and falls back to conservative ceilings when the
    // catalog is cold, so hot paths — including the document-generation worker
    // clamping against a persisted model_id — never throw or await here.
    if (isOpenRouterModelId(model)) return openrouterCapabilities(model);
    const found = MODEL_CAPABILITIES[model];
    if (!found) throw new Error(`No capability metadata for model: ${model}`);
    return found;
}

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

/**
 * OpenRouter addresses models as `vendor/model`. No natively registered id
 * contains a slash, so the shape alone is an unambiguous discriminator.
 */
export function isOpenRouterModelId(model: string): boolean {
    return model.includes("/");
}

export function providerForModel(model: string): Provider {
    if (isOpenRouterModelId(model)) return "openrouter";
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(
    id: string | null | undefined,
    fallback: string,
): string {
    if (!id) return fallback;
    if (ALL_MODELS.has(id)) return id;
    if (isOpenRouterModelId(id) && isOpenRouterModelAllowed(id)) return id;
    return fallback;
}

function hasProviderKey(provider: Provider, apiKeys?: UserApiKeys): boolean {
    if (!apiKeys) return true;
    return !!apiKeys[provider]?.trim();
}

export function resolveAvailableMainModel(
    id: string | null | undefined,
    apiKeys?: UserApiKeys,
): string {
    const selected = resolveModel(id, DEFAULT_MAIN_MODEL);
    if (hasProviderKey(providerForModel(selected), apiKeys)) return selected;

    return (
        MAIN_MODEL_FALLBACK_ORDER.find((candidate) =>
            hasProviderKey(providerForModel(candidate), apiKeys),
        ) ?? selected
    );
}
