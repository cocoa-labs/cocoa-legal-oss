// backend/src/lib/email/threadLink.test.ts
//
// getThreadLink resolves the chat + owner an inbound reply should rejoin, by
// matching the Gmail thread to the most recent agent-initiated outbound. This
// is the hinge that lets a reply re-enter its originating conversation.
import assert from "node:assert/strict";
import { getThreadLink } from "./store";

// Minimal chainable Supabase stub: every builder method returns the same
// thenable, which resolves to the canned { data, error }.
function makeDb(rows: unknown[]) {
    const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        not: () => c,
        order: () => c,
        limit: () => c,
        then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
            Promise.resolve({ data: rows, error: null }).then(
                resolve,
                reject as never,
            ),
    };
    return { from: () => c } as never;
}

async function main() {
    // Resolves chat + owner from the most recent agent-initiated outbound.
    const linked = await getThreadLink(
        makeDb([{ id: "em1", chat_id: "chat1", user_id: "user1" }]),
        "thread-1",
    );
    assert.deepEqual(linked, {
        chatId: "chat1",
        userId: "user1",
        emailId: "em1",
    });

    // No agent-initiated outbound on the thread → null (do not auto-reply).
    assert.equal(await getThreadLink(makeDb([]), "thread-x"), null);

    // Empty thread id short-circuits to null without a query.
    assert.equal(
        await getThreadLink(
            makeDb([{ id: "x", chat_id: "c", user_id: "u" }]),
            "",
        ),
        null,
    );

    console.log("threadLink.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
