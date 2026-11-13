// backend/src/lib/recordings/assemblyai.ts
//
// One-shot HTTP client for AssemblyAI's v2 REST API — the recordings pipeline's
// only door to AssemblyAI. Two calls: submitTranscription (POST /transcript,
// always with speaker_labels) kicks off a diarized job; getTranscription
// (GET /transcript/{id}) reads it back and maps AssemblyAI's payload onto our
// Utterance / status vocabulary. The pipeline (Task 4) owns the poll cadence and
// retries — this client is stateless and does exactly one request per call.
//
// Style mirrors lib/llm/openai.ts: raw fetch against a REST endpoint with
// explicit non-2xx surfacing. `fetchImpl` is injectable (defaults to
// globalThis.fetch) so the tests never hit the network. AssemblyAI's auth scheme
// is a RAW key in the `authorization` header (NO "Bearer " prefix), and that key
// is never logged.

import { parseUtterances, type Utterance } from "./types";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";

// Cap the slice of an error body we fold into a thrown Error — enough to see
// AssemblyAI's message without dumping an unbounded response into the logs.
const MAX_ERROR_BODY_CHARS = 500;

type FetchImpl = typeof globalThis.fetch;

/** AssemblyAI transcript lifecycle (their `status` field's values). */
export type AssemblyAiStatus = "queued" | "processing" | "completed" | "error";

/** POST /transcript response — the job id and its initial status. */
export interface AssemblyAiSubmitResult {
    id: string;
    status: AssemblyAiStatus;
}

/** GET /transcript/{id} response, mapped onto our vocabulary. */
export interface AssemblyAiTranscriptResult {
    id: string;
    status: AssemblyAiStatus;
    text: string | null;
    error: string | null;
    audio_duration_seconds: number | null;
    utterances: Utterance[];
}

/**
 * Guard the key at the door: trim it, and throw a clear error (without ever
 * echoing the key) when it is missing/blank so we never fire a doomed request.
 */
function requireApiKey(apiKey: string | null | undefined): string {
    const key = apiKey?.trim();
    if (!key) {
        throw new Error(
            "AssemblyAI API key is missing; set ASSEMBLYAI_API_KEY before transcribing.",
        );
    }
    return key;
}

function isKnownStatus(value: unknown): value is AssemblyAiStatus {
    return (
        value === "queued" ||
        value === "processing" ||
        value === "completed" ||
        value === "error"
    );
}

/**
 * Fold a non-2xx response into a thrown Error carrying the HTTP status and,
 * when the body is AssemblyAI's `{ error: "..." }` JSON, that message (otherwise
 * the raw body) — truncated so a giant body can't flood the logs. Returns
 * without touching the body when the response is ok, leaving it for the caller.
 */
async function throwIfNotOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    let detail = body;
    try {
        const parsed = JSON.parse(body) as { error?: unknown };
        if (parsed && typeof parsed.error === "string") detail = parsed.error;
    } catch {
        // Body wasn't JSON — keep the raw text.
    }
    const truncated = detail.slice(0, MAX_ERROR_BODY_CHARS);
    throw new Error(
        `AssemblyAI request failed (${response.status})${
            truncated ? `: ${truncated}` : ""
        }`,
    );
}

/**
 * Map AssemblyAI's utterances onto Utterance[]. Their speaker is a bare label
 * ("A"), which we render as "Speaker A"; a non-string/absent speaker becomes
 * "Speaker ?". start/end are already in ms → start_ms/end_ms. Every other
 * concern (dropping a member with no string text, dropping non-objects, coercing
 * non-finite times to 0) is delegated to parseUtterances, so a garbage entry can
 * never crash the pipeline. Absent/non-array utterances yield [].
 */
function mapUtterances(value: unknown): Utterance[] {
    if (!Array.isArray(value)) return [];
    const mapped = value.map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return null;
        }
        const raw = item as Record<string, unknown>;
        return {
            speaker:
                typeof raw.speaker === "string"
                    ? `Speaker ${raw.speaker}`
                    : "Speaker ?",
            text: raw.text,
            start_ms: raw.start,
            end_ms: raw.end,
        };
    });
    return parseUtterances(mapped);
}

/**
 * Kick off a diarized transcription. `speaker_labels` is ALWAYS true (a locked
 * product decision — there is no knob for it). Throws before any request when
 * the key is missing, and on any non-2xx response.
 */
export async function submitTranscription(params: {
    audioUrl: string;
    apiKey: string | null;
    fetchImpl?: FetchImpl;
}): Promise<AssemblyAiSubmitResult> {
    const key = requireApiKey(params.apiKey);
    const doFetch = params.fetchImpl ?? globalThis.fetch;

    const response = await doFetch(`${ASSEMBLYAI_BASE_URL}/transcript`, {
        method: "POST",
        headers: {
            authorization: key,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            audio_url: params.audioUrl,
            speaker_labels: true,
        }),
    });
    await throwIfNotOk(response);

    const json = (await response.json()) as { id?: unknown; status?: unknown };
    return {
        id: typeof json.id === "string" ? json.id : "",
        status: isKnownStatus(json.status) ? json.status : "error",
    };
}

/**
 * Read a transcription back and map AssemblyAI's payload onto our shape: absent
 * text → null, absent/null utterances → [], audio_duration (seconds) →
 * audio_duration_seconds. An unexpected status string is treated as "error" with
 * an explanatory message — never left as a poll-forever "processing". Throws only
 * on a missing key or a non-2xx response; a transcript whose OWN status is
 * "error" comes back mapped, not thrown (the pipeline decides what to do).
 */
export async function getTranscription(params: {
    transcriptId: string;
    apiKey: string | null;
    fetchImpl?: FetchImpl;
}): Promise<AssemblyAiTranscriptResult> {
    const key = requireApiKey(params.apiKey);
    const doFetch = params.fetchImpl ?? globalThis.fetch;

    const response = await doFetch(
        `${ASSEMBLYAI_BASE_URL}/transcript/${encodeURIComponent(
            params.transcriptId,
        )}`,
        { method: "GET", headers: { authorization: key } },
    );
    await throwIfNotOk(response);

    const json = (await response.json()) as Record<string, unknown>;
    const known = isKnownStatus(json.status);
    const status: AssemblyAiStatus = known
        ? (json.status as AssemblyAiStatus)
        : "error";
    const error = !known
        ? `AssemblyAI returned an unexpected transcript status: ${JSON.stringify(
              json.status,
          )}`
        : typeof json.error === "string"
          ? json.error
          : null;

    return {
        id: typeof json.id === "string" ? json.id : params.transcriptId,
        status,
        text: typeof json.text === "string" ? json.text : null,
        error,
        audio_duration_seconds:
            typeof json.audio_duration === "number" &&
            Number.isFinite(json.audio_duration)
                ? json.audio_duration
                : null,
        utterances: mapUtterances(json.utterances),
    };
}
