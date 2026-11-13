// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

// "openrouter" is an aggregator rather than a first-party vendor: it routes a
// vendor/model id on to whichever upstream serves it. It sits alongside the
// native providers so the native paths stay untouched.
export type Provider = "claude" | "gemini" | "openai" | "openrouter";

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmContentPart =
    | { type: "text"; text: string }
    | {
          type: "image";
          mimeType: "image/png" | "image/jpeg" | "image/webp";
          data: string;
          filename?: string;
      };

export type LlmMessage = {
    role: "user" | "assistant";
    content: string | LlmContentPart[];
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
    onToolInputProgress?: (progress: {
        name: string;
        deltaChars: number;
        totalChars: number;
    }) => void;
};

export type LlmFinishReason =
    | "completed"
    | "max_output"
    | "context_limit"
    | "refused"
    | "cancelled"
    | "iteration_limit"
    | "error";

export type LlmUsage = {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
};

export type UserApiKeys = {
    claude?: string | null;
    gemini?: string | null;
    openai?: string | null;
    openrouter?: string | null;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable provider-side reasoning/thinking. Off by default — should only
     * be turned on for interactive chat surfaces where the user actually
     * benefits from seeing the thought stream. Bulk extraction jobs and
     * one-shot completions should leave this off to save tokens and latency.
     */
    enableThinking?: boolean;
    /** Provider request cancellation, normally tied to the HTTP client. */
    signal?: AbortSignal;
    /** Optional caller cap, clamped to the model's published maximum. */
    maxOutputTokens?: number;
    /** Text-only max-output continuations. Defaults to two. */
    maxContinuations?: number;
};

export type StreamChatResult = {
    fullText: string;
    finishReason: LlmFinishReason;
    /** Provider-native terminal status, retained for diagnostics/conformance. */
    providerFinishReason: string | null;
    /** Whether the normalized terminal state is safe to retry automatically. */
    retryable: boolean;
    usage: LlmUsage;
    iterations: number;
};

export function isRetryableFinishReason(reason: LlmFinishReason): boolean {
    return (
        reason === "error" ||
        reason === "max_output" ||
        reason === "iteration_limit"
    );
}
