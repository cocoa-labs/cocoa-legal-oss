import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "@/app/lib/cocoLegalApi";

export type ModelProvider = "claude" | "gemini" | "openai" | "openrouter";

// Auto-switch target when the selected model's provider has no key. Two
// sibling lists on the backend serve different purposes and are deliberately
// separate: MAIN_MODEL_FALLBACK_ORDER (lib/llm/models.ts) and
// mainChatRuntimeCandidates (lib/chatTools.ts). Update all three together.
const PREFERRED_AVAILABLE_MODELS = [
    "claude-sonnet-5",
    "gpt-5.4-mini",
    "gemini-3-flash-preview",
] as const;

export function getModelProvider(modelId: string): ModelProvider | null {
    // OpenRouter addresses models as `vendor/model`; no native id has a slash.
    if (modelId.includes("/")) return "openrouter";
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, apiKeys);
}

/**
 * @param inputModalities catalog-reported modalities, available for OpenRouter
 * models via useModelsCatalog. Native models keep the previous behavior of
 * treating every registered model as vision-capable.
 */
export function isModelVisionCapable(
    modelId: string,
    inputModalities?: string[],
): boolean {
    if (modelId.includes("/")) {
        return inputModalities?.includes("image") ?? false;
    }
    return MODELS.some((model) => model.id === modelId);
}

export function getFirstAvailableModel(apiKeys: ApiKeyState): string | null {
    const preferred = PREFERRED_AVAILABLE_MODELS.find((modelId) =>
        isModelAvailable(modelId, apiKeys),
    );
    if (preferred) return preferred;

    return MODELS.find((model) => isModelAvailable(model.id, apiKeys))?.id ?? null;
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    return !!apiKeys[provider]?.configured;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    if (provider === "openrouter") return "OpenRouter";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    return "gemini";
}
