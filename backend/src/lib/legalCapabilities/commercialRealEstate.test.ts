// backend/src/lib/legalCapabilities/commercialRealEstate.test.ts
//
// Guard test for the CRE capability. Runs in its own process (one tsx
// invocation per test file in package.json), so importing the capability
// here does not leak registry state into the byte-equality snapshot test
// for the system prompt.
//
// The key-coverage assertion is the load-bearing guard: every `cre.*`
// playbook key the capability references MUST be present in
// CRE_PLAYBOOK_KEYS — and the seed migration (009_cre_playbook_seed.sql)
// MUST seed every key in that list. A key added to the capability without a
// matching seed (or a seed for a key the capability never reads) would mean
// substitute() blanks a placeholder at runtime; this test fails fast on the
// capability side so that drift is caught in CI.

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
    const { commercialRealEstateCapability } = await import(
        "./commercialRealEstate"
    );

    const cap = getCapability("cre-review");
    assert.ok(cap, "cre-review capability should resolve from the registry");
    assert.equal(cap.id, "cre-review");
    assert.equal(cap.practice, "Real Estate");
    assert.equal(cap.workflow.type, "tabular");
    assert.equal(cap, commercialRealEstateCapability);

    const realEstate = capabilitiesByPractice("Real Estate");
    assert.ok(
        realEstate.some((c) => c.id === "cre-review"),
        "capabilitiesByPractice('Real Estate') should include cre-review",
    );
}

async function testTabularColumnsPresent() {
    const cap = getCapability("cre-review");
    assert.ok(cap);
    assert.equal(cap.workflow.type, "tabular");
    if (cap.workflow.type !== "tabular") return; // narrow for TS
    const cols = cap.workflow.columns_config;
    // Sanity: a real abstraction sheet, contiguous 0-based indices.
    assert.ok(cols.length >= 20, "expected the full lease abstraction column set");
    cols.forEach((c, i) => assert.equal(c.index, i, `column ${i} index mismatch`));
    // At least one column must steer off the firm playbook so review is
    // firm-aware end-to-end.
    assert.ok(
        cols.some((c) => c.prompt.includes("{{playbook:cre.lease.")),
        "at least one column prompt must reference the firm CRE playbook",
    );
}

// THE GUARD: every cre.* key the capability references (playbookKeys plus any
// {{playbook:cre.*}} placeholder in its workflow/system-prompt fragment) must
// be present in CRE_PLAYBOOK_KEYS. The seed migration must cover that list.
async function testEveryCrePlaybookKeyIsCanonical() {
    const cap = getCapability("cre-review");
    assert.ok(cap);
    const canonical = new Set<string>(CRE_PLAYBOOK_KEYS);

    // 1) Declared playbookKeys.
    for (const key of cap.playbookKeys) {
        if (key.startsWith("cre.")) {
            assert.ok(
                canonical.has(key),
                `capability.playbookKeys references cre.* key "${key}" not in CRE_PLAYBOOK_KEYS — seed it in 009_cre_playbook_seed.sql and add it to CRE_PLAYBOOK_KEYS`,
            );
        }
    }

    // 2) Any cre.* placeholder inlined in column prompts or the system-prompt
    //    fragment must also resolve to a canonical key, so nothing is blanked
    //    at runtime by substitute().
    const placeholderRe = /\{\{playbook:(cre\.[^}\s]+)\}\}/g;
    const haystacks: string[] = [
        cap.systemPromptFragment.persona_framing,
        cap.systemPromptFragment.methodology,
    ];
    if (cap.workflow.type === "tabular") {
        for (const col of cap.workflow.columns_config) haystacks.push(col.prompt);
    }
    for (const text of haystacks) {
        for (const m of text.matchAll(placeholderRe)) {
            assert.ok(
                canonical.has(m[1]),
                `cre.* placeholder {{playbook:${m[1]}}} is not in CRE_PLAYBOOK_KEYS — seed it in 009_cre_playbook_seed.sql and add it to CRE_PLAYBOOK_KEYS`,
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

async function main() {
    await testCapabilityRegisters();
    await testTabularColumnsPresent();
    await testEveryCrePlaybookKeyIsCanonical();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
