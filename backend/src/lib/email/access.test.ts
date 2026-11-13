// backend/src/lib/email/access.test.ts
//
// Read-scoping policy for email_messages (closes the audit High "any
// authenticated user can read every inbound email firm-wide"). A LINKED email
// (signature envelope / chat / project) is readable only by users with access
// to that resource; creator identity never survives membership removal. Pure
// logic + a minimal Supabase stub —
// no live DB.
import assert from "node:assert/strict";
import {
    canUserReadEmail,
    filterReadableEmails,
    UNLINKED_INBOUND_IS_FIRM_READABLE,
} from "./access";
import type { EmailMessage } from "./store";

function email(over: Partial<EmailMessage>): EmailMessage {
    return {
        id: "e1",
        user_id: "owner",
        org_id: null,
        project_id: null,
        chat_id: null,
        agent_operation_id: null,
        direction: "outbound",
        status: "sent",
        from_address: null,
        to_addresses: [],
        cc_addresses: [],
        bcc_addresses: [],
        subject: "",
        body_text: "",
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
        created_at: "",
        updated_at: "",
        ...over,
    };
}

type RecordedCall = { method: string; args: unknown[] };

/**
 * Chainable Supabase stub routed per table. Each query records its builder
 * calls; the per-table handler maps those calls to canned rows. `queryCounts`
 * lets tests assert the batch filter issues ONE query per table (no N+1).
 */
function makeDb(
    handlers: Record<string, (calls: RecordedCall[]) => unknown[]>,
    queryCounts?: Record<string, number>,
) {
    return {
        from(table: string) {
            if (queryCounts) {
                queryCounts[table] = (queryCounts[table] ?? 0) + 1;
            }
            const calls: RecordedCall[] = [];
            const c: Record<string, unknown> = {};
            for (const m of [
                "select",
                "eq",
                "neq",
                "in",
                "filter",
                "not",
                "ilike",
                "order",
                "limit",
            ]) {
                c[m] = (...args: unknown[]) => {
                    calls.push({ method: m, args });
                    return c;
                };
            }
            c.then = (resolve: (v: unknown) => unknown, reject?: unknown) => {
                const rows = handlers[table] ? handlers[table](calls) : [];
                return Promise.resolve({ data: rows, error: null }).then(
                    resolve,
                    reject as never,
                );
            };
            return c;
        },
    } as never;
}

/** Fixture world: envelopes env-mine/env-other, chats, and projects. */
function fixtureDb(queryCounts?: Record<string, number>) {
    return makeDb(
        {
            signature_envelopes: (calls) => {
                const inCall = calls.find((c) => c.method === "in");
                const ids = (inCall?.args[1] as string[]) ?? [];
                return [
                    { id: "env-mine", user_id: "me", project_id: null, org_id: null },
                    { id: "env-other", user_id: "alice", project_id: null, org_id: null },
                ].filter((r) => ids.includes(r.id));
            },
            chats: (calls) => {
                const inCall = calls.find((c) => c.method === "in");
                const ids = (inCall?.args[1] as string[]) ?? [];
                return [
                    { id: "chat-mine", user_id: "me", project_id: null },
                    { id: "chat-other", user_id: "alice", project_id: null },
                ].filter((r) => ids.includes(r.id));
            },
            projects: (calls) => {
                return calls.some((c) => c.method === "in" && c.args[0] === "matter_id")
                    ? [{ id: "proj-shared" }]
                    : [];
            },
            matter_memberships: () => [{ matter_id: "matter-shared" }],
            organization_memberships: () => [{ organization_id: "org-firm" }],
        },
        queryCounts,
    );
}

async function main() {
    // The single-firm seam: flipping this constant is the multi-firm change.
    assert.equal(UNLINKED_INBOUND_IS_FIRM_READABLE, false);

    // 1. Own outbound — always readable by its owner.
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({ user_id: "me", direction: "outbound" }),
        ),
        true,
        "own outbound is readable",
    );

    // 2. Linked to MY signature envelope — readable even though the row is
    //    owned by the agent mailbox user.
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({
                user_id: "gmail-agent",
                direction: "inbound",
                signature_envelope_id: "env-mine",
            }),
        ),
        true,
        "email linked to my envelope is readable",
    );

    // 3. Linked to someone ELSE's envelope — NOT readable, even though it is
    //    inbound (the linked-resource rule beats the firm-inbox rule).
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({
                user_id: "gmail-agent",
                direction: "inbound",
                signature_envelope_id: "env-other",
            }),
        ),
        false,
        "email linked to another user's envelope is NOT readable",
    );

    // 4. Linked to a project where I have an active matter membership.
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({
                user_id: "alice",
                direction: "inbound",
                project_id: "proj-shared",
            }),
            "me@firm.test",
        ),
        true,
        "email linked to a member project is readable",
    );
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({
                user_id: "alice",
                direction: "inbound",
                project_id: "proj-unrelated",
            }),
            "me@firm.test",
        ),
        false,
        "email linked to a project I cannot access is NOT readable",
    );

    // 5. Unlinked inbound is readable only inside its organization.
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({ user_id: "gmail-agent", direction: "inbound", org_id: "org-firm" }),
        ),
        true,
        "unlinked inbound is org-member readable",
    );

    // 6. Unlinked OUTBOUND owned by someone else — private (drops the old
    //    blanket agent-mailbox-owner allowance).
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({ user_id: "alice", direction: "outbound" }),
        ),
        false,
        "another user's unlinked outbound stays private",
    );

    // 7. Chat-linked: my chat readable, someone else's chat not.
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({
                user_id: "gmail-agent",
                direction: "inbound",
                chat_id: "chat-mine",
            }),
        ),
        true,
        "email linked to my chat is readable",
    );
    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({
                user_id: "gmail-agent",
                direction: "inbound",
                chat_id: "chat-other",
            }),
        ),
        false,
        "email linked to another user's chat is NOT readable",
    );

    // 8. Batch filter: keeps readable rows, drops the rest, preserves order,
    //    and prefetches each linked-resource table with ONE .in() query
    //    (no per-row N+1).
    const counts: Record<string, number> = {};
    const rows = [
        email({ id: "a", user_id: "me" }),
        email({
            id: "b",
            user_id: "gmail-agent",
            direction: "inbound",
            signature_envelope_id: "env-mine",
        }),
        email({
            id: "c",
            user_id: "gmail-agent",
            direction: "inbound",
            signature_envelope_id: "env-other",
        }),
        email({ id: "d", user_id: "gmail-agent", direction: "inbound", org_id: "org-firm" }),
        email({ id: "e", user_id: "alice", direction: "outbound" }),
        email({
            id: "f",
            user_id: "gmail-agent",
            direction: "inbound",
            chat_id: "chat-other",
        }),
        email({
            id: "g",
            user_id: "alice",
            direction: "inbound",
            project_id: "proj-shared",
        }),
    ];
    const readable = await filterReadableEmails(
        fixtureDb(counts),
        "me",
        rows,
        "me@firm.test",
    );
    assert.deepEqual(
        readable.map((r) => r.id),
        ["a", "b", "d", "g"],
        "batch filter keeps exactly the readable rows, in order",
    );
    assert.equal(
        counts["signature_envelopes"],
        1,
        "envelopes prefetched in one batch query",
    );
    assert.equal(counts["chats"], 1, "chats prefetched in one batch query");

    // 9. Empty input short-circuits without queries.
    const noCounts: Record<string, number> = {};
    assert.deepEqual(
        await filterReadableEmails(fixtureDb(noCounts), "me", []),
        [],
    );
    assert.deepEqual(noCounts, {}, "no queries for an empty batch");

    // 10. Even an owned linked row resolves its resource, so removing the
    // creator from a matter cannot leave a hidden creator-access bypass.
    const ownCounts: Record<string, number> = {};
    const own = await filterReadableEmails(fixtureDb(ownCounts), "me", [
        email({ id: "x", user_id: "me", chat_id: "chat-mine" }),
    ]);
    assert.equal(own.length, 1);
    assert.equal(ownCounts.chats, 1, "owned linked rows still resolve access");

    assert.equal(
        await canUserReadEmail(
            fixtureDb(),
            "me",
            email({ user_id: "me", project_id: "project-after-removal" }),
            "me@firm.test",
        ),
        false,
        "a creator cannot read a project email after matter access is removed",
    );

    console.log("access.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
