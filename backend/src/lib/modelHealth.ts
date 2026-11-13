import type { createServerSupabase } from "./supabase";
import { FEATURED_MODELS, providerForModel } from "./llm";
import { Sentry } from "./telemetry";

type DatabaseClient = ReturnType<typeof createServerSupabase>;

export type ModelHealthStatus =
    | "healthy"
    | "degraded"
    | "unverified"
    | "unhealthy";

export type ModelHealthMetadata = {
    status: ModelHealthStatus;
    verificationStatus: "verified" | "unverified";
    capabilityResults: Record<string, unknown>;
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    lastErrorCode: string | null;
};

type HealthRow = {
    model_id: string;
    verification_status: "verified" | "unverified";
    health_status: ModelHealthStatus;
    capability_results: Record<string, unknown> | null;
    last_checked_at: string | null;
    last_success_at: string | null;
    last_failure_at: string | null;
    consecutive_failures: number | null;
    last_error_code: string | null;
};

export const UNVERIFIED_MODEL_HEALTH: ModelHealthMetadata = {
    status: "unverified",
    verificationStatus: "unverified",
    capabilityResults: {},
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
};

export async function loadModelHealth(
    db: DatabaseClient,
    modelIds?: string[],
): Promise<Map<string, ModelHealthMetadata>> {
    let query = db
        .from("model_runtime_health")
        .select(
            "model_id, verification_status, health_status, capability_results, last_checked_at, last_success_at, last_failure_at, consecutive_failures, last_error_code",
        );
    if (modelIds?.length) query = query.in("model_id", modelIds);
    const { data, error } = await query;
    if (error) throw new Error(`model health unavailable: ${error.message}`);

    return new Map(
        ((data ?? []) as HealthRow[]).map((row) => [
            row.model_id,
            {
                status: row.health_status,
                verificationStatus: row.verification_status,
                capabilityResults: row.capability_results ?? {},
                lastCheckedAt: row.last_checked_at,
                lastSuccessAt: row.last_success_at,
                lastFailureAt: row.last_failure_at,
                consecutiveFailures: row.consecutive_failures ?? 0,
                lastErrorCode: row.last_error_code,
            },
        ]),
    );
}

export async function ensureFeaturedModelHealthRows(
    db: DatabaseClient,
): Promise<void> {
    const { error } = await db.from("model_runtime_health").upsert(
        FEATURED_MODELS.map((model) => ({
            model_id: model.id,
            provider: providerForModel(model.id),
            verification_status: "unverified",
            health_status: "unverified",
        })),
        { onConflict: "model_id", ignoreDuplicates: true },
    );
    if (error)
        throw new Error(`model health registry unavailable: ${error.message}`);
}

export async function verifiedHealthyFallbackModels(
    db: DatabaseClient,
    modelIds: string[],
): Promise<Set<string>> {
    if (modelIds.length === 0) return new Set();
    try {
        const health = await loadModelHealth(db, modelIds);
        return new Set(
            modelIds.filter((id) => {
                const entry = health.get(id);
                return (
                    entry?.verificationStatus === "verified" &&
                    entry.status === "healthy"
                );
            }),
        );
    } catch (error) {
        console.warn("[model-health] fallback certification unavailable", {
            error: error instanceof Error ? error.message : String(error),
        });
        return new Set();
    }
}

export async function listVerifiedHealthyFallbackModels(
    db: DatabaseClient,
): Promise<string[]> {
    try {
        const { data, error } = await db
            .from("model_runtime_health")
            .select("model_id")
            .eq("verification_status", "verified")
            .eq("health_status", "healthy")
            .order("last_success_at", { ascending: false, nullsFirst: false })
            .limit(250);
        if (error) throw error;
        return (data ?? []).map((row) => String(row.model_id));
    } catch (error) {
        console.warn("[model-health] fallback catalog unavailable", {
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
}

export async function recordModelRuntimeOutcome(
    db: DatabaseClient,
    input: { modelId: string; success: boolean; errorCode?: string | null },
): Promise<void> {
    try {
        const { error } = await db.rpc("record_model_runtime_outcome", {
            p_model_id: input.modelId,
            p_provider: providerForModel(input.modelId),
            p_success: input.success,
            p_error_code: input.errorCode?.slice(0, 80) ?? null,
        });
        if (error) throw error;
        try {
            Sentry.metrics.count("assistant.model_runtime_outcome", 1, {
                attributes: {
                    model_id: input.modelId,
                    provider: providerForModel(input.modelId),
                    outcome: input.success ? "success" : "failure",
                    error_code: input.success
                        ? "none"
                        : (input.errorCode?.slice(0, 80) ?? "unknown"),
                },
            });
        } catch {
            // Metrics must never alter model health persistence.
        }
    } catch (error) {
        // Health telemetry must never fail or delay the user's response.
        console.warn("[model-health] outcome recording failed", {
            modelId: input.modelId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function recordModelConformance(
    db: DatabaseClient,
    input: {
        modelId: string;
        success: boolean;
        capabilityResults: Record<string, unknown>;
        errorCode?: string | null;
    },
): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await db.from("model_runtime_health").upsert(
        {
            model_id: input.modelId,
            provider: providerForModel(input.modelId),
            verification_status: input.success ? "verified" : "unverified",
            health_status: input.success ? "healthy" : "unhealthy",
            capability_results: input.capabilityResults,
            last_checked_at: now,
            last_success_at: input.success ? now : undefined,
            last_failure_at: input.success ? undefined : now,
            consecutive_failures: input.success ? 0 : 1,
            last_error_code: input.success
                ? null
                : (input.errorCode?.slice(0, 80) ?? "conformance_failed"),
            updated_at: now,
        },
        { onConflict: "model_id" },
    );
    if (error)
        throw new Error(
            `model conformance persistence failed: ${error.message}`,
        );
    try {
        Sentry.metrics.count("assistant.model_conformance", 1, {
            attributes: {
                model_id: input.modelId,
                provider: providerForModel(input.modelId),
                outcome: input.success ? "success" : "failure",
                error_code: input.success
                    ? "none"
                    : (input.errorCode?.slice(0, 80) ?? "conformance_failed"),
            },
        });
    } catch {
        // Metrics must never alter model health persistence.
    }
}

export function recordGenerationAttemptMetrics(input: {
    requestedModelId: string;
    finalModelId: string;
    attemptCount: number;
    finishReason: string;
}): void {
    try {
        Sentry.metrics.distribution(
            "assistant.generation_attempts",
            input.attemptCount,
            {
                attributes: {
                    requested_model_id: input.requestedModelId,
                    final_model_id: input.finalModelId,
                    finish_reason: input.finishReason,
                    used_fallback:
                        input.requestedModelId === input.finalModelId
                            ? "false"
                            : "true",
                },
            },
        );
    } catch {
        // Reliability telemetry must never alter the user's generation.
    }
}

export function privacySafeModelErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/context window|context.?limit|too many input tokens/i.test(message))
        return "context_limit";
    if (/\b401\b|unauthori[sz]ed|invalid api key/i.test(message))
        return "authorization";
    if (/\b429\b|rate.?limit/i.test(message)) return "rate_limit";
    if (/timeout|timed out|network|fetch failed|econnreset/i.test(message))
        return "transport";
    if (/\brefus|content.?filter|safety policy/i.test(message))
        return "refused";
    return "provider_error";
}
