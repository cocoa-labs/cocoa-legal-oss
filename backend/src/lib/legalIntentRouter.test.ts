// backend/src/lib/legalIntentRouter.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerCapability, clearRegistryForTests } from "./legalCapabilities/index";
import { detectIntent, INTENT_CONFIDENCE_THRESHOLD } from "./legalIntentRouter";
import type { LegalCapability } from "./legalCapabilities/types";

// The router is exercised against a CRE-shaped capability that mirrors the
// real cre-review intentSignals (multi-word keywords + document hints), so the
// true/false-positive assertions reflect the shipped vocabulary. We register
// into the shared test registry rather than importing the real module so the
// registry stays deterministic across the suite.
function makeCapability(
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
            keywords: [],
            document_hints: [],
            confirm_prompt: "Run?",
            run_label: "Run review",
        },
        resultCard: "Card",
        outputs: { docx: false, in_app_document: false },
        connectorRequirements: [],
        ...overrides,
    };
}

const CRE_CAP = makeCapability("cre-review", {
    intentSignals: {
        keywords: [
            "commercial lease",
            "lease abstraction",
            "estoppel",
            "snda",
            "subordination",
            "non-disturbance",
            "purchase and sale",
            "rent roll",
            "co-tenancy",
            "cam",
            "title commitment",
        ],
        document_hints: [
            "commercial lease",
            "estoppel certificate",
            "subordination",
            "non-disturbance",
            "purchase and sale",
            "rent roll",
            "title commitment",
            "snda",
        ],
        confirm_prompt: "Run a Commercial Real Estate review on this document?",
        run_label: "Run review",
    },
});

function withCapabilities(
    caps: LegalCapability[],
    run: () => void,
): void {
    clearRegistryForTests();
    for (const c of caps) registerCapability(c);
    try {
        run();
    } finally {
        clearRegistryForTests();
    }
}

describe("detectIntent", () => {
    it("returns null with an empty registry", () => {
        clearRegistryForTests();
        assert.equal(detectIntent("commercial lease review", []), null);
    });

    // ── True positives ──────────────────────────────────────────────────
    it("fires on a lease message (single strong keyword phrase + corroboration)", () => {
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent(
                "Can you run a commercial lease abstraction on this?",
                [],
            );
            assert.ok(proposal, "expected a proposal");
            assert.equal(proposal?.capabilityId, "cre-review");
            assert.ok(proposal!.confidence >= INTENT_CONFIDENCE_THRESHOLD);
            assert.equal(
                proposal?.confirmPrompt,
                "Run a Commercial Real Estate review on this document?",
            );
        });
    });

    it("fires on an attached Office_Lease.pdf via normalized document hint", () => {
        // The hint "commercial lease" must match the underscore-separated
        // filename — the shared matcher normalizes separators to spaces, the
        // same normalization the upload classifier uses.
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent("here you go", [
                { filename: "Office_Commercial_Lease.pdf" },
            ]);
            assert.ok(proposal, "expected a proposal from the filename hint");
            assert.equal(proposal?.capabilityId, "cre-review");
        });
    });

    it("fires on a document_type slug hit even with a neutral message", () => {
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent("review please", [
                {
                    filename: "doc-3.pdf",
                    extractedText: "THIS COMMERCIAL LEASE AGREEMENT ...",
                },
            ]);
            assert.ok(proposal, "expected a proposal from body text");
            assert.equal(proposal?.capabilityId, "cre-review");
        });
    });

    // ── prefilledInputs.documentIds (carry the attached doc through) ─────
    it("carries the attached document_id into prefilledInputs on a positive match", () => {
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent("here you go", [
                {
                    filename: "Office_Commercial_Lease.pdf",
                    documentId: "doc-123",
                },
            ]);
            assert.ok(proposal, "expected a proposal from the filename hint");
            assert.equal(proposal?.capabilityId, "cre-review");
            assert.deepEqual(proposal?.prefilledInputs, {
                documentIds: ["doc-123"],
            });
        });
    });

    it("de-duplicates attached document ids and ignores attachments without one", () => {
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent("estoppel and snda terms", [
                { filename: "Estoppel Certificate.pdf", documentId: "doc-a" },
                { filename: "duplicate.pdf", documentId: "doc-a" },
                { filename: "no-id.pdf" },
            ]);
            assert.ok(proposal, "expected a proposal");
            assert.deepEqual(proposal?.prefilledInputs, {
                documentIds: ["doc-a"],
            });
        });
    });

    it("omits prefilledInputs when no attachment carries a document_id", () => {
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent(
                "Can you run a commercial lease abstraction on this?",
                [],
            );
            assert.ok(proposal, "expected a proposal");
            assert.equal(proposal?.prefilledInputs, undefined);
        });
    });

    // ── False positives (must NOT fire) ─────────────────────────────────
    it("does NOT fire on 'lease a car'", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(
                detectIntent("I want to lease a car next month", []),
                null,
            );
        });
    });

    it("does NOT fire on 'release notes'", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(
                detectIntent("summarize these release notes for me", []),
                null,
            );
        });
    });

    it("does NOT fire on a credit-agreement message", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(
                detectIntent(
                    "Review this senior secured credit agreement and flag the covenants",
                    [{ filename: "Credit_Agreement.pdf" }],
                ),
                null,
            );
        });
    });

    it("does NOT fire on 'please release the funds'", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(
                detectIntent("please release the funds from escrow", []),
                null,
            );
        });
    });

    it("does NOT fire on a single stray keyword (cam) alone", () => {
        // "cam" appears as a substring guard: requires >=2 keywords OR a doc
        // hint. One keyword in prose must not trip the router.
        withCapabilities([CRE_CAP], () => {
            assert.equal(
                detectIntent("the webcam broke during the cam test", []),
                null,
            );
        });
    });

    // ── Short-acronym substring guards (psa/cam inside unrelated words) ───
    // The shared matcher requires short/acronym phrases ("psa", "cam", "snda")
    // to appear on a word boundary, so these prose samples — which contain
    // "cam"/"psa" only as substrings of unrelated words — must NOT fire.
    it("does NOT fire on 'the campaign psalm' (cam/psa as substrings)", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(detectIntent("the campaign psalm", []), null);
        });
    });

    it("does NOT fire on 'scampering psalms' (cam/psa as substrings)", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(detectIntent("scampering psalms", []), null);
        });
    });

    it("does NOT fire on 'decampment and psaltery' (cam/psa as substrings)", () => {
        withCapabilities([CRE_CAP], () => {
            assert.equal(detectIntent("decampment and psaltery", []), null);
        });
    });

    // Legitimate whole-word acronym use MUST still fire: "snda" and "cam" are
    // two distinct whole-word keyword hits (both short acronyms the matcher
    // boundary-checks), which clears the keywordHits>=2 rule — proving the
    // boundary rule rejects substrings without suppressing genuine acronyms.
    it("DOES fire on legitimate whole-word acronyms ('the SNDA and CAM caps')", () => {
        withCapabilities([CRE_CAP], () => {
            const proposal = detectIntent(
                "please review the SNDA and the CAM caps",
                [],
            );
            assert.ok(proposal, "expected a proposal from two whole-word acronyms");
            assert.equal(proposal?.capabilityId, "cre-review");
        });
    });

    // ── Cross-capability selection ──────────────────────────────────────
    it("picks the higher-confidence capability when two could fire", () => {
        const other = makeCapability("other-cap", {
            intentSignals: {
                keywords: ["estoppel", "snda"],
                document_hints: [],
                confirm_prompt: "Other?",
                run_label: "Run review",
            },
        });
        withCapabilities([other, CRE_CAP], () => {
            // A document hint (strong) should beat a two-keyword match.
            const proposal = detectIntent("estoppel and snda terms", [
                { filename: "Estoppel Certificate.pdf" },
            ]);
            assert.ok(proposal);
            assert.equal(proposal?.capabilityId, "cre-review");
        });
    });
});
