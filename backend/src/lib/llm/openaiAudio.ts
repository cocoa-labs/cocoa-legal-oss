// backend/src/lib/llm/openaiAudio.ts
//
// One-shot HTTP client for OpenAI's text-to-speech endpoint — the recordings
// voice-briefing's only door to OpenAI TTS. A single call: synthesizeSpeech
// (POST /audio/speech) turns a briefing script into mp3 bytes. The orchestrator
// (recordings/briefing.ts) owns sizing the script; this client does exactly one
// request per call and is otherwise stateless.
//
// Style mirrors lib/llm/openai.ts: raw fetch against a REST endpoint, the OpenAI
// key resolved user-key→env with the SAME precedence as openai.ts's private
// apiKey() helper (replicated faithfully — it is not exported there), Bearer
// auth, and explicit non-2xx surfacing. `fetchImpl` is injectable (defaults to
// globalThis.fetch) so tests never hit the network. The key is never logged or
// folded into a thrown message.

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

/** OpenAI's hard cap on the TTS `input` field. Callers own staying under it;
 * this is the last-line guard so a runaway script never fires a doomed request. */
export const OPENAI_TTS_INPUT_CAP = 4096;

// Cap the slice of an error body folded into a thrown Error — enough to read
// OpenAI's message (including an org-verification notice) without flooding logs.
const MAX_ERROR_BODY_CHARS = 500;

type FetchImpl = typeof globalThis.fetch;

/**
 * Resolve the OpenAI key with openai.ts's exact precedence: a trimmed per-user
 * BYOK key wins, else the trimmed OPENAI_API_KEY env, else a thrown error (never
 * echoing the key). Replicated rather than imported because openai.ts's apiKey()
 * is module-private.
 */
function resolveApiKey(override?: string | null): string {
    const key = override?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "OpenAI API key is not configured. Set OPENAI_API_KEY or add a user OpenAI key.",
        );
    }
    return key;
}

/**
 * Fold a non-2xx response into a thrown Error carrying the HTTP status and, when
 * the body is OpenAI's `{ error: { message } }` (or `{ error: "..." }`) JSON,
 * that message — otherwise the raw body — truncated so a giant body can't flood
 * the logs. The key is not part of the message.
 */
async function throwIfNotOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    let detail = body;
    try {
        const parsed = JSON.parse(body) as {
            error?: { message?: unknown } | string;
        };
        if (parsed && typeof parsed.error === "string") {
            detail = parsed.error;
        } else if (
            parsed &&
            typeof parsed.error === "object" &&
            typeof parsed.error?.message === "string"
        ) {
            detail = parsed.error.message;
        }
    } catch {
        // Body wasn't JSON — keep the raw text.
    }
    const truncated = detail.slice(0, MAX_ERROR_BODY_CHARS);
    throw new Error(
        `OpenAI TTS request failed (${response.status})${
            truncated ? `: ${truncated}` : ""
        }`,
    );
}

/**
 * Synthesize spoken audio from `text` via OpenAI TTS, returning the mp3 bytes.
 * Throws BEFORE any request on empty/whitespace text, on text over the
 * 4096-char OpenAI cap, and on a missing key; throws on any non-2xx with the
 * status + a truncated body detail. `fetchImpl` is injectable for tests.
 */
export async function synthesizeSpeech(params: {
    text: string;
    model: string;
    voice: string;
    apiKeys?: { openai?: string | null };
    fetchImpl?: FetchImpl;
}): Promise<Buffer> {
    const text = params.text ?? "";
    if (!text.trim()) {
        throw new Error("Cannot synthesize speech from empty text.");
    }
    if (text.length > OPENAI_TTS_INPUT_CAP) {
        throw new Error(
            `TTS input is ${text.length} characters; the maximum is ${OPENAI_TTS_INPUT_CAP}.`,
        );
    }
    const key = resolveApiKey(params.apiKeys?.openai);
    const doFetch = params.fetchImpl ?? globalThis.fetch;

    const response = await doFetch(OPENAI_TTS_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: params.model,
            voice: params.voice,
            input: text,
            response_format: "mp3",
        }),
    });
    await throwIfNotOk(response);

    return Buffer.from(await response.arrayBuffer());
}
