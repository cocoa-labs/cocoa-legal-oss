// backend/src/lib/enrichWithPriorEvents.test.ts
//
// enrichWithPriorEvents is the only mechanism that tells the agent what it did
// in earlier turns. It surfaced document/workflow activity but NOT outbound
// email or signature lifecycle — so after an email was sent, a bare "thanks"
// made the agent re-draft the same email (it had no record it ever went out).
// These tests pin the email/signature awareness alongside the existing
// doc/workflow behavior.
import assert from "node:assert/strict";
import { enrichWithPriorEvents, type ChatMessage } from "./chatTools";

// Minimal chainable Supabase stub. Each builder method returns the same
// thenable, so a query like
//   db.from(t).select("*").eq(...).eq(...).order(...).limit(...)
// resolves to the canned { data, error } for that table.
function makeDb(byTable: Record<string, { data: unknown[]; error?: unknown }>) {
    function chain(table: string) {
        const res = byTable[table] ?? { data: [], error: null };
        const c: Record<string, unknown> = {
            select: () => c,
            eq: () => c,
            in: () => c,
            order: () => c,
            limit: () => c,
            then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
                Promise.resolve({
                    data: res.data ?? [],
                    error: res.error ?? null,
                }).then(resolve, reject as never),
        };
        return c;
    }
    return { from: (t: string) => chain(t) } as never;
}

const CHAT_ID = "chat-1";

function baseMessages(): ChatMessage[] {
    return [
        { role: "user", content: "Email me the Acme Corp report." },
        { role: "assistant", content: "Done — it's awaiting your approval." },
        { role: "user", content: "Thanks, you rock!" },
    ];
}

function outboundEmail(over: Record<string, unknown>) {
    return {
        id: "em-1",
        chat_id: CHAT_ID,
        direction: "outbound",
        status: "sent",
        to_addresses: ["alex@example.com"],
        cc_addresses: [],
        bcc_addresses: [],
        subject: "Acme Corp IPO Research Report - June 2026",
        body_text: "...",
        attachments: [],
        user_id: "u1",
        created_at: "t1",
        updated_at: "t1",
        ...over,
    };
}

// PRIMARY: an email already SENT in this chat must be surfaced to the model on
// the next turn, with an explicit instruction not to re-send it. Without this,
// a bare "thanks" makes the agent re-draft the same email.
async function testSentEmailSurfacedWithDoNotResend() {
    const db = makeDb({
        chat_messages: { data: [{ content: [], created_at: "t1" }] },
        email_messages: { data: [outboundEmail({ status: "sent" })] },
        signature_envelopes: { data: [] },
    });

    const out = await enrichWithPriorEvents(baseMessages(), CHAT_ID, db, {});
    // The note attaches to the most recent assistant message (index 1).
    const assistant = out[1].content ?? "";
    assert.match(assistant, /already SENT/, "should state the email was sent");
    assert.ok(
        assistant.includes("alex@example.com"),
        "should name the recipient",
    );
    assert.ok(
        assistant.includes("Acme Corp IPO Research Report - June 2026"),
        "should name the subject",
    );
    assert.match(
        assistant,
        /Do NOT re-draft/,
        "should instruct the model not to re-draft/re-send",
    );
}

// A still-pending email should read as awaiting approval (not sent), so the
// model tells the user to approve the existing draft rather than making a new
// one.
async function testPendingEmailSurfacedAsAwaitingApproval() {
    const db = makeDb({
        chat_messages: { data: [{ content: [], created_at: "t1" }] },
        email_messages: {
            data: [outboundEmail({ status: "pending_approval", id: "em-2" })],
        },
        signature_envelopes: { data: [] },
    });

    const out = await enrichWithPriorEvents(baseMessages(), CHAT_ID, db, {});
    assert.match(
        out[1].content ?? "",
        /AWAITING your approval/,
        "pending email should read as awaiting approval",
    );
}

// A cancelled email should read as cancelled (not as a live draft to resend).
async function testCancelledEmailSurfacedAsCancelled() {
    const db = makeDb({
        chat_messages: { data: [{ content: [], created_at: "t1" }] },
        email_messages: {
            data: [outboundEmail({ status: "cancelled", id: "em-3" })],
        },
        signature_envelopes: { data: [] },
    });

    const out = await enrichWithPriorEvents(baseMessages(), CHAT_ID, db, {});
    assert.match(out[1].content ?? "", /CANCELLED/, "should read as cancelled");
}

// Existing contract: no chatId → messages returned unchanged.
async function testNoChatIdReturnsUnchanged() {
    const db = makeDb({});
    const messages = baseMessages();
    const out = await enrichWithPriorEvents(messages, null, db, {});
    assert.equal(out, messages, "should return the same array reference");
    assert.equal(out[1].content, "Done — it's awaiting your approval.");
}

// Regression: prior-turn document activity must still be surfaced (this is the
// behavior the email case is being added alongside).
async function testDocActivityStillSurfaced() {
    const db = makeDb({
        chat_messages: {
            data: [
                {
                    content: [
                        {
                            type: "doc_created",
                            document_id: "uuid-brief",
                            filename: "Brief.docx",
                        },
                    ],
                    created_at: "t1",
                },
            ],
        },
        email_messages: { data: [] },
        signature_envelopes: { data: [] },
    });

    const out = await enrichWithPriorEvents(baseMessages(), CHAT_ID, db, {});
    assert.match(
        out[1].content ?? "",
        /generate_docx → "Brief\.docx"/,
        "doc_created activity should still be summarized",
    );
}

async function main() {
    await testSentEmailSurfacedWithDoNotResend();
    await testPendingEmailSurfacedAsAwaitingApproval();
    await testCancelledEmailSurfacedAsCancelled();
    await testNoChatIdReturnsUnchanged();
    await testDocActivityStillSurfaced();
    console.log("enrichWithPriorEvents.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
