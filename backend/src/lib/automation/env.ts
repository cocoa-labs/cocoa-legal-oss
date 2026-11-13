// backend/src/lib/automation/env.ts
//
// Env-flag readers for the PI email-automation pipeline. Pure functions over
// an injected env object (defaulting to process.env) so the defaults /
// overrides matrix is unit-testable without mutating process.env — mirrors
// validateCriticalEnv. The vars are registered as warn-only entries in
// lib/envValidation.ts (AUTOMATION_ENV_VARS).
//
// Boolean convention follows lib/email/autoReply.ts:
//   - default-OFF switches flip on only for a case-insensitive "true";
//   - default-ON safeties flip off only for a case-insensitive "false"
//     (junk values must never disarm a safety).

import { DEFAULT_MAIN_MODEL } from "../llm/models";

type Env = NodeJS.ProcessEnv;

/** Parse an integer env value, falling back unless it satisfies `ok`. */
function intOr(
    raw: string | undefined,
    fallback: number,
    ok: (n: number) => boolean,
): number {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && ok(parsed) ? parsed : fallback;
}

/**
 * Master kill-switch (default OFF): gates the scheduler at boot and the
 * cold-inbound enqueue hook in email ingestion. Everything automation does is
 * a no-op unless AUTOMATION_ENABLED=true.
 */
export function automationEnabled(env: Env = process.env): boolean {
    return (env.AUTOMATION_ENABLED ?? "").toLowerCase() === "true";
}

/** Scheduler poll cadence in ms (AUTOMATION_POLL_INTERVAL_MS, default 2 min). */
export function automationPollIntervalMs(env: Env = process.env): number {
    return intOr(env.AUTOMATION_POLL_INTERVAL_MS, 120_000, (n) => n > 0);
}

/**
 * Drafts-only safety (default ON): when true the pipeline may only stage
 * drafts for human approval, never send autonomously. Only an explicit
 * AUTOMATION_DRAFTS_ONLY=false disarms it. Consumed by the 4b pipeline.
 */
export function automationDraftsOnly(env: Env = process.env): boolean {
    return (env.AUTOMATION_DRAFTS_ONLY ?? "").toLowerCase() !== "false";
}

/** Max retries per run step (AUTOMATION_MAX_RETRIES, default 3; 0 = never). */
export function automationMaxRetries(env: Env = process.env): number {
    return intOr(env.AUTOMATION_MAX_RETRIES, 3, (n) => n >= 0);
}

/**
 * LLM classification stage switch (default ON). Only an explicit
 * AUTOMATION_LLM_CLASSIFY_ENABLED=false turns it off (4b then falls back to
 * its non-LLM heuristics). Consumed by the 4b pipeline.
 */
export function automationLlmClassifyEnabled(env: Env = process.env): boolean {
    return (env.AUTOMATION_LLM_CLASSIFY_ENABLED ?? "").toLowerCase() !== "false";
}

/**
 * Model the pipeline's LLM stages run on: AUTOMATION_MODEL when set,
 * otherwise the product runtime default (see the CLAUDE.md model policy —
 * DEFAULT_MAIN_MODEL is the single source of truth).
 */
export function automationModel(env: Env = process.env): string {
    const raw = env.AUTOMATION_MODEL?.trim();
    return raw || DEFAULT_MAIN_MODEL;
}

/**
 * Reconciliation cadence: every Nth scheduler tick runs the 2-day QUERY
 * ingest instead of the cursor walk, healing any message a transient
 * getMessage failure caused the cursor to skip permanently
 * (AUTOMATION_RECONCILE_EVERY_N_TICKS, default 30 — ~1/hour at the default
 * 2-minute poll). Must be positive; junk falls back.
 */
export function automationReconcileEveryNTicks(env: Env = process.env): number {
    return intOr(env.AUTOMATION_RECONCILE_EVERY_N_TICKS, 30, (n) => n > 0);
}
