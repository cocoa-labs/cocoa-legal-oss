import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildSystemPrompt } from "./index";
import {
    clearRegistryForTests,
    registerCapability,
} from "../legalCapabilities";
import type { LegalCapability } from "../legalCapabilities/types";

const LEGACY_SNAPSHOT_PATH = path.join(
    __dirname,
    "__fixtures__",
    "legacy-system-prompt.txt",
);
const LEGACY_SYSTEM_PROMPT = fs.readFileSync(LEGACY_SNAPSHOT_PATH, "utf8");

async function testRefactorMatchesLegacy() {
    // Robustness: the empty-ctx output must be byte-identical regardless of
    // registry state. Clearing here proves it without weakening the
    // assertion — the firmContext test separately proves a POPULATED
    // registry also leaves empty-ctx output unchanged.
    clearRegistryForTests();
    const built = buildSystemPrompt({});
    if (built !== LEGACY_SYSTEM_PROMPT) {
        const actualPath = path.join(__dirname, ".build.actual.txt");
        fs.writeFileSync(actualPath, built);
        console.error(
            `buildSystemPrompt({}) does not byte-match the legacy snapshot at ${LEGACY_SNAPSHOT_PATH}. ` +
                `Wrote actual output to ${actualPath} — diff the two files to find the divergence.`,
        );
    }
    assert.equal(built, LEGACY_SYSTEM_PROMPT);
}

async function testCapabilitiesPreambleHiddenWhenRegistryEmpty() {
    clearRegistryForTests();
    const built = buildSystemPrompt({});
    assert.equal(built.includes("LEGAL CAPABILITIES:"), false);
}

function scopingFixture(id: string): LegalCapability {
    return {
        id,
        title: `Scoping Fixture ${id}`,
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

// Fragment scoping: only the capabilities the turn matched (or forced)
// contribute their methodology. The preamble stays unscoped — one line per
// capability is cheap and advertises what exists.
async function testActiveCapabilityIdsScopeFragments() {
    clearRegistryForTests();
    registerCapability(scopingFixture("a"));
    registerCapability(scopingFixture("b"));
    const built = buildSystemPrompt({
        firmId: "firm-123",
        resolvedPlaybook: {},
        activeCapabilityIds: ["b"],
    });
    assert.equal(built.includes("--- CAPABILITY: b ---"), true);
    assert.equal(built.includes("methodology-of-b"), true);
    assert.equal(built.includes("--- CAPABILITY: a ---"), false);
    assert.equal(built.includes("methodology-of-a"), false);
    // Both capabilities are still advertised in the preamble.
    assert.equal(built.includes("Scoping Fixture a"), true);
    assert.equal(built.includes("Scoping Fixture b"), true);
}

async function main() {
    await testRefactorMatchesLegacy();
    await testCapabilitiesPreambleHiddenWhenRegistryEmpty();
    await testActiveCapabilityIdsScopeFragments();
    // Leave the registry clean for any sibling test in the same process.
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
