// backend/src/lib/legalCapabilities/personalInjury.test.ts
//
// Guard test for the two Personal Injury capabilities (pi-claims-triage and
// pi-invoice-processing). Runs in its own process (one tsx invocation per
// test file in package.json), so importing the capabilities here does not
// leak registry state into the byte-equality snapshot test for the system
// prompt.
//
// The load-bearing guard mirrors commercialRealEstate.test.ts, with one
// deliberate strengthening: it READS THE SEED MIGRATION FROM DISK
// (024_pi_playbook_seed.sql) and asserts the capability↔seed lockstep in
// both directions — every canonical pi.* key is seeded, and the migration
// seeds no pi.* key outside the canonical list. Unlike CRE (whose two
// capabilities share the full key set), the PI modules each declare a
// SUBSET of PI_PLAYBOOK_KEYS (the prompt-key subsets in piProfiles.ts), so
// the equality assertion here is against those subsets, plus a ⊆ check
// against the canonical list.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    getCapability,
    capabilitiesByPractice,
    clearRegistryForTests,
} from "./index";
import {
    PI_PLAYBOOK_KEYS,
    PI_CLAIMS_PROMPT_KEYS,
    PI_INVOICE_PROMPT_KEYS,
} from "./piProfiles";

const SEED_MIGRATION_PATH = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "migrations",
    "024_pi_playbook_seed.sql",
);

const PI_CAPABILITY_IDS = ["pi-claims-triage", "pi-invoice-processing"] as const;

async function testCapabilitiesRegister() {
    clearRegistryForTests();
    // Importing the modules self-registers each capability (side effect).
    const { piClaimsTriageCapability } = await import("./piClaimsTriage");
    const { piInvoiceProcessingCapability } = await import(
        "./piInvoiceProcessing"
    );

    const claims = getCapability("pi-claims-triage");
    assert.ok(claims, "pi-claims-triage should resolve from the registry");
    assert.equal(claims.id, "pi-claims-triage");
    assert.equal(claims.practice, "Personal Injury");
    assert.equal(claims.workflow.type, "assistant");
    assert.equal(claims, piClaimsTriageCapability);

    const invoices = getCapability("pi-invoice-processing");
    assert.ok(invoices, "pi-invoice-processing should resolve from the registry");
    assert.equal(invoices.id, "pi-invoice-processing");
    assert.equal(invoices.practice, "Personal Injury");
    assert.equal(invoices.workflow.type, "assistant");
    assert.equal(invoices, piInvoiceProcessingCapability);

    const pi = capabilitiesByPractice("Personal Injury");
    for (const id of PI_CAPABILITY_IDS) {
        assert.ok(
            pi.some((c) => c.id === id),
            `capabilitiesByPractice('Personal Injury') should include ${id}`,
        );
    }
}

// GUARD (a): every canonical pi.* key is seeded by migration 024, and the
// migration seeds no pi.* key that is not canonical. This reads the actual
// SQL file so a key added to PI_PLAYBOOK_KEYS without a seed (or a seed for
// a phantom key) is caught in CI, not at runtime by a blanked placeholder.
async function testSeedMigrationCoversCanonicalKeys() {
    assert.ok(
        fs.existsSync(SEED_MIGRATION_PATH),
        `seed migration missing at ${SEED_MIGRATION_PATH}`,
    );
    const sql = fs.readFileSync(SEED_MIGRATION_PATH, "utf8");

    for (const key of PI_PLAYBOOK_KEYS) {
        assert.ok(
            sql.includes(`'${key}'`),
            `PI_PLAYBOOK_KEYS key "${key}" is not seeded by 024_pi_playbook_seed.sql`,
        );
    }

    // Reverse direction: every quoted pi.* literal in the migration must be
    // canonical, so the seed cannot drift ahead of the code.
    const canonical = new Set<string>(PI_PLAYBOOK_KEYS);
    for (const m of sql.matchAll(/'(pi\.[a-z0-9_.]+)'/g)) {
        assert.ok(
            canonical.has(m[1]),
            `024_pi_playbook_seed.sql seeds "${m[1]}" which is not in PI_PLAYBOOK_KEYS`,
        );
    }
}

// GUARD (b) + (c): for each module, every {{playbook:pi.*}} placeholder in
// its persona/methodology/workflow prompt must appear in that module's
// playbookKeys (the selection machinery inlines only declared keys), and
// its playbookKeys must be a subset of the canonical PI_PLAYBOOK_KEYS
// (which guard (a) proves are all seeded).
async function testModuleKeysAreDeclaredAndCanonical() {
    const canonical = new Set<string>(PI_PLAYBOOK_KEYS);
    const placeholderRe = /\{\{playbook:(pi\.[^}\s]+)\}\}/g;

    for (const id of PI_CAPABILITY_IDS) {
        const cap = getCapability(id);
        assert.ok(cap, `capability ${id} should be registered`);

        // (c) playbookKeys ⊆ PI_PLAYBOOK_KEYS.
        for (const key of cap.playbookKeys) {
            assert.ok(
                canonical.has(key),
                `${id}.playbookKeys references "${key}" which is not in PI_PLAYBOOK_KEYS — seed it in 024_pi_playbook_seed.sql and add it to piProfiles.ts`,
            );
        }

        // (b) every inlined pi.* placeholder is declared on the module.
        const declared = new Set(cap.playbookKeys);
        const haystacks: string[] = [
            cap.systemPromptFragment.persona_framing,
            cap.systemPromptFragment.methodology,
        ];
        if (cap.workflow.type === "assistant") {
            haystacks.push(cap.workflow.prompt_md);
        } else {
            for (const col of cap.workflow.columns_config) {
                haystacks.push(col.prompt);
            }
        }
        for (const text of haystacks) {
            for (const m of text.matchAll(placeholderRe)) {
                assert.ok(
                    declared.has(m[1]),
                    `${id} inlines {{playbook:${m[1]}}} but does not declare it in playbookKeys — the substitution machinery only resolves declared keys`,
                );
            }
        }
    }
}

// Lockstep with piProfiles.ts: the modules' playbookKeys must EQUAL the
// prompt-key subsets (no missing, no extra), so the profile constants stay
// the single source of truth.
async function testModuleKeysEqualProfileSubsets() {
    const claims = getCapability("pi-claims-triage");
    assert.ok(claims);
    assert.deepEqual(
        [...claims.playbookKeys].sort(),
        [...PI_CLAIMS_PROMPT_KEYS].sort(),
        "pi-claims-triage.playbookKeys must equal PI_CLAIMS_PROMPT_KEYS exactly",
    );

    const invoices = getCapability("pi-invoice-processing");
    assert.ok(invoices);
    assert.deepEqual(
        [...invoices.playbookKeys].sort(),
        [...PI_INVOICE_PROMPT_KEYS].sort(),
        "pi-invoice-processing.playbookKeys must equal PI_INVOICE_PROMPT_KEYS exactly",
    );

    // The prompt subsets themselves must be subsets of the canonical list.
    const canonical = new Set<string>(PI_PLAYBOOK_KEYS);
    for (const key of [...PI_CLAIMS_PROMPT_KEYS, ...PI_INVOICE_PROMPT_KEYS]) {
        assert.ok(
            canonical.has(key),
            `prompt subset key "${key}" is not in PI_PLAYBOOK_KEYS`,
        );
    }
}

// Professional-responsibility framing: both PI methodologies must carry the
// CRE modules' one-sentence engagement framing (analysis to assist a
// licensed attorney; not legal advice; no attorney-client relationship).
// The fragment is ctx-gated, so the empty-ctx byte-equality snapshot test
// (systemPrompt/index.test.ts) stays the proof it never leaks into the
// legacy prompt.
async function testEngagementFraming() {
    const framing =
        "this is analysis to assist a licensed attorney; it is not legal advice and creates no attorney-client relationship";
    for (const id of PI_CAPABILITY_IDS) {
        const cap = getCapability(id);
        assert.ok(cap, `capability ${id} should be registered`);
        assert.ok(
            cap.systemPromptFragment.methodology.includes(framing),
            `${id} methodology must carry the engagement framing sentence`,
        );
    }
}

// The claims acknowledgement is a human-approved email draft: the capability
// must declare the draft_email binding against the seeded template key, and
// neither PI capability produces documents.
async function testOutputBindings() {
    const claims = getCapability("pi-claims-triage");
    assert.ok(claims);
    assert.equal(claims.outputs.docx, false);
    assert.equal(claims.outputs.in_app_document, false);
    assert.equal(claims.outputs.draft_email?.template, "pi.claims.ack_template");
    assert.ok(claims.connectorRequirements.includes("email"));

    const invoices = getCapability("pi-invoice-processing");
    assert.ok(invoices);
    assert.equal(invoices.outputs.docx, false);
    assert.equal(invoices.outputs.in_app_document, false);
    assert.ok(invoices.connectorRequirements.includes("email"));
}

async function main() {
    await testCapabilitiesRegister();
    await testSeedMigrationCoversCanonicalKeys();
    await testModuleKeysAreDeclaredAndCanonical();
    await testModuleKeysEqualProfileSubsets();
    await testEngagementFraming();
    await testOutputBindings();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
