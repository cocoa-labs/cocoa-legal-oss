import assert from "node:assert/strict";
import type { GoogleGenAI } from "@google/genai";
import { streamGeminiWithClient } from "./gemini";

let requestCount = 0;
const fakeClient = {
    models: {
        generateContentStream: async () => {
            requestCount++;
            const chunks =
                requestCount === 1
                    ? [
                          {
                              candidates: [
                                  {
                                      content: {
                                          parts: [
                                              { text: "Before tool. " },
                                              {
                                                  functionCall: {
                                                      id: "call-1",
                                                      name: "read_source",
                                                      args: { id: "source-1" },
                                                  },
                                              },
                                          ],
                                      },
                                      finishReason: "STOP",
                                  },
                              ],
                          },
                      ]
                    : [
                          {
                              candidates: [
                                  {
                                      content: {
                                          parts: [{ text: "Final prose." }],
                                      },
                                      finishReason: "STOP",
                                  },
                              ],
                          },
                      ];
            return {
                async *[Symbol.asyncIterator]() {
                    for (const chunk of chunks) yield chunk;
                },
            };
        },
    },
} as unknown as Pick<GoogleGenAI, "models">;

async function main() {
    try {
        let streamed = "";
        let toolRuns = 0;
        const result = await streamGeminiWithClient(
            {
                model: "gemini-3-flash-preview",
                systemPrompt: "Synthetic fixture test.",
                messages: [{ role: "user", content: "Review the source." }],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "read_source",
                            description: "Read a synthetic source.",
                            parameters: {
                                type: "object",
                                properties: { id: { type: "string" } },
                                required: ["id"],
                            },
                        },
                    },
                ],
                callbacks: {
                    onContentDelta(text) {
                        streamed += text;
                    },
                },
                async runTools(calls) {
                    toolRuns++;
                    assert.equal(calls[0]?.name, "read_source");
                    return [
                        {
                            tool_use_id: calls[0].id,
                            content: JSON.stringify({
                                text: "Synthetic source",
                            }),
                        },
                    ];
                },
                maxIterations: 3,
                maxContinuations: 0,
            },
            fakeClient,
        );

        assert.equal(toolRuns, 1);
        assert.equal(streamed, "Before tool. Final prose.");
        assert.equal(result.fullText, "Before tool. Final prose.");
        assert.equal(result.finishReason, "completed");
        assert.equal(result.providerFinishReason, "STOP");
        assert.equal(result.retryable, false);
        console.log("llm/gemini.test.ts: all passed");
    } finally {
        // Fixture client has no external state to restore.
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
