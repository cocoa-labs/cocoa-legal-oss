// backend/src/lib/automation/ackTemplate.test.ts
//
// The acknowledgement body is DETERMINISTIC template substitution — the one
// hard guarantee on the outbound path is that no LLM text can flow into it.
// These tests pin the substitution contract with the seeded template's keys
// (pi.claims.ack_template: claim_number / carrier / client_name /
// adjuster_name): known vars replace, unknown/undefined vars blank out, and
// the template text itself passes through untouched.
import assert from "node:assert/strict";
import { renderAckTemplate } from "./ackTemplate";

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

console.log("automation/ackTemplate.test.ts");

test("replaces every seeded placeholder, including repeats", () => {
    const template =
        "Re: Claim No. {{claim_number}} — {{client_name}}\n\n" +
        "Dear {{adjuster_name}},\n\n" +
        "We confirm receipt regarding the claim with {{carrier}}. " +
        "Reference claim number {{claim_number}} in all communications.";
    const out = renderAckTemplate(template, {
        claim_number: "24-1234567",
        carrier: "Example Mutual",
        client_name: "Jane Doe",
        adjuster_name: "John Adjuster",
    });
    assert.equal(
        out,
        "Re: Claim No. 24-1234567 — Jane Doe\n\n" +
            "Dear John Adjuster,\n\n" +
            "We confirm receipt regarding the claim with Example Mutual. " +
            "Reference claim number 24-1234567 in all communications.",
    );
});

test("unknown placeholders render as empty string, not literal braces", () => {
    assert.equal(
        renderAckTemplate("Hello {{nonexistent_key}}!", { claim_number: "1" }),
        "Hello !",
    );
});

test("undefined values render as empty string", () => {
    assert.equal(
        renderAckTemplate("Dear {{adjuster_name}},", {
            adjuster_name: undefined,
        }),
        "Dear ,",
    );
});

test("whitespace inside braces is tolerated ({{ key }})", () => {
    assert.equal(
        renderAckTemplate("No. {{ claim_number }}", { claim_number: "X-1" }),
        "No. X-1",
    );
});

test("text without placeholders passes through byte-for-byte", () => {
    const template = "Nothing to substitute { here } or {single}.";
    assert.equal(renderAckTemplate(template, {}), template);
});

test("substituted values are inserted literally (no re-expansion)", () => {
    // A value containing {{...}} must not be treated as a placeholder — the
    // substitution is a single deterministic pass over the template.
    assert.equal(
        renderAckTemplate("A: {{a}}", { a: "{{b}}", b: "evil" }),
        "A: {{b}}",
    );
});

console.log("automation/ackTemplate.test.ts: all passed");
