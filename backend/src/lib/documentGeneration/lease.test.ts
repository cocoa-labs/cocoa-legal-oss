import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocumentJobLease, DocumentGenerationLeaseLost } from "./lease";
import {
    executeDocumentGenerationJob,
    checkpointDocumentGenerationItem,
} from "./worker";
import { fixtureDb, savedJob } from "./testFixtures";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fakeTimers() {
    const callbacks: (() => void)[] = [];
    const delays: number[] = [];
    return {
        callbacks,
        delays,
        timers: {
            schedule: ((callback: () => void, delay: number) => {
                callbacks.push(callback);
                delays.push(delay);
                return callbacks.length;
            }) as unknown as typeof setTimeout,
            unschedule: (() => {}) as typeof clearTimeout,
        },
    };
}

test("heartbeats execute their database thenable every 30 seconds and cannot overlap", async () => {
    const clock = fakeTimers();
    let finishWrite: (() => void) | undefined;
    let slow = false;
    const fixture = fixtureDb(async () => {
        if (slow)
            await new Promise<void>((resolve) => {
                finishWrite = resolve;
            });
        return { data: { id: "job-1" }, error: null };
    });
    const lease = createDocumentJobLease(fixture.db, savedJob(), clock.timers);
    await lease.start();
    assert.equal(
        fixture.calls.length,
        1,
        "an un-awaited Supabase builder would never execute",
    );
    assert.deepEqual(clock.delays, [30_000]);
    slow = true;
    clock.callbacks.shift()!();
    await settle();
    assert.equal(
        clock.callbacks.length,
        0,
        "next heartbeat is scheduled only after this write settles",
    );
    assert.equal(fixture.calls.length, 2);
    finishWrite!();
    await settle();
    assert.deepEqual(clock.delays, [30_000, 30_000]);
    assert.equal(fixture.calls[1].filters.claimed_by, "worker-1");
    assert.equal(fixture.calls[1].filters.status, "running");
    await lease.stop();
    clock.callbacks.shift()!();
    await settle();
    assert.equal(
        fixture.calls.length,
        2,
        "stopped workers never renew ownership",
    );
});

test("heartbeat failure, failed ownership reads, and lost ownership stop writes", async () => {
    for (const failure of ["write", "read", "lost"] as const) {
        const fixture = fixtureDb((query) => ({
            data: failure === "lost" ? null : { id: "job-1" },
            error:
                (failure === "write" && query.operation === "update") ||
                (failure === "read" && query.operation === "select")
                    ? { message: "database offline" }
                    : null,
        }));
        const clock = fakeTimers();
        const lease = createDocumentJobLease(
            fixture.db,
            savedJob(),
            clock.timers,
        );
        if (failure === "read") await lease.start();
        else
            await assert.rejects(
                () => lease.start(),
                DocumentGenerationLeaseLost,
            );
        await assert.rejects(
            () => lease.assertOwned(),
            DocumentGenerationLeaseLost,
        );
        await lease.stop();
    }
});

test("worker surfaces item reads and never finalizes unread or still-active items", async () => {
    for (const scenario of ["read-error", "ownership-lost"] as const) {
        let ownershipReads = 0;
        const fixture = fixtureDb((query) => {
            if (query.table === "document_generation_items")
                return {
                    data: [],
                    error:
                        scenario === "read-error"
                            ? { message: "items unavailable" }
                            : null,
                };
            if (
                query.table === "document_generation_jobs" &&
                query.operation === "select"
            )
                ownershipReads++;
            return {
                data:
                    scenario === "ownership-lost" && ownershipReads > 0
                        ? null
                        : { id: "job-1" },
                error: null,
            };
        });
        await assert.rejects(
            () => executeDocumentGenerationJob(savedJob(), fixture.db),
            scenario === "read-error"
                ? /items unavailable/
                : DocumentGenerationLeaseLost,
        );
        assert.equal(
            fixture.calls.some(
                (query) =>
                    query.operation === "update" &&
                    (query.values as Record<string, unknown>).status,
            ),
            false,
        );
        assert.equal(
            fixture.calls.some(
                (query) =>
                    query.table === "documents" ||
                    query.table === "document_versions",
            ),
            false,
        );
    }
});

test("failed completion writes are surfaced instead of marking the packet complete", async () => {
    const fixture = fixtureDb((query) => {
        if (query.table === "document_generation_items")
            return {
                data: [{ status: "ready" }, { status: "ready" }],
                error: null,
            };
        if (
            query.operation === "update" &&
            (query.values as Record<string, unknown>).status
        )
            return { data: null, error: { message: "completion unavailable" } };
        return {
            data: { id: "job-1", cancel_requested_at: null },
            error: null,
        };
    });
    await assert.rejects(
        () => executeDocumentGenerationJob(savedJob(), fixture.db),
        /completion unavailable/,
    );
    assert.equal(
        fixture.calls.some((query) => query.table === "chat_messages"),
        false,
    );
});

test("checkpoints require current ownership and surface failed or empty database writes", async () => {
    for (const mode of ["lost", "write-error", "missing-item"] as const) {
        const fixture = fixtureDb((query) => {
            if (query.table === "document_generation_jobs")
                return {
                    data: mode === "lost" ? null : { id: "job-1" },
                    error: null,
                };
            return {
                data: null,
                error:
                    mode === "write-error"
                        ? { message: "write unavailable" }
                        : null,
            };
        });
        const lease = createDocumentJobLease(
            fixture.db,
            savedJob(),
            fakeTimers().timers,
        );
        await assert.rejects(
            () =>
                checkpointDocumentGenerationItem(
                    fixture.db,
                    "item-1",
                    { draft_sections_json: [] },
                    lease,
                ),
            mode === "lost" ? DocumentGenerationLeaseLost : /unavailable/,
        );
        if (mode === "lost")
            assert.equal(
                fixture.calls.some((query) => query.operation === "update"),
                false,
            );
        await lease.stop();
    }
});
