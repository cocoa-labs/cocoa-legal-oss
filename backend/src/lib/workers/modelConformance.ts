import {
    FEATURED_MODELS,
    completeStructured,
    providerForModel,
    streamChatWithTools,
    type OpenAIToolSchema,
} from "../llm";
import {
    ensureFeaturedModelHealthRows,
    privacySafeModelErrorCode,
    recordModelConformance,
} from "../modelHealth";
import { createServerSupabase } from "../supabase";
import { claimWorkerLease, workerInstanceId } from "./leases";

const CHECK_INTERVAL_MS = 15 * 60_000;
const FEATURED_RECHECK_MS = 24 * 60 * 60_000;
const RECENT_RECHECK_MS = 72 * 60 * 60_000;
const RECENT_USE_MS = 7 * 24 * 60 * 60_000;
const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let timer: NodeJS.Timeout | null = null;

type CandidateRow = {
    model_id: string;
    last_checked_at: string | null;
    last_used_at: string | null;
};

const CONFORMANCE_TOOL: OpenAIToolSchema = {
    type: "function",
    function: {
        name: "conformance_echo",
        description: "Echo a synthetic token for a model conformance check.",
        parameters: {
            type: "object",
            properties: { token: { type: "string" } },
            required: ["token"],
            additionalProperties: false,
        },
    },
};

function hasServerKey(modelId: string): boolean {
    const provider = providerForModel(modelId);
    const key =
        provider === "claude"
            ? process.env.ANTHROPIC_API_KEY
            : provider === "gemini"
              ? process.env.GEMINI_API_KEY
              : provider === "openai"
                ? process.env.OPENAI_API_KEY
                : process.env.OPENROUTER_API_KEY;
    return !!key?.trim();
}

export function conformancePassed(results: {
    streaming?: unknown;
    tools_then_final_prose?: unknown;
    citations?: unknown;
    structured_output?: unknown;
    declared_modalities?: unknown;
}): boolean {
    return (
        results.streaming === true &&
        results.tools_then_final_prose === true &&
        results.citations === true &&
        results.structured_output === true &&
        results.declared_modalities === true
    );
}

async function runSyntheticConformance(modelId: string) {
    let visible = "";
    let visibleAfterTool = "";
    let sawTool = false;
    let deltaCount = 0;

    const streamed = await streamChatWithTools({
        model: modelId,
        systemPrompt:
            "This is a synthetic conformance test containing no user data. Call conformance_echo exactly once. After its result, reply exactly: CONFORMANCE_OK [1]",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Run the synthetic check." },
                    {
                        type: "image",
                        mimeType: "image/png",
                        data: TINY_PNG,
                        filename: "synthetic.png",
                    },
                ],
            },
        ],
        tools: [CONFORMANCE_TOOL],
        maxIterations: 3,
        maxOutputTokens: 512,
        maxContinuations: 0,
        callbacks: {
            onContentDelta(text) {
                deltaCount++;
                visible += text;
                if (sawTool) visibleAfterTool += text;
            },
        },
        async runTools(calls) {
            sawTool = true;
            return calls.map((call) => ({
                tool_use_id: call.id,
                content: JSON.stringify({ echo: "ping" }),
            }));
        },
    });

    const structured = await completeStructured({
        model: modelId,
        systemPrompt: "Synthetic conformance test. No user data is present.",
        user: "Return an object whose ok field is true.",
        schemaName: "model_conformance",
        schema: {
            type: "object",
            properties: { ok: { const: true } },
            required: ["ok"],
            additionalProperties: false,
        },
        maxTokens: 128,
    });

    const structuredValue = structured.value as { ok?: unknown };
    const results = {
        certification_version: 1,
        streaming: deltaCount > 0,
        tools_then_final_prose:
            sawTool &&
            streamed.finishReason === "completed" &&
            visibleAfterTool.includes("CONFORMANCE_OK"),
        citations: visibleAfterTool.includes("[1]"),
        structured_output: structuredValue?.ok === true,
        declared_modalities: visible.includes("CONFORMANCE_OK"),
    };
    return results;
}

async function nextCandidate(
    rows: CandidateRow[],
): Promise<CandidateRow | null> {
    const now = Date.now();
    const featured = new Set(FEATURED_MODELS.map((model) => model.id));
    return (
        rows
            .filter((row) => {
                if (!hasServerKey(row.model_id)) return false;
                const checkedAt = row.last_checked_at
                    ? Date.parse(row.last_checked_at)
                    : 0;
                if (featured.has(row.model_id)) {
                    return now - checkedAt >= FEATURED_RECHECK_MS;
                }
                const usedAt = row.last_used_at
                    ? Date.parse(row.last_used_at)
                    : 0;
                return (
                    now - usedAt <= RECENT_USE_MS &&
                    now - checkedAt >= RECENT_RECHECK_MS
                );
            })
            .sort(
                (a, b) =>
                    Date.parse(a.last_checked_at ?? "1970-01-01") -
                    Date.parse(b.last_checked_at ?? "1970-01-01"),
            )[0] ?? null
    );
}

export async function checkOneModelConformance(): Promise<number> {
    const db = createServerSupabase();
    if (
        !(await claimWorkerLease(
            db,
            "model-conformance",
            workerInstanceId(),
            10 * 60,
        ))
    ) {
        return 0;
    }
    await ensureFeaturedModelHealthRows(db);
    const { data, error } = await db
        .from("model_runtime_health")
        .select("model_id, last_checked_at, last_used_at")
        .order("last_checked_at", { ascending: true, nullsFirst: true })
        .limit(1_000);
    if (error) throw error;
    const candidate = await nextCandidate((data ?? []) as CandidateRow[]);
    if (!candidate) return 0;

    try {
        const capabilityResults = await runSyntheticConformance(
            candidate.model_id,
        );
        const success = conformancePassed(capabilityResults);
        await recordModelConformance(db, {
            modelId: candidate.model_id,
            success,
            capabilityResults,
            errorCode: success ? null : "conformance_failed",
        });
    } catch (error) {
        await recordModelConformance(db, {
            modelId: candidate.model_id,
            success: false,
            capabilityResults: { certification_version: 1 },
            errorCode: privacySafeModelErrorCode(error),
        });
    }
    return 1;
}

export function startModelConformanceWorker(): void {
    if (
        timer ||
        (process.env.MODEL_HEALTH_WORKER_ENABLED ?? "true").toLowerCase() ===
            "false"
    ) {
        return;
    }
    const run = () =>
        void checkOneModelConformance().catch((error) => {
            console.error("[model-health] conformance worker failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    run();
    timer = setInterval(run, CHECK_INTERVAL_MS);
    timer.unref();
}
