// backend/src/lib/images/imageTools.ts
//
// The chat image tool family: `generate_image` (prompt → image) and
// `edit_image` (image-to-image via a text instruction). Schemas are the same
// OpenAI-style shape every other Quill tool uses, so the provider adapters
// (claude/openai/gemini) translate them automatically. The model discovers the
// capability purely from these descriptions — which is what turns the old
// "I can't create images" refusal into an actual generate.
//
// runImageToolCall mirrors runRecordingToolCall: it returns a text/JSON
// toolResult the model reads (with the document_id + a human-readable message)
// plus an `imageGenerated` side-channel payload the stream turns into an
// `image_generated` SSE event + persisted AssistantEvent (the inline card).

import type { createServerSupabase } from "../supabase";
import type { OpenAIToolSchema } from "../llm/types";
import {
    editChatImage,
    generateChatImage,
    type ChatImageDeps,
} from "./generateChatImage";
import type { EditImageSource } from "./sourceImage";

type Db = ReturnType<typeof createServerSupabase>;

export const IMAGE_TOOLS: OpenAIToolSchema[] = [
    {
        type: "function",
        function: {
            name: "generate_image",
            description:
                "Create a brand-new image from a text description and show it inline in the chat. Use this whenever the user asks you to create, generate, draw, design, or make an image, infographic, diagram, chart-style graphic, illustration, icon, logo concept, poster, or any other visual. The image is saved as a document the user can view, download, edit, or attach to an email. Note: the model renders scenes/illustrations/simple graphics well, but long or precise blocks of text inside the image may not render perfectly — keep any in-image text short. Do NOT claim you cannot create images; call this tool.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description:
                            "A detailed description of the image to create. Include subject, style, layout, colors, mood, and any short text labels that must appear.",
                    },
                    orientation: {
                        type: "string",
                        enum: ["square", "landscape", "portrait"],
                        description:
                            "Shape of the image. Use 'landscape' for infographics/banners/slides, 'square' for icons/illustrations, 'portrait' for posters. Defaults to landscape.",
                    },
                    quality: {
                        type: "string",
                        enum: ["low", "medium", "high"],
                        description:
                            "Rendering quality. Defaults to high (best detail/legibility). Use low/medium only for quick rough drafts.",
                    },
                },
                required: ["prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_image",
            description:
                "Edit an EXISTING image with a text instruction (image-to-image) and show the result inline. Use when the user asks to change, modify, tweak, adjust, restyle, add to, or remove something from an image — whether it was generated in this chat or uploaded by the user. By default this edits the most recent image in the conversation. To edit a specific earlier image you generated, pass its document_id in `source`. The edited result is saved as a new image document.",
            parameters: {
                type: "object",
                properties: {
                    instruction: {
                        type: "string",
                        description:
                            "What to change, e.g. 'make the header navy and add our logo top-right' or 'remove the background'.",
                    },
                    source: {
                        type: "object",
                        description:
                            "Optional: which image to edit. Omit to edit the most recent image in the chat.",
                        properties: {
                            document_id: {
                                type: "string",
                                description:
                                    "The document_id of a previously generated image to edit.",
                            },
                            attachment_id: {
                                type: "string",
                                description:
                                    "The attachment_id of an image the user uploaded to edit.",
                            },
                        },
                    },
                },
                required: ["instruction"],
            },
        },
    },
];

export const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set(
    IMAGE_TOOLS.map((t) => t.function.name),
);

/** The inline-card payload streamed + persisted for a produced image. */
export interface ImageGeneratedEvent {
    type: "image_generated";
    document_id: string;
    filename: string;
    prompt: string;
    kind: "generate" | "edit";
}

function describeError(err: unknown): string {
    return err instanceof Error && err.message ? err.message : String(err);
}

/** Parse the model's `source` arg into an EditImageSource, or null if absent. */
function parseSourceArg(raw: unknown): EditImageSource | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as { document_id?: unknown; attachment_id?: unknown };
    const documentId =
        typeof obj.document_id === "string" && obj.document_id.trim()
            ? obj.document_id.trim()
            : null;
    const attachmentId =
        typeof obj.attachment_id === "string" && obj.attachment_id.trim()
            ? obj.attachment_id.trim()
            : null;
    if (!documentId && !attachmentId) return null;
    return { document_id: documentId, attachment_id: attachmentId };
}

/**
 * Dispatch one image tool call. Tenancy is the session userId. Returns the
 * model-facing toolResult and, on success, an `imageGenerated` payload the
 * caller streams as an `image_generated` event and records for reload.
 */
export async function runImageToolCall(params: {
    name: string;
    args: Record<string, unknown>;
    db: Db;
    userId: string;
    projectId?: string | null;
    chatId?: string | null;
    /** Per-turn source bound by the "Edit" button; used when the model omits one. */
    editImageSource?: EditImageSource | null;
    deps?: ChatImageDeps;
}): Promise<{ toolResult: unknown; imageGenerated?: ImageGeneratedEvent }> {
    const { name, args, db, userId, projectId, chatId } = params;

    if (name === "generate_image") {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
            return {
                toolResult: {
                    ok: false,
                    error: "A prompt describing the image is required.",
                },
            };
        }
        const orientation =
            typeof args.orientation === "string" ? args.orientation : undefined;
        const quality =
            typeof args.quality === "string" ? args.quality : undefined;
        try {
            const r = await generateChatImage({
                db,
                userId,
                projectId: projectId ?? null,
                prompt,
                orientation,
                quality,
                deps: params.deps,
            });
            return {
                toolResult: {
                    ok: true,
                    document_id: r.documentId,
                    filename: r.filename,
                    message:
                        "The image was generated and is shown in a card directly below your reply, where the user can view, download, edit, or attach it to an email. It is saved as a document. In your reply, briefly say what you created; do not paste the image or a link, and do not say it appears above — the card renders below your text.",
                },
                imageGenerated: {
                    type: "image_generated",
                    document_id: r.documentId,
                    filename: r.filename,
                    prompt,
                    kind: "generate",
                },
            };
        } catch (err) {
            return {
                toolResult: {
                    ok: false,
                    error: `Failed to generate the image: ${describeError(err)}`,
                },
            };
        }
    }

    if (name === "edit_image") {
        const instruction =
            typeof args.instruction === "string" ? args.instruction.trim() : "";
        if (!instruction) {
            return {
                toolResult: {
                    ok: false,
                    error: "An instruction describing the edit is required.",
                },
            };
        }
        const source =
            parseSourceArg(args.source) ?? params.editImageSource ?? null;
        try {
            const r = await editChatImage({
                db,
                userId,
                projectId: projectId ?? null,
                chatId: chatId ?? null,
                instruction,
                source,
                deps: params.deps,
            });
            return {
                toolResult: {
                    ok: true,
                    document_id: r.documentId,
                    filename: r.filename,
                    message:
                        "The edited image is shown in a card directly below your reply and saved as a new image document. In your reply, briefly say what you changed; do not paste the image or a link, and do not say it appears above — the card renders below your text.",
                },
                imageGenerated: {
                    type: "image_generated",
                    document_id: r.documentId,
                    filename: r.filename,
                    prompt: instruction,
                    kind: "edit",
                },
            };
        } catch (err) {
            return {
                toolResult: {
                    ok: false,
                    error: `Failed to edit the image: ${describeError(err)}`,
                },
            };
        }
    }

    return { toolResult: { ok: false, error: `Unknown image tool: ${name}` } };
}
