export type LegalSearchProvider = "tavily" | "exa" | "firecrawl";

export type LegalSearchMode = "default" | "fast" | "authority" | "deep";

export type LegalSearchResult = {
    title: string;
    url: string;
    provider: LegalSearchProvider;
    providers?: LegalSearchProvider[];
    sourceType: "official" | "research" | "pdf" | "news" | "secondary" | "web";
    publishedDate?: string | null;
    snippet?: string | null;
    highlights?: string[];
    markdown?: string | null;
    confidence: number;
    retrievedAt: string;
};

export type LegalSearchRequest = {
    query: string;
    mode?: LegalSearchMode;
    maxResults?: number;
    jurisdiction?: string;
    includeDomains?: string[];
    excludeDomains?: string[];
};

export type LegalSearchResponse = {
    query: string;
    mode: LegalSearchMode;
    providers: LegalSearchProvider[];
    results: LegalSearchResult[];
    warnings: string[];
    retrievedAt: string;
};

type ProviderSearchResult = Omit<
    LegalSearchResult,
    "confidence" | "retrievedAt" | "providers"
> & {
    rawScore?: number | null;
};

const LEGAL_AUTHORITY_DOMAINS = [
    "supreme.justia.com",
    "law.justia.com",
    "courtlistener.com",
    "govinfo.gov",
    "congress.gov",
    "ecfr.gov",
    "federalregister.gov",
    "sec.gov",
    "justice.gov",
    "uscourts.gov",
    "supreme.court.gov",
    "finra.org",
    "consumerfinance.gov",
    "irs.gov",
    "treasury.gov",
];

const SECONDARY_LEGAL_DOMAINS = [
    "skadden.com",
    "lw.com",
    "kirkland.com",
    "stblaw.com",
    "wlrk.com",
    "paulweiss.com",
    "debevoise.com",
    "cooley.com",
    "orrick.com",
    "akingump.com",
];

function apiKey(provider: LegalSearchProvider): string | null {
    if (provider === "tavily") {
        return (
            process.env.TAVILY_API_KEY?.trim() ||
            process.env.TAVILY_KEY?.trim() ||
            null
        );
    }
    if (provider === "exa") {
        return (
            process.env.EXA_API_KEY?.trim() ||
            process.env.EXA_KEY?.trim() ||
            null
        );
    }
    return (
        process.env.FIRECRAWL_API_KEY?.trim() ||
        process.env.FIRECRAWL_KEY?.trim() ||
        null
    );
}

function providersForMode(mode: LegalSearchMode): LegalSearchProvider[] {
    if (mode === "fast") return ["tavily"];
    if (mode === "authority") return ["exa", "firecrawl"];
    if (mode === "deep") return ["tavily", "exa", "firecrawl"];
    return ["tavily", "exa", "firecrawl"];
}

function normalizedMax(value: number | undefined): number {
    if (!Number.isFinite(value)) return 8;
    return Math.min(Math.max(Math.round(value ?? 8), 1), 12);
}

function providerTimeoutMs(): number {
    const raw = Number.parseInt(
        process.env.LEGAL_SEARCH_PROVIDER_TIMEOUT_MS ?? "",
        10,
    );
    if (!Number.isFinite(raw) || raw <= 0) return 15000;
    return Math.min(Math.max(raw, 1000), 60000);
}

function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        parsed.searchParams.sort();
        return parsed.toString().replace(/\/$/, "");
    } catch {
        return url.trim();
    }
}

function hostname(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
        return "";
    }
}

function sourceTypeFor(url: string, providerHint?: string): LegalSearchResult["sourceType"] {
    const host = hostname(url);
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith(".pdf") || providerHint === "pdf") return "pdf";
    if (
        host.endsWith(".gov") ||
        host.endsWith(".mil") ||
        host.includes("courts.") ||
        LEGAL_AUTHORITY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
    ) {
        return "official";
    }
    if (providerHint === "research") return "research";
    if (providerHint === "news") return "news";
    if (SECONDARY_LEGAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return "secondary";
    }
    return "web";
}

function compactText(value: unknown, max = 500): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed) return null;
    return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function cleanHighlights(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 4);
}

function objectValue(row: Record<string, unknown>, key: string): unknown {
    return row[key];
}

function nestedObjectValue(
    row: Record<string, unknown>,
    objectKey: string,
    valueKey: string,
): unknown {
    const nested = row[objectKey];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
        return undefined;
    }
    return (nested as Record<string, unknown>)[valueKey];
}

async function postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs = providerTimeoutMs(),
): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...headers,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            const detail = compactText(text || response.statusText, 400);
            throw new Error(`${response.status} ${detail ?? "request failed"}`);
        }
        return response.json();
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            throw new Error(`request timed out after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function searchTavily(request: LegalSearchRequest, limit: number): Promise<ProviderSearchResult[]> {
    const key = apiKey("tavily");
    if (!key) throw new Error("TAVILY_API_KEY is not configured");
    const data = (await postJson(
        "https://api.tavily.com/search",
        { Authorization: `Bearer ${key}` },
        {
            query: request.query,
            search_depth: request.mode === "fast" ? "basic" : "advanced",
            max_results: limit,
            include_answer: false,
            include_raw_content: true,
            include_domains: request.includeDomains,
            exclude_domains: request.excludeDomains,
            country: "united states",
        },
    )) as { results?: Record<string, unknown>[] };

    return (data.results ?? []).flatMap((result) => {
        const url = String(result.url ?? "");
        if (!url) return [];
        const rawContent = compactText(result.raw_content, 2500);
        return [
            {
                title: compactText(result.title, 160) ?? url,
                url,
                provider: "tavily" as const,
                sourceType: sourceTypeFor(url),
                publishedDate:
                    typeof result.published_date === "string"
                        ? result.published_date
                        : null,
                snippet: compactText(result.content, 700),
                highlights: [],
                markdown: rawContent,
                rawScore:
                    typeof result.score === "number" ? result.score : null,
            },
        ];
    });
}

async function searchExa(request: LegalSearchRequest, limit: number): Promise<ProviderSearchResult[]> {
    const key = apiKey("exa");
    if (!key) throw new Error("EXA_API_KEY is not configured");
    const data = (await postJson(
        "https://api.exa.ai/search",
        { "x-api-key": key },
        {
            query: request.query,
            numResults: limit,
            includeDomains: request.includeDomains,
            excludeDomains: request.excludeDomains,
            contents: { highlights: true },
        },
    )) as { results?: Record<string, unknown>[] };

    return (data.results ?? []).flatMap((result) => {
        const url = String(result.url ?? "");
        if (!url) return [];
        const highlights = cleanHighlights(result.highlights);
        return [
            {
                title: compactText(result.title, 160) ?? url,
                url,
                provider: "exa" as const,
                sourceType: sourceTypeFor(url),
                publishedDate:
                    typeof result.publishedDate === "string"
                        ? result.publishedDate
                        : null,
                snippet:
                    compactText(result.summary, 700) ??
                    compactText(result.text, 700) ??
                    highlights[0] ??
                    null,
                highlights,
                markdown: compactText(result.text, 2500),
                rawScore:
                    typeof result.score === "number" ? result.score : null,
            },
        ];
    });
}

async function searchFirecrawl(request: LegalSearchRequest, limit: number): Promise<ProviderSearchResult[]> {
    const key = apiKey("firecrawl");
    if (!key) throw new Error("FIRECRAWL_API_KEY is not configured");
    const body = {
        query: request.query,
        limit,
        sources: ["web"],
        includeDomains: request.includeDomains,
        excludeDomains: request.excludeDomains,
        country: "US",
        ignoreInvalidURLs: true,
    };
    const endpoint = "https://api.firecrawl.dev/v2/search";
    const headers = { Authorization: `Bearer ${key}` };
    const shouldScrape = request.mode === "deep";
    const data = (await postJson(
        endpoint,
        headers,
        shouldScrape
            ? {
                  ...body,
                  scrapeOptions: { formats: [{ type: "markdown" }] },
              }
            : body,
        shouldScrape ? providerTimeoutMs() : 8000,
    ).catch((err) => {
        if (!shouldScrape) throw err;
        return postJson(endpoint, headers, body, 8000);
    })) as {
        data?: {
            web?: Record<string, unknown>[];
            news?: Record<string, unknown>[];
        };
    };

    const web = (data.data?.web ?? []).map((result) => ({
        result,
        hint: typeof result.category === "string" ? result.category : "web",
    }));
    const news = (data.data?.news ?? []).map((result) => ({
        result,
        hint: "news",
    }));

    return [...web, ...news].flatMap(({ result, hint }) => {
        const url = String(
            objectValue(result, "url") ??
                nestedObjectValue(result, "metadata", "sourceURL") ??
                "",
        );
        if (!url) return [];
        return [
            {
                title:
                    compactText(result.title, 160) ??
                    compactText(nestedObjectValue(result, "metadata", "title"), 160) ??
                    url,
                url,
                provider: "firecrawl" as const,
                sourceType: sourceTypeFor(url, hint),
                publishedDate:
                    typeof result.date === "string" ? result.date : null,
                snippet:
                    compactText(result.description, 700) ??
                    compactText(result.snippet, 700) ??
                    compactText(result.markdown, 700),
                highlights: [],
                markdown: compactText(result.markdown, 3000),
                rawScore: null,
            },
        ];
    });
}

function rank(results: ProviderSearchResult[], retrievedAt: string, limit: number): LegalSearchResult[] {
    const grouped = new Map<string, ProviderSearchResult[]>();
    for (const result of results) {
        const key = normalizeUrl(result.url);
        grouped.set(key, [...(grouped.get(key) ?? []), result]);
    }

    const merged: LegalSearchResult[] = [];
    for (const group of grouped.values()) {
        const base =
            group.find((item) => item.markdown) ??
            group.find((item) => item.highlights?.length) ??
            group[0];
        const providers = [...new Set(group.map((item) => item.provider))];
        const sourceBonus =
            base.sourceType === "official"
                ? 0.35
                : base.sourceType === "research" || base.sourceType === "pdf"
                  ? 0.2
                  : base.sourceType === "secondary"
                    ? 0.1
                    : 0;
        const providerBonus = Math.min((providers.length - 1) * 0.18, 0.36);
        const contentBonus = base.markdown ? 0.12 : base.highlights?.length ? 0.08 : 0;
        const scoreBonus =
            typeof base.rawScore === "number"
                ? Math.min(Math.max(base.rawScore, 0), 1) * 0.17
                : 0.08;
        const confidence = Math.min(
            0.35 + sourceBonus + providerBonus + contentBonus + scoreBonus,
            0.99,
        );
        merged.push({
            ...base,
            providers,
            confidence: Number(confidence.toFixed(2)),
            retrievedAt,
        });
    }

    return merged
        .sort((a, b) => {
            const diff = b.confidence - a.confidence;
            if (diff !== 0) return diff;
            return (b.markdown?.length ?? 0) - (a.markdown?.length ?? 0);
        })
        .slice(0, limit);
}

export async function runLegalSearch(
    request: LegalSearchRequest,
): Promise<LegalSearchResponse> {
    const query = request.query.trim();
    const mode = request.mode ?? "default";
    const limit = normalizedMax(request.maxResults);
    const retrievedAt = new Date().toISOString();
    const desiredProviders = providersForMode(mode);
    const warnings: string[] = [];

    if (!query) {
        return {
            query,
            mode,
            providers: [],
            results: [],
            warnings: ["query is required"],
            retrievedAt,
        };
    }

    const providerJobs = desiredProviders.map(async (provider) => {
        try {
            if (provider === "tavily") return await searchTavily(request, limit);
            if (provider === "exa") return await searchExa(request, limit);
            return await searchFirecrawl(request, limit);
        } catch (err) {
            warnings.push(
                `${provider}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return [] as ProviderSearchResult[];
        }
    });

    const settled = await Promise.all(providerJobs);
    const providerResults = settled.flat();
    const providers = [
        ...new Set(providerResults.map((result) => result.provider)),
    ];

    if (providers.length === 0 && warnings.length === 0) {
        warnings.push("No legal search providers are configured.");
    }

    return {
        query,
        mode,
        providers,
        results: rank(providerResults, retrievedAt, limit),
        warnings,
        retrievedAt,
    };
}
