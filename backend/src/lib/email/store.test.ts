// backend/src/lib/email/store.test.ts
//
// Pins the status-guarded cancel contract POST /email/:id/cancel now leans
// on (phase-4b review follow-up): cancelPendingEmail's conditional UPDATE is
// the mutex — only a row still in pending_approval flips to cancelled, and a
// null return means NOTHING was mutated (the email already sent, was
// sending, failed, or was cancelled), so a sent record can never be
// clobbered to `cancelled`. The unguarded markEmailCancelled — the
// overwrite-any-status hazard — is deleted; these tests are the regression
// fence around its replacement. Scripted Supabase stub, no live database.
import assert from "node:assert/strict";
import { cancelPendingEmail } from "./store";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown },
    ) => {
        const c: Record<string, unknown> = {};
        const record =
            (method: string) =>
            (...args: unknown[]) => {
                log.calls.push({ method, args });
                return c;
            };
        for (const m of [
            "insert",
            "update",
            "upsert",
            "delete",
            "select",
            "eq",
            "neq",
            "in",
            "is",
            "or",
            "not",
            "ilike",
            "lt",
            "lte",
            "gt",
            "gte",
            "order",
            "limit",
            "range",
        ]) {
            c[m] = record(m);
        }
        const resolved = {
            data: result.data ?? null,
            error: result.error ?? null,
        };
        c.single = () => Promise.resolve(resolved);
        c.maybeSingle = () => Promise.resolve(resolved);
        c.then = (resolve: (v: unknown) => void) => resolve(resolved);
        return c;
    };
    const db = {
        from: (table: string) => {
            const log: ChainLog = { table, calls: [] };
            chains.push(log);
            return makeChain(log, script[next++] ?? {});
        },
    } as never;
    return { db, chains };
}

function callsOf(chain: ChainLog, method: string) {
    return chain.calls.filter((c) => c.method === method);
}

const pendingRow = {
    id: "email-1",
    user_id: "user-1",
    org_id: null,
    project_id: null,
    chat_id: null,
    agent_operation_id: "op-1",
    direction: "outbound",
    status: "cancelled",
    from_address: null,
    to_addresses: ["a@example.com"],
    cc_addresses: [],
    bcc_addresses: [],
    subject: "s",
    body_text: "b",
    body_html: null,
    attachments: [],
    signature_envelope_id: null,
    provider_message_id: null,
    provider_thread_id: null,
    in_reply_to: null,
    reply_to_address: null,
    error: null,
    approved_by: null,
    approved_at: null,
    sent_at: null,
    received_at: null,
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
};

async function main(): Promise<void> {
    console.log("email/store.test.ts");

    await test("cancelPendingEmail: the WHERE on pending_approval is the mutex", async () => {
        const { db, chains } = makeDb([{ data: pendingRow }]);
        const cancelled = await cancelPendingEmail(db, "email-1");
        assert.ok(cancelled, "matched row → cancelled row returned");
        assert.equal(cancelled?.status, "cancelled");

        assert.equal(chains[0].table, "email_messages");
        const payload = callsOf(chains[0], "update")[0].args[0] as Record<
            string,
            unknown
        >;
        assert.deepEqual(
            payload,
            { status: "cancelled" },
            "only the status flips",
        );
        assert.deepEqual(
            callsOf(chains[0], "eq").map((c) => c.args),
            [
                ["id", "email-1"],
                ["status", "pending_approval"],
            ],
            "conditional UPDATE: id + still-pending — sent/sending rows never match",
        );
    });

    await test("cancelPendingEmail: sent/sending/cancelled row → null, nothing mutated", async () => {
        // The conditional UPDATE matched no row (email is not pending) — the
        // store reports null so the route can 409 instead of lying.
        const { db } = makeDb([{ data: null }]);
        const cancelled = await cancelPendingEmail(db, "email-1");
        assert.equal(cancelled, null);
    });

    await test("cancelPendingEmail: missing email schema degrades to null, not a throw", async () => {
        const { db } = makeDb([
            {
                error: {
                    code: "42P01",
                    message: 'relation "public.email_messages" does not exist',
                },
            },
        ]);
        // tolerateMissingSchema logs a dev-mode warning on this path; keep
        // the test output pristine without changing behavior under test.
        const previousEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            const cancelled = await cancelPendingEmail(db, "email-1");
            assert.equal(cancelled, null);
        } finally {
            if (previousEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = previousEnv;
        }
    });

    console.log("email/store.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
