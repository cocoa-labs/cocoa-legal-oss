// backend/src/lib/intentDetection.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildIntentAttachments,
    titlesFromStructureTree,
} from "./intentDetection";

type DocRow = {
    id: string;
    filename: string | null;
    document_type: string | null;
    structure_tree: unknown;
};

/**
 * Minimal Supabase stand-in for the single documents query the builder runs.
 * Records the table, the `.in()` ids and the `.eq()` filters so the test can
 * assert the query shape as well as the result mapping.
 */
function makeDb(rows: DocRow[]) {
    const calls: {
        table: string;
        ids: string[];
        eq: [string, string][];
    }[] = [];
    const db = {
        from(table: string) {
            const call = { table, ids: [] as string[], eq: [] as [string, string][] };
            calls.push(call);
            const chain: Record<string, unknown> = {
                select: () => chain,
                in: (_col: string, ids: string[]) => {
                    call.ids = ids;
                    return chain;
                },
                eq: (col: string, value: string) => {
                    call.eq.push([col, value]);
                    return chain;
                },
                then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
                    Promise.resolve({
                        data: rows.filter((r) => call.ids.includes(r.id)),
                        error: null,
                    }).then(resolve, reject as never),
            };
            return chain;
        },
    };
    return { db: db as never, calls };
}

describe("titlesFromStructureTree", () => {
    it("joins non-empty titles with newlines", () => {
        assert.equal(
            titlesFromStructureTree([
                { title: "COMMERCIAL LEASE AGREEMENT" },
                { title: "  1. Premises  " },
                { title: "" },
                { title: "2. Base Rent" },
            ]),
            "COMMERCIAL LEASE AGREEMENT\n1. Premises\n2. Base Rent",
        );
    });

    it("drops 'Page N' placeholders, which carry no signal", () => {
        assert.equal(
            titlesFromStructureTree([
                { title: "Page 1" },
                { title: "Exhibit A" },
                { title: "Page 3" },
            ]),
            "Exhibit A",
        );
        assert.equal(
            titlesFromStructureTree([{ title: "Page 1" }, { title: "page 2" }]),
            null,
        );
    });

    it("caps at maxLines and maxChars", () => {
        const nodes = Array.from({ length: 60 }, (_, i) => ({
            title: `Section ${i}`,
        }));
        const capped = titlesFromStructureTree(nodes, { maxLines: 3 });
        assert.equal(capped, "Section 0\nSection 1\nSection 2");

        const long = titlesFromStructureTree(nodes, { maxChars: 12 });
        assert.equal(long?.length, 12);
    });

    it("returns null for a non-array or empty tree", () => {
        assert.equal(titlesFromStructureTree(null), null);
        assert.equal(titlesFromStructureTree({ title: "x" }), null);
        assert.equal(titlesFromStructureTree("Page 1"), null);
        assert.equal(titlesFromStructureTree([]), null);
        assert.equal(titlesFromStructureTree([{ title: 7 }]), null);
    });
});

describe("buildIntentAttachments", () => {
    it("returns [] when there are no files", async () => {
        const { db, calls } = makeDb([]);
        assert.deepEqual(
            await buildIntentAttachments({
                files: undefined,
                userId: "u1",
                userEmail: "u@example.com",
                db,
            }),
            [],
        );
        assert.deepEqual(
            await buildIntentAttachments({
                files: [null, "not-an-object"],
                userId: "u1",
                userEmail: "u@example.com",
                db,
            }),
            [],
        );
        assert.equal(calls.length, 0, "no query for an empty file list");
    });

    it("builds a full attachment for an accessible, ready document", async () => {
        const { db, calls } = makeDb([
            {
                id: "d1",
                filename: "stored-lease.pdf",
                document_type: "commercial-lease",
                structure_tree: [
                    { title: "COMMERCIAL LEASE" },
                    { title: "Page 2" },
                    { title: "1. Premises" },
                ],
            },
        ]);
        let seenIds: string[] | null = null;
        const out = await buildIntentAttachments(
            {
                files: [{ filename: "lease.pdf", document_id: "d1" }],
                userId: "u1",
                userEmail: "u@example.com",
                db,
            },
            {
                filterAccessibleDocumentIdsFn: async (ids) => {
                    seenIds = ids;
                    return ids;
                },
            },
        );
        assert.deepEqual(seenIds, ["d1"]);
        assert.deepEqual(out, [
            {
                filename: "lease.pdf",
                extractedText: "COMMERCIAL LEASE\n1. Premises",
                documentType: "commercial-lease",
                documentId: "d1",
            },
        ]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].table, "documents");
        assert.deepEqual(calls[0].ids, ["d1"]);
        assert.deepEqual(calls[0].eq, [["status", "ready"]]);
    });

    it("contributes filename only when the document is not accessible", async () => {
        const { db } = makeDb([
            {
                id: "d1",
                filename: "stored-lease.pdf",
                document_type: "commercial-lease",
                structure_tree: [{ title: "COMMERCIAL LEASE" }],
            },
        ]);
        const out = await buildIntentAttachments(
            {
                files: [{ filename: "someone-elses-lease.pdf", document_id: "d1" }],
                userId: "u2",
                userEmail: "other@example.com",
                db,
            },
            { filterAccessibleDocumentIdsFn: async () => [] },
        );
        assert.deepEqual(out, [
            {
                filename: "someone-elses-lease.pdf",
                extractedText: null,
                documentType: null,
                documentId: null,
            },
        ]);
    });

    it("contributes filename only for an image attachment with no document id", async () => {
        const { db, calls } = makeDb([]);
        const out = await buildIntentAttachments(
            {
                files: [{ filename: "photo.png" }],
                userId: "u1",
                userEmail: null,
                db,
            },
            {
                filterAccessibleDocumentIdsFn: async () => {
                    throw new Error("must not run without document ids");
                },
            },
        );
        assert.deepEqual(out, [
            {
                filename: "photo.png",
                extractedText: null,
                documentType: null,
                documentId: null,
            },
        ]);
        assert.equal(calls.length, 0);
    });

    it("skips the access query when allowedDocumentIds is supplied", async () => {
        const { db } = makeDb([
            {
                id: "d1",
                filename: "stored.pdf",
                document_type: null,
                structure_tree: null,
            },
            {
                id: "d2",
                filename: "other.pdf",
                document_type: "snda",
                structure_tree: null,
            },
        ]);
        let called = false;
        const out = await buildIntentAttachments(
            {
                files: [
                    { filename: null, document_id: "d1" },
                    { filename: "other.pdf", document_id: "d2" },
                ],
                userId: "u1",
                userEmail: "u@example.com",
                db,
                allowedDocumentIds: new Set(["d1"]),
            },
            {
                filterAccessibleDocumentIdsFn: async () => {
                    called = true;
                    return ["d1", "d2"];
                },
            },
        );
        assert.equal(called, false, "the access fn must not run");
        assert.deepEqual(out, [
            {
                filename: "stored.pdf",
                extractedText: null,
                documentType: null,
                documentId: "d1",
            },
            {
                filename: "other.pdf",
                extractedText: null,
                documentType: null,
                documentId: null,
            },
        ]);
    });

    it("carries a file's `origin` through, and omits it when absent", async () => {
        const { db } = makeDb([
            {
                id: "d1",
                filename: "Sampleton_Commercial_Lease.pdf",
                document_type: "lease",
                structure_tree: null,
            },
        ]);
        const out = await buildIntentAttachments({
            files: [
                { filename: null, document_id: "d1", origin: "displayed" },
                { filename: "loose.png", document_id: null, origin: "displayed" },
                { filename: "attached.pdf", document_id: null },
            ],
            userId: "u1",
            userEmail: "u@example.com",
            db,
            allowedDocumentIds: new Set(["d1"]),
        });
        assert.deepEqual(out, [
            {
                filename: "Sampleton_Commercial_Lease.pdf",
                extractedText: null,
                documentType: "lease",
                documentId: "d1",
                origin: "displayed",
            },
            {
                filename: "loose.png",
                extractedText: null,
                documentType: null,
                documentId: null,
                origin: "displayed",
            },
            {
                filename: "attached.pdf",
                extractedText: null,
                documentType: null,
                documentId: null,
            },
        ]);
    });
});

// ---------------------------------------------------------------------------
// Task 4: env readers, the classify gate, prompt sanitation, the LLM
// classifier and the detection orchestrator.
// ---------------------------------------------------------------------------

import {
    classifyIntentLlm,
    intentClassifierModel,
    intentClassifierTimeoutMs,
    intentLlmClassifyEnabled,
    intentLlmMinConfidence,
    intentPostStreamGraceMs,
    intentRequireLexicalAgreement,
    INTENT_LLM_MIN_CONFIDENCE_DEFAULT,
    runIntentDetection,
    sanitizeConfirmPrompt,
    shouldClassifyIntent,
    withDeadline,
    type ClassifierEligibleCapability,
} from "./intentDetection";
import {
    clearRegistryForTests,
    registerCapability,
} from "./legalCapabilities/index";
import type { LegalCapability } from "./legalCapabilities/types";
import type { CompleteStructuredParams } from "./llm/structured";

describe("intent env readers", () => {
    it("defaults are safe and only the documented values override", () => {
        assert.equal(intentLlmClassifyEnabled({}), true);
        assert.equal(
            intentLlmClassifyEnabled({ INTENT_LLM_CLASSIFY_ENABLED: "FALSE" }),
            false,
        );
        assert.equal(
            intentLlmClassifyEnabled({ INTENT_LLM_CLASSIFY_ENABLED: "nonsense" }),
            true,
            "junk must never disarm a default-ON switch",
        );

        assert.equal(intentClassifierModel({}), undefined);
        assert.equal(
            intentClassifierModel({ INTENT_CLASSIFIER_MODEL: "  " }),
            undefined,
        );
        assert.equal(
            intentClassifierModel({ INTENT_CLASSIFIER_MODEL: " claude-opus-5 " }),
            "claude-opus-5",
        );

        assert.equal(intentClassifierTimeoutMs({}), 6000);
        assert.equal(
            intentClassifierTimeoutMs({ INTENT_CLASSIFIER_TIMEOUT_MS: "250" }),
            250,
        );
        assert.equal(
            intentClassifierTimeoutMs({ INTENT_CLASSIFIER_TIMEOUT_MS: "0" }),
            6000,
        );
        assert.equal(
            intentClassifierTimeoutMs({ INTENT_CLASSIFIER_TIMEOUT_MS: "junk" }),
            6000,
        );

        assert.equal(intentPostStreamGraceMs({}), 1500);
        assert.equal(
            intentPostStreamGraceMs({ INTENT_POST_STREAM_GRACE_MS: "0" }),
            0,
            "zero grace is a legitimate 'never wait' setting",
        );
        assert.equal(
            intentPostStreamGraceMs({ INTENT_POST_STREAM_GRACE_MS: "-5" }),
            1500,
        );

        assert.equal(intentLlmMinConfidence({}), INTENT_LLM_MIN_CONFIDENCE_DEFAULT);
        assert.equal(
            intentLlmMinConfidence({ INTENT_LLM_MIN_CONFIDENCE: "0.95" }),
            0.95,
        );
        assert.equal(intentLlmMinConfidence({ INTENT_LLM_MIN_CONFIDENCE: "3" }), 1);
        assert.equal(intentLlmMinConfidence({ INTENT_LLM_MIN_CONFIDENCE: "-1" }), 0);
        assert.equal(
            intentLlmMinConfidence({ INTENT_LLM_MIN_CONFIDENCE: "junk" }),
            INTENT_LLM_MIN_CONFIDENCE_DEFAULT,
        );

        assert.equal(intentRequireLexicalAgreement({}), true);
        assert.equal(
            intentRequireLexicalAgreement({
                INTENT_LLM_REQUIRE_LEXICAL_AGREEMENT: "false",
            }),
            false,
        );
        assert.equal(
            intentRequireLexicalAgreement({
                INTENT_LLM_REQUIRE_LEXICAL_AGREEMENT: "no",
            }),
            true,
        );
    });
});

describe("shouldClassifyIntent", () => {
    const base = {
        llmEnabled: true,
        suppressed: false,
        capabilityRunTurn: false,
        seededWorkflowTurn: false,
        trivialTurn: false,
        candidateCount: 1,
        eligibleCount: 1,
    };

    it("is true only when every gate is open", () => {
        assert.equal(shouldClassifyIntent(base), true);
    });

    it("is false for each individual gate", () => {
        assert.equal(shouldClassifyIntent({ ...base, llmEnabled: false }), false);
        assert.equal(shouldClassifyIntent({ ...base, suppressed: true }), false);
        assert.equal(
            shouldClassifyIntent({ ...base, capabilityRunTurn: true }),
            false,
        );
        assert.equal(
            shouldClassifyIntent({ ...base, seededWorkflowTurn: true }),
            false,
        );
        assert.equal(shouldClassifyIntent({ ...base, trivialTurn: true }), false);
        assert.equal(shouldClassifyIntent({ ...base, candidateCount: 0 }), false);
        assert.equal(shouldClassifyIntent({ ...base, eligibleCount: 0 }), false);
    });
});

describe("sanitizeConfirmPrompt", () => {
    const FALLBACK = "Run a Commercial Real Estate review on this document?";

    it("returns the fallback for a non-string", () => {
        assert.equal(sanitizeConfirmPrompt(null, FALLBACK), FALLBACK);
        assert.equal(sanitizeConfirmPrompt(7, FALLBACK), FALLBACK);
        assert.equal(sanitizeConfirmPrompt(undefined, FALLBACK), FALLBACK);
    });

    it("strips newlines, control characters and markdown", () => {
        assert.equal(
            sanitizeConfirmPrompt(
                "**Review** the\n\tSampleton *lease* now?",
                FALLBACK,
            ),
            "Review the Sampleton lease now?",
        );
        assert.equal(
            sanitizeConfirmPrompt("Review the [Sampleton lease](x) now?", FALLBACK),
            "Review the Sampleton lease now?",
        );
        assert.equal(
            sanitizeConfirmPrompt("`Abstract` the ~~old~~ _lease_?", FALLBACK),
            "Abstract the old lease?",
        );
    });

    it("rejects injection-shaped and degenerate prompts", () => {
        for (const raw of [
            "See https://evil.example for details?",
            "Email me at a@b.com about the lease?",
            "Review <script>alert(1)</script> lease?",
            "Review lease?",
            "   ",
            `Review the ${"very ".repeat(40)}long lease?`,
        ]) {
            assert.equal(
                sanitizeConfirmPrompt(raw, FALLBACK),
                FALLBACK,
                `expected the fallback for ${JSON.stringify(raw.slice(0, 40))}`,
            );
        }
    });

    it("ends the prompt with exactly one question mark", () => {
        assert.equal(
            sanitizeConfirmPrompt("Abstract the Sampleton lease", FALLBACK),
            "Abstract the Sampleton lease?",
        );
        assert.equal(
            sanitizeConfirmPrompt("Abstract the Sampleton lease.", FALLBACK),
            "Abstract the Sampleton lease?",
        );
        assert.equal(
            sanitizeConfirmPrompt("Abstract the Sampleton lease!!", FALLBACK),
            "Abstract the Sampleton lease?",
        );
        assert.equal(
            sanitizeConfirmPrompt("Abstract the Sampleton lease (V2)", FALLBACK),
            "Abstract the Sampleton lease (V2)?",
        );
        assert.equal(
            sanitizeConfirmPrompt("Abstract the Sampleton lease?", FALLBACK),
            "Abstract the Sampleton lease?",
        );
    });
});

// --- classifyIntentLlm -----------------------------------------------------

const ELIGIBLE: ClassifierEligibleCapability[] = [
    {
        id: "cre-review",
        title: "Commercial Real Estate Review",
        description: "Abstract and risk-review a commercial real estate instrument.",
        classifierGuidance: {
            choose_when: "an attached lease or purchase agreement needs abstraction",
            do_not_choose_when: "the user only mentions real estate in passing",
        },
    },
    {
        id: "triage-nda",
        title: "Triage NDA",
        description: "Triage an inbound NDA against the firm playbook.",
    },
];

function capturingComplete(value: unknown) {
    const calls: CompleteStructuredParams[] = [];
    const fn = async (params: CompleteStructuredParams) => {
        calls.push(params);
        return { value, raw: JSON.stringify(value), usedNativeStructured: true };
    };
    return { fn: fn as never, calls };
}

function classifyInput(
    overrides: Partial<Parameters<typeof classifyIntentLlm>[0]> = {},
): Parameters<typeof classifyIntentLlm>[0] {
    return {
        message: "Can you abstract the attached Sampleton commercial lease?",
        attachments: [],
        conversationSummary: null,
        recentUserTurns: [],
        eligible: ELIGIBLE,
        candidateIds: ["cre-review"],
        requireAgreement: true,
        minConfidence: 0.8,
        model: "claude-sonnet-5",
        timeoutMs: 5000,
        ...overrides,
    };
}

const GOOD_VALUE = {
    capability_id: "cre-review",
    confidence: 0.92,
    confirm_prompt: "Abstract the attached Sampleton lease?",
    reason: "an attached commercial lease",
    document_id: null,
};

describe("classifyIntentLlm request shape", () => {
    it("frames everything as UNTRUSTED and constrains the enum + budget", async () => {
        const { fn, calls } = capturingComplete(GOOD_VALUE);
        await classifyIntentLlm(classifyInput(), { completeStructuredFn: fn });
        assert.equal(calls.length, 1);
        const params = calls[0];
        assert.match(params.systemPrompt ?? "", /UNTRUSTED/);
        assert.match(params.user, /UNTRUSTED/);
        assert.equal(params.maxTokens, 256);
        assert.equal(params.schemaName, "intent_classification");
        assert.equal(params.model, "claude-sonnet-5");
        assert.equal(params.schema.additionalProperties, false);
        const properties = params.schema.properties as Record<
            string,
            Record<string, unknown>
        >;
        assert.deepEqual(properties.capability_id.enum, [
            "cre-review",
            "triage-nda",
            "none",
        ]);
        assert.deepEqual(properties.document_id.type, ["string", "null"]);
        assert.equal(properties.confidence.type, "number");
        // The registry's disambiguation text reaches the model verbatim.
        assert.match(params.user, /Choose when: an attached lease/);
        assert.match(params.user, /Do not choose when: the user only mentions/);
        assert.match(
            params.user,
            /confirm_prompt must be ONE yes\/no question of at most 15 words/,
        );
        assert.match(
            params.user,
            /Lexical prefilter matched \(hint only, may be wrong\): cre-review/,
        );
    });

    it("truncates the message, the summary, the turns and the attachment list", async () => {
        const { fn, calls } = capturingComplete(GOOD_VALUE);
        await classifyIntentLlm(
            classifyInput({
                message: "m".repeat(4000),
                conversationSummary: "s".repeat(2000),
                recentUserTurns: ["t1", "t2", "t".repeat(900)],
                attachments: Array.from({ length: 7 }, (_, i) => ({
                    filename: `file-${i}.pdf`,
                    extractedText: null,
                    documentType: null,
                    documentId: `d${i}`,
                })),
            }),
            { completeStructuredFn: fn },
        );
        const user = calls[0].user;
        assert.ok(user.includes("m".repeat(3000)), "message kept to 3000 chars");
        assert.ok(!user.includes("m".repeat(3001)), "message truncated at 3000");
        assert.ok(user.includes("s".repeat(1500)), "summary kept to 1500 chars");
        assert.ok(!user.includes("s".repeat(1501)), "summary truncated at 1500");
        assert.ok(user.includes("t".repeat(600)), "turn kept to 600 chars");
        assert.ok(!user.includes("t".repeat(601)), "turn truncated at 600");
        assert.ok(!user.includes("t1"), "only the last two turns are sent");
        assert.ok(user.includes("t2"), "the last two turns are sent");

        const attachmentBlock = user.split("--- ATTACHMENTS (UNTRUSTED) ---")[1];
        const lines = attachmentBlock
            .split("\n")
            .filter((l) => l.startsWith("file-"));
        assert.equal(lines.length, 5, "at most 5 attachment lines");
        assert.match(lines[0], /^file-0\.pdf \| .* \[d0\]$/);
    });
});

describe("classifyIntentLlm acceptance", () => {
    it("accepts a high-confidence, agreed, registered id", async () => {
        const { fn } = capturingComplete(GOOD_VALUE);
        const out = await classifyIntentLlm(classifyInput(), {
            completeStructuredFn: fn,
        });
        assert.deepEqual(out, {
            outcome: "accepted",
            capabilityId: "cre-review",
            confidence: 0.92,
            confirmPrompt: "Abstract the attached Sampleton lease?",
            documentId: null,
            reason: "an attached commercial lease",
        });
    });

    it("maps every refusal to its own outcome", async () => {
        const cases: [unknown, string][] = [
            [{ ...GOOD_VALUE, capability_id: "none" }, "none"],
            [{ ...GOOD_VALUE, capability_id: "made-up" }, "unregistered"],
            [{ ...GOOD_VALUE, confidence: 0.6 }, "low_confidence"],
            [{ ...GOOD_VALUE, confidence: "high" }, "low_confidence"],
            [{ ...GOOD_VALUE, capability_id: "triage-nda" }, "disagree"],
            ["not an object", "malformed"],
            [null, "malformed"],
            [[GOOD_VALUE], "malformed"],
        ];
        for (const [value, expected] of cases) {
            const { fn } = capturingComplete(value);
            const out = await classifyIntentLlm(classifyInput(), {
                completeStructuredFn: fn,
            });
            assert.equal(
                out.outcome,
                expected,
                `expected ${expected} for ${String(JSON.stringify(value)).slice(0, 60)}`,
            );
        }
    });

    it("accepts a lexically-unmatched id when agreement is not required", async () => {
        const { fn } = capturingComplete({
            ...GOOD_VALUE,
            capability_id: "triage-nda",
        });
        const out = await classifyIntentLlm(
            classifyInput({ requireAgreement: false }),
            { completeStructuredFn: fn },
        );
        assert.equal(out.outcome, "accepted");
        assert.equal(
            out.outcome === "accepted" ? out.capabilityId : null,
            "triage-nda",
        );
    });

    it("drops a document_id the user did not attach on this turn", async () => {
        const attachments = [
            {
                filename: "lease.pdf",
                extractedText: null,
                documentType: null,
                documentId: "d1",
            },
        ];
        const foreign = capturingComplete({
            ...GOOD_VALUE,
            document_id: "d-not-mine",
        });
        const out = await classifyIntentLlm(classifyInput({ attachments }), {
            completeStructuredFn: foreign.fn,
        });
        assert.equal(out.outcome === "accepted" ? out.documentId : "x", null);

        const own = capturingComplete({ ...GOOD_VALUE, document_id: "d1" });
        const kept = await classifyIntentLlm(classifyInput({ attachments }), {
            completeStructuredFn: own.fn,
        });
        assert.equal(kept.outcome === "accepted" ? kept.documentId : "x", "d1");
    });

    it("returns timeout without throwing, and never awaits the orphan", async () => {
        const never = (async () =>
            new Promise<never>(() => {
                /* never settles */
            })) as never;
        const started = Date.now();
        const out = await classifyIntentLlm(classifyInput({ timeoutMs: 50 }), {
            completeStructuredFn: never,
        });
        assert.equal(out.outcome, "timeout");
        assert.ok(Date.now() - started < 2000, "returned on the timeout, not later");
    });

    it("returns error when the provider throws", async () => {
        const throwing = (async () => {
            throw new Error("provider down");
        }) as never;
        const out = await classifyIntentLlm(classifyInput(), {
            completeStructuredFn: throwing,
        });
        assert.equal(out.outcome, "error");
    });
});

// --- runIntentDetection ----------------------------------------------------

function makeCap(
    id: string,
    overrides: Partial<LegalCapability> = {},
): LegalCapability {
    return {
        id,
        title: `Cap ${id}`,
        practice: "Real Estate",
        description: "test capability",
        workflow: { type: "assistant", prompt_md: "x" },
        systemPromptFragment: { persona_framing: "p", methodology: "m" },
        playbookKeys: [],
        intentSignals: {
            keywords: ["commercial lease", "estoppel"],
            document_hints: ["commercial lease"],
            confirm_prompt: `Run ${id} on this document?`,
            run_label: `Run ${id}`,
        },
        resultCard: "Card",
        outputs: { docx: false, in_app_document: false },
        connectorRequirements: [],
        ...overrides,
    };
}

/** Chip-eligible: declares an outputSpec, so runTargetFor() is "chat". */
const CHIP_CAP = makeCap("cre-fixture", {
    outputSpec: { overall_scheme: "traffic-light", sections: [] },
    intake: ["represented_party"],
});
/** Chip-eligible through the tabular path (runTargetFor() is "modal"). */
const TAB_CAP = makeCap("tab-fixture", {
    workflow: { type: "tabular", columns_config: [] },
});
/** Not chip-eligible: no outputSpec and not tabular. */
const NO_CHIP_CAP = makeCap("no-chip-fixture");

async function withCaps<T>(
    caps: LegalCapability[],
    run: () => Promise<T>,
): Promise<T> {
    clearRegistryForTests();
    for (const c of caps) registerCapability(c);
    try {
        return await run();
    } finally {
        clearRegistryForTests();
    }
}

const LEASE_ATTACHMENT = {
    filename: "Office_Commercial_Lease_2026.pdf",
    extractedText: null,
    documentType: null,
    documentId: "d1",
};

function detectionArgs(
    overrides: Partial<Parameters<typeof runIntentDetection>[0]> = {},
): Parameters<typeof runIntentDetection>[0] {
    return {
        message: "Please take a look at the attached commercial lease for Sampleton.",
        attachments: [LEASE_ATTACHMENT],
        conversationSummary: null,
        recentUserTurns: [],
        excludedCapabilityIds: new Set<string>(),
        suppressed: false,
        capabilityRunTurn: false,
        seededWorkflowTurn: false,
        model: "claude-sonnet-5",
        timeoutMs: 1000,
        ...overrides,
    };
}

const FIXED_DEPS = { now: () => 1_000, uuid: () => "proposal-uuid-1" };

describe("runIntentDetection — LLM path", () => {
    it("turns an accepted classification into a registry-shaped proposal", async () => {
        await withCaps([CHIP_CAP, NO_CHIP_CAP], async () => {
            const { fn, calls } = capturingComplete({
                capability_id: "cre-fixture",
                confidence: 0.91,
                confirm_prompt: "**Abstract** the Sampleton lease",
                reason: "attached lease",
                document_id: "d1",
            });
            const result = await runIntentDetection(detectionArgs(), {
                completeStructuredFn: fn,
                ...FIXED_DEPS,
            });
            assert.equal(result.ran, true);
            assert.equal(result.source, "llm");
            assert.equal(result.outcome, "accepted");
            assert.equal(result.model, "claude-sonnet-5");
            assert.deepEqual(result.proposal, {
                capabilityId: "cre-fixture",
                confidence: 0.91,
                confirmPrompt: "Abstract the Sampleton lease?",
                prefilledInputs: { documentIds: ["d1"] },
                proposalId: "proposal-uuid-1",
                title: "Cap cre-fixture",
                runLabel: "Run cre-fixture",
                runTarget: "chat",
                intake: ["represented_party"],
                source: "llm",
            });
            // Only chip-eligible capabilities are ever offered to the model.
            const enumIds = (
                calls[0].schema.properties as Record<string, Record<string, unknown>>
            ).capability_id.enum;
            assert.deepEqual(enumIds, ["cre-fixture", "none"]);
        });
    });

    it("keeps an excluded capability out of the enum and out of the result", async () => {
        await withCaps([CHIP_CAP, TAB_CAP], async () => {
            const { fn, calls } = capturingComplete({
                capability_id: "cre-fixture",
                confidence: 0.9,
                confirm_prompt: "Abstract the Sampleton lease?",
                reason: "r",
                document_id: null,
            });
            const result = await runIntentDetection(
                detectionArgs({
                    excludedCapabilityIds: new Set(["tab-fixture"]),
                }),
                { completeStructuredFn: fn, ...FIXED_DEPS },
            );
            const enumIds = (
                calls[0].schema.properties as Record<string, Record<string, unknown>>
            ).capability_id.enum;
            assert.deepEqual(enumIds, ["cre-fixture", "none"]);
            assert.equal(result.proposal?.capabilityId, "cre-fixture");
        });
    });

    it("respects the model's 'none' — no lexical second chance", async () => {
        await withCaps([CHIP_CAP], async () => {
            const { fn } = capturingComplete({
                capability_id: "none",
                confidence: 0.99,
                confirm_prompt: "",
                reason: "just a question",
                document_id: null,
            });
            const result = await runIntentDetection(detectionArgs(), {
                completeStructuredFn: fn,
                ...FIXED_DEPS,
            });
            assert.equal(result.proposal, null);
            assert.equal(result.outcome, "none");
            assert.equal(result.ran, true);
        });
    });

    it("falls back to the structural signal on a timeout, but never on keywords", async () => {
        const never = (async () =>
            new Promise<never>(() => {
                /* never settles */
            })) as never;

        await withCaps([CHIP_CAP], async () => {
            const structural = await runIntentDetection(
                detectionArgs({ timeoutMs: 40 }),
                { completeStructuredFn: never, ...FIXED_DEPS },
            );
            assert.equal(structural.outcome, "lexical");
            assert.equal(structural.source, "lexical");
            assert.equal(structural.ran, true);
            assert.equal(structural.proposal?.capabilityId, "cre-fixture");
            assert.equal(
                structural.proposal?.confirmPrompt,
                "Run cre-fixture on this document?",
                "the fallback uses the registry's static prompt",
            );
            assert.equal(structural.proposal?.source, "lexical");

            const keywordsOnly = await runIntentDetection(
                detectionArgs({
                    message:
                        "Remind me how a commercial lease estoppel usually works in Texas.",
                    attachments: [],
                    timeoutMs: 40,
                }),
                { completeStructuredFn: never, ...FIXED_DEPS },
            );
            assert.equal(keywordsOnly.proposal, null);
            assert.equal(keywordsOnly.outcome, "timeout");
        });
    });
});

describe("runIntentDetection — structural fallback", () => {
    it("never treats document body prose as a structural signal", async () => {
        await withCaps([CHIP_CAP], async () => {
            const memo = {
                filename: "Memo_to_file.docx",
                extractedText:
                    "MEMORANDUM\nRe: whether the commercial lease question matters",
                documentType: "memo",
                documentId: "d9",
            };
            const prose = await runIntentDetection(
                detectionArgs({ attachments: [memo], llmEnabled: false }),
                FIXED_DEPS,
            );
            assert.equal(
                prose.proposal,
                null,
                "title-line prose must not clear the lexical-only bar",
            );
            assert.equal(prose.ran, false);

            const named = await runIntentDetection(
                detectionArgs({
                    attachments: [
                        { ...memo, filename: "Office_Commercial_Lease.pdf" },
                    ],
                    llmEnabled: false,
                }),
                FIXED_DEPS,
            );
            assert.equal(named.proposal?.capabilityId, "cre-fixture");
            assert.equal(named.proposal?.source, "lexical");
            assert.deepEqual(named.proposal?.prefilledInputs, {
                documentIds: ["d9"],
            });
        });
    });

    it("never spends a model call on a trivial turn, and offers it no chip", async () => {
        await withCaps([CHIP_CAP], async () => {
            let called = false;
            const spy = (async () => {
                called = true;
                throw new Error("must not run");
            }) as never;
            // Short, attachment-free, but lexically a candidate ("estoppel").
            const result = await runIntentDetection(
                detectionArgs({ message: "estoppel?", attachments: [] }),
                { completeStructuredFn: spy, ...FIXED_DEPS },
            );
            assert.equal(called, false, "a trivial turn never costs a model call");
            assert.equal(result.ran, false);
            assert.equal(result.model, null);
            assert.equal(
                result.proposal,
                null,
                "with no attachment there is no structural signal, so no chip",
            );
            assert.equal(result.outcome, "trivial_turn");
        });
    });

    it("still applies the structural rule when the classifier is switched off", async () => {
        await withCaps([CHIP_CAP], async () => {
            let called = false;
            const spy = (async () => {
                called = true;
                throw new Error("must not run");
            }) as never;
            const result = await runIntentDetection(
                detectionArgs({ llmEnabled: false }),
                { completeStructuredFn: spy, ...FIXED_DEPS },
            );
            assert.equal(called, false);
            assert.equal(result.ran, false);
            assert.equal(result.source, "lexical");
            assert.equal(result.outcome, "lexical");
            assert.equal(result.proposal?.capabilityId, "cre-fixture");
            assert.equal(result.model, null);
        });
    });
});

// ---------------------------------------------------------------------------
// Final-review fixes: F4 (surface-scoped run targets), F6 (a grace race that
// clears its own timer), F7 (distinguishable no-chip outcomes).
// ---------------------------------------------------------------------------

describe("withDeadline", () => {
    it("resolves with the promise's value when it settles first", async () => {
        assert.equal(await withDeadline(Promise.resolve("v"), 1000), "v");
    });

    it("resolves null when the deadline wins", async () => {
        const never = new Promise<string>(() => {
            /* never settles */
        });
        assert.equal(await withDeadline(never, 10), null);
    });

    it("clears the timer instead of holding the event loop open", async () => {
        const before = process
            .getActiveResourcesInfo()
            .filter((r) => r === "Timeout").length;
        assert.equal(await withDeadline(Promise.resolve(1), 60_000), 1);
        // One tick for the finally to run.
        await new Promise((resolve) => setImmediate(resolve));
        const after = process
            .getActiveResourcesInfo()
            .filter((r) => r === "Timeout").length;
        assert.equal(after, before, "the 60s timer must not survive the race");
    });
});

describe("runIntentDetection — surface-scoped run targets", () => {
    it("offers only the run targets the surface can launch", async () => {
        await withCaps([CHIP_CAP, TAB_CAP], async () => {
            const { fn, calls } = capturingComplete({
                capability_id: "cre-fixture",
                confidence: 0.9,
                confirm_prompt: "Abstract the Sampleton lease?",
                reason: "r",
                document_id: null,
            });
            await runIntentDetection(
                detectionArgs({ allowedRunTargets: ["chat"] }),
                { completeStructuredFn: fn, ...FIXED_DEPS },
            );
            const enumIds = (
                calls[0].schema.properties as Record<string, Record<string, unknown>>
            ).capability_id.enum;
            assert.deepEqual(
                enumIds,
                ["cre-fixture", "none"],
                "a modal-only capability is never offered on a chat-only surface",
            );
        });
    });

    it("still offers every run target when the caller names none", async () => {
        await withCaps([CHIP_CAP, TAB_CAP], async () => {
            const { fn, calls } = capturingComplete({
                capability_id: "cre-fixture",
                confidence: 0.9,
                confirm_prompt: "Abstract the Sampleton lease?",
                reason: "r",
                document_id: null,
            });
            await runIntentDetection(detectionArgs(), {
                completeStructuredFn: fn,
                ...FIXED_DEPS,
            });
            const enumIds = (
                calls[0].schema.properties as Record<string, Record<string, unknown>>
            ).capability_id.enum;
            assert.deepEqual(enumIds, ["cre-fixture", "tab-fixture", "none"]);
        });
    });

    it("spends no model call when the surface excludes every candidate", async () => {
        await withCaps([TAB_CAP], async () => {
            let called = false;
            const spy = (async () => {
                called = true;
                throw new Error("must not run");
            }) as never;
            const result = await runIntentDetection(
                detectionArgs({ allowedRunTargets: ["chat"] }),
                { completeStructuredFn: spy, ...FIXED_DEPS },
            );
            assert.equal(called, false);
            assert.equal(result.proposal, null);
            assert.equal(result.outcome, "no_candidate");
        });
    });
});

describe("runIntentDetection — no-chip outcomes are distinguishable", () => {
    it("reports llm_disabled when the classifier is off and nothing is structural", async () => {
        await withCaps([CHIP_CAP], async () => {
            const result = await runIntentDetection(
                detectionArgs({
                    llmEnabled: false,
                    attachments: [],
                    message:
                        "Please review the commercial lease terms before we sign anything.",
                }),
                FIXED_DEPS,
            );
            assert.equal(result.proposal, null);
            assert.equal(result.outcome, "llm_disabled");
            assert.equal(result.ran, false);
        });
    });
});

describe("runIntentDetection — refusals", () => {
    it("emits nothing at all on a suppressed, run or seeded-workflow turn", async () => {
        await withCaps([CHIP_CAP], async () => {
            for (const flag of [
                "suppressed",
                "capabilityRunTurn",
                "seededWorkflowTurn",
            ] as const) {
                let called = false;
                const spy = (async () => {
                    called = true;
                    throw new Error("must not run");
                }) as never;
                const result = await runIntentDetection(
                    detectionArgs({ [flag]: true }),
                    { completeStructuredFn: spy, ...FIXED_DEPS },
                );
                assert.equal(result.proposal, null, `${flag} must emit no chip`);
                assert.equal(result.outcome, "skipped");
                assert.equal(result.ran, false);
                assert.equal(result.source, "none");
                assert.equal(called, false);
            }
        });
    });

    it("never proposes a capability no chip can launch", async () => {
        await withCaps([NO_CHIP_CAP], async () => {
            let called = false;
            const spy = (async () => {
                called = true;
                throw new Error("must not run");
            }) as never;
            const result = await runIntentDetection(detectionArgs(), {
                completeStructuredFn: spy,
                ...FIXED_DEPS,
            });
            assert.equal(result.proposal, null);
            assert.equal(result.outcome, "no_candidate");
            assert.equal(called, false);
        });
    });

    it("skips an excluded capability on the fallback path too", async () => {
        await withCaps([CHIP_CAP], async () => {
            const result = await runIntentDetection(
                detectionArgs({
                    llmEnabled: false,
                    excludedCapabilityIds: new Set(["cre-fixture"]),
                }),
                FIXED_DEPS,
            );
            assert.equal(result.proposal, null);
            assert.equal(result.outcome, "no_candidate");
        });
    });
});

// ---------------------------------------------------------------------------
// R1: the matter surface's DISPLAYED document is classifier CONTEXT only. It
// must never make a turn non-trivial (a "thanks" with a doc in the panel still
// costs no model call) and must never, on its own, trigger the structural
// fallback (which would re-propose the same chip every turn until refused).
// ---------------------------------------------------------------------------

/** The document merely open in the matter's panel — nobody attached it. */
const DISPLAYED_LEASE = {
    filename: "Sampleton_Commercial_Lease_MSA.pdf",
    extractedText: null,
    documentType: null,
    documentId: "d-displayed",
    origin: "displayed" as const,
};

describe("runIntentDetection — displayed document is context, not a trigger", () => {
    it("keeps a short turn trivial when the only document is the displayed one", async () => {
        await withCaps([CHIP_CAP], async () => {
            let called = false;
            const spy = (async () => {
                called = true;
                throw new Error("must not run");
            }) as never;
            const result = await runIntentDetection(
                detectionArgs({
                    message: "thanks",
                    attachments: [DISPLAYED_LEASE],
                }),
                { completeStructuredFn: spy, ...FIXED_DEPS },
            );
            assert.equal(called, false, "a trivial turn never costs a model call");
            assert.equal(result.outcome, "trivial_turn");
            assert.equal(result.ran, false);
            assert.equal(result.model, null);
            assert.equal(result.proposal, null);
        });
    });

    it("still shows the displayed document to the classifier on a real turn", async () => {
        await withCaps([CHIP_CAP], async () => {
            const { fn, calls } = capturingComplete({
                capability_id: "none",
                confidence: 0.99,
                confirm_prompt: "",
                reason: "a general question",
                document_id: null,
            });
            const result = await runIntentDetection(
                detectionArgs({
                    message:
                        "What does an introducing broker have to file with the NFA?",
                    attachments: [DISPLAYED_LEASE],
                }),
                { completeStructuredFn: fn, ...FIXED_DEPS },
            );
            assert.equal(result.ran, true, "a non-trivial turn is classified");
            assert.equal(calls.length, 1);
            assert.match(
                calls[0].user,
                /Sampleton_Commercial_Lease_MSA\.pdf/,
                "the displayed document is context for the classifier",
            );
            assert.equal(result.proposal, null);
            assert.equal(result.outcome, "none");
        });
    });

    it("never lets the displayed document alone fire the structural fallback", async () => {
        await withCaps([CHIP_CAP], async () => {
            const result = await runIntentDetection(
                detectionArgs({
                    llmEnabled: false,
                    message:
                        "What does an introducing broker have to file with the NFA?",
                    attachments: [DISPLAYED_LEASE],
                }),
                FIXED_DEPS,
            );
            assert.equal(
                result.proposal,
                null,
                "a document the user did not attach is not a structural signal",
            );
            assert.equal(result.outcome, "llm_disabled");
            assert.equal(result.ran, false);
            assert.equal(result.source, "none");
        });
    });

    it("still fires the structural fallback for an explicitly attached document", async () => {
        await withCaps([CHIP_CAP], async () => {
            const result = await runIntentDetection(
                detectionArgs({
                    llmEnabled: false,
                    attachments: [LEASE_ATTACHMENT, DISPLAYED_LEASE],
                }),
                FIXED_DEPS,
            );
            assert.equal(result.proposal?.capabilityId, "cre-fixture");
            assert.equal(result.proposal?.source, "lexical");
            assert.equal(result.outcome, "lexical");
        });
    });
});
