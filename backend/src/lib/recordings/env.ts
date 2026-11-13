// backend/src/lib/recordings/env.ts
//
// Env readers for the Recordings & transcription pipeline. Pure functions over
// an injected env object (defaulting to process.env) so the defaults/overrides/
// clamps matrix is unit-testable without mutating process.env — mirrors
// lib/automation/env.ts. The vars are registered as warn-only entries in
// lib/envValidation.ts (RECORDINGS_ENV_VARS).
//
// Boolean convention follows lib/automation/env.ts: the default-ON worker
// switch flips off only for a case-insensitive "false" (junk must never
// disarm it). Numeric knobs CLAMP to a safe floor rather than falling back —
// a too-small poll interval or a negative retry count is coerced into range,
// while non-numeric junk falls back to the default.

import { DEFAULT_MAIN_MODEL } from "../llm/models";

type Env = NodeJS.ProcessEnv;

/**
 * Parse an integer env value. Non-numeric/unset → `fallback`; a valid integer
 * below `min` is clamped up to `min` (never silently the default).
 */
function intClampedMin(
    raw: string | undefined,
    fallback: number,
    min: number,
): number {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(parsed, min);
}

/**
 * AssemblyAI API key (server-env only — no per-user BYOK for transcription).
 * Trimmed; empty/whitespace counts as absent so the worker treats it as unset.
 */
export function assemblyAiApiKey(env: Env = process.env): string | null {
    const raw = env.ASSEMBLYAI_API_KEY?.trim();
    return raw ? raw : null;
}

/**
 * Whether the recordings transcription worker should run. Requires the
 * AssemblyAI key (there is nothing to transcribe with without it) and is ON by
 * default when the key is present; only an explicit RECORDINGS_WORKER_ENABLED=
 * false disarms it. Storage availability is checked at boot by the scheduler
 * (Task 6), not here.
 */
export function recordingsWorkerEnabled(env: Env = process.env): boolean {
    if (!assemblyAiApiKey(env)) return false;
    return (env.RECORDINGS_WORKER_ENABLED ?? "").toLowerCase() !== "false";
}

/**
 * Worker poll cadence in ms (RECORDINGS_POLL_INTERVAL_MS, default 15000).
 * Clamped to a 2000ms floor so a fat-fingered tiny value can't spin the loop;
 * non-numeric junk falls back to the default.
 */
export function recordingsPollIntervalMs(env: Env = process.env): number {
    return intClampedMin(env.RECORDINGS_POLL_INTERVAL_MS, 15_000, 2_000);
}

/**
 * Max retries per pipeline step (RECORDINGS_MAX_RETRIES, default 3; 0 = never).
 * Negatives clamp to 0; non-numeric junk falls back to the default.
 */
export function recordingsMaxRetries(env: Env = process.env): number {
    return intClampedMin(env.RECORDINGS_MAX_RETRIES, 3, 0);
}

/**
 * Model the pipeline's LLM stages (summary, action items, briefing script) run
 * on: RECORDINGS_MODEL when set, otherwise the product runtime default
 * (DEFAULT_MAIN_MODEL in llm/models.ts is the single source of truth; never
 * hardcode Opus).
 */
export function recordingsModel(env: Env = process.env): string {
    const raw = env.RECORDINGS_MODEL?.trim();
    return raw || DEFAULT_MAIN_MODEL;
}

/** OpenAI TTS model for the voice briefing (OPENAI_TTS_MODEL). */
export function openaiTtsModel(env: Env = process.env): string {
    const raw = env.OPENAI_TTS_MODEL?.trim();
    return raw || "gpt-4o-mini-tts";
}

/** OpenAI TTS voice for the voice briefing (OPENAI_TTS_VOICE). */
export function openaiTtsVoice(env: Env = process.env): string {
    const raw = env.OPENAI_TTS_VOICE?.trim();
    return raw || "alloy";
}

/**
 * OpenAI image model for the timeline image (OPENAI_IMAGE_MODEL). Defaults to
 * gpt-image-2 — user-pinned for its text rendering; the default must stay
 * exactly this string.
 */
export function openaiImageModel(env: Env = process.env): string {
    const raw = env.OPENAI_IMAGE_MODEL?.trim();
    return raw || "gpt-image-2";
}
