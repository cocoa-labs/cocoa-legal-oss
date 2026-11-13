// backend/src/lib/systemPrompt/capability-fragments.test.ts
//
// Proves fragment scoping: the full methodology of EVERY registered
// capability used to be injected on any single keyword hit. Now the caller
// passes the ids the turn actually matched (or forced) and only those
// capabilities contribute a fragment. Passing no ids keeps the legacy
// "emit everything" behaviour for callers that have not been updated.
import assert from "node:assert/strict";
import { capabilityFragments } from "./capability-fragments";
import {
    registerCapability,
    clearRegistryForTests,
} from "../legalCapabilities";
import type { LegalCapability } from "../legalCapabilities/types";

function fixture(id: string): LegalCapability {
    return {
        id,
        title: `Fixture ${id}`,
        practice: "Real Estate",
        description: "Test-only.",
        workflow: { type: "assistant", prompt_md: "x" },
        systemPromptFragment: {
            persona_framing: `persona-of-${id}`,
            methodology: `methodology-of-${id}`,
        },
        playbookKeys: [],
        intentSignals: {
            keywords: [id],
            document_hints: [],
            confirm_prompt: "Run?",
            run_label: "Run review",
        },
        resultCard: "Card",
        outputs: { docx: false, in_app_document: false },
        connectorRequirements: [],
    };
}

function registerBoth() {
    clearRegistryForTests();
    registerCapability(fixture("a"));
    registerCapability(fixture("b"));
}

async function testNoIdsEmitsEveryCapability() {
    registerBoth();
    const out = capabilityFragments();
    assert.equal(out.includes("--- CAPABILITY: a ---"), true);
    assert.equal(out.includes("--- CAPABILITY: b ---"), true);
    assert.equal(out.includes("methodology-of-a"), true);
    assert.equal(out.includes("methodology-of-b"), true);
}

async function testScopedIdsEmitOnlyThatCapability() {
    registerBoth();
    const out = capabilityFragments(["b"]);
    assert.equal(out.includes("--- CAPABILITY: b ---"), true);
    assert.equal(out.includes("persona-of-b"), true);
    assert.equal(out.includes("methodology-of-b"), true);
    assert.equal(out.includes("--- CAPABILITY: a ---"), false);
    assert.equal(out.includes("persona-of-a"), false);
    assert.equal(out.includes("methodology-of-a"), false);
}

async function testEmptyIdsEmitNothing() {
    registerBoth();
    assert.equal(capabilityFragments([]), "");
}

async function testUnknownIdEmitsNothing() {
    registerBoth();
    assert.equal(capabilityFragments(["not-registered"]), "");
}

async function testScopedIdsKeepRegistrationOrder() {
    registerBoth();
    const out = capabilityFragments(["b", "a"]);
    assert.equal(
        out.indexOf("--- CAPABILITY: a ---") <
            out.indexOf("--- CAPABILITY: b ---"),
        true,
        "fragments must follow registration order, not the caller's id order",
    );
}

async function testEmptyRegistryEmitsNothing() {
    clearRegistryForTests();
    assert.equal(capabilityFragments(), "");
    assert.equal(capabilityFragments(["a"]), "");
}

async function main() {
    await testNoIdsEmitsEveryCapability();
    await testScopedIdsEmitOnlyThatCapability();
    await testEmptyIdsEmitNothing();
    await testUnknownIdEmitsNothing();
    await testScopedIdsKeepRegistrationOrder();
    await testEmptyRegistryEmitsNothing();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
