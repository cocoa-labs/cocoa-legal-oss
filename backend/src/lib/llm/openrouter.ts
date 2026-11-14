import { capabilitiesForModel } from "./models";
import { extractSseJson } from "./sse";
import { toOpenRouterTools } from "./tools";
import type {
    LlmContentPart,
    LlmMessage,
    NormalizedToolCall,
    StreamChatParams,
    StreamChatResult,
} from "./types";
import { isRetryableFinishReason } from "./types";

// OpenRouter adapter — one key, the whole catalog.
//
// Transport mirrors openai.ts (raw fetch + hand-parsed SSE, no extra SDK), but
// the conversation is stateless like the Claude path: chat.completions has no
// server-side thread, so the full message list is replayed each iteration.

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_APP_NAME = "Cocoa Legal";

/**
 * Attribution headers for OpenRouter's dashboards and leaderboards. The
 * referer is always the deployer's own site — an OPENROUTER_SITE_URL
 * override, else FRONTEND_URL — and is omitted when neither is set, so no
 * deployment's traffic is credited to anyone else's domain.
 */
export function openRouterAttributionHeaders(
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const headers: Record<string, string> = {
        "X-Title": env.OPENROUTER_APP_NAME?.trim() || DEFAULT_APP_NAME,
    };
    const site = env.OPENROUTER_SITE_URL?.trim() || env.FRONTEND_URL?.trim();
    if (site) headers["HTTP-Referer"] = site;
    return headers;
}
const CONTINUATION_PROMPT =
    "Continue exactly where you stopped. Do not repeat completed text.";

function apiKey(override?: string | null): string {
    const key = override?.trim() || process.env.OPENROUTER_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "OpenRouter API key is not configured. Set OPENROUTER_API_KEY or add a user OpenRouter key.",
        );
    }
    return key;
}

type ChatMessage =
    | { role: "system" | "user" | "assistant"; content: unknown }
    | {
          role: "assistant";
          content: string | null;
          tool_calls: {
              id: string;
              type: "function";
              function: { name: string; arguments: string };
          }[];
      }
    | { role: "tool"; tool_call_id: string; content: string };

function toChatContent(content: LlmMessage["content"]): unknown {
    if (typeof content === "string") return content;
    return content.map((part: LlmContentPart) =>
        part.type === "text"
            ? { type: "text", text: part.text }
            : {
                  type: "image_url",
                  image_url: { url: `data:${part.mimeType};base64,${part.data}` },
              },
    );
}

/** Accumulates streamed tool-call fragments, which arrive keyed by index. */
type PendingCall = { id: string; name: string; args: string };

export async function streamOpenRouter(
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
    const key = apiKey(apiKeys?.openrouter);
    const maxIter = params.maxIterations ?? 10;
    const maxContinuations = params.maxContinuations ?? 2;
    const modelLimit = capabilitiesForModel(model).maxOutputTokens;
    const maxTokens = Math.min(params.maxOutputTokens ?? modelLimit, modelLimit);
    const requestTools = toOpenRouterTools(tools);

    const messages: ChatMessage[] = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...params.messages.map((m) => ({
            role: m.role,
            content: toChatContent(m.content),
        })),
    ];

    let fullText = "";
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

        const resp = await fetch(OPENROUTER_CHAT_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                // Attribution for OpenRouter's dashboards/leaderboards.
                ...openRouterAttributionHeaders(),
            },
            body: JSON.stringify({
                model,
                messages,
                ...(requestTools.length ? { tools: requestTools } : {}),
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: maxTokens,
                // Unified reasoning switch. Left off entirely when not wanted —
                // some catalog models mandate reasoning and reject an explicit
                // disable.
                ...(enableThinking ? { reasoning: { enabled: true } } : {}),
            }),
            signal: params.signal,
        });

        if (!resp.ok || !resp.body) {
            const detail = await resp.text().catch(() => "");
            throw new Error(
                `OpenRouter request failed (${resp.status}): ${detail.slice(0, 500)}`,
            );
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let iterText = "";
        let stopReason: string | null = null;
        let sawReasoning = false;
        let reasoningOpen = false;
        const pending = new Map<number, PendingCall>();

        const closeReasoning = () => {
            if (reasoningOpen) {
                reasoningOpen = false;
                callbacks.onReasoningBlockEnd?.();
            }
        };

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const { events, rest } = extractSseJson(buffer);
                buffer = rest;

                for (const event of events) {
                    const e = event as Record<string, any>;

                    // OpenRouter reports upstream failures as an in-band error
                    // frame rather than a non-2xx status.
                    if (e.error) {
                        throw new Error(
                            `OpenRouter stream error: ${e.error.message ?? JSON.stringify(e.error)}`,
                        );
                    }

                    if (e.usage) {
                        inputTokens += e.usage.prompt_tokens ?? 0;
                        outputTokens += e.usage.completion_tokens ?? 0;
                        reasoningTokens +=
                            e.usage.completion_tokens_details
                                ?.reasoning_tokens ?? 0;
                    }

                    const choice = e.choices?.[0];
                    if (!choice) continue;
                    const delta = choice.delta ?? {};

                    if (typeof delta.reasoning === "string" && delta.reasoning) {
                        sawReasoning = true;
                        reasoningOpen = true;
                        callbacks.onReasoningDelta?.(delta.reasoning);
                    }

                    if (typeof delta.content === "string" && delta.content) {
                        if (sawReasoning) closeReasoning();
                        iterText += delta.content;
                        fullText += delta.content;
                        callbacks.onContentDelta?.(delta.content);
                    }

                    for (const tc of delta.tool_calls ?? []) {
                        if (sawReasoning) closeReasoning();
                        const index: number = tc.index ?? 0;
                        const existing = pending.get(index);
                        if (!existing) {
                            const created: PendingCall = {
                                id: tc.id ?? `call_${index}`,
                                name: tc.function?.name ?? "",
                                args: tc.function?.arguments ?? "",
                            };
                            pending.set(index, created);
                            if (created.name) {
                                callbacks.onToolCallStart?.({
                                    id: created.id,
                                    name: created.name,
                                    input: {},
                                });
                            }
                            if (created.args) {
                                callbacks.onToolInputProgress?.({
                                    name: created.name,
                                    deltaChars: created.args.length,
                                    totalChars: created.args.length,
                                });
                            }
                        } else {
                            if (tc.id) existing.id = tc.id;
                            if (tc.function?.name && !existing.name) {
                                existing.name = tc.function.name;
                                callbacks.onToolCallStart?.({
                                    id: existing.id,
                                    name: existing.name,
                                    input: {},
                                });
                            }
                            const fragment: string =
                                tc.function?.arguments ?? "";
                            if (fragment) {
                                existing.args += fragment;
                                callbacks.onToolInputProgress?.({
                                    name: existing.name,
                                    deltaChars: fragment.length,
                                    totalChars: existing.args.length,
                                });
                            }
                        }
                    }

                    if (choice.finish_reason) stopReason = choice.finish_reason;
                }
            }
        } catch (err) {
            if (params.signal?.aborted) {
                finishReason = "cancelled";
                break;
            }
            throw err;
        } finally {
            reader.releaseLock?.();
            closeReasoning();
        }

        const calls: NormalizedToolCall[] = [...pending.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, c]) => {
                let input: Record<string, unknown> = {};
                try {
                    const parsed = JSON.parse(c.args || "{}");
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        input = parsed as Record<string, unknown>;
                    }
                } catch {
                    // A truncated argument blob yields an empty input; the
                    // tool layer reports the failure back to the model.
                }
                return { id: c.id, name: c.name, input };
            });
        providerFinishReason = stopReason;

        if (calls.length && runTools) {
            const results = await runTools(calls);
            messages.push({
                role: "assistant",
                content: iterText || null,
                tool_calls: calls.map((c) => ({
                    id: c.id,
                    type: "function" as const,
                    function: {
                        name: c.name,
                        arguments: JSON.stringify(c.input),
                    },
                })),
            });
            for (const call of calls) {
                const match = results.find((r) => r.tool_use_id === call.id);
                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: match?.content ?? "",
                });
            }
            if (iter === maxIter - 1) finishReason = "iteration_limit";
            continue;
        }

        if (stopReason === "length") {
            // Text-only truncation can be continued; a truncated tool call
            // cannot be, so this only runs when no calls were emitted.
            if (continuations < maxContinuations) {
                continuations++;
                messages.push({ role: "assistant", content: iterText });
                messages.push({ role: "user", content: CONTINUATION_PROMPT });
                continue;
            }
            finishReason = "max_output";
            break;
        }

        if (stopReason === "content_filter") {
            finishReason = "refused";
            break;
        }

        finishReason = "completed";
        break;
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

export async function completeOpenRouterText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openrouter?: string | null };
}): Promise<string> {
    const key = apiKey(params.apiKeys?.openrouter);
    const modelLimit = capabilitiesForModel(params.model).maxOutputTokens;
    const resp = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...openRouterAttributionHeaders(),
        },
        body: JSON.stringify({
            model: params.model,
            messages: [
                ...(params.systemPrompt
                    ? [{ role: "system", content: params.systemPrompt }]
                    : []),
                { role: "user", content: params.user },
            ],
            max_tokens: Math.min(params.maxTokens ?? 512, modelLimit),
        }),
    });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(
            `OpenRouter request failed (${resp.status}): ${detail.slice(0, 500)}`,
        );
    }
    const body = (await resp.json()) as Record<string, any>;
    if (body.error) {
        throw new Error(`OpenRouter error: ${body.error.message ?? "unknown"}`);
    }
    const choice = body.choices?.[0];
    // Error prefixes match the sibling adapters so callers branch uniformly.
    if (choice?.finish_reason === "length") {
        throw new Error("[max_output] OpenRouter reached its output limit.");
    }
    if (choice?.finish_reason === "content_filter") {
        throw new Error("[refused] OpenRouter refused the completion.");
    }
    return String(choice?.message?.content ?? "");
}
