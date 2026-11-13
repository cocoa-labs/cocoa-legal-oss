import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { isRetryableFinishReason } from "./types";
import { toClaudeTools } from "./tools";
// buildSchemaPrompt lives in structured.ts, which imports back from this
// module (completeClaudeStructured). The cycle is benign: both edges are
// only dereferenced at call time, never during module evaluation.
import { buildSchemaPrompt } from "./structured";
import { capabilitiesForModel } from "./models";

type ContentBlock =
    | { type: "text"; text: string }
    | {
          type: "image";
          source: {
              type: "base64";
              media_type: "image/png" | "image/jpeg" | "image/webp";
              data: string;
          };
      }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown };

type NativeMessage = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
};

// Anthropic request fragment controlling extended thinking.
//
// Opting in yields the adaptive form every Claude 4.x+ model requires (effort
// replaces the retired fixed token budget). Opting out is the subtle case: on
// the 5 family, omitting `thinking` entirely runs adaptive thinking BY DEFAULT
// and max_tokens then caps thinking + visible text together, which silently
// truncates small-budget callers (title generation runs at 64 tokens). Those
// models get an explicit disable. Fable 5 is the exception — it rejects
// `{type: "disabled"}` with a 400 because thinking is always on — so it gets
// no thinking field at all. 4.x and older keep byte-identical requests.
export function claudeThinkingConfig(
    model: string,
    enableThinking: boolean,
): Record<string, unknown> {
    if (enableThinking) {
        return {
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
        };
    }
    if (model.startsWith("claude-fable-")) return {};
    if (model.startsWith("claude-sonnet-5") || model.startsWith("claude-opus-5")) {
        return { thinking: { type: "disabled" } };
    }
    return {};
}

function apiKey(override?: string | null): string {
    const key = override?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "Anthropic API key is not configured. Set ANTHROPIC_API_KEY or add a user Anthropic key.",
        );
    }
    return key;
}

function client(override?: string | null): Anthropic {
    const apiKeyValue = apiKey(override);
    return new Anthropic({ apiKey: apiKeyValue });
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): NativeMessage[] {
    return messages.map((m) => ({
        role: m.role,
        content:
            typeof m.content === "string"
                ? m.content
                : m.content.map((part) =>
                      part.type === "text"
                          ? { type: "text", text: part.text }
                          : {
                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type: part.mimeType,
                                    data: part.data,
                                },
                            },
                  ),
    }));
}

export async function streamClaude(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const anthropic = client(apiKeys?.claude);
    const claudeTools = toClaudeTools(tools);
    const modelLimit = capabilitiesForModel(model).maxOutputTokens;
    const maxTokens = Math.min(
        params.maxOutputTokens ?? modelLimit,
        modelLimit,
    );
    const maxContinuations = params.maxContinuations ?? 2;

    const messages: NativeMessage[] = toNativeMessages(params.messages);
    let fullText = "";
    let finishReason: StreamChatResult["finishReason"] = "completed";
    let iterations = 0;
    let continuations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let providerFinishReason: string | null = null;

    for (let iter = 0; iter < maxIter; iter++) {
        iterations = iter + 1;
        if (params.signal?.aborted) {
            finishReason = "cancelled";
            break;
        }
        const stream = anthropic.messages.stream(
            {
                model,
                system: systemPrompt,
                messages: messages as Anthropic.MessageParam[],
                tools: claudeTools.length
                    ? (claudeTools as unknown as Tool[])
                    : undefined,
                max_tokens: maxTokens,
                ...(claudeThinkingConfig(
                    model,
                    !!enableThinking,
                ) as unknown as Record<string, never>),
                // Extended thinking requires temperature to be default (omitted).
            },
            { signal: params.signal },
        );

        let sawThinking = false;
        let activeToolName = "tool";
        let toolInputChars = 0;

        stream.on("text", (delta) => {
            callbacks.onContentDelta?.(delta);
        });
        if (enableThinking) {
            stream.on("thinking", (delta) => {
                sawThinking = true;
                callbacks.onReasoningDelta?.(delta);
            });
        }
        stream.on("streamEvent", (event) => {
            if (
                event.type === "content_block_start" &&
                event.content_block.type === "tool_use"
            ) {
                activeToolName = event.content_block.name;
                toolInputChars = 0;
            }
        });
        stream.on("inputJson", (delta) => {
            toolInputChars += delta.length;
            callbacks.onToolInputProgress?.({
                name: activeToolName,
                deltaChars: delta.length,
                totalChars: toolInputChars,
            });
        });

        let final: Anthropic.Message;
        try {
            final = await stream.finalMessage();
        } catch (err) {
            if (params.signal?.aborted) {
                finishReason = "cancelled";
                break;
            }
            throw err;
        }
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        const stopReason = String(final.stop_reason ?? "end_turn");
        providerFinishReason = stopReason;
        inputTokens += final.usage?.input_tokens ?? 0;
        outputTokens += final.usage?.output_tokens ?? 0;
        const assistantBlocks = final.content as ContentBlock[];

        // Extract text content and tool_use calls from the final assistant
        // message so we can accumulate text and drive the tool-call loop.
        const toolCalls: NormalizedToolCall[] = [];
        for (const block of assistantBlocks) {
            if (block.type === "text") {
                const txt = (block as { text: string }).text;
                if (typeof txt === "string") fullText += txt;
            } else if (block.type === "tool_use") {
                const tu = block as {
                    id: string;
                    name: string;
                    input: unknown;
                };
                const call: NormalizedToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input as Record<string, unknown>) ?? {},
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }
        }

        if (stopReason === "max_tokens") {
            console.error(
                `[claude] hit max_tokens=${maxTokens} (iter ${iter}, toolCalls=${toolCalls.length})`,
            );
            if (!toolCalls.length && continuations < maxContinuations) {
                continuations++;
                messages.push({ role: "assistant", content: assistantBlocks });
                messages.push({
                    role: "user",
                    content:
                        "Continue exactly where you stopped. Do not repeat completed text.",
                });
                continue;
            }
            finishReason = "max_output";
            break;
        }

        if (stopReason === "model_context_window_exceeded") {
            finishReason = "context_limit";
            break;
        }
        if (stopReason === "refusal") {
            finishReason = "refused";
            break;
        }

        if (
            stopReason !== "tool_use" &&
            stopReason !== "end_turn" &&
            stopReason !== "stop_sequence"
        ) {
            finishReason = "error";
            break;
        }

        if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
            finishReason = "completed";
            break;
        }

        const results = await runTools(toolCalls);

        // Record the assistant turn (preserving the original content blocks,
        // which Claude requires on the follow-up) and the user turn that
        // carries the tool_result blocks.
        messages.push({ role: "assistant", content: assistantBlocks });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                content: r.content,
            })),
        });

        if (iter === maxIter - 1) finishReason = "iteration_limit";
    }

    return {
        fullText,
        finishReason,
        providerFinishReason,
        retryable: isRetryableFinishReason(finishReason),
        usage: { inputTokens, outputTokens },
        iterations,
    };
}

export async function completeClaudeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { claude?: string | null };
}): Promise<string> {
    const anthropic = client(params.apiKeys?.claude);
    const modelLimit = capabilitiesForModel(params.model).maxOutputTokens;
    const resp = await anthropic.messages.create({
        model: params.model,
        max_tokens: Math.min(params.maxTokens ?? 512, modelLimit),
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.user }],
        ...(claudeThinkingConfig(params.model, false) as Record<string, never>),
    });
    if (resp.stop_reason === "refusal") {
        throw new Error("[refused] Claude refused the completion.");
    }
    if (resp.stop_reason === "max_tokens") {
        throw new Error("[max_output] Claude reached its output limit.");
    }
    if (String(resp.stop_reason) === "model_context_window_exceeded") {
        throw new Error("[context_limit] Claude exceeded its context window.");
    }
    const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    return text;
}

// The one failure class allowed to fall back to prompt-and-parse: the API
// rejecting the structured-output request shape itself (e.g. a model or
// deployment without structured-output support). Auth, rate-limit, overload,
// and network errors must propagate — retries are the caller's job.
function isStructuredOutputUnsupported(err: unknown): boolean {
    if (!(err instanceof APIError)) return false;
    if (err.status !== 400) return false;
    return /output_config|output_format|structured output/i.test(
        String(err.message ?? ""),
    );
}

// Structured-output completion against Claude, used only via
// completeStructured (structured.ts). This is a prompt-injection boundary
// for untrusted email/PDF content: the request NEVER carries tools and never
// enables thinking. Attempt 1 uses native structured outputs
// (output_config.format — the GA surface in @anthropic-ai/sdk 0.104, which
// supersedes the older `output_format` + structured-outputs-2025-11-13
// beta); attempt 2 re-sends without the schema constraint, baking the schema
// into the prompt instead, and only fires when attempt 1 was rejected as
// unsupported.
export async function completeClaudeStructured(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    documents?: { data: string; filename?: string }[];
    schema: Record<string, unknown>;
    // Accepted for the completeStructured contract; the current SDK's
    // json_schema output format has no name slot, so it is not sent.
    schemaName?: string;
    maxTokens?: number;
    apiKeys?: { claude?: string | null };
}): Promise<{ raw: string; usedNativeStructured: boolean }> {
    const anthropic = client(params.apiKeys?.claude);
    const maxTokens = Math.min(
        params.maxTokens ?? 8192,
        capabilitiesForModel(params.model).maxOutputTokens,
    );

    // Each PDF goes first as a native document block, then the text block.
    const userBlocks = (text: string): Anthropic.ContentBlockParam[] => [
        ...(params.documents ?? []).map(
            (doc): Anthropic.DocumentBlockParam => ({
                type: "document",
                source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: doc.data,
                },
                title: doc.filename ?? null,
            }),
        ),
        { type: "text", text },
    ];

    const textOf = (resp: Anthropic.Message): string =>
        resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");

    try {
        // Attempt 1 — schema-constrained decoding. The user text is sent
        // UNCHANGED: the schema is enforced by the API, not the prompt.
        const resp = await anthropic.messages.create({
            model: params.model,
            max_tokens: maxTokens,
            system: params.systemPrompt,
            messages: [{ role: "user", content: userBlocks(params.user) }],
            output_config: {
                format: { type: "json_schema", schema: params.schema },
            },
            ...(claudeThinkingConfig(params.model, false) as Record<
                string,
                never
            >),
        });
        if (resp.stop_reason === "refusal") {
            throw new Error("[refused] Claude refused the structured completion.");
        }
        if (resp.stop_reason === "max_tokens") {
            throw new Error("[max_output] Claude truncated the structured completion.");
        }
        return { raw: textOf(resp), usedNativeStructured: true };
    } catch (err) {
        if (!isStructuredOutputUnsupported(err)) throw err;
    }

    // Attempt 2 — prompt-and-parse fallback. PDF document blocks are GA (no
    // beta needed) and stay attached; only the user text changes.
    const resp = await anthropic.messages.create({
        model: params.model,
        max_tokens: maxTokens,
        system: params.systemPrompt,
        messages: [
            {
                role: "user",
                content: userBlocks(
                    buildSchemaPrompt(params.user, params.schema),
                ),
            },
        ],
        ...(claudeThinkingConfig(params.model, false) as Record<string, never>),
    });
    if (resp.stop_reason === "refusal") {
        throw new Error("[refused] Claude refused the structured completion.");
    }
    if (resp.stop_reason === "max_tokens") {
        throw new Error("[max_output] Claude truncated the structured completion.");
    }
    return { raw: textOf(resp), usedNativeStructured: false };
}

// Helper re-export for callers wanting to hand normalized results back in.
export type { NormalizedToolResult };
