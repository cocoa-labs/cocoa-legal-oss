import assert from "node:assert/strict";
import { test } from "node:test";
import {
    planDraftBudget,
    enforceDraftBudget,
    DocumentDraftSizingError,
    draftedWordCount,
} from "./draftBudget";
import { resolveDraftOutline, validateSavedOutline } from "./outlinePlanning";

function outline(count: number) {
    return {
        sections: Array.from({ length: count }, (_, index) => ({
            heading: `Clause ${index + 1}`,
            level: 1,
            instructions: "Draft the related clauses together.",
        })),
    };
}

test("ordinary legal documents use every adaptive budget tier", () => {
    assert.ok(
        draftedWordCount([
            { heading: "Clause", content: "word&nbsp;".repeat(31_000) },
        ]) > 30_000,
        "encoded spaces count toward the same budget as rendered whitespace",
    );
    const tiers = [
        ["articles of incorporation", 3_000, 10_000],
        ["regulatory filing", 3_000, 10_000],
        ["conflict policy", 6_000, 15_000],
        ["board consent", 6_000, 15_000],
        ["board resolution", 6_000, 15_000],
        ["legal memorandum", 10_000, 20_000],
        ["Form 1023 narrative", 10_000, 20_000],
        ["formation roadmap", 10_000, 20_000],
        ["bylaws", 15_000, 30_000],
        ["shared services agreement", 15_000, 30_000],
        ["commercial contract", 15_000, 30_000],
        ["multi-policy package", 15_000, 30_000],
        ["unknown", 8_000, 20_000],
    ] as const;
    for (const [type, targetWords, maxWords] of tiers) {
        const budget = planDraftBudget(type, "Prepare the document.");
        assert.equal(budget.source, "ordinary");
        assert.equal(budget.targetWords, targetWords, type);
        assert.equal(budget.maxWords, maxWords, type);
    }
});

test("oversized model outlines get one correction and cannot bypass the runtime cap", async () => {
    for (const size of [13, 90, 201]) {
        let calls = 0;
        await assert.rejects(
            () =>
                resolveDraftOutline({
                    title: "Bylaws",
                    documentType: "bylaws",
                    draftingInstructions: "Draft bylaws.",
                    generate: async () => {
                        calls++;
                        return outline(size);
                    },
                }),
            DocumentDraftSizingError,
        );
        assert.equal(calls, 2);
    }
    let calls = 0;
    const result = await resolveDraftOutline({
        title: "Bylaws",
        documentType: "bylaws",
        draftingInstructions: "Draft bylaws.",
        generate: async (correction) => {
            calls++;
            return outline(correction ? 12 : 90);
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.outline.sections.length, 12);
    assert.equal(result.outline.budget?.maxWords, 30_000);
});

test("explicit lengths up to 100,000 words and user outlines retain separate limits", async () => {
    const longForm = planDraftBudget("memo", "Write a long-form analysis.");
    assert.deepEqual(longForm, {
        source: "explicit_length",
        targetWords: 30_000,
        maxWords: 34_500,
    });
    const budget = planDraftBudget("memo", "Write a 20,000-word treatise.");
    assert.equal(budget.source, "explicit_length");
    assert.equal(budget.targetWords, 20_000);
    assert.equal(budget.maxWords, 23_000);
    assert.deepEqual(
        planDraftBudget("agreement", "Create a 100,000-word agreement."),
        {
            source: "explicit_length",
            targetWords: 100_000,
            maxWords: 115_000,
        },
    );
    assert.deepEqual(
        planDraftBudget("memorandum", "Prepare a 200-page memorandum."),
        {
            source: "explicit_length",
            targetWords: 90_000,
            maxWords: 103_500,
        },
    );
    assert.throws(
        () => planDraftBudget("agreement", "Create a 100,001-word agreement."),
        /up to 100,000 words/i,
    );
    const result = await resolveDraftOutline({
        title: "Treatise",
        documentType: "memo",
        draftingInstructions: "Write a 20,000-word treatise.",
        generate: async () => outline(50),
    });
    assert.equal(result.outline.sections.length, 50);
    const instructions =
        "Outline:\n" +
        outline(80)
            .sections.map(
                (section, index) =>
                    `${index + 1}. ${section.heading} substantive instructions`,
            )
            .join("\n");
    const explicit = await resolveDraftOutline({
        title: "Treatise",
        documentType: "memo",
        draftingInstructions: instructions,
        generate: async () => {
            throw new Error("must preserve user outline");
        },
    });
    assert.equal(explicit.outline.sections.length, 80);
    assert.equal(explicit.outline.budget?.source, "explicit_outline");
    assert.equal(explicit.outline.budget?.targetWords, 28_000);
    assert.equal(explicit.outline.budget?.maxWords, 30_000);
    await assert.rejects(
        () =>
            resolveDraftOutline({
                title: "Oversized outline",
                documentType: "memo",
                draftingInstructions:
                    "Outline:\n" +
                    outline(81)
                        .sections.map(
                            (section, index) =>
                                `${index + 1}. ${section.heading} substantive instructions`,
                        )
                        .join("\n"),
                generate: async () => outline(12),
            }),
        /up to 80/i,
    );
});

test("a model-authored long outline or length cannot opt an ordinary request into long form", async () => {
    const result = await resolveDraftOutline({
        title: "Bylaws",
        documentType: "bylaws",
        draftingInstructions:
            "Write a 100,000-word treatise. Outline:\n" +
            outline(90)
                .sections.map((section, i) => `${i + 1}. ${section.heading}`)
                .join("\n"),
        explicitInstructions: "Prepare ordinary bylaws.",
        generate: async () => outline(12),
    });
    assert.equal(result.outline.budget?.source, "ordinary");
    assert.equal(result.outline.budget?.maxWords, 30_000);
    assert.equal(result.outline.sections.length, 12);
});

test("one bounded size correction preserves headings; failure never truncates the checkpoint", async () => {
    const sections = [
        { heading: "Governance", content: "word ".repeat(31_000) },
    ];
    const saved = structuredClone(sections);
    let calls = 0;
    const budget = planDraftBudget("bylaws", "");
    await assert.rejects(
        () =>
            enforceDraftBudget(sections, budget, async (current) => {
                calls++;
                return current;
            }),
        DocumentDraftSizingError,
    );
    assert.equal(calls, 1);
    assert.deepEqual(sections, saved);
    const corrected = await enforceDraftBudget(sections, budget, async () => [
        { heading: "Governance", content: "word ".repeat(3000) },
    ]);
    assert.ok(draftedWordCount(corrected) <= 30_000);
    await assert.rejects(
        () =>
            enforceDraftBudget(sections, budget, async () => [
                { heading: "Missing everything", content: "Short." },
            ]),
        DocumentDraftSizingError,
    );
    assert.equal(
        await enforceDraftBudget(sections, undefined, async () => {
            throw new Error("legacy recovery must not replan");
        }),
        sections,
    );
    assert.equal(validateSavedOutline(outline(80))?.sections.length, 80);
    assert.equal(
        validateSavedOutline(outline(90))?.sections.length,
        90,
        "legacy saved outlines remain recoverable without replanning",
    );
});
