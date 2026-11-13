// backend/src/lib/legalCapabilities/documentAuthoring.test.ts
//
// Guard test for the CRE authoring capability. Runs in its own process (one
// tsx invocation per test file in package.json), so importing the capability
// here does not leak registry state into the byte-equality snapshot test for
// the system prompt.
//
// The load-bearing guard mirrors commercialRealEstate.test.ts: every cre.*
// playbook key this capability references — declared in playbookKeys AND any
// {{playbook:cre.*}} placeholder inlined in its workflow prompt or
// system-prompt fragment — MUST be present in CRE_PLAYBOOK_KEYS, which the
// seed migration (009_cre_playbook_seed.sql) covers. Because authoring reuses
// the canonical cre.* set verbatim (no new keys), this should always hold;
// the test fails fast if a future edit introduces an unseeded key.

import assert from "node:assert/strict";
import {
    getCapability,
    capabilitiesByPractice,
    clearRegistryForTests,
} from "./index";
import { CRE_PLAYBOOK_KEYS } from "./creProfiles";

async function testCapabilityRegisters() {
    clearRegistryForTests();
    // Importing the module self-registers the capability (side effect).
    const { documentAuthoringCapability } = await import("./documentAuthoring");

    const cap = getCapability("cre-authoring");
    assert.ok(cap, "cre-authoring capability should resolve from the registry");
    assert.equal(cap.id, "cre-authoring");
    assert.equal(cap.practice, "Real Estate");
    assert.equal(cap, documentAuthoringCapability);

    const realEstate = capabilitiesByPractice("Real Estate");
    assert.ok(
        realEstate.some((c) => c.id === "cre-authoring"),
        "capabilitiesByPractice('Real Estate') should include cre-authoring",
    );
}

// THE GUARD: every cre.* key the capability references (playbookKeys plus any
// {{playbook:cre.*}} placeholder in its workflow/system-prompt fragment) must
// be present in CRE_PLAYBOOK_KEYS. The seed migration must cover that list.
async function testEveryCrePlaybookKeyIsCanonical() {
    const cap = getCapability("cre-authoring");
    assert.ok(cap);
    const canonical = new Set<string>(CRE_PLAYBOOK_KEYS);

    // 1) Declared playbookKeys only reference seeded cre.* keys.
    for (const k of cap.playbookKeys) {
        assert.ok(
            CRE_PLAYBOOK_KEYS.includes(k as never),
            `unseeded playbook key: ${k}`,
        );
    }

    // 2) Any cre.* placeholder inlined in the workflow prompt or the
    //    system-prompt fragment must also resolve to a canonical key, so
    //    nothing is blanked at runtime by substitute().
    const placeholderRe = /\{\{playbook:(cre\.[^}\s]+)\}\}/g;
    const haystacks: string[] = [
        cap.systemPromptFragment.persona_framing,
        cap.systemPromptFragment.methodology,
    ];
    if (cap.workflow.type === "assistant") {
        haystacks.push(cap.workflow.prompt_md);
    } else {
        for (const col of cap.workflow.columns_config) haystacks.push(col.prompt);
    }
    for (const text of haystacks) {
        for (const m of text.matchAll(placeholderRe)) {
            assert.ok(
                canonical.has(m[1]),
                `cre.* placeholder {{playbook:${m[1]}}} is not in CRE_PLAYBOOK_KEYS`,
            );
        }
    }

    // 3) playbookKeys must EQUAL the canonical set (no missing, no extra).
    assert.deepEqual(
        [...cap.playbookKeys].sort(),
        [...CRE_PLAYBOOK_KEYS].sort(),
        "capability.playbookKeys must equal CRE_PLAYBOOK_KEYS exactly",
    );
}

async function testDeclaresDocxAndInAppOutputs() {
    const cap = getCapability("cre-authoring");
    assert.ok(cap);
    assert.equal(cap.outputs.docx, true);
    assert.equal(cap.outputs.in_app_document, true);
}

async function main() {
    await testCapabilityRegisters();
    await testEveryCrePlaybookKeyIsCanonical();
    await testDeclaresDocxAndInAppOutputs();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
