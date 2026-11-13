// backend/src/lib/email/inboxRead.test.ts
//
// Read-side helpers for the inbox feature: getEmailThread (full thread,
// oldest-first) and listInboundEmails (the whole-agent-inbox scan behind
// read_inbox). Read AUTHORIZATION lives in email/access.ts and is covered by
// access.test.ts. Pure logic + a minimal Supabase stub — no live DB.
import assert from "node:assert/strict";
import {
    agentMailboxOwnerId,
    claimEmailForSending,
    getEmailByOperationId,
    getEmailThread,
    listInboundEmails,
} from "./store";

// Minimal chainable Supabase stub: every builder method returns the same
// thenable, which resolves to the canned { data, error }.
function makeDb(rows: unknown[]) {
    const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        ilike: () => c,
        not: () => c,
        order: () => c,
        limit: () => c,
        update: () => c,
        // A conditional claim resolves to the single matched row, or null when
        // the WHERE (status) didn't match (race lost / wrong status).
        maybeSingle: () =>
            Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
            Promise.resolve({ data: rows, error: null }).then(
                resolve,
                reject as never,
            ),
    };
    return { from: () => c } as never;
}

async function main() {
    process.env.GMAIL_AGENT_OWNER_USER_ID = "agent-owner";
    assert.equal(agentMailboxOwnerId(), "agent-owner");

    // getEmailThread — empty thread id short-circuits without a query.
    assert.deepEqual(await getEmailThread(makeDb([{ id: "z" }]), ""), []);

    // getEmailThread — serializes + returns every message on the thread.
    const thread = await getEmailThread(
        makeDb([
            { id: "a", direction: "outbound", subject: "Hi", created_at: "1" },
            {
                id: "b",
                direction: "inbound",
                subject: "Re: Hi",
                created_at: "2",
            },
        ]),
        "thread-1",
    );
    assert.equal(thread.length, 2);
    assert.equal(thread[0].id, "a");
    assert.equal(thread[1].direction, "inbound");

    // listInboundEmails — returns mapped inbound rows (filters are applied
    // server-side; the stub just confirms the rows flow through serializeEmail).
    const inbound = await listInboundEmails(
        makeDb([{ id: "i1", direction: "inbound", subject: "New" }]),
        { limit: 10, fromContains: "alex", subjectContains: "Acme" },
    );
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].id, "i1");
    assert.equal(inbound[0].direction, "inbound");

    // getEmailByOperationId — resolves the email drafted for an operation (the
    // hinge that lets /operations/:id/approve actually send on reload).
    const byOp = await getEmailByOperationId(
        makeDb([{ id: "em9", agent_operation_id: "op9", direction: "outbound" }]),
        "op9",
    );
    assert.equal(byOp?.id, "em9");
    assert.equal(await getEmailByOperationId(makeDb([]), "op-none"), null);
    assert.equal(await getEmailByOperationId(makeDb([{ id: "x" }]), ""), null);

    // claimEmailForSending — atomic send claim. The conditional UPDATE matches a
    // row (still pending_approval) → returns it (this caller won the claim);
    // matches nothing (already claimed/sent) → returns null (caller no-ops).
    const won = await claimEmailForSending(
        makeDb([{ id: "em1", status: "sending", direction: "outbound" }]),
        "em1",
    );
    assert.equal(won?.id, "em1");
    const lost = await claimEmailForSending(makeDb([]), "em1");
    assert.equal(lost, null);

    console.log("inboxRead.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
