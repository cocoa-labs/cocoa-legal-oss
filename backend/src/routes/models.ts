import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
    FEATURED_MODELS,
    capabilitiesForModel,
    getOpenRouterCatalog,
    providerForModel,
    type OpenRouterModelInfo,
} from "../lib/llm";
import { createServerSupabase } from "../lib/supabase";
import {
    loadModelHealth,
    UNVERIFIED_MODEL_HEALTH,
    type ModelHealthMetadata,
} from "../lib/modelHealth";

export const modelsRouter = Router();

type FeaturedEntry = {
    id: string;
    label: string;
    group: string;
    provider: string;
    contextLength: number;
    maxOutputTokens: number;
    health: ModelHealthMetadata;
};

/**
 * GET /models — what the client picker renders.
 *
 * `featured` is the natively-supported set (stable, hand-curated labels).
 * `openrouter` is the live catalog, which is what keeps the picker current
 * without a deploy. A catalog outage is not an error: the response still
 * carries the featured models with `openrouterCatalogAvailable: false`, and
 * the client falls back to its compiled-in list if this endpoint fails
 * outright.
 */
modelsRouter.get("/", requireAuth, async (req, res) => {
    // Quill's chat surfaces always carry the full agent toolset, so a model
    // that cannot call tools would fail confusingly. Callers opt into the
    // filter with ?tools=1.
    const toolsOnly = req.query.tools === "1";
    let openrouter: OpenRouterModelInfo[] = [];
    let openrouterCatalogAvailable = false;
    try {
        openrouter = await getOpenRouterCatalog({ toolsOnly });
        openrouterCatalogAvailable = openrouter.length > 0;
    } catch (err) {
        console.warn("[models] catalog unavailable:", (err as Error)?.message);
    }

    let healthByModel = new Map<string, ModelHealthMetadata>();
    try {
        healthByModel = await loadModelHealth(createServerSupabase());
    } catch (err) {
        console.warn("[models] health unavailable:", (err as Error)?.message);
    }

    const featured: FeaturedEntry[] = FEATURED_MODELS.map((m) => {
        const caps = capabilitiesForModel(m.id);
        return {
            id: m.id,
            label: m.label,
            group: m.group,
            provider: providerForModel(m.id),
            contextLength: caps.inputTokens,
            maxOutputTokens: caps.maxOutputTokens,
            health: healthByModel.get(m.id) ?? UNVERIFIED_MODEL_HEALTH,
        };
    });
    const openrouterWithHealth = openrouter.map((model) => ({
        ...model,
        health: healthByModel.get(model.id) ?? UNVERIFIED_MODEL_HEALTH,
    }));

    res.set("Cache-Control", "private, max-age=300");
    res.json({
        featured,
        openrouter: openrouterWithHealth,
        openrouterCatalogAvailable,
    });
});
