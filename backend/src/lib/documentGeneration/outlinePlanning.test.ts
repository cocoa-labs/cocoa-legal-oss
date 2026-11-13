import assert from "node:assert/strict";
import {
    deterministicFallbackOutline,
    extractExplicitOutline,
    resolveDraftOutline,
    validateSavedOutline,
} from "./outlinePlanning";

const PRODUCTION_MEMO_INSTRUCTIONS =
    "Formal internal memorandum addressed to the real estate practice group. " +
    "Structure: (1) Executive summary and recommendation; " +
    "(2) The portfolio — Building A and Building B status under Example Lease No. 26-100, the renewal posture, key dates, and the full rent schedule table; " +
    "(3) Entity formation — Delaware LLC, EIN, operating agreement, authorized signatories, name clearance, and the bar on commingling tenant deposits; " +
    "(4) Ownership structure analysis — what a tenant-in-common interest is, single-member vs. multi-member LLC compared in a table; " +
    "(5) Lender consent mechanics — consent requests, estoppels, SNDAs, notices, fees, and processing risks; " +
    "(6) Tax analysis — Treas. Reg. 1.1031(k)-1 like-kind exchange timing, the facts that would defeat it, the consequences, and attorney sign-off; " +
    "(7) Property management transition — explain vendor onboarding, access credentials, and system permissioning; " +
    "(8) Broker selection — diligence and negotiation criteria; " +
    "(9) Compliance program build — policies, programs, and filings; " +
    "(10) Workstream plan and timetable — an eight-week table with parallel tracks; " +
    "(11) Closing conditions — an itemized gating list; " +
    "(12) Key risks and open items — lender appetite, consent timing, title scheduling, liquidity, and tenant deposits. " +
    "Close with next steps and the AI-assistance/not-legal-advice note.";

const PRODUCTION_CHECKLIST_INSTRUCTIONS =
    "A working, sequenced checklist with checkbox rows. " +
    "Sections: (A) Pre-filing prerequisites — LLC formation, EIN, operating agreement, bank account, signatories, and notary logistics; " +
    "(B) Lender consents — request timing, review lead time, delivery, and the guarantor trigger; " +
    "(C) Title and survey — commitment, exceptions, survey, zoning report, fees, and endorsements; " +
    "(D) Estoppels and SNDAs — tenant estoppels, SNDA forms, delivery questions, and definitions; " +
    "(E) Escrow and deposits — escrow agent selection, the deposit under the purchase agreement, and the $45,000 earnest-money alternative; " +
    "(F) Compliance documents — entity certificates, authority resolutions, FIRPTA affidavit, 1099-S reporting, AML screening, insurance certificates, and the closing statement; " +
    "(G) Systems and onboarding — property-management integration, Building A/Building B enablement, access credentials, payment routing, and vendor onboarding; " +
    "(H) Closing gates — hard stops before funding or recording; " +
    "(I) Common deficiency traps — ownership, consents, notarization, title exceptions, survey gaps, tenant deposits, and lender letters. " +
    "Finish with a one-page 'at a glance' week-by-week summary table and the AI-assistance/not-legal-advice note.";

async function main() {
    const memo = extractExplicitOutline(PRODUCTION_MEMO_INSTRUCTIONS);
    assert.ok(memo);
    assert.equal(memo.sections.length, 12);
    assert.deepEqual(
        memo.sections.map((section) => section.heading),
        [
            "Executive summary and recommendation",
            "The portfolio",
            "Entity formation",
            "Ownership structure analysis",
            "Lender consent mechanics",
            "Tax analysis",
            "Property management transition",
            "Broker selection",
            "Compliance program build",
            "Workstream plan and timetable",
            "Closing conditions",
            "Key risks and open items",
        ],
    );
    assert.match(memo.sections[5].instructions, /1\.1031\(k\)-1/);
    assert.match(memo.sections[11].instructions, /Close with next steps/);

    const checklist = extractExplicitOutline(PRODUCTION_CHECKLIST_INSTRUCTIONS);
    assert.ok(checklist);
    assert.equal(checklist.sections.length, 10);
    assert.equal(checklist.sections[0].heading, "Pre-filing prerequisites");
    assert.equal(checklist.sections[8].heading, "Common deficiency traps");
    assert.equal(checklist.sections[9].heading, "At-a-Glance Summary");
    assert.match(checklist.sections[9].instructions, /week-by-week/i);

    const lineNumbered = extractExplicitOutline(
        "Outline:\n1. Introduction and scope\n2. Analysis and options\n3. Recommendation and next steps",
    );
    assert.equal(lineNumbered?.sections.length, 3);
    assert.deepEqual(
        lineNumbered?.sections.map((section) => section.heading),
        [
            "Introduction and scope",
            "Analysis and options",
            "Recommendation and next steps",
        ],
    );

    const eightySectionOutline = extractExplicitOutline(
        `Structure:\n${Array.from(
            { length: 80 },
            (_, index) =>
                `${index + 1}. Section ${index + 1} substantive instructions`,
        ).join("\n")}`,
    );
    assert.equal(
        eightySectionOutline?.sections.length,
        80,
        "explicit long-form outlines accept the documented maximum",
    );
    assert.throws(
        () =>
            extractExplicitOutline(
                `Structure:\n${Array.from(
                    { length: 81 },
                    (_, index) =>
                        `${index + 1}. Section ${index + 1} substantive instructions`,
                ).join("\n")}`,
            ),
        /81 drafting units.*up to 80/i,
        "explicit outlines over the supported maximum fail actionably",
    );

    assert.equal(
        extractExplicitOutline(
            "Discuss CFTC Reg. 4.14(a)(6) and recommend a launch posture.",
        ),
        null,
        "a legal citation is not an explicit section list",
    );
    assert.equal(
        extractExplicitOutline(
            "Structure: (1) Analysis of paragraph (2); (6) Separate statutory cross-reference.",
        ),
        null,
        "non-sequential cross-references are not treated as a section list",
    );

    let modelCalls = 0;
    const explicitResolution = await resolveDraftOutline({
        title: "Roadmap",
        documentType: "internal legal memorandum",
        draftingInstructions: PRODUCTION_MEMO_INSTRUCTIONS,
        generate: async () => {
            modelCalls += 1;
            throw new Error("must not be called");
        },
    });
    assert.equal(modelCalls, 0);
    assert.equal(explicitResolution.strategy, "explicit_instructions");
    assert.equal(explicitResolution.outline.sections.length, 12);

    const generatedResolution = await resolveDraftOutline({
        title: "Short Memo",
        documentType: "memorandum",
        draftingInstructions: "Analyze the question and recommend next steps.",
        generate: async () => ({
            sections: [
                {
                    heading: "Analysis",
                    level: 1,
                    instructions: "Analyze the governing requirements.",
                },
            ],
        }),
    });
    assert.equal(generatedResolution.strategy, "model");
    assert.equal(generatedResolution.outline.sections[0].heading, "Analysis");

    const maxOutput = new Error(
        "[max_output] Claude truncated the structured completion",
    );
    const recovered = await resolveDraftOutline({
        title: "Short Memo",
        documentType: "memorandum",
        draftingInstructions: "Analyze the question and recommend next steps.",
        generate: async () => {
            throw maxOutput;
        },
    });
    assert.equal(recovered.strategy, "deterministic_fallback");
    assert.equal(recovered.recoveredError, maxOutput);
    assert.equal(recovered.outline.sections.length, 6);

    const invalid = await resolveDraftOutline({
        title: "Checklist",
        documentType: "registration checklist",
        draftingInstructions: "Create a sequenced registration checklist.",
        generate: async () => ({ sections: [] }),
    });
    assert.equal(invalid.strategy, "deterministic_fallback");
    assert.equal(invalid.outline.sections.length, 5);

    const refusal = new Error("content policy refusal");
    await assert.rejects(
        resolveDraftOutline({
            title: "Memo",
            documentType: "memorandum",
            draftingInstructions: "Draft a memo.",
            generate: async () => {
                throw refusal;
            },
            shouldRethrow: (error) => error === refusal,
        }),
        (error) => error === refusal,
    );

    assert.equal(validateSavedOutline({ sections: [] }), null);
    assert.equal(
        deterministicFallbackOutline("registration checklist").sections.length,
        5,
    );
    console.log("documentGeneration/outlinePlanning.test.ts: all passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
