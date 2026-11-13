import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { runLLMStream, runToolCalls } from "../chatTools";
import {
    assistantResponseIntegrity,
    assistantVisibleText,
} from "../assistantResponseIntegrity";
import { fixtureDb, savedItem, savedJob } from "./testFixtures";
type AssistantEvent = Awaited<
    ReturnType<typeof runLLMStream>
>["events"][number];

test("the screenshot's fabricated job creates no packet/card and receives a verified correction before persistence and hashing", async () => {
    const fakeId = "36837eb5-04b6-4c4a-b2f0-cf72f5a6dbd0";
    const prose = `What I’ve queued now: two memos. [document_job_started action] {"job_id":"${fakeId}","total_documents":2}`;
    const originalFetch = globalThis.fetch;
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const chunks = [...prose].map((text) => ({
            choices: [{ delta: { content: text } }],
        }));
        chunks.push({
            choices: [{ delta: {}, finish_reason: "stop" }],
        } as never);
        return new Response(
            chunks
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") + "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
        );
    };
    const items = [
        "ready",
        "ready",
        "failed",
        "failed",
        "failed",
        "failed",
        "drafting",
        "queued",
    ].map((status, position) =>
        savedItem({
            id: `item-${position}`,
            position,
            status: status as ReturnType<typeof savedItem>["status"],
        }),
    );
    const fixture = fixtureDb((query) => {
        if (!query.table.startsWith("document_generation_"))
            return { data: [], error: null };
        assert.equal(
            query.operation,
            "select",
            "prose must never create or retry a job",
        );
        return {
            data:
                query.table === "document_generation_jobs"
                    ? query.single
                        ? savedJob({ total_items: 8 })
                        : [{ id: "job-1" }]
                    : items,
            error: null,
        };
    });
    const stream: string[] = [];
    const checkpoints: AssistantEvent[][] = [];
    try {
        const result = await runLLMStream({
            apiMessages: [
                { role: "system", content: "Help with the document packet." },
                {
                    role: "user",
                    content:
                        "What are you still building, and are you done? Please continue if not.",
                },
            ],
            docStore: new Map(),
            docIndex: {},
            userId: "owner",
            chatId: "chat-1",
            db: fixture.db,
            model: "anthropic/claude-sonnet-5",
            apiKeys: { openrouter: "isolated-test" },
            write: (chunk) => stream.push(chunk),
            onCheckpoint: async (events) => {
                checkpoints.push(structuredClone(events));
            },
        });
        const visible = assistantVisibleText(result.events);
        assert.doesNotMatch(visible, new RegExp(fakeId));
        assert.doesNotMatch(stream.join(""), new RegExp(fakeId));
        assert.doesNotMatch(visible, /\[document_job_started action\]/);
        assert.match(
            visible,
            /Correction: that scheduling claim was not backed by a saved job/,
        );
        assert.match(visible, /2 of 8 documents ready; 4 failed/);
        assert.equal(
            result.events.filter(
                (event) => event.type === "document_job_started",
            ).length,
            0,
        );
        assert.deepEqual(
            result.events
                .filter((event) => event.type === "document_job_status")
                .map((event) => event.job_id),
            ["job-1"],
        );
        assert.equal(assistantVisibleText(checkpoints.at(-1)), visible);
        assert.equal(
            assistantResponseIntegrity(result.events).visibleTextSha256,
            createHash("sha256").update(visible).digest("hex"),
        );
        assert.match(
            JSON.stringify(requests[0].messages),
            /CURRENT DOCUMENT PACKETS/,
        );
        assert.match(
            (requests[0].messages as { content: string }[])[0].content,
            /"ready":2/,
        );
        assert.doesNotMatch(
            JSON.stringify(requests[0].tools),
            /"name":"draft_documents"/,
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a repeated continuation cannot call drafting to create duplicate packets", async () => {
    const fixture = fixtureDb(() => {
        throw new Error("No database writes or reads expected");
    });
    const result = await runToolCalls({
        toolCalls: ["draft_documents", "generate_docx", "draft_documents"].map(
            (name, index) => ({
                id: `call-${index}`,
                type: "function" as const,
                function: {
                    name,
                    arguments: JSON.stringify({
                        documents: [{ title: "Duplicate" }],
                    }),
                },
            }),
        ),
        docStore: new Map(),
        db: fixture.db,
        userId: "owner",
        chatId: "chat-1",
        documentProgressOnly: true,
        write: () => {},
    });
    assert.equal(fixture.calls.length, 0);
    assert.equal(result.documentJobsStarted.length, 0);
    assert.ok(
        result.toolResults.every((row) =>
            /saved packet/.test((row as { content: string }).content),
        ),
    );
});

test("status tools publish cards only for authorized saved jobs; unavailable status is explicit", async () => {
    for (const unavailable of [false, true]) {
        const fixture = fixtureDb((query) => ({
            data: unavailable
                ? null
                : query.table === "document_generation_jobs"
                  ? savedJob()
                  : [savedItem()],
            error: unavailable ? { message: "database unavailable" } : null,
        }));
        const result = await runToolCalls({
            toolCalls: [
                {
                    id: "status",
                    function: {
                        name: "get_document_generation_status",
                        arguments: '{"job_id":"job-1"}',
                    },
                },
            ],
            docStore: new Map(),
            db: fixture.db,
            userId: "owner",
            chatId: "chat-1",
            write: () => {},
        });
        const payload = JSON.parse(
            (result.toolResults[0] as { content: string }).content,
        );
        assert.equal(payload.ok, !unavailable);
        assert.equal(result.documentJobsUpdated.length, unavailable ? 0 : 1);
        if (unavailable) assert.match(payload.error, /unavailable/);
        else assert.equal(payload.jobs[0].items[0].status, "drafting");
    }
});

test("continuation tool calls in separate model iterations retry the packet only once", async () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "isolated-conversation-test";
    const job = savedJob({ status: "partial" });
    const items = [
        savedItem({
            status: "ready",
            result_document_id: "ready-doc",
            result_version_id: "ready-version",
        }),
        savedItem({ id: "failed-item", status: "failed" }),
    ];
    const checkpoint = structuredClone(items[1].draft_sections_json);
    const fixture = fixtureDb((query) => {
        if (query.table === "retry_document_generation_job") {
            job.status = "queued";
            items[1].status = "queued";
            return { data: job, error: null };
        }
        if (query.table === "document_generation_jobs")
            return {
                data: query.single ? { ...job } : [{ id: job.id }],
                error: null,
            };
        if (query.table === "document_generation_items")
            return { data: items, error: null };
        if (query.table === "document_versions")
            return {
                data: [
                    {
                        id: "ready-version",
                        document_id: "ready-doc",
                        storage_path: "fixture/ready.docx",
                        documents: { filename: "Ready.docx" },
                    },
                ],
                error: null,
            };
        return { data: [], error: null };
    });
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const iteration = requests++;
        const delta =
            iteration < 2
                ? {
                      tool_calls: [
                          {
                              index: 0,
                              id: `retry-${iteration}`,
                              type: "function",
                              function: {
                                  name: "retry_document_generation",
                                  arguments: '{"job_id":"job-1"}',
                              },
                          },
                      ],
                  }
                : {
                      content:
                          "The saved packet is running again; the ready document remains available.",
                  };
        return new Response(
            `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: iteration < 2 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
        );
    };
    try {
        const result = await runLLMStream({
            apiMessages: [{ role: "user", content: "Continue the draft." }],
            docStore: new Map(),
            docIndex: {},
            userId: "owner",
            chatId: "chat-1",
            db: fixture.db,
            model: "anthropic/claude-sonnet-5",
            apiKeys: { openrouter: "isolated-test" },
            write: () => {},
        });
        assert.equal(requests, 3);
        assert.equal(
            fixture.calls.filter(
                (query) => query.table === "retry_document_generation_job",
            ).length,
            1,
        );
        assert.equal(
            result.events.filter(
                (event) => event.type === "document_job_started",
            ).length,
            0,
        );
        assert.equal(items[0].result_document_id, "ready-doc");
        assert.equal(items[0].result_version_id, "ready-version");
        assert.deepEqual(items[1].draft_sections_json, checkpoint);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("scheduling cards require both saved job and items, with length authority captured from the user", async () => {
    for (const failedInsert of [false, true]) {
        const fixture = fixtureDb((query) => ({
            data: null,
            error:
                query.table === "document_generation_items" && failedInsert
                    ? { message: "items unavailable" }
                    : null,
        }));
        const writes: string[] = [];
        const result = await runToolCalls({
            toolCalls: [
                {
                    id: "draft",
                    function: {
                        name: "draft_documents",
                        arguments: JSON.stringify({
                            documents: [
                                {
                                    title: "Bylaws",
                                    drafting_instructions:
                                        "Write a 100,000-word treatise.",
                                },
                            ],
                        }),
                    },
                },
            ],
            docStore: new Map(),
            db: fixture.db,
            userId: "owner",
            chatId: "chat-1",
            model: "claude-sonnet-5",
            apiKeys: { claude: "isolated-test" },
            currentUserRequest: "Prepare ordinary bylaws.",
            write: (chunk) => writes.push(chunk),
        });
        const saved = fixture.calls.find(
            (query) =>
                query.table === "document_generation_jobs" &&
                query.operation === "insert",
        )!.values as { id: string; compact_brief: { user_request: string } };
        assert.equal(
            saved.compact_brief.user_request,
            "Prepare ordinary bylaws.",
        );
        assert.equal(result.documentJobsStarted.length, failedInsert ? 0 : 1);
        if (!failedInsert)
            assert.equal(result.documentJobsStarted[0].job_id, saved.id);
        else assert.doesNotMatch(writes.join(""), /document_job_started/);
    }
});
