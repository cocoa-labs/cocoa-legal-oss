// backend/src/lib/legalCapabilities/calendarCapability.test.ts
//
// Guard test for the Calendar & Scheduling capability (calendar-scheduling).
// Runs in its own tsx process so importing the capability here does not leak
// registry state into the byte-equality snapshot test for the system prompt.
// The load-bearing guards: it registers with a valid shape, seeds no playbook
// keys (and inlines no {{playbook:...}} placeholder), declares the calendar
// connector requirement, and its methodology encodes the approve-outward/
// auto-internal safety rule.

import assert from "node:assert/strict";
import {
    getCapability,
    allCapabilities,
    capabilitiesByPractice,
    clearRegistryForTests,
} from "./index";
import type { LegalPractice } from "./types";

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
    const { calendarCapability } = await import("./calendarCapability");

    const cap = getCapability("calendar-scheduling");
    assert.ok(cap, "calendar-scheduling should resolve from the registry");
    assert.equal(cap, calendarCapability);
    assert.equal(cap.id, "calendar-scheduling");
    assert.equal(cap.title, "Calendar & Scheduling");

    assert.ok(
        VALID_PRACTICES.has(cap.practice),
        `practice "${cap.practice}" is not a valid LegalPractice`,
    );

    assert.equal(cap.workflow.type, "assistant");
    if (cap.workflow.type === "assistant") {
        assert.ok(
            cap.workflow.prompt_md.trim().length > 0,
            "workflow.prompt_md must be non-empty",
        );
    }

    assert.ok(cap.systemPromptFragment.persona_framing.trim().length > 0);
    assert.ok(cap.systemPromptFragment.methodology.trim().length > 0);

    assert.ok(
        capabilitiesByPractice(cap.practice).some(
            (c) => c.id === "calendar-scheduling",
        ),
        "capabilitiesByPractice should include calendar-scheduling",
    );
    assert.ok(
        allCapabilities().some((c) => c.id === "calendar-scheduling"),
        "allCapabilities should include calendar-scheduling",
    );
}

async function testNoPlaybookKeysReferenced() {
    const cap = getCapability("calendar-scheduling");
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

async function testConnectorAndSafetyRule() {
    const cap = getCapability("calendar-scheduling");
    assert.ok(cap);

    // Declares the calendar connector — the seam the routes/tools depend on.
    assert.ok(
        cap.connectorRequirements.includes("calendar"),
        "connectorRequirements should include calendar",
    );
    assert.equal(cap.outputs.docx, false);
    assert.equal(cap.outputs.in_app_document, false);
    assert.ok(cap.resultCard.trim().length > 0);

    for (const kw of ["calendar", "schedule", "meeting", "court date"]) {
        assert.ok(
            cap.intentSignals.keywords.includes(kw),
            `intentSignals.keywords should include "${kw}"`,
        );
    }

    // The methodology must carry the approve-outward / auto-internal rule — the
    // single most important safety property of the calendar tools.
    const method = cap.systemPromptFragment.methodology.toLowerCase();
    assert.ok(
        method.includes("approve outward") && method.includes("auto internal"),
        "methodology must state the approve-outward / auto-internal rule",
    );
}

async function main() {
    await testRegistersWithValidShape();
    await testNoPlaybookKeysReferenced();
    await testConnectorAndSafetyRule();
    clearRegistryForTests();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
