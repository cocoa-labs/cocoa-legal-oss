// backend/src/lib/legalCapabilities/recordingsCapability.test.ts
//
// Guard test for the Meeting & Recording Intelligence capability
// (meeting-intelligence). Runs in its own tsx process, so importing the
// capability here does not leak registry state into the byte-equality snapshot
// test for the system prompt. Mirrors the shape assertions in
// personalInjury.test.ts but is simpler: this capability seeds no playbook
// keys, so the load-bearing guard is that playbookKeys is empty AND no
// {{playbook:...}} placeholder appears anywhere in its prompts (which would
// reference an unseeded key).

import assert from "node:assert/strict";
import {
    getCapability,
    allCapabilities,
    capabilitiesByPractice,
    clearRegistryForTests,
} from "./index";
import type { LegalPractice } from "./types";

// The full LegalPractice union (types.ts) — the practice value must be one.
const VALID_PRACTICES: ReadonlySet<LegalPractice> = new Set([
    "Legal Operations",
    "Corporate",
    "Finance",
    "Employment",
    "Real Estate",
    "Litigation",
    "Personal Injury",
    "Private Equity",
    "General Transactions",
]);

async function testRegistersWithValidShape() {
    clearRegistryForTests();
    // Importing the module self-registers the capability (side effect).
    const { recordingsCapability } = await import("./recordingsCapability");

    const cap = getCapability("meeting-intelligence");
    assert.ok(cap, "meeting-intelligence should resolve from the registry");
    assert.equal(cap, recordingsCapability);
    assert.equal(cap.id, "meeting-intelligence");
    assert.equal(cap.title, "Meeting & Recording Intelligence");

    // Practice value must be a member of the union.
    assert.ok(
        VALID_PRACTICES.has(cap.practice),
        `practice "${cap.practice}" is not a valid LegalPractice`,
    );

    // Assistant workflow with a non-empty conversational prompt.
    assert.equal(cap.workflow.type, "assistant");
    if (cap.workflow.type === "assistant") {
        assert.ok(
            cap.workflow.prompt_md.trim().length > 0,
            "workflow.prompt_md must be non-empty",
        );
    }

    // Fragment strings non-empty.
    assert.ok(
        cap.systemPromptFragment.persona_framing.trim().length > 0,
        "persona_framing must be non-empty",
    );
    assert.ok(
        cap.systemPromptFragment.methodology.trim().length > 0,
        "methodology must be non-empty",
    );

    // Registered instance is discoverable via the practice filter + snapshot.
    assert.ok(
        capabilitiesByPractice(cap.practice).some(
            (c) => c.id === "meeting-intelligence",
        ),
        "capabilitiesByPractice should include meeting-intelligence",
    );
    assert.ok(
        allCapabilities().some((c) => c.id === "meeting-intelligence"),
        "allCapabilities should include meeting-intelligence",
    );
}

// playbookKeys is empty AND no {{playbook:...}} placeholder appears in any
// prompt — the hard CLAUDE.md rule is never to reference an unseeded key, and
// this capability seeds none, so it must inline none.
async function testNoPlaybookKeysReferenced() {
    const cap = getCapability("meeting-intelligence");
    assert.ok(cap);
    assert.deepEqual(cap.playbookKeys, [], "playbookKeys must be empty");

    const placeholderRe = /\{\{playbook:[^}\s]+\}\}/;
    const haystacks = [
        cap.systemPromptFragment.persona_framing,
        cap.systemPromptFragment.methodology,
        cap.workflow.type === "assistant" ? cap.workflow.prompt_md : "",
    ];
    for (const text of haystacks) {
        assert.ok(
            !placeholderRe.test(text),
            "no {{playbook:...}} placeholder may appear (no keys are seeded)",
        );
    }
}

// Intent signals + output/connector declarations.
async function testIntentAndOutputs() {
    const cap = getCapability("meeting-intelligence");
    assert.ok(cap);

    for (const kw of ["recording", "recordings", "transcript", "action items"]) {
        assert.ok(
            cap.intentSignals.keywords.includes(kw),
            `intentSignals.keywords should include "${kw}"`,
        );
    }
    assert.deepEqual(cap.intentSignals.document_hints, []);
    assert.ok(
        cap.intentSignals.confirm_prompt.trim().length > 0,
        "confirm_prompt must be non-empty",
    );

    assert.equal(cap.outputs.docx, false);
    assert.equal(cap.outputs.in_app_document, true);
    assert.ok(
        cap.connectorRequirements.includes("email"),
        "connectorRequirements should include email",
    );
    assert.ok(
        cap.resultCard.trim().length > 0,
        "resultCard must be a non-empty component name",
    );
}

async function main() {
    await testRegistersWithValidShape();
    await testNoPlaybookKeysReferenced();
    await testIntentAndOutputs();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
