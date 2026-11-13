// backend/src/lib/legalCapabilities/index.test.ts
import assert from "node:assert/strict";
import {
    LEGAL_CAPABILITIES,
    getCapability,
    allCapabilities,
    capabilitiesByPractice,
    registerCapability,
    clearRegistryForTests,
    runTargetFor,
} from "./index";
import type { CapabilityOutputSpec, LegalCapability } from "./types";

const fixture: LegalCapability = {
    id: "fixture-cap",
    title: "Fixture Capability",
    practice: "Legal Operations",
    description: "Test fixture only.",
    workflow: {
        type: "assistant",
        prompt_md: "Hello {{playbook:test.greeting}}.",
    },
    systemPromptFragment: {
        persona_framing: "When asked to fixture, do fixturely things.",
        methodology: "Fixture methodology.",
    },
    playbookKeys: ["test.greeting"],
    intentSignals: {
        keywords: ["fixture"],
        document_hints: [],
        confirm_prompt: "Run fixture?",
        run_label: "Run review",
    },
    resultCard: "FixtureCard",
    outputs: { docx: false, in_app_document: false },
    connectorRequirements: [],
};

async function testEmptyRegistryByDefault() {
    clearRegistryForTests();
    assert.deepEqual(LEGAL_CAPABILITIES(), []);
    assert.deepEqual(allCapabilities(), []);
    assert.equal(getCapability("anything"), null);
}

async function testRegisterAndLookup() {
    clearRegistryForTests();
    registerCapability(fixture);
    assert.equal(allCapabilities().length, 1);
    assert.equal(getCapability("fixture-cap")?.title, "Fixture Capability");
}

async function testDuplicateIdRejected() {
    clearRegistryForTests();
    registerCapability(fixture);
    assert.throws(
        () => registerCapability(fixture),
        /already registered/i,
    );
}

async function testByPracticeFilter() {
    clearRegistryForTests();
    registerCapability(fixture);
    registerCapability({ ...fixture, id: "corp-cap", practice: "Corporate" });
    const ops = capabilitiesByPractice("Legal Operations");
    assert.equal(ops.length, 1);
    assert.equal(ops[0].id, "fixture-cap");
}

const outputSpec: CapabilityOutputSpec = {
    overall_scheme: "risk-score",
    sections: [{ id: "findings", label: "Findings", kind: "findings" }],
};

async function testRunTargetChatWhenOutputSpecPresent() {
    assert.equal(
        runTargetFor({
            outputSpec,
            workflow: { type: "assistant", prompt_md: "x" },
        }),
        "chat",
    );
}

async function testRunTargetModalForTabularWithoutOutputSpec() {
    assert.equal(
        runTargetFor({ workflow: { type: "tabular", columns_config: [] } }),
        "modal",
    );
}

async function testRunTargetNullForAssistantWithoutOutputSpec() {
    assert.equal(
        runTargetFor({ workflow: { type: "assistant", prompt_md: "x" } }),
        null,
    );
}

async function testOutputSpecBeatsTabular() {
    // A tabular pack that also declares an outputSpec runs in chat: the
    // structured result card is the richer surface, so it wins.
    assert.equal(
        runTargetFor({
            outputSpec,
            workflow: { type: "tabular", columns_config: [] },
        }),
        "chat",
    );
}

async function main() {
    await testEmptyRegistryByDefault();
    await testRegisterAndLookup();
    await testDuplicateIdRejected();
    await testByPracticeFilter();
    await testRunTargetChatWhenOutputSpecPresent();
    await testRunTargetModalForTabularWithoutOutputSpec();
    await testRunTargetNullForAssistantWithoutOutputSpec();
    await testOutputSpecBeatsTabular();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
