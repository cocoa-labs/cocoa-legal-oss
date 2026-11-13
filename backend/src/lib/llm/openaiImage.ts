// backend/src/lib/llm/openaiImage.ts
//
// One-shot HTTP client for OpenAI's image-generation endpoint — the recordings
// timeline-graphic's only door to OpenAI image generation. A single call:
// generateImage (POST /images/generations) turns a prompt into PNG bytes. The
// orchestrator (recordings/timelineImage.ts) owns building the prompt and picks
// the model via env (openaiImageModel) — this client never hardcodes a model.
//
// Style mirrors lib/llm/openai.ts: raw fetch, the OpenAI key resolved
// user-key→env with the SAME precedence as openai.ts's private apiKey() helper
// (replicated faithfully — it is not exported there), Bearer auth, and explicit
// non-2xx surfacing. A non-2xx body's message is surfaced VERBATIM (within the
// truncation cap): the user-pinned gpt-image-2 can 403 with an org-verification
// notice, and that must reach the user readable. `fetchImpl` is injectable
// (defaults to globalThis.fetch); the key is never logged or thrown.

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";

/** Default image size when the caller does not pin one (wide, deck-friendly). */
export const DEFAULT_IMAGE_SIZE = "1536x1024";

/** The three orientations the chat image tools expose, mapped to gpt-image sizes. */
export type ImageOrientation = "square" | "landscape" | "portrait";

const ORIENTATION_SIZE: Record<ImageOrientation, string> = {
    square: "1024x1024",
    landscape: "1536x1024",
    portrait: "1024x1536",
};

/**
 * Map a caller's orientation to a gpt-image `size` string. An unknown/absent
 * orientation falls back to `landscape` (the deck-friendly default the timeline
 * graphic already uses).
 */
export function sizeForOrientation(orientation?: string | null): string {
    if (orientation && orientation in ORIENTATION_SIZE) {
        return ORIENTATION_SIZE[orientation as ImageOrientation];
    }
    return ORIENTATION_SIZE.landscape;
}

// Cap the slice of an error body folded into a thrown Error — enough to read an
// org-verification message without flooding logs.
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
 * that message VERBATIM — otherwise the raw body — truncated so a giant body
 * can't flood the logs. The key is not part of the message.
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
        `OpenAI image request failed (${response.status})${
            truncated ? `: ${truncated}` : ""
        }`,
    );
}

/**
 * Decode the PNG bytes from an OpenAI image response's `data[0].b64_json`.
 * Throws when the (already 2xx) response carries no image data. Shared by
 * generateImage and editImage — both endpoints return the same b64 shape.
 */
async function decodeImageResponse(response: Response): Promise<Buffer> {
    const json = (await response.json()) as {
        data?: { b64_json?: unknown }[];
    };
    const b64 = json.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) {
        throw new Error(
            "OpenAI image response contained no b64_json image data.",
        );
    }
    return Buffer.from(b64, "base64");
}

/**
 * Generate one image from `prompt`, returning the PNG bytes decoded from the
 * response's `data[0].b64_json`. Throws BEFORE any request on an empty prompt
 * and on a missing key; throws on any non-2xx with the status + a verbatim body
 * detail, and when the 2xx response carries no b64_json. `size` defaults to
 * 1536x1024; `model` is always the caller's (env-resolved) choice. `quality`
 * is sent ONLY when provided (defensive: a model that rejects the field still
 * surfaces its verbatim error rather than us pre-committing to a value).
 */
export async function generateImage(params: {
    prompt: string;
    model: string;
    size?: string;
    quality?: string;
    apiKeys?: { openai?: string | null };
    fetchImpl?: FetchImpl;
}): Promise<Buffer> {
    const prompt = params.prompt ?? "";
    if (!prompt.trim()) {
        throw new Error("Cannot generate an image from an empty prompt.");
    }
    const key = resolveApiKey(params.apiKeys?.openai);
    const doFetch = params.fetchImpl ?? globalThis.fetch;

    const body: Record<string, unknown> = {
        model: params.model,
        prompt,
        size: params.size ?? DEFAULT_IMAGE_SIZE,
        n: 1,
    };
    if (params.quality) body.quality = params.quality;

    const response = await doFetch(OPENAI_IMAGE_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    await throwIfNotOk(response);
    return decodeImageResponse(response);
}

/**
 * Edit an EXISTING image (image-to-image): POST multipart/form-data to
 * `/v1/images/edits` with the source image + a text instruction, returning the
 * new PNG bytes. Mirrors generateImage's key resolution / error surfacing.
 * Uses global FormData/Blob (Node 18+); the Content-Type (with the multipart
 * boundary) is set by fetch, so it is intentionally NOT passed in headers.
 * Throws before any request on an empty prompt / empty image / missing key.
 * `quality` and `size` are sent only when provided.
 */
export async function editImage(params: {
    prompt: string;
    model: string;
    image: { bytes: Buffer; mimeType: string; filename?: string };
    size?: string;
    quality?: string;
    apiKeys?: { openai?: string | null };
    fetchImpl?: FetchImpl;
}): Promise<Buffer> {
    const prompt = params.prompt ?? "";
    if (!prompt.trim()) {
        throw new Error("Cannot edit an image from an empty instruction.");
    }
    if (!params.image?.bytes?.byteLength) {
        throw new Error("Cannot edit an image without source image bytes.");
    }
    const key = resolveApiKey(params.apiKeys?.openai);
    const doFetch = params.fetchImpl ?? globalThis.fetch;

    // Copy into a standalone ArrayBuffer — a Buffer from a decoder can be a
    // view into a pooled/detachable buffer that Blob would otherwise capture.
    const view = params.image.bytes;
    const ab = view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
    ) as ArrayBuffer;

    const form = new FormData();
    form.append("model", params.model);
    form.append("prompt", prompt);
    form.append("n", "1");
    if (params.size) form.append("size", params.size);
    if (params.quality) form.append("quality", params.quality);
    form.append(
        "image",
        new Blob([ab], { type: params.image.mimeType || "image/png" }),
        params.image.filename ?? "source.png",
    );

    const response = await doFetch(OPENAI_IMAGE_EDIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
    });
    await throwIfNotOk(response);
    return decodeImageResponse(response);
}
