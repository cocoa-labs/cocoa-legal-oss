// backend/src/lib/concurrency.test.ts
//
// mapWithConcurrency paces the tabular-review generate fan-out (one
// download+extract+LLM pipeline per document used to launch all at once).
// These tests pin the three properties the SSE route depends on: results
// stay in input order, in-flight work never exceeds the cap, and one
// failing item neither blocks nor cancels the others.
import assert from "node:assert/strict";
import {
    createConcurrencyGate,
    envInt,
    mapWithConcurrency,
} from "./concurrency";

/** Let every already-scheduled microtask and timer callback run. */
function tick(): Promise<void> {
    return new Promise((r) => setTimeout(r, 1));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function main() {
    // Results come back in input order even when items finish out of order.
    {
        const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
        const run = mapWithConcurrency([0, 1, 2], 3, async (i) => {
            await gates[i].promise;
            return `item-${i}`;
        });
        // Finish in reverse order.
        gates[2].resolve();
        gates[1].resolve();
        gates[0].resolve();
        assert.deepEqual(await run, ["item-0", "item-1", "item-2"]);
    }

    // The cap holds: with limit 2 over 6 items, at most 2 run at once, and
    // every item still runs exactly once.
    {
        let inFlight = 0;
        let peak = 0;
        const started: number[] = [];
        const result = await mapWithConcurrency(
            [10, 20, 30, 40, 50, 60],
            2,
            async (item, index) => {
                started.push(index);
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 1));
                inFlight -= 1;
                return item * 2;
            },
        );
        assert.equal(peak, 2);
        assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
        assert.deepEqual(result, [20, 40, 60, 80, 100, 120]);
    }

    // Error isolation: a mid-list failure must not stop later items from
    // running (each document's cells are persisted independently). The first
    // rejection is rethrown only after every item has settled, so the SSE
    // route still emits its terminal error event exactly once.
    {
        const ran: number[] = [];
        let thrown: unknown = null;
        try {
            await mapWithConcurrency([0, 1, 2, 3], 2, async (i) => {
                ran.push(i);
                if (i === 1) throw new Error("doc 1 failed");
                await new Promise((r) => setTimeout(r, 1));
                return i;
            });
        } catch (err) {
            thrown = err;
        }
        assert.ok(thrown instanceof Error && thrown.message === "doc 1 failed");
        assert.deepEqual([...ran].sort(), [0, 1, 2, 3]);
    }

    // Degenerate limits clamp to sequential rather than dropping work.
    {
        let inFlight = 0;
        let peak = 0;
        const result = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight -= 1;
            return n;
        });
        assert.equal(peak, 1);
        assert.deepEqual(result, [1, 2, 3]);
    }

    // Empty input resolves immediately.
    assert.deepEqual(
        await mapWithConcurrency([], 4, async () => {
            throw new Error("should not run");
        }),
        [],
    );

    // envInt: positive integers parse; absent/garbage/non-positive fall back.
    {
        const KEY = "CONCURRENCY_TEST_ENV_INT";
        delete process.env[KEY];
        assert.equal(envInt(KEY, 4), 4);
        process.env[KEY] = "7";
        assert.equal(envInt(KEY, 4), 7);
        process.env[KEY] = "zero";
        assert.equal(envInt(KEY, 4), 4);
        process.env[KEY] = "-2";
        assert.equal(envInt(KEY, 4), 4);
        delete process.env[KEY];
    }

    // createConcurrencyGate: the standing gate in front of soffice. Each
    // LibreOffice process peaks at 150-300 MB, so overlapping conversions are
    // what get one SIGKILLed by the host's memory cap.

    // The cap holds and waiters are admitted in arrival order, including a
    // caller that arrives while a slot is being handed over.
    {
        const gate = createConcurrencyGate(1);
        const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
        const started: number[] = [];
        let inFlight = 0;
        let peak = 0;

        const runs = [0, 1, 2].map((i) =>
            gate(async () => {
                started.push(i);
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await gates[i].promise;
                inFlight -= 1;
                return i;
            }),
        );

        // Only the first task may have started.
        await new Promise((r) => setTimeout(r, 1));
        assert.deepEqual(started, [0]);

        gates[0].resolve();
        await new Promise((r) => setTimeout(r, 1));
        assert.deepEqual(started, [0, 1]);

        gates[1].resolve();
        gates[2].resolve();
        assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
        assert.equal(peak, 1);
        assert.deepEqual(started, [0, 1, 2]);
    }

    // The hand-off itself. The test above never exercises it: all three
    // callers arrive before anything completes, so every waiter is already
    // queued when a slot frees up. The dangerous window is the other one — a
    // caller arriving AFTER a task completed and woke a waiter. If release()
    // decrements `active` instead of handing the claimed slot over, the woken
    // waiter never re-claims it, the counter drifts and the gate quietly stops
    // limiting anything: two ~300 MB soffice processes at once, which is the
    // exact OOM the gate was added to prevent.
    {
        const gate = createConcurrencyGate(1);
        const holds = [deferred<void>(), deferred<void>(), deferred<void>()];
        const started: number[] = [];
        let inFlight = 0;
        let peak = 0;

        const run = (i: number) =>
            gate(async () => {
                started.push(i);
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await holds[i].promise;
                inFlight -= 1;
                return i;
            });

        const first = run(0);
        const second = run(1); // queued behind the first
        await tick();
        assert.deepEqual(started, [0]);

        // Complete the first task and let the woken waiter actually resume,
        // so the hand-off is fully settled before the next caller arrives.
        holds[0].resolve();
        assert.equal(await first, 0);
        await tick();
        assert.deepEqual(started, [0, 1]);

        // THE ARRIVAL UNDER TEST: the second task is mid-flight holding the
        // handed-over slot, and a third caller shows up.
        const third = run(2);
        await tick();
        assert.deepEqual(
            started,
            [0, 1],
            "a caller arriving after a hand-off jumped the queue — the woken waiter's slot was not counted",
        );
        assert.equal(inFlight, 1);

        holds[1].resolve();
        assert.equal(await second, 1);
        await tick();
        assert.deepEqual(started, [0, 1, 2]);
        holds[2].resolve();
        assert.equal(await third, 2);

        assert.equal(
            peak,
            1,
            `gate ran ${peak} tasks concurrently under a limit of 1`,
        );
    }

    // A limit above 1 lets exactly that many run at once.
    {
        const gate = createConcurrencyGate(2);
        let inFlight = 0;
        let peak = 0;
        await Promise.all(
            [1, 2, 3, 4, 5].map(() =>
                gate(async () => {
                    inFlight += 1;
                    peak = Math.max(peak, inFlight);
                    await new Promise((r) => setTimeout(r, 1));
                    inFlight -= 1;
                }),
            ),
        );
        assert.equal(peak, 2);
    }

    // A rejecting task releases its slot (otherwise one failed conversion
    // would wedge the gate forever) and the rejection reaches the caller.
    {
        const gate = createConcurrencyGate(1);
        let thrown: unknown = null;
        try {
            await gate(async () => {
                throw new Error("conversion blew up");
            });
        } catch (err) {
            thrown = err;
        }
        assert.ok(thrown instanceof Error && thrown.message === "conversion blew up");
        assert.equal(await gate(async () => "still open"), "still open");
    }

    // Degenerate limits clamp to sequential rather than deadlocking.
    {
        const gate = createConcurrencyGate(0);
        let inFlight = 0;
        let peak = 0;
        await Promise.all(
            [1, 2, 3].map(() =>
                gate(async () => {
                    inFlight += 1;
                    peak = Math.max(peak, inFlight);
                    await new Promise((r) => setTimeout(r, 1));
                    inFlight -= 1;
                }),
            ),
        );
        assert.equal(peak, 1);
    }

    console.log("concurrency.test.ts: all assertions passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
