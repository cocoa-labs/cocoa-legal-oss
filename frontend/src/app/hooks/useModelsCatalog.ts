"use client";

import { useEffect, useState } from "react";
import {
    getModelsCatalog,
    type FeaturedModelEntry,
    type ModelsCatalogResponse,
    type OpenRouterCatalogEntry,
} from "@/app/lib/cocoLegalApi";
import { MODELS } from "@/app/components/assistant/ModelToggle";

const unverifiedHealth = () => ({
    status: "unverified" as const,
    verificationStatus: "unverified" as const,
    capabilityResults: {},
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
});

// Several pickers can be mounted at once (main chat, matter chat, tabular
// panel). They share one in-flight request and one cached response rather than
// each fetching a few hundred catalog entries.
const STALE_MS = 5 * 60 * 1000;

type CacheEntry = { at: number; data: ModelsCatalogResponse };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ModelsCatalogResponse>>();

/** What the picker shows when /models is unreachable: the compiled-in list. */
function offlineFallback(): ModelsCatalogResponse {
    return {
        featured: MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            group: m.group,
            provider: "",
            contextLength: 0,
            maxOutputTokens: 0,
            health: unverifiedHealth(),
        })),
        openrouter: [],
        openrouterCatalogAvailable: false,
    };
}

async function load(toolsOnly: boolean): Promise<ModelsCatalogResponse> {
    const key = toolsOnly ? "tools" : "all";
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < STALE_MS) return hit.data;

    const existing = inFlight.get(key);
    if (existing) return existing;

    const request = getModelsCatalog({ toolsOnly })
        .then((data) => {
            // Backward-compatible with a backend from the preceding rollout
            // phase, before health metadata was added to GET /models.
            const normalized: ModelsCatalogResponse = {
                ...data,
                featured: data.featured.map((model) => ({
                    ...model,
                    health: model.health ?? unverifiedHealth(),
                })),
                openrouter: data.openrouter.map((model) => ({
                    ...model,
                    health: model.health ?? unverifiedHealth(),
                })),
            };
            cache.set(key, { at: Date.now(), data: normalized });
            return normalized;
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, request);
    return request;
}

export type ModelsCatalog = {
    featured: FeaturedModelEntry[];
    openrouter: OpenRouterCatalogEntry[];
    catalogAvailable: boolean;
    loading: boolean;
};

/**
 * @param toolsOnly restrict the OpenRouter section to models that can call
 * tools. Chat surfaces want this — Quill always carries its full toolset, so a
 * tool-less model would fail confusingly mid-conversation.
 */
export function useModelsCatalog(toolsOnly = true): ModelsCatalog {
    const [state, setState] = useState<ModelsCatalogResponse | null>(
        () => cache.get(toolsOnly ? "tools" : "all")?.data ?? null,
    );
    const [loading, setLoading] = useState(!state);

    useEffect(() => {
        let cancelled = false;
        // Deliberately no synchronous setState here: a warm cache resolves on
        // the first render, and flipping `loading` up front would queue a
        // cascading re-render for every mounted picker.
        load(toolsOnly)
            .then((data) => {
                if (!cancelled) {
                    setState(data);
                    setLoading(false);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setState(offlineFallback());
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [toolsOnly]);

    const data = state ?? offlineFallback();
    return {
        featured: data.featured,
        openrouter: data.openrouter,
        catalogAvailable: data.openrouterCatalogAvailable,
        loading,
    };
}
