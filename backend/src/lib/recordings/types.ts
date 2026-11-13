// backend/src/lib/recordings/types.ts
//
// Shared types for the recordings + transcription pipeline: the `recordings`
// state machine (see migrations/025_recordings.sql) and the two jsonb shapes it
// stores on the row — the diarized transcript (`utterances`) and the extracted
// `action_items`.
//
// utterances / action_items come back from the database as UNTRUSTED jsonb
// (seeded by AssemblyAI diarization and an LLM summary step), so parseUtterances
// / parseActionItems re-check every member before anything downstream reads it.
// They mirror the hand-rolled-validator discipline in lib/automation/types.ts,
// but with a softer contract: they never throw. A malformed member is dropped;
// a thin one is coerced (missing speaker → "", missing times → 0, missing
// done → false, missing owner/due → null); the result is always an array.

/** Every status recordings.status may hold (DB check constraint order). */
export const RECORDING_STATUSES = [
    "queued",
    "transcribing",
    "summarizing",
    "ready",
    "failed",
] as const;

export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

/** How the audio was captured: browser mic (MediaRecorder) or an upload. */
export type RecordingSource = "mic" | "upload";

/** One diarized speech segment (AssemblyAI utterance). */
export interface Utterance {
    speaker: string;
    text: string;
    start_ms: number;
    end_ms: number;
}

/** One extracted follow-up, as stored in recordings.action_items. */
export interface ActionItem {
    id: string;
    text: string;
    done: boolean;
    owner: string | null;
    due: string | null;
}

/**
 * One `recordings` row — a single captured audio's trip through the pipeline.
 * Keys are the snake_case columns exactly; nullability follows the 025 DDL
 * (next_attempt_at / consent_ack_at / title / audio_* are NOT NULL there).
 */
export interface Recording {
    id: string;
    user_id: string;
    project_id: string | null;
    chat_id: string | null;
    chat_message_id: string | null;
    title: string;
    source: RecordingSource;
    status: RecordingStatus;
    audio_storage_key: string;
    audio_mime: string;
    audio_size_bytes: number;
    duration_seconds: number | null;
    consent_ack_at: string;
    assemblyai_transcript_id: string | null;
    utterances: Utterance[];
    transcript_text: string | null;
    summary_md: string | null;
    action_items: ActionItem[];
    transcript_document_id: string | null;
    voice_briefing_document_id: string | null;
    timeline_image_document_id: string | null;
    email_id: string | null;
    error: string | null;
    retry_count: number;
    next_attempt_at: string;
    created_at: string;
    updated_at: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Sanitize untrusted jsonb into Utterance[]. Never throws: a non-array yields
 * [], non-object members are dropped, a member with no string `text` is dropped
 * (it carries no content), and the rest is coerced (speaker → "", times → 0).
 */
export function parseUtterances(value: unknown): Utterance[] {
    if (!Array.isArray(value)) return [];
    const out: Utterance[] = [];
    for (const item of value) {
        if (!isPlainObject(item)) continue;
        if (typeof item.text !== "string") continue;
        out.push({
            speaker: typeof item.speaker === "string" ? item.speaker : "",
            text: item.text,
            start_ms: toFiniteNumber(item.start_ms),
            end_ms: toFiniteNumber(item.end_ms),
        });
    }
    return out;
}

/**
 * Sanitize untrusted jsonb into ActionItem[]. Never throws: a non-array yields
 * [], non-object members are dropped, a member missing a string `id` or `text`
 * is dropped (no stable identity / no content), and the rest is coerced
 * (non-boolean done → false, non-string owner/due → null).
 */
export function parseActionItems(value: unknown): ActionItem[] {
    if (!Array.isArray(value)) return [];
    const out: ActionItem[] = [];
    for (const item of value) {
        if (!isPlainObject(item)) continue;
        if (typeof item.id !== "string") continue;
        if (typeof item.text !== "string") continue;
        out.push({
            id: item.id,
            text: item.text,
            done: typeof item.done === "boolean" ? item.done : false,
            owner: typeof item.owner === "string" ? item.owner : null,
            due: typeof item.due === "string" ? item.due : null,
        });
    }
    return out;
}
