import type { ModelCapabilities } from "./models";

// OpenRouter's model catalog, cached in memory.
//
// The catalog is what makes the picker self-updating: rather than hardcoding a
// model list that goes stale every release cycle, we serve whatever OpenRouter
// currently routes to. It is a soft dependency — every native provider path
// keeps working when this is cold, stale, or unreachable.

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1h — the catalog changes slowly.
const FAILURE_COOLDOWN_MS = 60 * 1000; // don't hammer a provider that is down
const FETCH_TIMEOUT_MS = 10_000;

// Conservative ceilings used when the catalog has not loaded yet. Every model
// OpenRouter routes to clears these, and the adapter's continuation loop
// covers outputs that need more room than the 8K floor.
export const OPENROUTER_FALLBACK_CAPABILITIES: ModelCapabilities = {
    inputTokens: 131_072,
    maxOutputTokens: 8_192,
};

// Ceiling derived for a model whose provider does not publish
// max_completion_tokens.
const DERIVED_MAX_OUTPUT_CEILING = 16_384;

export type OpenRouterModelInfo = {
    id: string;
    name: string;
    contextLength: number;
    maxCompletionTokens: number | null;
    pricing: { prompt: string; completion: string };
    inputModalities: string[];
    supportsTools: boolean;
};

type CatalogState = {
    byId: Map<string, OpenRouterModelInfo>;
    ordered: OpenRouterModelInfo[];
    fetchedAt: number;
};

let cache: CatalogState | null = null;
let inFlight: Promise<CatalogState | null> | null = null;
let cooldownUntil = 0;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let nowImpl: () => number = () => Date.now();

/** Test seam — resets the cache and swaps the fetch/clock implementations. */
export function __resetCatalogForTests(overrides?: {
    fetchFn?: typeof fetch;
    nowFn?: () => number;
}): void {
    cache = null;
    inFlight = null;
    cooldownUntil = 0;
    fetchImpl = overrides?.fetchFn ?? ((...args) => fetch(...args));
    nowImpl = overrides?.nowFn ?? (() => Date.now());
}

function parseEntry(raw: unknown): OpenRouterModelInfo | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, any>;
    const id = typeof r.id === "string" ? r.id : "";
    const contextLength =
        typeof r.context_length === "number" ? r.context_length : 0;
    // Both are required to be useful: the id addresses the model and the
    // context length backs the token clamp.
    if (!id || !contextLength) return null;

    const maxCompletion = r.top_provider?.max_completion_tokens;
    const supported: unknown = r.supported_parameters;

    return {
        id,
        name: typeof r.name === "string" && r.name ? r.name : id,
        contextLength,
        maxCompletionTokens:
            typeof maxCompletion === "number" ? maxCompletion : null,
        pricing: {
            prompt: String(r.pricing?.prompt ?? "0"),
            completion: String(r.pricing?.completion ?? "0"),
        },
        inputModalities: Array.isArray(r.architecture?.input_modalities)
            ? r.architecture.input_modalities.filter(
                  (m: unknown): m is string => typeof m === "string",
              )
            : ["text"],
        supportsTools: Array.isArray(supported)
            ? supported.includes("tools")
            : false,
    };
}

async function fetchCatalog(): Promise<CatalogState | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const key = process.env.OPENROUTER_API_KEY?.trim();
        const resp = await fetchImpl(MODELS_URL, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                // The catalog is public; the key is sent only so requests are
                // attributed when one is configured.
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const body = (await resp.json()) as { data?: unknown[] };
        const ordered = (body?.data ?? [])
            .map(parseEntry)
            .filter((m): m is OpenRouterModelInfo => m !== null);
        const state: CatalogState = {
            byId: new Map(ordered.map((m) => [m.id, m])),
            ordered,
            fetchedAt: nowImpl(),
        };
        cache = state;
        cooldownUntil = 0;
        return state;
    } catch (err) {
        cooldownUntil = nowImpl() + FAILURE_COOLDOWN_MS;
        console.warn(
            "[openrouter-catalog] refresh failed:",
            (err as Error)?.message ?? err,
        );
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function refreshOnce(): Promise<CatalogState | null> {
    if (inFlight) return inFlight;
    inFlight = fetchCatalog().finally(() => {
        inFlight = null;
    });
    return inFlight;
}

/**
 * The current catalog. A fresh cache is returned as-is; a stale one is
 * returned immediately while a refresh runs in the background; a cold cache
 * awaits one fetch. Never throws — an unreachable OpenRouter yields [].
 */
export async function getOpenRouterCatalog(opts?: {
    toolsOnly?: boolean;
}): Promise<OpenRouterModelInfo[]> {
    const now = nowImpl();
    const stale = !cache || now - cache.fetchedAt > CATALOG_TTL_MS;

    if (stale && now >= cooldownUntil) {
        if (cache) {
            void refreshOnce(); // serve stale, refresh behind it
        } else {
            await refreshOnce();
        }
    }

    const models = cache?.ordered ?? [];
    return opts?.toolsOnly ? models.filter((m) => m.supportsTools) : models;
}

/**
 * Token ceilings for an OpenRouter model id. Deliberately synchronous:
 * capabilitiesForModel() and the adapters' clamps are hot, synchronous paths,
 * so a cold cache resolves to conservative defaults rather than awaiting.
 */
export function openrouterCapabilities(modelId: string): ModelCapabilities {
    const found = cache?.byId.get(modelId);
    if (!found) return OPENROUTER_FALLBACK_CAPABILITIES;
    return {
        inputTokens: found.contextLength,
        maxOutputTokens:
            found.maxCompletionTokens ??
            Math.min(found.contextLength, DERIVED_MAX_OUTPUT_CEILING),
    };
}

/**
 * Whether an OpenRouter id may be selected. Permissive while the cache is
 * cold — the provider itself is the real gate, and rejecting ids during a
 * catalog outage would strand users on a model they legitimately picked.
 */
export function isOpenRouterModelAllowed(modelId: string): boolean {
    if (!cache) return true;
    return cache.byId.has(modelId);
}

/** Fire-and-forget warm-up, called once at server start. */
export function warmOpenRouterCatalog(): void {
    void getOpenRouterCatalog().catch(() => {});
}
