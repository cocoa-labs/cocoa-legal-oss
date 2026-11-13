// backend/src/lib/calendar/reminderScheduler.test.ts
//
// The reminder tick (pollOnce) is the heart of the deadline-reminder worker:
// take the singleton lease, sweep the due deadlines, draft a reminder for each,
// and mark it sent so it never fires twice. It must NEVER reject — a missing
// schema / a failed draft is a logged skip, not a crash loop. All collaborators
// are injected so the tick is driven without timers, email, or a database.
import assert from "node:assert/strict";
import { pollOnce } from "./reminderScheduler";
import type { CalendarEventMeta } from "./types";

function test(name: string, fn: () => Promise<void>): Promise<void> {
    return fn()
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

function meta(id: string): CalendarEventMeta {
    return {
        id,
        calendar_id: "firmcal",
        google_event_id: `evt-${id}`,
        matter_id: null,
        project_id: null,
        recording_id: null,
        deadline_type: "filing",
        deadline_at: "2026-08-01T00:00:00Z",
        reminder_lead_days: 10,
        reminder_sent_at: null,
        created_by_user_id: "user-1",
        created_at: "",
        updated_at: "",
    };
}

const db = {} as never;
const noop = () => {};

function baseDeps(over: Record<string, unknown>) {
    return {
        db,
        instanceId: "test:1",
        pollIntervalMs: 1000,
        acquireLease: async () => true,
        listDue: async () => [] as CalendarEventMeta[],
        remind: async () => {},
        markSent: async () => {},
        log: noop,
        ...over,
    } as Parameters<typeof pollOnce>[0];
}

async function main(): Promise<void> {
    console.log("calendar/reminderScheduler.test.ts");

    await test("no lease → skips entirely, never sweeps", async () => {
        let swept = false;
        const res = await pollOnce(
            baseDeps({
                acquireLease: async () => false,
                listDue: async () => {
                    swept = true;
                    return [];
                },
            }),
        );
        assert.equal(res.leased, false);
        assert.equal(swept, false);
    });

    await test("leased → reminds each due deadline and marks it sent", async () => {
        const reminded: string[] = [];
        const marked: string[] = [];
        const res = await pollOnce(
            baseDeps({
                listDue: async () => [meta("a"), meta("b")],
                remind: async (_db: unknown, m: CalendarEventMeta) => {
                    reminded.push(m.id);
                },
                markSent: async (_db: unknown, id: string) => {
                    marked.push(id);
                },
            }),
        );
        assert.equal(res.leased, true);
        assert.equal(res.reminded, 2);
        assert.deepEqual(reminded, ["a", "b"]);
        assert.deepEqual(marked, ["a", "b"], "each reminded deadline is marked sent");
    });

    await test("a failed reminder is a logged skip — not marked sent, retried next tick", async () => {
        const marked: string[] = [];
        const res = await pollOnce(
            baseDeps({
                listDue: async () => [meta("a"), meta("b")],
                remind: async (_db: unknown, m: CalendarEventMeta) => {
                    if (m.id === "a") throw new Error("smtp down");
                },
                markSent: async (_db: unknown, id: string) => {
                    marked.push(id);
                },
            }),
        );
        assert.equal(res.reminded, 1, "only the successful one counts");
        assert.deepEqual(marked, ["b"], "the failed deadline is NOT marked sent");
    });

    await test("a lease-acquire throw degrades to a skipped tick, never rejects", async () => {
        const res = await pollOnce(
            baseDeps({
                acquireLease: async () => {
                    throw new Error("calendar_sync_state missing");
                },
            }),
        );
        assert.equal(res.leased, false);
    });

    console.log("calendar/reminderScheduler.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
