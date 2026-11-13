import assert from "node:assert/strict";
import { test } from "node:test";
import { startDocumentJobPolling } from "./documentJobPolling";
import type { DocumentGenerationJobStatus } from "../components/shared/types";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const packet = (status: DocumentGenerationJobStatus["status"]) =>
    ({ id: "saved-job", status }) as DocumentGenerationJobStatus;

test("polling continues through active states and transient errors while retaining the last result", async () => {
    const next: (() => void)[] = [];
    const delays: number[] = [];
    let job: DocumentGenerationJobStatus | undefined;
    let error: string | undefined;
    let requests = 0;
    const responses = [
        packet("queued"),
        packet("running"),
        new Error("Temporarily unavailable"),
        packet("partial"),
    ];
    const stop = startDocumentJobPolling({
        load: async () => {
            const response = responses[requests++];
            if (response instanceof Error) throw response;
            return response;
        },
        onJob: (current) => {
            job = current;
            error = undefined;
        },
        onError: (message) => {
            error = message;
        },
        schedule: (callback, ms) => {
            next.push(callback);
            delays.push(ms);
            return next.length as unknown as ReturnType<typeof setTimeout>;
        },
        unschedule: () => {},
    });
    await settle();
    assert.equal(job?.status, "queued");
    next.shift()!();
    await settle();
    assert.equal(job?.status, "running");
    next.shift()!();
    await settle();
    assert.equal(job?.status, "running");
    assert.equal(error, "Temporarily unavailable");
    next.shift()!();
    await settle();
    assert.equal(job?.status, "partial");
    assert.equal(error, undefined);
    assert.deepEqual(delays, [2500, 2500, 4000]);
    assert.equal(next.length, 0);
    stop();
});

test("reload starts a fresh status request, terminal states stop polling, and unmount ignores late responses", async () => {
    for (const status of [
        "completed",
        "partial",
        "failed",
        "cancelled",
    ] as const) {
        let requests = 0;
        const start = () =>
            startDocumentJobPolling({
                load: async () => {
                    requests++;
                    return packet(status);
                },
                onJob: () => {},
                onError: () => {},
                schedule: () => {
                    throw new Error("Terminal polling must stop");
                },
            });
        const first = start();
        await settle();
        first();
        const reload = start();
        await settle();
        reload();
        assert.equal(requests, 2);
    }
    let finish!: (job: DocumentGenerationJobStatus) => void;
    let delivered = false;
    const stop = startDocumentJobPolling({
        load: () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
        onJob: () => {
            delivered = true;
        },
        onError: () => {},
        schedule: () => {
            throw new Error("Unmounted");
        },
    });
    stop();
    finish(packet("running"));
    await settle();
    assert.equal(delivered, false);
});
