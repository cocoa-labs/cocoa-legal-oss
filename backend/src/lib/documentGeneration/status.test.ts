import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureDb, savedItem, savedJob } from "./testFixtures";
import {
    authorizedDocumentJob,
    documentGenerationContext,
    documentJobActivity,
    getDocumentGenerationStatus,
    listChatDocumentGenerationStatuses,
    retryDocumentGeneration,
    assertDocumentSchedulingAvailable,
} from "./status";
import { getDocumentGenerationCanaryState } from "./canary";

const scope = { userId: "owner", chatId: "chat-1" };
process.env.DOWNLOAD_SIGNING_SECRET = "isolated-document-status-test";

function packetFixture(
    status = "running" as ReturnType<typeof savedJob>["status"],
) {
    const job = savedJob({ status });
    const items = [
        savedItem({
            status: "ready",
            result_document_id: "ready-doc",
            result_version_id: "ready-version",
            outline_json: {
                budget: {
                    source: "ordinary",
                    targetWords: 15_000,
                    maxWords: 30_000,
                },
                sections: [
                    {
                        heading: "Governance",
                        level: 1,
                        instructions: "Explain governance.",
                    },
                ],
            },
            layout_attempts_json: [
                {
                    renderer_mode: "standard",
                    summary: {
                        status: "passed",
                        reasons: [],
                        affected_pages: [],
                        page_count: 12,
                        text_coverage: 1,
                        analyzer_version: 4,
                        missing_token_count: 0,
                    },
                },
            ],
        }),
        savedItem({
            id: "item-2",
            position: 1,
            status:
                status === "completed"
                    ? "ready"
                    : status === "cancelled"
                      ? "cancelled"
                      : "failed",
        }),
    ];
    let role = "viewer";
    const fixture = fixtureDb((query) => {
        if (query.table === "document_generation_jobs")
            return {
                data: query.single ? { ...job } : [{ ...job }],
                error: null,
            };
        if (query.table === "document_generation_items")
            return { data: structuredClone(items), error: null };
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
        if (query.table === "projects")
            return {
                data: {
                    id: "project-1",
                    user_id: "owner",
                    matter_id: "matter-1",
                    lifecycle_status: "active",
                },
                error: null,
            };
        if (query.table === "matter_memberships")
            return { data: { role }, error: null };
        if (query.table === "audit_events") return { data: null, error: null };
        if (query.operation === "rpc") {
            assert.equal(query.table, "retry_document_generation_job");
            if (!["partial", "failed"].includes(job.status))
                return { data: null, error: null };
            job.status = "queued";
            items
                .filter((item) => item.status === "failed")
                .forEach((item) => {
                    item.status = "queued";
                });
            return { data: { ...job }, error: null };
        }
        throw new Error(`Unexpected query: ${query.table}`);
    });
    return {
        ...fixture,
        job,
        items,
        setRole(value: string) {
            role = value;
        },
    };
}

test("status uses live items and keeps ready downloads through every packet state", async () => {
    for (const state of [
        "queued",
        "running",
        "completed",
        "partial",
        "failed",
        "cancelled",
    ] as const) {
        const fixture = packetFixture(state);
        const status = await getDocumentGenerationStatus(
            fixture.db,
            "job-1",
            scope,
        );
        assert.equal(status.status, state);
        assert.equal(status.completed_items, state === "completed" ? 2 : 1);
        assert.equal(
            status.failed_items,
            state === "completed" || state === "cancelled" ? 0 : 1,
        );
        assert.equal(status.items[0].result?.document_id, "ready-doc");
        assert.match(status.items[0].result!.download_url, /^\/download\//);
        assert.equal(status.items[0].title, "Bylaws");
        assert.ok((status.items[0].word_count ?? 0) > 0);
        assert.equal(status.items[0].word_budget?.max_words, 30_000);
        assert.equal(status.items[0].layout_summary?.analyzer_version, 4);
        assert.equal(status.items[0].layout_summary?.missing_token_count, 0);
        assert.ok(status.last_activity_at);
        assert.match(documentGenerationContext([status]), /ready-doc/);
    }
});

test("continuation is atomic and at most once per packet per turn; ready IDs and checkpoints survive", async () => {
    const fixture = packetFixture("partial");
    const before = structuredClone(fixture.items);
    const retried = new Set<string>();
    const results = await Promise.all(
        [1, 2, 3].map(() =>
            retryDocumentGeneration(fixture.db, "job-1", scope, retried),
        ),
    );
    assert.equal(
        results.filter((result) => result.outcome === "requeued").length,
        1,
    );
    assert.equal(
        fixture.calls.filter((call) => call.operation === "rpc").length,
        1,
    );
    assert.deepEqual(fixture.items[0], before[0]);
    assert.deepEqual(
        fixture.items[1].draft_sections_json,
        before[1].draft_sections_json,
    );
    assert.deepEqual(fixture.items[1].outline_json, before[1].outline_json);
    fixture.job.status = "failed";
    fixture.items[1].status = "failed";
    assert.equal(
        (await retryDocumentGeneration(fixture.db, "job-1", scope, retried))
            .outcome,
        "already_requested",
    );
    assert.equal(
        (await retryDocumentGeneration(fixture.db, "job-1", scope, new Set()))
            .outcome,
        "requeued",
    );
});

test("active, completed and cancelled packets never enqueue a retry", async () => {
    for (const status of [
        "queued",
        "running",
        "completed",
        "cancelled",
    ] as const) {
        const fixture = packetFixture(status);
        const result = await retryDocumentGeneration(
            fixture.db,
            "job-1",
            scope,
        );
        assert.equal(result.outcome, status === "queued" ? "running" : status);
        assert.equal(
            fixture.calls.filter((call) => call.operation === "rpc").length,
            0,
        );
    }
});

test("chat and owner restrictions apply to reads and retries; matter viewers cannot mutate", async () => {
    const fixture = packetFixture("failed");
    await assert.rejects(
        () =>
            getDocumentGenerationStatus(fixture.db, "job-1", {
                ...scope,
                userId: "stranger",
            }),
        /not found/,
    );
    await assert.rejects(
        () =>
            retryDocumentGeneration(fixture.db, "job-1", {
                ...scope,
                chatId: "other-chat",
            }),
        /not found/,
    );
    fixture.job.project_id = "project-1";
    await authorizedDocumentJob(fixture.db, "job-1", scope, "read");
    await assert.rejects(
        () => retryDocumentGeneration(fixture.db, "job-1", scope),
        /not found/,
    );
    assert.equal(
        fixture.calls.filter((call) => call.operation === "rpc").length,
        0,
    );
    fixture.setRole("editor");
    assert.equal(
        (await retryDocumentGeneration(fixture.db, "job-1", scope)).outcome,
        "requeued",
    );
});

test("unavailable job, item, download, list and retry reads/writes surface errors", async () => {
    for (const failedTable of [
        "document_generation_jobs",
        "document_generation_items",
        "document_versions",
    ]) {
        const fixture = packetFixture("failed");
        const broken = fixtureDb((query) =>
            query.table === failedTable
                ? { data: null, error: { message: "database unavailable" } }
                : query.table === "document_generation_jobs"
                  ? { data: savedJob(), error: null }
                  : { data: fixture.items, error: null },
        );
        await assert.rejects(
            () => getDocumentGenerationStatus(broken.db, "job-1", scope),
            /unavailable/,
        );
    }
    const broken = fixtureDb(() => ({
        data: null,
        error: { message: "offline" },
    }));
    await assert.rejects(
        () => listChatDocumentGenerationStatuses(broken.db, scope),
        /offline/,
    );
    await assert.rejects(
        () => retryDocumentGeneration(broken.db, "job-1", scope),
        /offline/,
    );
});

test("stale worker activity is delayed, never completed, and failed readiness rejects scheduling", () => {
    const job = savedJob({ heartbeat_at: "2026-09-12T12:00:00Z" });
    assert.equal(
        documentJobActivity(job, [], Date.parse("2026-09-12T12:03:00Z"))
            .stalled,
        true,
    );
    assert.equal(job.status, "running");
    assert.throws(
        () =>
            assertDocumentSchedulingAvailable({
                ...getDocumentGenerationCanaryState(),
                status: "failed",
            }),
        /renderer is not ready/,
    );
});
