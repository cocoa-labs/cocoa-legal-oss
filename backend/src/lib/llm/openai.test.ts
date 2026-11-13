// backend/src/lib/llm/openai.test.ts
//
// streamOpenAI buffers assistant prose into `pendingText` whenever tools are
// registered (always, in chat) so the text can be ordered relative to tool
// calls. These tests pin that the buffer is always flushed — never dropped.
// The regression they guard is prose emitted alongside a tool call: the buffer
// used to be re-declared on the next loop iteration, so anything the model said
// before calling a tool was lost server-side (never streamed, never in
// fullText, never persisted). The same drop hit the max_output-with-tool-calls
// exit. The continuation case is here to prove the hoisted flush did not change
// the text-only continuation semantics it replaced.
//
// There are two flush sites, and the cases below pin each one on its own:
//   (a) inside the `output_item.added` handler, so prose keeps its place ahead
//       of the tool call it preceded — and likewise ahead of a refusal;
//   (b) the `finally` after the read loop, which is the only thing that saves
//       prose emitted *after* the last tool call, and the only thing that saves
//       anything at all when `reader.read()` rejects mid-stream.
// Case 2 exists specifically because a case whose frames contain
// `output_item.added` is rescued by (a) and therefore cannot fail if (b)
// regresses.
//
// Everything is hermetic: `createResponse` calls the bare global fetch, so
// globalThis.fetch is stubbed with canned SSE bodies and restored in a finally.
import assert from "node:assert/strict";
import { streamOpenAI } from "./openai";
import type {
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
} from "./types";

const MODEL = "gpt-5.5";

const TOOLS: OpenAIToolSchema[] = [
    {
        type: "function",
        function: {
            name: "draft_document",
            description: "Draft a document.",
            parameters: { type: "object", properties: {} },
        },
    },
];

/** One `data: {...}\n\n` frame per event, shaped for extractSseJson. */
function sseBody(events: unknown[]): string {
    return (
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
        "data: [DONE]\n\n"
    );
}

function textDelta(delta: string) {
    return { type: "response.output_text.delta", delta };
}

function functionCallAdded(callId: string, name: string) {
    return {
        type: "response.output_item.added",
        item: { type: "function_call", call_id: callId, name, arguments: "" },
    };
}

function functionCallDone(callId: string, name: string, args: string) {
    return {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: callId, name, arguments: args },
    };
}

function refusalDelta(delta: string) {
    return { type: "response.refusal.delta", delta };
}

function completed(id: string) {
    return { type: "response.completed", response: { id, status: "completed" } };
}

function incomplete(id: string, reason: string) {
    return {
        type: "response.incomplete",
        response: {
            id,
            status: "incomplete",
            incomplete_details: { reason },
        },
    };
}

/** Either a whole canned body, or a stream that errors partway through. */
type CannedBody = string | ReadableStream<Uint8Array>;

/**
 * A body whose reader yields `chunks` and then rejects — the shape a real abort
 * produces. `createResponse` hands `signal` to fetch, so cancelling errors the
 * body stream rather than ending it, and the rejection escapes the read loop.
 */
function rejectingBody(
    chunks: string[],
    error: Error,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let next = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (next < chunks.length) {
                controller.enqueue(encoder.encode(chunks[next++]));
                return;
            }
            controller.error(error);
        },
    });
}

/**
 * A fetch that answers each successive call with the next canned SSE body and
 * records the request bodies it was given.
 */
function stubFetch(bodies: CannedBody[], captured: string[]): typeof fetch {
    let call = 0;
    return (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(String(init?.body ?? ""));
        const body = bodies[call++];
        if (body === undefined) {
            throw new Error(`unexpected OpenAI request #${call}`);
        }
        return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        });
    }) as typeof fetch;
}

/** Runs `fn` with globalThis.fetch stubbed, always restoring the real one. */
async function withStubbedFetch<T>(
    bodies: CannedBody[],
    fn: (captured: string[]) => Promise<T>,
): Promise<T> {
    const realFetch = globalThis.fetch;
    const captured: string[] = [];
    globalThis.fetch = stubFetch(bodies, captured);
    try {
        return await fn(captured);
    } finally {
        globalThis.fetch = realFetch;
    }
}

/** Ordered log of the streaming callbacks, so chronology can be asserted. */
type Event = { kind: "text" | "tool"; value: string };

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

async function main() {
    console.log("llm/openai.test.ts");

    // 1. the reported bug: prose emitted alongside a tool call ----------------
    await test(
        "keeps prose emitted before a tool call, in order, across the tool round-trip",
        async () => {
            const bodies = [
                sseBody([
                    textDelta("Here is the draft. "),
                    functionCallAdded("call_1", "draft_document"),
                    functionCallDone(
                        "call_1",
                        "draft_document",
                        '{"title":"NDA"}',
                    ),
                    completed("resp_1"),
                ]),
                sseBody([textDelta("Done."), completed("resp_2")]),
            ];

            const events: Event[] = [];
            const toolCalls: NormalizedToolCall[][] = [];

            const result = await withStubbedFetch(bodies, async (captured) => {
                const out = await streamOpenAI({
                    model: MODEL,
                    systemPrompt: "You are Quill.",
                    messages: [{ role: "user", content: "Draft an NDA." }],
                    tools: TOOLS,
                    apiKeys: { openai: "test-key" },
                    callbacks: {
                        onContentDelta: (text) =>
                            events.push({ kind: "text", value: text }),
                        onToolCallStart: (call) =>
                            events.push({ kind: "tool", value: call.name }),
                    },
                    runTools: async (
                        calls,
                    ): Promise<NormalizedToolResult[]> => {
                        toolCalls.push(calls);
                        return calls.map((call) => ({
                            tool_use_id: call.id,
                            content: "drafted",
                        }));
                    },
                });

                // The tool result must have been fed back on the second call —
                // otherwise this is not exercising the tool round-trip at all.
                assert.equal(captured.length, 2, "two OpenAI requests");
                const secondInput = JSON.parse(captured[1]).input;
                assert.equal(secondInput[0].type, "function_call_output");
                assert.equal(secondInput[0].call_id, "call_1");

                return out;
            });

            // The prose emitted alongside the tool call must survive.
            assert.equal(result.fullText, "Here is the draft. Done.");
            assert.equal(result.finishReason, "completed");
            assert.equal(result.providerFinishReason, "completed");
            assert.equal(result.retryable, false);
            assert.equal(result.iterations, 2);

            // It must also have been streamed to the client, not just totalled.
            const deltas = events
                .filter((event) => event.kind === "text")
                .map((event) => event.value);
            assert.ok(
                deltas.includes("Here is the draft. "),
                `pre-tool prose was never streamed: ${JSON.stringify(deltas)}`,
            );

            // Chronology: the prose preceded the tool call, so its delta must
            // reach the event log before onToolCallStart.
            const firstText = events.findIndex(
                (event) => event.kind === "text",
            );
            const firstTool = events.findIndex(
                (event) => event.kind === "tool",
            );
            assert.notEqual(firstTool, -1, "tool call started");
            assert.ok(
                firstText < firstTool,
                `prose must stream before the tool call: ${JSON.stringify(events)}`,
            );

            assert.equal(toolCalls.length, 1);
            assert.equal(toolCalls[0][0].name, "draft_document");
            assert.deepEqual(toolCalls[0][0].input, { title: "NDA" });
        },
    );

    // 2. prose emitted AFTER the tool call — only the post-loop flush saves it -
    await test(
        "keeps prose emitted after the tool call, which only the post-loop flush can rescue",
        async () => {
            // The buffer is empty when `output_item.added` fires, so the flush
            // inside that handler is a no-op here and cannot rescue anything.
            // The prose arrives afterwards and the response then ends with tool
            // calls present, so the `finally` after the read loop is the sole
            // remaining path. Narrowing that flush to `if (!toolCalls.length)`
            // reintroduces the reported bug and this case — and only this case —
            // catches it: fullText comes back as "Done.".
            const bodies = [
                sseBody([
                    functionCallAdded("call_2", "draft_document"),
                    functionCallDone("call_2", "draft_document", "{}"),
                    textDelta("Trailing prose."),
                    completed("resp_1"),
                ]),
                sseBody([textDelta("Done."), completed("resp_2")]),
            ];

            const deltas: string[] = [];
            const result = await withStubbedFetch(bodies, async (captured) => {
                const out = await streamOpenAI({
                    model: MODEL,
                    systemPrompt: "You are Quill.",
                    messages: [{ role: "user", content: "Draft an NDA." }],
                    tools: TOOLS,
                    apiKeys: { openai: "test-key" },
                    callbacks: {
                        onContentDelta: (text) => deltas.push(text),
                    },
                    runTools: async (
                        calls,
                    ): Promise<NormalizedToolResult[]> =>
                        calls.map((call) => ({
                            tool_use_id: call.id,
                            content: "drafted",
                        })),
                });

                // Confirm the tool round-trip really happened, so the first
                // response genuinely exited through the runTools hand-off.
                assert.equal(captured.length, 2, "two OpenAI requests");
                const secondInput = JSON.parse(captured[1]).input;
                assert.equal(secondInput[0].type, "function_call_output");
                assert.equal(secondInput[0].call_id, "call_2");

                return out;
            });

            assert.equal(result.fullText, "Trailing prose.Done.");
            assert.equal(result.finishReason, "completed");
            assert.equal(result.iterations, 2);
            assert.deepEqual(deltas, ["Trailing prose.", "Done."]);
        },
    );

    // 3. max_output reached with tool calls present ---------------------------
    await test(
        "keeps buffered prose when the response ends incomplete with tool calls",
        async () => {
            const bodies = [
                sseBody([
                    textDelta("Partial thought before the call. "),
                    functionCallAdded("call_9", "draft_document"),
                    functionCallDone("call_9", "draft_document", "{}"),
                    incomplete("resp_1", "max_output_tokens"),
                ]),
            ];

            const deltas: string[] = [];
            const result = await withStubbedFetch(bodies, () =>
                streamOpenAI({
                    model: MODEL,
                    systemPrompt: "You are Quill.",
                    messages: [{ role: "user", content: "Draft an NDA." }],
                    tools: TOOLS,
                    apiKeys: { openai: "test-key" },
                    callbacks: {
                        onContentDelta: (text) => deltas.push(text),
                    },
                    runTools: async () => [],
                }),
            );

            assert.equal(result.finishReason, "max_output");
            assert.equal(result.retryable, true);
            assert.equal(result.fullText, "Partial thought before the call. ");
            assert.deepEqual(deltas, ["Partial thought before the call. "]);
        },
    );

    // 4. the text-only continuation path must behave exactly as before --------
    await test(
        "still flushes and continues on a text-only incomplete response",
        async () => {
            const bodies = [
                sseBody([
                    textDelta("First half. "),
                    incomplete("resp_1", "max_output_tokens"),
                ]),
                sseBody([textDelta("Second half."), completed("resp_2")]),
            ];

            const deltas: string[] = [];
            const result = await withStubbedFetch(bodies, async (captured) => {
                const out = await streamOpenAI({
                    model: MODEL,
                    systemPrompt: "You are Quill.",
                    messages: [{ role: "user", content: "Write something." }],
                    tools: TOOLS,
                    apiKeys: { openai: "test-key" },
                    callbacks: {
                        onContentDelta: (text) => deltas.push(text),
                    },
                    runTools: async () => [],
                });

                // The continuation nudge is still what gets sent second.
                assert.equal(captured.length, 2, "two OpenAI requests");
                const secondInput = JSON.parse(captured[1]).input;
                assert.match(secondInput[0].content, /Continue exactly where/);

                return out;
            });

            assert.equal(result.fullText, "First half. Second half.");
            assert.equal(result.finishReason, "completed");
            assert.deepEqual(deltas, ["First half. ", "Second half."]);
        },
    );

    // 5. a refusal must not jump ahead of the prose it followed ---------------
    await test(
        "keeps prose ahead of the refusal that followed it",
        async () => {
            // The refusal is written straight to fullText and to onContentDelta
            // while the prose is still buffered, so without a flush at the top
            // of that handler both come out reversed. chatTools persists in
            // callback order, so the stored transcript would read the refusal
            // before the sentence that preceded it.
            const bodies = [
                sseBody([
                    textDelta("Here is my answer. "),
                    refusalDelta("I cannot help with that."),
                    completed("resp_1"),
                ]),
            ];

            const deltas: string[] = [];
            const result = await withStubbedFetch(bodies, () =>
                streamOpenAI({
                    model: MODEL,
                    systemPrompt: "You are Quill.",
                    messages: [{ role: "user", content: "Do something." }],
                    tools: TOOLS,
                    apiKeys: { openai: "test-key" },
                    callbacks: {
                        onContentDelta: (text) => deltas.push(text),
                    },
                    runTools: async () => [],
                }),
            );

            assert.equal(result.finishReason, "refused");
            assert.equal(
                result.fullText,
                "Here is my answer. I cannot help with that.",
            );
            // Exactly two deltas — the post-loop flush must not re-emit the
            // prose the refusal handler already drained.
            assert.deepEqual(deltas, [
                "Here is my answer. ",
                "I cannot help with that.",
            ]);
        },
    );

    // 6. a mid-stream read rejection — the live cancellation path -------------
    await test(
        "keeps buffered prose when reader.read() rejects mid-stream",
        async () => {
            // `createResponse` passes `signal` to fetch, so an abort errors the
            // body stream instead of ending it: the rejection propagates out of
            // the read loop, and anything short of a `finally` never drains the
            // buffer. chatTools then catches, flushes an iterText that never
            // received the prose, and persists a truncated message.
            const abort = Object.assign(new Error("The operation was aborted"), {
                name: "AbortError",
            });
            const bodies = [
                rejectingBody(
                    [
                        `data: ${JSON.stringify(
                            textDelta("Buffered before the abort."),
                        )}\n\n`,
                    ],
                    abort,
                ),
            ];

            const deltas: string[] = [];
            await withStubbedFetch(bodies, async () => {
                await assert.rejects(
                    streamOpenAI({
                        model: MODEL,
                        systemPrompt: "You are Quill.",
                        messages: [{ role: "user", content: "Draft an NDA." }],
                        tools: TOOLS,
                        apiKeys: { openai: "test-key" },
                        callbacks: {
                            onContentDelta: (text) => deltas.push(text),
                        },
                        runTools: async () => [],
                    }),
                    (err: unknown) => {
                        // The drain must not swallow or replace the failure.
                        assert.equal(err, abort);
                        return true;
                    },
                );
            });

            // streamOpenAI cannot hand back fullText when it throws, so the
            // delta callback is the observable half — and it is exactly what
            // chatTools' catch flushes into the persisted message.
            assert.deepEqual(deltas, ["Buffered before the abort."]);
        },
    );

    console.log("llm/openai.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
