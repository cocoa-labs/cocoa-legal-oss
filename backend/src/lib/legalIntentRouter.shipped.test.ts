// backend/src/lib/legalIntentRouter.shipped.test.ts
//
// Router tests against the SHIPPED capability vocabulary. The sibling
// legalIntentRouter.test.ts exercises the scoring rule with a local fixture
// capability; this file imports ./legalCapabilities/register so the phrases
// under test are exactly the ones production registers. That is the only way
// a false positive like "run a CRE review on this CFTC/NFA question" is
// actually caught by CI.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./legalCapabilities/register";
import {
    describeProposalCapability,
    detectIntent,
    detectIntentCandidates,
    LEXICAL_ONLY_CONFIDENCE_THRESHOLD,
} from "./legalIntentRouter";
import type { LegalCapability } from "./legalCapabilities/types";

// The turn that shipped the bug: a derivatives-regulatory question that
// happens to use the words "subordination" and "purchase and sale". It is a
// legitimate keyword co-occurrence, so the router may keep it as a weak
// candidate — but it must never reach the lexical-only firing bar.
const CFTC_TURN =
    "Our client is a commodity pool operator registered with the CFTC and a member of the NFA. " +
    "They asked whether their clearing agreement with their FCM has to be amended before " +
    "a new principal joins who holds a Series 3 license. There is also a subordination " +
    "agreement supporting their capital computation, and the pool handles the purchase and " +
    "sale of futures contracts through an omnibus account. Please walk me through which NFA " +
    "registration steps apply to the new principal, whether the clearing agreement has to be " +
    "refiled, and how the subordination agreement affects the minimum capital requirement " +
    "under CFTC Regulation 1.17.";

describe("legalIntentRouter (shipped vocabulary)", () => {
    it("does not fire a lexical-only proposal on a CFTC/NFA question", () => {
        const proposal = detectIntent(CFTC_TURN, []);
        if (proposal !== null) {
            assert.ok(
                proposal.confidence < LEXICAL_ONLY_CONFIDENCE_THRESHOLD,
                `expected weak confidence, got ${proposal.confidence} for ${proposal.capabilityId}`,
            );
        }

        // Unconditional: whether or not cre-review is reported as a candidate
        // at all, no cre-review candidate may reach the lexical-only bar. A
        // conditional assertion here would silently pass if the candidate list
        // ever stopped including it for the wrong reason.
        const candidates = detectIntentCandidates(CFTC_TURN, []);
        for (const cre of candidates.filter(
            (c) => c.capabilityId === "cre-review",
        )) {
            assert.ok(
                cre.confidence < LEXICAL_ONLY_CONFIDENCE_THRESHOLD,
                `cre-review must stay below the lexical-only bar, got ${cre.confidence}`,
            );
        }

        // The turn IS a compliance question, and the prefilter must say so —
        // that is what gives the classifier something correct to choose.
        assert.ok(
            candidates.some((c) => c.capabilityId === "compliance-check"),
            `expected compliance-check among candidates, got ${candidates
                .map((c) => c.capabilityId)
                .join(", ")}`,
        );
    });

    it("does not fire on 'lease' hiding inside another word", () => {
        assert.equal(detectIntent("please release the funds from escrow", []), null);
        assert.equal(detectIntent("release notes", []), null);
        assert.equal(detectIntent("lease a car for the partner", []), null);
    });

    it("still fires on a structural hit: an attached commercial lease", () => {
        const proposal = detectIntent("thoughts?", [
            {
                filename: "Office_Commercial_Lease_2026.pdf",
                extractedText: null,
                documentType: null,
                documentId: null,
            },
        ]);
        assert.ok(proposal, "expected a proposal from the filename signal");
        assert.equal(proposal.capabilityId, "cre-review");
        assert.ok(
            proposal.confidence >= LEXICAL_ONLY_CONFIDENCE_THRESHOLD,
            `expected >= ${LEXICAL_ONLY_CONFIDENCE_THRESHOLD}, got ${proposal.confidence}`,
        );
    });

    it("still fires on the persisted document_type slug alone", () => {
        const proposal = detectIntent("thoughts?", [
            {
                filename: null,
                extractedText: null,
                documentType: "commercial-lease",
                documentId: null,
            },
        ]);
        assert.ok(proposal, "expected a proposal from the document_type slug");
        assert.equal(proposal.capabilityId, "cre-review");
        assert.ok(
            proposal.confidence >= LEXICAL_ONLY_CONFIDENCE_THRESHOLD,
            `expected >= ${LEXICAL_ONLY_CONFIDENCE_THRESHOLD}, got ${proposal.confidence}`,
        );
    });

    it("returns candidates sorted by confidence with their hit counts", () => {
        const candidates = detectIntentCandidates("thoughts?", [
            {
                filename: "Office_Commercial_Lease_2026.pdf",
                extractedText: null,
                documentType: null,
                documentId: null,
            },
        ]);
        assert.ok(candidates.length > 0, "expected at least one candidate");
        for (let i = 1; i < candidates.length; i += 1) {
            assert.ok(
                candidates[i - 1].confidence >= candidates[i].confidence,
                "candidates must be sorted by descending confidence",
            );
        }
        for (const c of candidates) {
            assert.equal(typeof c.keywordHits, "number");
            assert.equal(typeof c.docHits, "number");
            assert.ok(c.confidence >= 0.4);
        }
        const cre = candidates.find((c) => c.capabilityId === "cre-review");
        assert.ok(cre, "cre-review must be a candidate");
        assert.equal(cre.docHits, 1);
        assert.equal(cre.keywordHits, 0);
    });
});

function fixture(overrides: Partial<LegalCapability> = {}): LegalCapability {
    return {
        id: "fixture",
        title: "Fixture Capability",
        practice: "Real Estate",
        description: "d",
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

describe("describeProposalCapability", () => {
    it("carries the registry-owned label and routes an outputSpec to chat", () => {
        assert.deepEqual(
            describeProposalCapability(
                fixture({
                    outputSpec: { overall_scheme: "traffic-light", sections: [] },
                    intake: ["represented_party"],
                }),
            ),
            {
                title: "Fixture Capability",
                runLabel: "Run review",
                runTarget: "chat",
                intake: ["represented_party"],
            },
        );
    });

    it("routes a tabular pack to the modal and omits absent intake", () => {
        assert.deepEqual(
            describeProposalCapability(
                fixture({ workflow: { type: "tabular", columns_config: [] } }),
            ),
            {
                title: "Fixture Capability",
                runLabel: "Run review",
                runTarget: "modal",
            },
        );
    });

    it("reports null for a capability no chip can launch", () => {
        assert.equal(describeProposalCapability(fixture()).runTarget, null);
    });
});
