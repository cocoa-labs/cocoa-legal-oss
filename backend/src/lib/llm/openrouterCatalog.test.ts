import assert from "node:assert/strict";
import {
    OPENROUTER_FALLBACK_CAPABILITIES,
    __resetCatalogForTests,
    getOpenRouterCatalog,
    isOpenRouterModelAllowed,
    openrouterCapabilities,
} from "./openrouterCatalog";

// A trimmed copy of the real GET /api/v1/models payload shape.
const payload = (extra: Record<string, unknown>[] = []) => ({
    data: [
        {
            id: "anthropic/claude-sonnet-5",
            canonical_slug: "anthropic/claude-sonnet-5-20260630",
            name: "Anthropic: Claude Sonnet 5",
            context_length: 1_000_000,
            pricing: { prompt: "0.000002", completion: "0.00001" },
            architecture: {
                input_modalities: ["text", "image", "file"],
                output_modalities: ["text"],
            },
            top_provider: { max_completion_tokens: 128_000 },
            supported_parameters: ["tools", "tool_choice", "reasoning"],
        },
        {
            id: "some-vendor/no-tools-model",
            name: "Some Vendor: No Tools",
            context_length: 32_768,
            pricing: { prompt: "0.0000001", completion: "0.0000004" },
            architecture: { input_modalities: ["text"] },
            top_provider: { max_completion_tokens: null },
            supported_parameters: ["max_tokens"],
        },
        // Defensive parsing: entries missing id/context_length are skipped.
        { name: "broken entry, no id" },
        ...extra,
    ],
});

function stubFetch(
    impl: () => Promise<unknown> | unknown,
): { calls: () => number; fn: typeof fetch } {
    let calls = 0;
    const fn = (async () => {
        calls++;
        const body = await impl();
        return {
            ok: true,
            status: 200,
            json: async () => body,
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls: () => calls, fn };
}

async function run() {
    // --- parsing + field retention -----------------------------------------
    {
        const f = stubFetch(() => payload());
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => 1_000 });
        const all = await getOpenRouterCatalog();
        assert.equal(all.length, 2, "skips entries missing required fields");
        const sonnet = all.find((m) => m.id === "anthropic/claude-sonnet-5")!;
        assert.equal(sonnet.name, "Anthropic: Claude Sonnet 5");
        assert.equal(sonnet.contextLength, 1_000_000);
        assert.equal(sonnet.maxCompletionTokens, 128_000);
        assert.equal(sonnet.pricing.prompt, "0.000002");
        assert.deepEqual(sonnet.inputModalities, ["text", "image", "file"]);
        assert.equal(sonnet.supportsTools, true);
        const noTools = all.find(
            (m) => m.id === "some-vendor/no-tools-model",
        )!;
        assert.equal(noTools.supportsTools, false);
    }

    // --- toolsOnly filtering ------------------------------------------------
    {
        const f = stubFetch(() => payload());
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => 1_000 });
        const tools = await getOpenRouterCatalog({ toolsOnly: true });
        assert.deepEqual(
            tools.map((m) => m.id),
            ["anthropic/claude-sonnet-5"],
            "toolsOnly keeps only models advertising tool support",
        );
    }

    // --- TTL: a fresh cache is not refetched --------------------------------
    {
        const f = stubFetch(() => payload());
        let now = 1_000;
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => now });
        await getOpenRouterCatalog();
        now += 60_000; // one minute later, well inside the TTL
        await getOpenRouterCatalog();
        assert.equal(f.calls(), 1, "fresh cache must not refetch");
    }

    // --- stale-while-revalidate --------------------------------------------
    {
        let variant = 0;
        const f = stubFetch(() => {
            variant++;
            return variant === 1
                ? payload()
                : payload([
                      {
                          id: "new/model-added-later",
                          name: "New Model",
                          context_length: 8_192,
                          pricing: { prompt: "0", completion: "0" },
                          architecture: { input_modalities: ["text"] },
                          top_provider: { max_completion_tokens: 4_096 },
                          supported_parameters: ["tools"],
                      },
                  ]);
        });
        let now = 1_000;
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => now });
        await getOpenRouterCatalog();
        now += 2 * 60 * 60 * 1000; // two hours later — past the TTL
        const stale = await getOpenRouterCatalog();
        assert.equal(
            stale.length,
            2,
            "a stale read is served immediately from cache",
        );
        await new Promise((r) => setTimeout(r, 10)); // let the refresh land
        const fresh = await getOpenRouterCatalog();
        assert.equal(f.calls(), 2, "stale read triggers exactly one refresh");
        assert.ok(
            fresh.some((m) => m.id === "new/model-added-later"),
            "the refreshed catalog replaces the stale one",
        );
    }

    // --- failure: empty list, fallback capabilities, cooldown ---------------
    {
        const f = stubFetch(() => {
            throw new Error("network down");
        });
        let now = 1_000;
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => now });
        const out = await getOpenRouterCatalog();
        assert.deepEqual(out, [], "a failed fetch yields an empty catalog");
        assert.deepEqual(
            openrouterCapabilities("anthropic/claude-sonnet-5"),
            OPENROUTER_FALLBACK_CAPABILITIES,
            "cold cache falls back to conservative capabilities",
        );
        now += 5_000; // inside the failure cooldown
        await getOpenRouterCatalog();
        assert.equal(f.calls(), 1, "cooldown suppresses immediate refetch");
    }

    // --- capabilities from a warm cache ------------------------------------
    {
        const f = stubFetch(() => payload());
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => 1_000 });
        await getOpenRouterCatalog();
        assert.deepEqual(
            openrouterCapabilities("anthropic/claude-sonnet-5"),
            { inputTokens: 1_000_000, maxOutputTokens: 128_000 },
        );
        // max_completion_tokens is null here, so it derives a safe ceiling.
        assert.deepEqual(openrouterCapabilities("some-vendor/no-tools-model"), {
            inputTokens: 32_768,
            maxOutputTokens: 16_384,
        });
        assert.deepEqual(
            openrouterCapabilities("vendor/never-heard-of-it"),
            OPENROUTER_FALLBACK_CAPABILITIES,
            "an unknown id still resolves rather than throwing",
        );
    }

    // --- allow-listing ------------------------------------------------------
    {
        const f = stubFetch(() => payload());
        __resetCatalogForTests({ fetchFn: f.fn, nowFn: () => 1_000 });
        assert.equal(
            isOpenRouterModelAllowed("anything/at-all"),
            true,
            "a cold cache is permissive — the provider is the real gate",
        );
        await getOpenRouterCatalog();
        assert.equal(isOpenRouterModelAllowed("anthropic/claude-sonnet-5"), true);
        assert.equal(isOpenRouterModelAllowed("vendor/not-in-catalog"), false);
    }

    console.log("llm/openrouterCatalog.test.ts: all passed");
}

void run();
