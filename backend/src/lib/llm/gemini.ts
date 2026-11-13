import { GoogleGenAI } from "@google/genai";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";
import { isRetryableFinishReason } from "./types";
import { toGeminiTools } from "./tools";
import { capabilitiesForModel } from "./models";

type GeminiPart = {
    text?: string;
    inlineData?: {
        mimeType: "image/png" | "image/jpeg" | "image/webp";
        data: string;
    };
    // Set by Gemini when the text content is a thought summary rather than
    // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
    thought?: boolean;
    functionCall?: {
        id?: string;
        name: string;
        args?: Record<string, unknown>;
    };
    functionResponse?: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
    };
    // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
    // a functionCall. It must be echoed back verbatim on the same part when
    // we replay the model's turn, or the API rejects the next call.
    thoughtSignature?: string;
};

type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};

function apiKey(override?: string | null): string {
    const key = override?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "Gemini API key is not configured. Set GEMINI_API_KEY or add a user Gemini key.",
        );
    }
    return key;
}

function client(override?: string | null): GoogleGenAI {
    return new GoogleGenAI({ apiKey: apiKey(override) });
}

type GeminiStreamClient = Pick<GoogleGenAI, "models">;

function toNativeContents(
    messages: StreamChatParams["messages"],
): GeminiContent[] {
    return messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts:
            typeof m.content === "string"
                ? [{ text: m.content }]
                : m.content.map((part) =>
                      part.type === "text"
                          ? { text: part.text }
                          : {
                                inlineData: {
                                    mimeType: part.mimeType,
                                    data: part.data,
                                },
                            },
                  ),
    }));
}

export async function streamGemini(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    return streamGeminiWithClient(params, client(params.apiKeys?.gemini));
}

/** Dependency-injected seam used by provider fixture tests. */
export async function streamGeminiWithClient(
    params: StreamChatParams,
    ai: GeminiStreamClient,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const functionDeclarations = toGeminiTools(tools);
    const modelLimit = capabilitiesForModel(model).maxOutputTokens;
    const maxTokens = Math.min(
        params.maxOutputTokens ?? modelLimit,
        modelLimit,
    );
    const maxContinuations = params.maxContinuations ?? 2;

    const contents: GeminiContent[] = toNativeContents(params.messages);
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
        const stream = await ai.models.generateContentStream({
            model,
            contents: contents as never,
            config: {
                maxOutputTokens: maxTokens,
                abortSignal: params.signal,
                systemInstruction: systemPrompt,
                tools: functionDeclarations.length
                    ? [{ functionDeclarations } as never]
                    : undefined,
                // When enabled, ask Gemini to surface thought summaries.
                // When disabled, explicitly zero the thinking budget so the
                // model skips thinking entirely (saves tokens and latency
                // for bulk extraction jobs).
                thinkingConfig: enableThinking
                    ? { includeThoughts: true }
                    : { thinkingBudget: 0 },
            },
        });

        // Per-iteration accumulators.
        const textParts: string[] = [];
        const callParts: GeminiPart[] = [];
        const toolCalls: NormalizedToolCall[] = [];
        let sawThinking = false;
        let nativeFinishReason = "STOP";

        for await (const chunk of stream) {
            const typedChunk = chunk as {
                candidates?: {
                    content?: { parts?: GeminiPart[] };
                    finishReason?: string;
                }[];
                usageMetadata?: {
                    promptTokenCount?: number;
                    candidatesTokenCount?: number;
                    thoughtsTokenCount?: number;
                };
            };
            nativeFinishReason =
                typedChunk.candidates?.[0]?.finishReason ?? nativeFinishReason;
            providerFinishReason = nativeFinishReason;
            if (typedChunk.usageMetadata?.promptTokenCount !== undefined) {
                inputTokens = typedChunk.usageMetadata.promptTokenCount;
            }
            if (
                typedChunk.usageMetadata?.candidatesTokenCount !== undefined ||
                typedChunk.usageMetadata?.thoughtsTokenCount !== undefined
            ) {
                outputTokens =
                    (typedChunk.usageMetadata.candidatesTokenCount ?? 0) +
                    (typedChunk.usageMetadata.thoughtsTokenCount ?? 0);
            }
            const parts = typedChunk.candidates?.[0]?.content?.parts ?? [];

            for (const part of parts) {
                if (part.text) {
                    if (part.thought) {
                        sawThinking = true;
                        callbacks.onReasoningDelta?.(part.text);
                    } else {
                        textParts.push(part.text);
                        callbacks.onContentDelta?.(part.text);
                    }
                }
                if (part.functionCall) {
                    // Preserve the whole part (including thoughtSignature)
                    // so it can be echoed verbatim in the replay turn.
                    callParts.push(part);
                    const call: NormalizedToolCall = {
                        id:
                            part.functionCall.id ??
                            `${part.functionCall.name}-${toolCalls.length}`,
                        name: part.functionCall.name,
                        input: part.functionCall.args ?? {},
                    };
                    callbacks.onToolCallStart?.(call);
                    const chars = JSON.stringify(call.input).length;
                    callbacks.onToolInputProgress?.({
                        name: call.name,
                        deltaChars: chars,
                        totalChars: chars,
                    });
                    toolCalls.push(call);
                }
            }
        }

        if (sawThinking) callbacks.onReasoningBlockEnd?.();

        fullText += textParts.join("");

        if (nativeFinishReason === "MAX_TOKENS") {
            if (!toolCalls.length && continuations < maxContinuations) {
                continuations++;
                contents.push({
                    role: "model",
                    parts: [{ text: textParts.join("") }],
                });
                contents.push({
                    role: "user",
                    parts: [
                        {
                            text: "Continue exactly where you stopped. Do not repeat completed text.",
                        },
                    ],
                });
                continue;
            }
            finishReason = "max_output";
            break;
        }
        if (/SAFETY|BLOCKLIST|PROHIBITED|RECITATION/.test(nativeFinishReason)) {
            finishReason = "refused";
            break;
        }
        if (nativeFinishReason !== "STOP") {
            finishReason = "error";
            break;
        }

        if (!toolCalls.length || !runTools) {
            finishReason = "completed";
            break;
        }

        const results = await runTools(toolCalls);

        // Append the model's turn (text + functionCall parts, in that order)
        // and the matching functionResponse turn.
        const modelParts: GeminiPart[] = [];
        if (textParts.length) modelParts.push({ text: textParts.join("") });
        for (const cp of callParts) modelParts.push(cp);
        contents.push({ role: "model", parts: modelParts });

        contents.push({
            role: "user",
            parts: results.map((r) => {
                const match = toolCalls.find((c) => c.id === r.tool_use_id);
                return {
                    functionResponse: {
                        ...(r.tool_use_id &&
                        !r.tool_use_id.startsWith(match?.name ?? "")
                            ? { id: r.tool_use_id }
                            : {}),
                        name: match?.name ?? "tool",
                        response: { output: r.content },
                    },
                };
            }),
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

export async function completeGeminiText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { gemini?: string | null };
}): Promise<string> {
    const ai = client(params.apiKeys?.gemini);
    const resp = await ai.models.generateContent({
        model: params.model,
        contents: [{ role: "user", parts: [{ text: params.user }] }],
        config: {
            ...(params.systemPrompt
                ? { systemInstruction: params.systemPrompt }
                : {}),
            maxOutputTokens: Math.min(
                params.maxTokens ?? 512,
                capabilitiesForModel(params.model).maxOutputTokens,
            ),
        },
    });
    const finishReason = String(resp.candidates?.[0]?.finishReason ?? "STOP");
    if (/SAFETY|BLOCKLIST|PROHIBITED|RECITATION/.test(finishReason)) {
        throw new Error("[refused] Gemini refused the completion.");
    }
    if (finishReason === "MAX_TOKENS") {
        throw new Error("[max_output] Gemini reached its output limit.");
    }
    if (finishReason !== "STOP") {
        throw new Error(`[error] Gemini completion ended with ${finishReason}.`);
    }
    return resp.text ?? "";
}
