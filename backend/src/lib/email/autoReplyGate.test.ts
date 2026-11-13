// backend/src/lib/email/autoReplyGate.test.ts
//
// The auto-reply gate is the ENTIRE safety envelope for autonomous email
// sending (there is no human approval). These tests pin every deny branch.
import assert from "node:assert/strict";
import { evaluateAutoReplyGate, extractAddress } from "./autoReply";

function base(over: Record<string, unknown> = {}) {
    return {
        enabled: true,
        hasChatLink: true,
        fromAddress: "Taylor Mockley <taylor@testbedyards.test>",
        agentAddress: "legal@example.com",
        autoSubmitted: null,
        precedence: null,
        listId: null,
        listUnsubscribe: null,
        outboundCount: 1,
        maxPerThread: 10,
        alreadyReplied: false,
        ...over,
    } as Parameters<typeof evaluateAutoReplyGate>[0];
}

function main() {
    // Happy path: a real reply on an agent-initiated thread → allow.
    assert.equal(evaluateAutoReplyGate(base()).allow, true);

    // Master kill-switch.
    assert.equal(evaluateAutoReplyGate(base({ enabled: false })).allow, false);

    // Only agent-initiated threads.
    assert.equal(
        evaluateAutoReplyGate(base({ hasChatLink: false })).allow,
        false,
    );

    // Idempotency: already replied to this message.
    assert.equal(
        evaluateAutoReplyGate(base({ alreadyReplied: true })).allow,
        false,
    );

    // Loop guard: never reply to our own address.
    assert.equal(
        evaluateAutoReplyGate(
            base({ fromAddress: "Quill <legal@example.com>" }),
        ).allow,
        false,
    );

    // Blocked robot/bounce senders.
    for (const f of [
        "no-reply@acme.com",
        "noreply@acme.com",
        "mailer-daemon@acme.com",
        "postmaster@acme.com",
        "bounce@acme.com",
    ]) {
        assert.equal(
            evaluateAutoReplyGate(base({ fromAddress: f })).allow,
            false,
            `should block ${f}`,
        );
    }

    // Auto-responders (Auto-Submitted), but "no" is fine.
    assert.equal(
        evaluateAutoReplyGate(base({ autoSubmitted: "auto-replied" })).allow,
        false,
    );
    assert.equal(
        evaluateAutoReplyGate(base({ autoSubmitted: "no" })).allow,
        true,
    );

    // Bulk / list precedence.
    assert.equal(
        evaluateAutoReplyGate(base({ precedence: "bulk" })).allow,
        false,
    );
    assert.equal(
        evaluateAutoReplyGate(base({ precedence: "list" })).allow,
        false,
    );

    // Mailing-list headers.
    assert.equal(
        evaluateAutoReplyGate(base({ listId: "<list.acme.com>" })).allow,
        false,
    );
    assert.equal(
        evaluateAutoReplyGate(
            base({ listUnsubscribe: "<mailto:u@acme.com>" }),
        ).allow,
        false,
    );

    // Per-thread reply cap.
    assert.equal(
        evaluateAutoReplyGate(base({ outboundCount: 10, maxPerThread: 10 }))
            .allow,
        false,
    );
    assert.equal(
        evaluateAutoReplyGate(base({ outboundCount: 9, maxPerThread: 10 }))
            .allow,
        true,
    );

    // Unusable sender address.
    assert.equal(
        evaluateAutoReplyGate(base({ fromAddress: "garbage" })).allow,
        false,
    );

    // extractAddress: pulls + lowercases the bare address.
    assert.equal(
        extractAddress("Taylor Mockley <Taylor@Testbed.test>"),
        "taylor@testbed.test",
    );
    assert.equal(extractAddress("bare@x.com"), "bare@x.com");

    console.log("autoReplyGate.test.ts: all passed");
}

main();
