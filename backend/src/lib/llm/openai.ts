import type {
    LlmMessage,
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";
import { isRetryableFinishReason } from "./types";
import { capabilitiesForModel } from "./models";
import { extractSseJson } from "./sse";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
type ResponseInputItem =
    | {
          role: "user" | "assistant";
          content:
              | string
              | (
                    | { type: "input_text"; text: string }
                    | { type: "input_image"; image_url: string }
                )[];
      }
    | { type: "function_call_output"; call_id: string; output: string };

type ResponseFunctionTool = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
};

type ResponseFunctionCallItem = {
    type: "function_call";
    call_id?: string;
    name?: string;
    arguments?: string;
};

type ResponseStreamEvent = {
    type?: string;
    delta?: string;
    response?: {
        id?: string;
        output_text?: string;
        status?: string;
        incomplete_details?: { reason?: string };
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            output_tokens_details?: { reasoning_tokens?: number };
        };
    };
    item?: ResponseFunctionCallItem;
};

function apiKey(override?: string | null): string {
    const key = override?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "OpenAI API key is not configured. Set OPENAI_API_KEY or add a user OpenAI key.",
        );
    }
    return key;
}

function toResponseTools(tools: OpenAIToolSchema[]): ResponseFunctionTool[] {
    return tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

function toResponseContent(content: LlmMessage["content"]) {
    if (typeof content === "string") return content;
    return content
        .map((part) => {
            if (part.type === "text") {
                return { type: "input_text" as const, text: part.text };
            }
            return {
                type: "input_image" as const,
                image_url: `data:${part.mimeType};base64,${part.data}`,
            };
        })
        .filter(Boolean) as (
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string }
    )[];
}

function toResponseInput(messages: LlmMessage[]): ResponseInputItem[] {
    return messages.map((message) => ({
        role: message.role,
        content: toResponseContent(message.content),
    }));
}

function parseFunctionCall(item: ResponseFunctionCallItem): NormalizedToolCall {
    let input: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(item.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
        }
    } catch {
        input = {};
    }

    return {
        id: item.call_id ?? item.name ?? "function_call",
        name: item.name ?? "",
        input,
    };
}

async function createResponse(params: {
    model: string;
    input: ResponseInputItem[];
    instructions?: string;
    tools?: ResponseFunctionTool[];
    stream?: boolean;
    maxTokens?: number;
    previousResponseId?: string;
    reasoningSummary?: boolean;
    apiKey: string;
    signal?: AbortSignal;
}): Promise<Response> {
    const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: params.model,
            instructions: params.instructions || undefined,
            input: params.input,
            tools: params.tools?.length ? params.tools : undefined,
            stream: params.stream,
            max_output_tokens: params.maxTokens,
            previous_response_id: params.previousResponseId,
            reasoning: params.reasoningSummary
                ? { summary: "auto" }
                : undefined,
        }),
        signal: params.signal,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const err = new Error(
            `OpenAI request failed (${response.status}): ${text || response.statusText}`,
        );
        (err as { status?: number }).status = response.status;
        throw err;
    }

    return response;
}

export async function streamOpenAI(
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
    const key = apiKey(apiKeys?.openai);
    const responseTools = toResponseTools(tools);
    const modelLimit = capabilitiesForModel(model).maxOutputTokens;
    const maxTokens = Math.min(
        params.maxOutputTokens ?? modelLimit,
        modelLimit,
    );
    const maxContinuations = params.maxContinuations ?? 2;
    let input = toResponseInput(params.messages);
    let previousResponseId: string | undefined;
    let fullText = "";
    const hasTools = responseTools.length > 0;
    let finishReason: StreamChatResult["finishReason"] = "completed";
    let iterations = 0;
    let continuations = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let providerFinishReason: string | null = null;

    for (let iter = 0; iter < maxIter; iter++) {
        iterations = iter + 1;
        if (params.signal?.aborted) {
            finishReason = "cancelled";
            break;
        }
        const response = await createResponse({
            model,
            instructions: iter === 0 ? systemPrompt : undefined,
            input,
            tools: responseTools,
            stream: true,
            previousResponseId,
            reasoningSummary: !!enableThinking,
            apiKey: key,
            maxTokens,
            signal: params.signal,
        });
        if (!response.body) throw new Error("OpenAI response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const toolCalls: NormalizedToolCall[] = [];
        const startedToolCallIds = new Set<string>();
        let buffer = "";
        let pendingText = "";
        let sawReasoning = false;
        let responseStatus = "completed";
        let incompleteReason = "";
        let activeToolName = "tool";
        let toolInputChars = 0;

        // `pendingText` is buffered (not streamed) whenever tools are
        // registered so prose can be ordered against tool calls. Every exit
        // from this response must drain it, or the text is lost server-side —
        // never streamed, never in fullText, never persisted.
        const flushPendingText = () => {
            if (!pendingText) return;
            fullText += pendingText;
            callbacks.onContentDelta?.(pendingText);
            pendingText = "";
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const extracted = extractSseJson(buffer);
                buffer = extracted.rest;

                for (const event of extracted.events as ResponseStreamEvent[]) {
                    if (event.response?.id) {
                        previousResponseId = event.response.id;
                    }
                    if (event.response?.status)
                        responseStatus = event.response.status;
                    if (event.response?.incomplete_details?.reason) {
                        incompleteReason =
                            event.response.incomplete_details.reason;
                    }
                    if (event.response?.usage) {
                        inputTokens =
                            event.response.usage.input_tokens ?? inputTokens;
                        outputTokens =
                            event.response.usage.output_tokens ?? outputTokens;
                        reasoningTokens =
                            event.response.usage.output_tokens_details
                                ?.reasoning_tokens ?? reasoningTokens;
                    }

                    if (
                        event.type ===
                            "response.reasoning_summary_text.delta" &&
                        typeof event.delta === "string"
                    ) {
                        sawReasoning = true;
                        callbacks.onReasoningDelta?.(event.delta);
                    }

                    if (
                        event.type === "response.output_text.delta" &&
                        typeof event.delta === "string"
                    ) {
                        if (hasTools) {
                            pendingText += event.delta;
                        } else {
                            fullText += event.delta;
                            callbacks.onContentDelta?.(event.delta);
                        }
                    }

                    if (
                        event.type === "response.output_item.added" &&
                        event.item?.type === "function_call"
                    ) {
                        // Prose emitted before this tool call — flush first so
                        // it reaches the event log in the order the model
                        // produced it.
                        flushPendingText();
                        const call = parseFunctionCall(event.item);
                        activeToolName = call.name || "tool";
                        toolInputChars = 0;
                        startedToolCallIds.add(call.id);
                        callbacks.onToolCallStart?.(call);
                    }

                    if (
                        event.type ===
                            "response.function_call_arguments.delta" &&
                        typeof event.delta === "string"
                    ) {
                        toolInputChars += event.delta.length;
                        callbacks.onToolInputProgress?.({
                            name: activeToolName,
                            deltaChars: event.delta.length,
                            totalChars: toolInputChars,
                        });
                    }

                    if (
                        event.type === "response.refusal.delta" &&
                        typeof event.delta === "string"
                    ) {
                        // Prose emitted before the refusal has to land first:
                        // chatTools persists in callback order, so flushing
                        // afterwards would store the refusal ahead of the
                        // sentence it followed.
                        flushPendingText();
                        finishReason = "refused";
                        callbacks.onContentDelta?.(event.delta);
                        fullText += event.delta;
                    }

                    if (
                        event.type === "response.output_item.done" &&
                        event.item?.type === "function_call"
                    ) {
                        const call = parseFunctionCall(event.item);
                        if (!startedToolCallIds.has(call.id)) {
                            callbacks.onToolCallStart?.(call);
                        }
                        toolCalls.push(call);
                    }
                }
            }

            if (sawReasoning) callbacks.onReasoningBlockEnd?.();
        } finally {
            // Drains the buffer on the way out, whichever way that is: the
            // status breaks (cancelled, failed, refused, context_limit,
            // max_output), the continuation branch, the runTools hand-off
            // (where the next iteration would otherwise re-declare the buffer),
            // and — because this is a `finally` — a rejected `reader.read()`.
            // That last one is the live cancellation path: `createResponse`
            // hands `signal` to fetch, so aborting errors the body stream
            // rather than ending it, and the rejection propagates straight past
            // this loop. The helper clears `pendingText`, so a flush that
            // already ran inside the loop cannot re-emit here, and this block
            // never swallows the in-flight error.
            flushPendingText();
        }
        providerFinishReason = incompleteReason
            ? `${responseStatus}:${incompleteReason}`
            : responseStatus;

        if (params.signal?.aborted || responseStatus === "cancelled") {
            finishReason = "cancelled";
            break;
        }
        if (responseStatus === "failed") {
            finishReason = "error";
            break;
        }
        if (finishReason === "refused") break;

        if (responseStatus === "incomplete") {
            const contextLimited = /context/i.test(incompleteReason);
            if (contextLimited) {
                finishReason = "context_limit";
                break;
            }
            if (!toolCalls.length && continuations < maxContinuations) {
                continuations++;
                input = [
                    {
                        role: "user",
                        content:
                            "Continue exactly where you stopped. Do not repeat completed text.",
                    },
                ];
                continue;
            }
            finishReason = "max_output";
            break;
        }

        if (!toolCalls.length || !runTools) break;

        const results = await runTools(toolCalls);
        input = results.map((result) => ({
            type: "function_call_output",
            call_id: result.tool_use_id,
            output: result.content,
        }));
        if (iter === maxIter - 1) finishReason = "iteration_limit";
    }

    return {
        fullText,
        finishReason,
        providerFinishReason,
        retryable: isRetryableFinishReason(finishReason),
        usage: { inputTokens, outputTokens, reasoningTokens },
        iterations,
    };
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const response = await createResponse({
        model: params.model,
        instructions: params.systemPrompt,
        input: [{ role: "user", content: params.user }],
        maxTokens: Math.min(
            params.maxTokens ?? 512,
            capabilitiesForModel(params.model).maxOutputTokens,
        ),
        apiKey: apiKey(params.apiKeys?.openai),
    });
    const json = (await response.json()) as {
        status?: string;
        incomplete_details?: { reason?: string } | null;
        output_text?: string;
        output?: {
            content?: { type?: string; text?: string; refusal?: string }[];
        }[];
    };

    const refused = json.output
        ?.flatMap((item) => item.content ?? [])
        .some((content) => content.type === "refusal");
    if (refused) throw new Error("[refused] OpenAI refused the completion.");
    if (json.status === "incomplete") {
        const reason = json.incomplete_details?.reason ?? "max_output";
        throw new Error(
            /context/i.test(reason)
                ? "[context_limit] OpenAI exceeded its context window."
                : "[max_output] OpenAI reached its output limit.",
        );
    }
    if (json.status === "failed") {
        throw new Error("[error] OpenAI completion failed.");
    }

    if (typeof json.output_text === "string") return json.output_text;

    return (
        json.output
            ?.flatMap((item) => item.content ?? [])
            .filter((content) => content.type === "output_text")
            .map((content) => content.text ?? "")
            .join("") ?? ""
    );
}

export type { NormalizedToolResult };
