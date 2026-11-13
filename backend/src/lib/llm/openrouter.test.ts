import assert from "node:assert/strict";
import { openRouterAttributionHeaders, streamOpenRouter } from "./openrouter";
import type { NormalizedToolCall, NormalizedToolResult } from "./types";

// --- SSE plumbing -----------------------------------------------------------

function sse(chunks: unknown[]): string {
    return (
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
        "data: [DONE]\n\n"
    );
}

/**
 * Stubs global fetch with a canned SSE body, and records the request bodies so
 * tests can assert on the second-iteration tool replay.
 */
function stubFetch(bodies: string[]) {
    const requests: Record<string, unknown>[] = [];
    let call = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        const body = bodies[Math.min(call, bodies.length - 1)];
        call++;
        return {
            ok: true,
            status: 200,
            body: {
                getReader() {
                    let done = false;
                    return {
                        read: async () => {
                            if (done) return { done: true, value: undefined };
                            done = true;
                            return {
                                done: false,
                                value: new TextEncoder().encode(body),
                            };
                        },
                        releaseLock() {},
                    };
                },
            },
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { requests, restore: () => (globalThis.fetch = original) };
}

const baseParams = {
    model: "anthropic/claude-sonnet-5",
    systemPrompt: "You are helpful.",
    messages: [{ role: "user" as const, content: "Hi" }],
    apiKeys: { openrouter: "sk-or-test" },
};

async function run() {
    // --- plain text stream + usage -----------------------------------------
    {
        const stub = stubFetch([
            sse([
                { choices: [{ delta: { content: "Hello" } }] },
                { choices: [{ delta: { content: " there" } }] },
                { choices: [{ delta: {}, finish_reason: "stop" }] },
                {
                    choices: [],
                    usage: { prompt_tokens: 11, completion_tokens: 4 },
                },
            ]),
        ]);
        let streamed = "";
        const res = await streamOpenRouter({
            ...baseParams,
            callbacks: { onContentDelta: (d) => (streamed += d) },
        });
        stub.restore();
        assert.equal(res.fullText, "Hello there");
        assert.equal(streamed, "Hello there", "deltas reach the callback");
        assert.equal(res.finishReason, "completed");
        assert.equal(res.usage.inputTokens, 11);
        assert.equal(res.usage.outputTokens, 4);
    }

    // --- reasoning deltas ---------------------------------------------------
    {
        const stub = stubFetch([
            sse([
                { choices: [{ delta: { reasoning: "thinking..." } }] },
                { choices: [{ delta: { content: "Answer" } }] },
                { choices: [{ delta: {}, finish_reason: "stop" }] },
            ]),
        ]);
        let reasoning = "";
        let blockEnds = 0;
        const res = await streamOpenRouter({
            ...baseParams,
            enableThinking: true,
            callbacks: {
                onReasoningDelta: (d) => (reasoning += d),
                onReasoningBlockEnd: () => blockEnds++,
            },
        });
        stub.restore();
        assert.equal(reasoning, "thinking...");
        assert.equal(blockEnds, 1, "reasoning block closes once content starts");
        assert.equal(res.fullText, "Answer");
        assert.equal(stub.requests[0].reasoning !== undefined, true);
    }

    // --- tool calls: fragmented arguments, two parallel calls ---------------
    {
        const stub = stubFetch([
            sse([
                {
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_a",
                                        function: {
                                            name: "get_weather",
                                            arguments: '{"ci',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
                {
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 1,
                                        id: "call_b",
                                        function: {
                                            name: "list_matters",
                                            arguments: "{}",
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
                {
                    // Arguments for call 0 arrive split across deltas and
                    // interleaved with the second call.
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        function: { arguments: 'ty":"Austin"}' },
                                    },
                                ],
                            },
                        },
                    ],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            ]),
            sse([
                { choices: [{ delta: { content: "Sunny in Austin." } }] },
                { choices: [{ delta: {}, finish_reason: "stop" }] },
            ]),
        ]);
        const started: NormalizedToolCall[] = [];
        let seenCalls: NormalizedToolCall[] = [];
        const res = await streamOpenRouter({
            ...baseParams,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "weather",
                        parameters: { type: "object", properties: {} },
                    },
                },
            ],
            callbacks: { onToolCallStart: (c) => started.push(c) },
            runTools: async (
                calls: NormalizedToolCall[],
            ): Promise<NormalizedToolResult[]> => {
                seenCalls = calls;
                return calls.map((c) => ({
                    tool_use_id: c.id,
                    content: `result for ${c.name}`,
                }));
            },
        });
        stub.restore();

        assert.equal(seenCalls.length, 2, "both parallel calls are dispatched");
        assert.deepEqual(seenCalls[0], {
            id: "call_a",
            name: "get_weather",
            input: { city: "Austin" },
        });
        assert.deepEqual(seenCalls[1].input, {});
        assert.equal(started.length, 2, "each call announces itself once");
        assert.equal(res.fullText, "Sunny in Austin.");
        assert.equal(res.iterations, 2);

        // The follow-up request must replay the assistant tool_calls turn and
        // one tool-role message per result, or the provider 400s.
        const followUp = stub.requests[1] as {
            messages: Record<string, any>[];
        };
        const assistantTurn = followUp.messages.find(
            (m) => m.role === "assistant",
        );
        assert.ok(assistantTurn?.tool_calls?.length === 2);
        assert.equal(assistantTurn.tool_calls[0].id, "call_a");
        assert.equal(
            assistantTurn.tool_calls[0].function.name,
            "get_weather",
        );
        const toolTurns = followUp.messages.filter((m) => m.role === "tool");
        assert.equal(toolTurns.length, 2);
        assert.equal(toolTurns[0].tool_call_id, "call_a");
        assert.equal(toolTurns[0].content, "result for get_weather");
    }

    // --- length -> continuation, then exhaustion ---------------------------
    {
        const lengthBody = sse([
            { choices: [{ delta: { content: "partial" } }] },
            { choices: [{ delta: {}, finish_reason: "length" }] },
        ]);
        const stub = stubFetch([lengthBody, lengthBody, lengthBody]);
        const res = await streamOpenRouter({
            ...baseParams,
            maxContinuations: 1,
        });
        stub.restore();
        assert.equal(res.finishReason, "max_output");
        assert.equal(
            stub.requests.length,
            2,
            "one continuation attempt, then it gives up",
        );
        const continued = stub.requests[1] as { messages: { content: any }[] };
        const last = continued.messages[continued.messages.length - 1];
        assert.match(String(last.content), /Continue exactly where you stopped/);
    }

    // --- content_filter -> refused -----------------------------------------
    {
        const stub = stubFetch([
            sse([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }]),
        ]);
        const res = await streamOpenRouter({ ...baseParams });
        stub.restore();
        assert.equal(res.finishReason, "refused");
    }

    // --- mid-stream provider error must throw ------------------------------
    {
        const stub = stubFetch([
            sse([{ error: { message: "upstream is overloaded", code: 502 } }]),
        ]);
        await assert.rejects(
            () => streamOpenRouter({ ...baseParams }),
            /overloaded/i,
            "a mid-stream error surfaces so the runtime fallback can act",
        );
        stub.restore();
    }

    // --- missing key --------------------------------------------------------
    {
        const saved = process.env.OPENROUTER_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
        await assert.rejects(
            () => streamOpenRouter({ ...baseParams, apiKeys: {} }),
            /OpenRouter API key is not configured/,
        );
        if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }

    // --- request shape ------------------------------------------------------
    {
        const stub = stubFetch([
            sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
        ]);
        await streamOpenRouter({ ...baseParams, maxOutputTokens: 1234 });
        stub.restore();
        const body = stub.requests[0] as Record<string, any>;
        assert.equal(body.model, "anthropic/claude-sonnet-5");
        assert.equal(body.stream, true);
        assert.equal(body.stream_options.include_usage, true);
        assert.equal(body.max_tokens, 1234, "caller cap is honored");
        assert.equal(body.messages[0].role, "system");
        assert.equal(
            body.reasoning,
            undefined,
            "reasoning is omitted unless thinking was requested",
        );
    }

    // --- attribution headers: no deployer-independent site default --------
    {
        const bare = openRouterAttributionHeaders({});
        assert.deepEqual(
            Object.keys(bare),
            ["X-Title"],
            "with no site configured, HTTP-Referer is omitted entirely",
        );
        assert.ok(bare["X-Title"], "X-Title always carries an app name");

        assert.equal(
            openRouterAttributionHeaders({ FRONTEND_URL: "https://legal.example.com" })[
                "HTTP-Referer"
            ],
            "https://legal.example.com",
            "falls back to the deployer's FRONTEND_URL",
        );
        assert.equal(
            openRouterAttributionHeaders({
                OPENROUTER_SITE_URL: "https://or.example.com",
                FRONTEND_URL: "https://legal.example.com",
            })["HTTP-Referer"],
            "https://or.example.com",
            "OPENROUTER_SITE_URL wins over FRONTEND_URL",
        );
        assert.equal(
            openRouterAttributionHeaders({ FRONTEND_URL: "   " })["HTTP-Referer"],
            undefined,
            "whitespace-only values count as unset",
        );
        assert.equal(
            openRouterAttributionHeaders({ OPENROUTER_APP_NAME: "Example Legal" })["X-Title"],
            "Example Legal",
        );
    }

    console.log("llm/openrouter.test.ts: all passed");
}

void run();
