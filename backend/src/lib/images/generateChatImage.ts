// backend/src/lib/images/generateChatImage.ts
//
// Orchestrators for the chat image tools: prompt → OpenAI gpt-image → persist as
// a first-class document (so it renders inline, downloads, and can be emailed).
// Mirrors recordings/timelineImage.ts's shape (resolve keys → call model →
// persist), but is chat-scoped and matter-agnostic (projectId may be null for a
// main-chat generation, which persists as a standalone document).
//
// The image model is ALWAYS openaiImageModel(env) — the single source of the
// "gpt-image-2" default lives in recordings/env.ts; nothing is hardcoded here.
// Every collaborator is injectable for tests. Failures THROW with the verbatim
// OpenAI detail (the tool layer maps them to a user-facing message).

import type { createServerSupabase } from "../supabase";
import type { UserApiKeys } from "../llm/types";
import {
    editImage,
    generateImage,
    sizeForOrientation,
} from "../llm/openaiImage";
import { openaiImageModel } from "../recordings/env";
import { getUserApiKeys } from "../userSettings";
import { persistGeneratedDocument } from "../documents/persistGeneratedDocument";
import {
    loadSourceImageBytes,
    resolveLatestChatImage,
    type EditImageSource,
} from "./sourceImage";

type Db = ReturnType<typeof createServerSupabase>;
type Env = NodeJS.ProcessEnv;

export interface GenerateChatImageResult {
    documentId: string;
    versionId: string;
    filename: string;
}

/** Injectable collaborators; every default is the real implementation. */
export interface ChatImageDeps {
    getUserApiKeysFn?: (userId: string, db: Db) => Promise<UserApiKeys>;
    generateImageFn?: typeof generateImage;
    editImageFn?: typeof editImage;
    persistFn?: typeof persistGeneratedDocument;
    loadSourceImageBytesFn?: typeof loadSourceImageBytes;
    resolveLatestChatImageFn?: typeof resolveLatestChatImage;
}

const VALID_QUALITIES = new Set(["low", "medium", "high"]);

/** Resolve the image quality: explicit request → OPENAI_IMAGE_QUALITY → "high". */
function resolveQuality(requested: string | undefined, env: Env): string {
    const q = requested?.trim().toLowerCase();
    if (q && VALID_QUALITIES.has(q)) return q;
    const envQ = env.OPENAI_IMAGE_QUALITY?.trim().toLowerCase();
    if (envQ && VALID_QUALITIES.has(envQ)) return envQ;
    return "high";
}

/** Best-effort BYOK keys (a failure degrades to {} — mirror of the pipeline). */
async function resolveApiKeys(
    userId: string,
    db: Db,
    fn: ChatImageDeps["getUserApiKeysFn"],
): Promise<UserApiKeys> {
    try {
        return await (fn ?? getUserApiKeys)(userId, db);
    } catch {
        return {};
    }
}

/** A short human title for the stored filename, derived from the prompt. */
function titleFromPrompt(prompt: string): string {
    return prompt.trim().replace(/\s+/g, " ").slice(0, 48) || "Image";
}

/**
 * Generate a fresh image from `prompt` and persist it. `orientation` picks the
 * gpt-image size (square/landscape/portrait, default landscape); `quality`
 * defaults to high.
 */
export async function generateChatImage(params: {
    db: Db;
    userId: string;
    projectId?: string | null;
    prompt: string;
    orientation?: string;
    quality?: string;
    env?: Env;
    deps?: ChatImageDeps;
}): Promise<GenerateChatImageResult> {
    const env = params.env ?? process.env;
    const deps = params.deps ?? {};
    const prompt = params.prompt?.trim() ?? "";
    if (!prompt) throw new Error("Cannot generate an image from an empty prompt.");

    const apiKeys = await resolveApiKeys(params.userId, params.db, deps.getUserApiKeysFn);

    const bytes = await (deps.generateImageFn ?? generateImage)({
        prompt,
        model: openaiImageModel(env),
        size: sizeForOrientation(params.orientation),
        quality: resolveQuality(params.quality, env),
        apiKeys,
    });

    return (deps.persistFn ?? persistGeneratedDocument)({
        db: params.db,
        userId: params.userId,
        projectId: params.projectId ?? null,
        title: titleFromPrompt(prompt),
        label: "image",
        extension: "png",
        fileType: "png",
        contentType: "image/png",
        bytes,
        derivationKind: "chat_image_generation",
    });
}

/**
 * Edit an existing image per `instruction` and persist the result as a new
 * document. The source is `source` when it carries an id, else the most recent
 * image in `chatId`; throws when neither yields an image.
 */
export async function editChatImage(params: {
    db: Db;
    userId: string;
    projectId?: string | null;
    chatId?: string | null;
    instruction: string;
    source?: EditImageSource | null;
    quality?: string;
    env?: Env;
    deps?: ChatImageDeps;
}): Promise<GenerateChatImageResult> {
    const env = params.env ?? process.env;
    const deps = params.deps ?? {};
    const instruction = params.instruction?.trim() ?? "";
    if (!instruction) throw new Error("Cannot edit an image from an empty instruction.");

    let ref: EditImageSource | null =
        params.source && (params.source.document_id || params.source.attachment_id)
            ? params.source
            : null;
    if (!ref && params.chatId) {
        ref = await (deps.resolveLatestChatImageFn ?? resolveLatestChatImage)({
            db: params.db,
            chatId: params.chatId,
            userId: params.userId,
        });
    }
    if (!ref) {
        throw new Error(
            "There is no image to edit yet — generate or attach an image first.",
        );
    }

    const source = await (deps.loadSourceImageBytesFn ?? loadSourceImageBytes)({
        db: params.db,
        userId: params.userId,
        projectId: params.projectId ?? null,
        ref,
    });

    const apiKeys = await resolveApiKeys(params.userId, params.db, deps.getUserApiKeysFn);

    const bytes = await (deps.editImageFn ?? editImage)({
        prompt: instruction,
        model: openaiImageModel(env),
        image: {
            bytes: source.bytes,
            mimeType: source.mimeType,
            filename: source.filename,
        },
        quality: resolveQuality(params.quality, env),
        apiKeys,
    });

    return (deps.persistFn ?? persistGeneratedDocument)({
        db: params.db,
        userId: params.userId,
        projectId: params.projectId ?? null,
        title: titleFromPrompt(instruction),
        label: "image edit",
        extension: "png",
        fileType: "png",
        contentType: "image/png",
        bytes,
        derivationKind: "chat_image_edit",
    });
}
