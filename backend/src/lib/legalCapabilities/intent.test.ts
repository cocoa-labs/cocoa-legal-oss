// backend/src/lib/legalCapabilities/intent.test.ts
import assert from "node:assert/strict";
import {
    selectRelevantPlaybookKeys,
    selectRelevantCapabilities,
} from "./intent";
import { registerCapability, clearRegistryForTests } from "./index";
import type { LegalCapability } from "./types";

const cap: LegalCapability = {
    id: "intent-fixture",
    title: "Intent Fixture",
    practice: "Real Estate",
    description: "Test-only.",
    workflow: { type: "assistant", prompt_md: "x" },
    systemPromptFragment: { persona_framing: "p", methodology: "m" },
    playbookKeys: ["re.standard_positions", "re.escalation"],
    intentSignals: {
        keywords: ["lease", "estoppel"],
        document_hints: ["lease-agreement", ".dwg"],
        confirm_prompt: "Run?",
        run_label: "Run review",
    },
    resultCard: "Card",
    outputs: { docx: false, in_app_document: false },
    connectorRequirements: [],
};

// A second capability that the test messages below never match, so it can
// only enter a result via `forceIds`. Registered AFTER `cap` so the
// registration-order guarantee is observable.
const otherCap: LegalCapability = {
    id: "intent-fixture-b",
    title: "Intent Fixture B",
    practice: "Personal Injury",
    description: "Test-only.",
    workflow: { type: "assistant", prompt_md: "y" },
    systemPromptFragment: { persona_framing: "pb", methodology: "mb" },
    playbookKeys: ["pi.demand_posture", "re.escalation"],
    intentSignals: {
        keywords: ["demand letter"],
        document_hints: ["police-report"],
        confirm_prompt: "Run?",
        run_label: "Run triage",
    },
    resultCard: "CardB",
    outputs: { docx: false, in_app_document: false },
    connectorRequirements: [],
};


// Empty registry (today's prod) → no keys, regardless of input.
async function testEmptyRegistryYieldsNothing() {
    clearRegistryForTests();
    assert.deepEqual(
        selectRelevantPlaybookKeys({ text: "please review this lease" }),
        [],
    );
}

async function testKeywordMatchYieldsCapabilityKeys() {
    clearRegistryForTests();
    registerCapability(cap);
    const keys = selectRelevantPlaybookKeys({
        text: "Can you review this LEASE for me?",
    });
    assert.deepEqual(keys.sort(), ["re.escalation", "re.standard_positions"]);
}

async function testDocumentHintMatchOnFilename() {
    clearRegistryForTests();
    registerCapability(cap);
    const keys = selectRelevantPlaybookKeys({
        text: "have a look",
        filenames: ["Office-Lease-Agreement-2026.pdf"],
    });
    assert.deepEqual(keys.sort(), ["re.escalation", "re.standard_positions"]);
}

async function testNoMatchYieldsNothing() {
    clearRegistryForTests();
    registerCapability(cap);
    const keys = selectRelevantPlaybookKeys({
        text: "draft a thank-you note",
        filenames: ["note.txt"],
    });
    assert.deepEqual(keys, []);
}

// --- selectRelevantCapabilities ---------------------------------------

async function testSelectCapabilitiesReturnsMatchingIdsAndKeys() {
    clearRegistryForTests();
    registerCapability(cap);
    registerCapability(otherCap);
    const rel = selectRelevantCapabilities({
        text: "Can you review this LEASE for me?",
    });
    assert.deepEqual(rel.ids, ["intent-fixture"]);
    assert.deepEqual(rel.keys, [
        "re.standard_positions",
        "re.escalation",
    ]);
}

async function testForceIdsAddsNonMatchingCapability() {
    clearRegistryForTests();
    registerCapability(cap);
    registerCapability(otherCap);
    const rel = selectRelevantCapabilities(
        { text: "Can you review this LEASE for me?" },
        { forceIds: ["intent-fixture-b"] },
    );
    // Registration order: cap (matched) then otherCap (forced).
    assert.deepEqual(rel.ids, ["intent-fixture", "intent-fixture-b"]);
    // Deduped union in registration order — "re.escalation" appears in both
    // capabilities but only once, at its first position.
    assert.deepEqual(rel.keys, [
        "re.standard_positions",
        "re.escalation",
        "pi.demand_posture",
    ]);
}

async function testForceIdsAloneWithoutAnyMatch() {
    clearRegistryForTests();
    registerCapability(cap);
    registerCapability(otherCap);
    const rel = selectRelevantCapabilities(
        { text: "draft a thank-you note" },
        { forceIds: ["intent-fixture-b"] },
    );
    assert.deepEqual(rel.ids, ["intent-fixture-b"]);
    assert.deepEqual(rel.keys, ["pi.demand_posture", "re.escalation"]);
}

async function testUnknownForceIdIsIgnored() {
    clearRegistryForTests();
    registerCapability(cap);
    const rel = selectRelevantCapabilities(
        { text: "draft a thank-you note" },
        { forceIds: ["not-registered"] },
    );
    assert.deepEqual(rel, { ids: [], keys: [] });
}

async function testNoMatchNoForceIsEmpty() {
    clearRegistryForTests();
    registerCapability(cap);
    registerCapability(otherCap);
    assert.deepEqual(
        selectRelevantCapabilities({
            text: "draft a thank-you note",
            filenames: ["note.txt"],
        }),
        { ids: [], keys: [] },
    );
}

async function main() {
    await testEmptyRegistryYieldsNothing();
    await testKeywordMatchYieldsCapabilityKeys();
    await testDocumentHintMatchOnFilename();
    await testNoMatchYieldsNothing();
    await testSelectCapabilitiesReturnsMatchingIdsAndKeys();
    await testForceIdsAddsNonMatchingCapability();
    await testForceIdsAloneWithoutAnyMatch();
    await testUnknownForceIdIsIgnored();
    await testNoMatchNoForceIsEmpty();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
