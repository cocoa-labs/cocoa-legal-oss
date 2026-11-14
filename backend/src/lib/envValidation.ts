/**
 * Startup environment validation.
 *
 * Before this existed, production would boot cleanly with a missing
 * SUPABASE_SECRET_KEY or DOWNLOAD_SIGNING_SECRET and only fail on the first
 * request that touched the misconfigured subsystem — a 500 in front of a
 * user instead of a refused deploy. The list below is derived from the
 * modules that throw at call time when their env is absent:
 *
 *   lib/supabase.ts       → SUPABASE_URL, SUPABASE_SECRET_KEY
 *   lib/storage.ts        → R2_ENDPOINT_URL, R2_ACCESS_KEY_ID,
 *                           R2_SECRET_ACCESS_KEY
 *                           (R2_BUCKET_NAME defaults to "cocoa-legal" — not critical)
 *   lib/downloadTokens.ts → DOWNLOAD_SIGNING_SECRET
 *
 * Pure function so the production/dev matrix is unit-testable without
 * mutating process.env or spawning processes.
 */

export const CRITICAL_ENV_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "R2_ENDPOINT_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "DOWNLOAD_SIGNING_SECRET",
] as const;

/**
 * Automation-pipeline env vars (lib/automation/env.ts) — ALL optional, never
 * fatal: the scheduler is a hard no-op unless AUTOMATION_ENABLED=true and
 * every reader has a safe default. Listed here so the one silent
 * misconfiguration (tuning vars set while the master switch is off) gets a
 * boot warning instead of a mystery.
 */
export const AUTOMATION_ENV_VARS = [
  "AUTOMATION_ENABLED",
  "AUTOMATION_POLL_INTERVAL_MS",
  "AUTOMATION_DRAFTS_ONLY",
  "AUTOMATION_MAX_RETRIES",
  "AUTOMATION_LLM_CLASSIFY_ENABLED",
  "AUTOMATION_MODEL",
  "AUTOMATION_RECONCILE_EVERY_N_TICKS",
] as const;

/**
 * Recordings-pipeline env vars (lib/recordings/env.ts) — ALL optional, never
 * fatal: the transcription worker is a no-op unless ASSEMBLYAI_API_KEY is set,
 * and every reader has a safe default. ASSEMBLYAI_API_KEY is the enabling
 * signal (the recordings analogue of AUTOMATION_ENABLED); listed here so the
 * one silent misconfiguration — tuning/TTS/image vars set while the key is
 * absent, so the whole feature is inert — gets a boot warning.
 */
export const RECORDINGS_ENV_VARS = [
  "ASSEMBLYAI_API_KEY",
  "RECORDINGS_WORKER_ENABLED",
  "RECORDINGS_POLL_INTERVAL_MS",
  "RECORDINGS_MAX_RETRIES",
  "RECORDINGS_MODEL",
  "OPENAI_TTS_MODEL",
  "OPENAI_TTS_VOICE",
  "OPENAI_IMAGE_MODEL",
] as const;

/**
 * Chat intent-detection env vars (lib/intentDetection.ts) — ALL optional,
 * never fatal: the hybrid classifier is ON by default and every reader has a
 * safe default (with the deterministic structural rule as the fallback). The
 * one silent misconfiguration is tuning vars left set after the classifier
 * itself was switched off — those get a boot warning below.
 */
export const INTENT_ENV_VARS = [
  "INTENT_LLM_CLASSIFY_ENABLED",
  "INTENT_CLASSIFIER_MODEL",
  "INTENT_CLASSIFIER_TIMEOUT_MS",
  "INTENT_POST_STREAM_GRACE_MS",
  "INTENT_LLM_MIN_CONFIDENCE",
  "INTENT_LLM_REQUIRE_LEXICAL_AGREEMENT",
] as const;

export interface EnvValidationResult {
  /** Critical vars that are unset or empty, in declaration order. */
  missing: string[];
  /** True only in production with at least one critical var missing. */
  fatal: boolean;
  /** Non-fatal advisory messages (e.g. SIGN_PUBLIC_BASE_URL). */
  warnings: string[];
}

export function validateCriticalEnv(
  env: Record<string, string | undefined>,
  isProduction: boolean,
): EnvValidationResult {
  // Empty string is never a usable credential — consumers treat "" as unset
  // (createServerSupabase's `|| ""` guard), so the validator must agree.
  const missing = CRITICAL_ENV_VARS.filter((name) => !env[name]);

  const warnings: string[] = [];
  // Signing links are built from SIGN_PUBLIC_BASE_URL. If it's empty the
  // links become relative ("/sign/<token>") and are unreachable from an
  // email — the exact silent failure that produced dead localhost:3000
  // links. Warn loudly, but never refuse to boot over it.
  if (!env.SIGN_PUBLIC_BASE_URL) {
    warnings.push(
      "SIGN_PUBLIC_BASE_URL is not set — e-signature links will be " +
        "relative and unreachable. Set it to the frontend origin (e.g. " +
        "http://localhost:3003 in dev, https://your-domain.example in prod).",
    );
  }

  // Automation tuning vars are consumed only when the master switch is on
  // (AUTOMATION_ENABLED=true — the same strict-"true" parse as
  // lib/automation/env.ts). Setting them without it means everything boots
  // and nothing runs — warn loudly, never refuse to boot.
  const automationTuning = AUTOMATION_ENV_VARS.filter(
    (name) => name !== "AUTOMATION_ENABLED" && env[name],
  );
  if (
    automationTuning.length > 0 &&
    (env.AUTOMATION_ENABLED ?? "").toLowerCase() !== "true"
  ) {
    warnings.push(
      `${automationTuning.join(", ")} ${
        automationTuning.length === 1 ? "is" : "are"
      } set but AUTOMATION_ENABLED is not "true" — the automation ` +
        "scheduler stays off and these values are ignored.",
    );
  }

  // Recordings tuning/TTS/image vars are consumed only when the transcription
  // worker can run — i.e. ASSEMBLYAI_API_KEY is set (the recordings analogue of
  // AUTOMATION_ENABLED). Without the key the whole feature is inert and these
  // values are ignored — warn loudly, never refuse to boot.
  const recordingsTuning = RECORDINGS_ENV_VARS.filter(
    (name) => name !== "ASSEMBLYAI_API_KEY" && env[name],
  );
  if (recordingsTuning.length > 0 && !env.ASSEMBLYAI_API_KEY) {
    warnings.push(
      `${recordingsTuning.join(", ")} ${
        recordingsTuning.length === 1 ? "is" : "are"
      } set but ASSEMBLYAI_API_KEY is not — the recordings worker stays off ` +
        "and these values are ignored.",
    );
  }

  // Intent-classifier tuning vars are consumed only while the classifier is
  // on. It is ON by default, so the only ignored-config case is an explicit
  // INTENT_LLM_CLASSIFY_ENABLED=false (the same strict-"false" parse as
  // lib/intentDetection.ts) with tuning vars still set — warn loudly, never
  // refuse to boot.
  const intentTuning = INTENT_ENV_VARS.filter(
    (name) => name !== "INTENT_LLM_CLASSIFY_ENABLED" && env[name],
  );
  if (
    intentTuning.length > 0 &&
    (env.INTENT_LLM_CLASSIFY_ENABLED ?? "").toLowerCase() === "false"
  ) {
    warnings.push(
      `${intentTuning.join(", ")} ${
        intentTuning.length === 1 ? "is" : "are"
      } set but INTENT_LLM_CLASSIFY_ENABLED is "false" — the intent ` +
        "classifier stays off and these values are ignored.",
    );
  }

  // Signing certificate. Without SIGNING_CERT_P12_BASE64 the e-signature
  // pipeline falls back to an ephemeral self-signed dev certificate whose
  // identity changes on every restart — expected in dev, a silent
  // legal-quality regression in production. Warn there, never refuse to boot
  // (a SET-but-broken cert IS fatal, but that is checkSigningIdentityAtBoot's
  // job in lib/signatures/cert.ts — it needs real parsing, not string checks).
  if (env.SIGNING_CERT_PASSPHRASE && !env.SIGNING_CERT_P12_BASE64) {
    warnings.push(
      "SIGNING_CERT_PASSPHRASE is set but SIGNING_CERT_P12_BASE64 is not — " +
        "the passphrase is ignored and the ephemeral dev signing certificate " +
        "is used.",
    );
  }
  if (isProduction && !env.SIGNING_CERT_P12_BASE64) {
    warnings.push(
      "SIGNING_CERT_P12_BASE64 is not set — e-signatures will use an " +
        "ephemeral self-signed certificate whose identity changes on every " +
        "restart. Generate a persistent org certificate with " +
        "scripts/generateSigningCert.ts (see DEPLOY.md).",
    );
  }

  return {
    missing,
    fatal: isProduction && missing.length > 0,
    warnings,
  };
}
