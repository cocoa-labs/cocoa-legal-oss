// backend/src/lib/systemPrompt/firmContext.test.ts
//
// Proves the firm-aware branch of buildSystemPrompt:
//  1. THE INVARIANT — even with a capability registered (populated
//     registry), buildSystemPrompt({}) is byte-identical to the legacy
//     snapshot. Emission is gated on the ctx flag, not on registry size.
//  2. With firmId + resolvedPlaybook, capability fragments are emitted and
//     {{playbook:key}} placeholders are substituted with the resolved
//     value (no literal "{{playbook:" survives).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildSystemPrompt } from "./index";
import {
    registerCapability,
    clearRegistryForTests,
} from "../legalCapabilities";
import type { LegalCapability } from "../legalCapabilities/types";

const LEGACY_SNAPSHOT_PATH = path.join(
    __dirname,
    "__fixtures__",
    "legacy-system-prompt.txt",
);
const LEGACY_SYSTEM_PROMPT = fs.readFileSync(LEGACY_SNAPSHOT_PATH, "utf8");

const dummyCapability: LegalCapability = {
    id: "dummy-steering-cap",
    title: "Dummy Steering Capability",
    practice: "Real Estate",
    description: "Test-only capability proving the steering chain.",
    workflow: {
        type: "assistant",
        prompt_md: "Use {{playbook:dummy.steering_key}}.",
    },
    systemPromptFragment: {
        persona_framing: "When steering, apply the firm's standard.",
        // The placeholder under test lives inside the methodology fragment.
        methodology:
            "Firm standard positions: {{playbook:dummy.steering_key}}.",
    },
    playbookKeys: ["dummy.steering_key"],
    intentSignals: {
        keywords: ["steer"],
        document_hints: [],
        confirm_prompt: "Run steering?",
        run_label: "Run review",
    },
    resultCard: "DummyCard",
    outputs: { docx: false, in_app_document: false },
    connectorRequirements: [],
};

// THE INVARIANT: a populated registry must NOT change empty-ctx output.
async function testEmptyCtxByteIdenticalEvenWithRegisteredCapability() {
    clearRegistryForTests();
    registerCapability(dummyCapability);
    // Registry now has one capability; the legacy/empty-ctx path must
    // still produce byte-identical output because emission is gated on
    // the ctx flag, not on allCapabilities().length.
    const built = buildSystemPrompt({});
    assert.equal(
        built,
        LEGACY_SYSTEM_PROMPT,
        "buildSystemPrompt({}) must stay byte-identical even with a populated registry",
    );
    assert.equal(built.includes("LEGAL CAPABILITIES:"), false);
    assert.equal(built.includes("dummy-steering-cap"), false);
}

async function testFirmCtxEmitsAndSubstitutes() {
    clearRegistryForTests();
    registerCapability(dummyCapability);
    const built = buildSystemPrompt({
        firmId: "firm-123",
        resolvedPlaybook: {
            "dummy.steering_key": "MUTUAL NDA, 2-year term",
        },
    });
    // Capability fragment is now present...
    assert.equal(built.includes("LEGAL CAPABILITIES:"), true);
    assert.equal(built.includes("dummy-steering-cap"), true);
    // ...the placeholder is substituted...
    assert.equal(built.includes("MUTUAL NDA, 2-year term"), true);
    // ...and NO literal template syntax leaks to the model.
    assert.equal(
        built.includes("{{playbook:"),
        false,
        "no literal {{playbook: should survive substitution",
    );
}

async function testFirmCtxStillStartsWithLegacyComposition() {
    // The firm-aware output is a superset: it begins with the exact
    // legacy prompt, then appends capability content.
    clearRegistryForTests();
    registerCapability(dummyCapability);
    const built = buildSystemPrompt({
        firmId: "firm-123",
        resolvedPlaybook: { "dummy.steering_key": "X" },
    });
    assert.equal(built.startsWith(LEGACY_SYSTEM_PROMPT), true);
}

async function main() {
    await testEmptyCtxByteIdenticalEvenWithRegisteredCapability();
    await testFirmCtxEmitsAndSubstitutes();
    await testFirmCtxStillStartsWithLegacyComposition();
    // Leave the registry clean for any sibling test in the same process.
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
