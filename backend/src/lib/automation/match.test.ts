// backend/src/lib/automation/match.test.ts
//
// Case matching decides WHOSE case gets written, so these tests pin the
// scoring math (token-set Jaccard over normalizeClientName output, +0.1
// DOL bonus capped at 1.0, containment scoring for names inside subjects),
// the pure threshold decision (min_score floor, then match_auto /
// match_confirm), and the orchestration rules with injected deps: claim
// numbers resolve exactly; multiple claims mapping to DIFFERENT cases is a
// triage, never a guess; claims below confirm create a PROVISIONAL case;
// invoices below confirm go to triage and never create cases.
import assert from "node:assert/strict";
import type { ClaimExtraction, ExtractedField, InvoiceExtraction } from "./types";
import {
    caseNumberInText,
    decideFuzzyMatch,
    matchClaimRun,
    matchFromRun,
    matchInvoiceRun,
    scoreClientNameMatch,
    scoreNameInText,
    toIsoDate,
    CONTAINMENT_AUTO_MARGIN,
    type CaseCandidate,
    type MatchDeps,
    type MatchThresholds,
} from "./match";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

function field(value: string, extra?: Partial<ExtractedField>): ExtractedField {
    return {
        value,
        quote: value,
        page: null,
        source: "email_body",
        confidence: 0.9,
        ...extra,
    };
}

const thresholds: MatchThresholds = {
    matchAuto: 0.95,
    matchConfirm: 0.8,
    minScore: 0.5,
};

function candidate(partial: Partial<CaseCandidate>): CaseCandidate {
    return {
        id: "case-1",
        client_name: "Jane Doe",
        client_name_normalized: "jane doe",
        case_number: null,
        date_of_loss: null,
        ...partial,
    };
}

function claimExtraction(input: {
    claimNumbers: string[];
    clientName?: string;
    dol?: string;
}): ClaimExtraction {
    return {
        claims: input.claimNumbers.map((n) => ({
            claim_number: field(n),
            carrier: field("Example Mutual"),
            ...(input.clientName
                ? { client_or_insured_name: field(input.clientName) }
                : {}),
            ...(input.dol ? { date_of_loss: field(input.dol) } : {}),
        })),
        summary: "s",
    };
}

const invoiceExtraction = (matterRef?: string): InvoiceExtraction => ({
    vendor: field("SampleRecords"),
    invoice_number: field("INV-1"),
    amount_cents: 1000,
    amount_raw: field("$10.00"),
    currency: "USD",
    ...(matterRef ? { matter_reference: field(matterRef) } : {}),
    summary: "s",
});

function makeDeps(overrides: Partial<MatchDeps>): MatchDeps {
    return {
        findCaseIdByClaimNumberFn: async () => null,
        listCandidatesFn: async () => [],
        createCaseFn: async () => {
            throw new Error("createCaseFn not expected in this test");
        },
        ...overrides,
    };
}

async function main() {
    console.log("automation/match.test.ts");

    await test("scoreClientNameMatch: token-set Jaccard on normalized names", () => {
        assert.equal(
            scoreClientNameMatch("Jane Doe", candidate({})),
            1,
            "identical names score 1",
        );
        const partial = scoreClientNameMatch(
            "Jane A. Doe",
            candidate({ client_name_normalized: "jane doe" }),
        );
        assert.ok(
            Math.abs(partial - 2 / 3) < 1e-9,
            `{jane,a,doe} ∩ {jane,doe} / union = 2/3, got ${partial}`,
        );
        assert.equal(
            scoreClientNameMatch("DOE, Jane", candidate({})),
            1,
            "punctuation/case fold away via normalizeClientName",
        );
        assert.equal(scoreClientNameMatch("", candidate({})), 0);
        assert.equal(
            scoreClientNameMatch(
                "Jane Doe",
                candidate({ client_name_normalized: null }),
            ),
            0,
            "a candidate without a normalized name can never match",
        );
    });

    await test("scoreClientNameMatch: exact DOL match adds +0.1, capped at 1.0", () => {
        const withBonus = scoreClientNameMatch(
            "Jane A Doe",
            candidate({
                client_name_normalized: "jane doe",
                date_of_loss: "2026-03-15",
            }),
            "2026-03-15",
        );
        assert.ok(Math.abs(withBonus - (2 / 3 + 0.1)) < 1e-9);
        assert.equal(
            scoreClientNameMatch(
                "Jane Doe",
                candidate({ date_of_loss: "2026-03-15" }),
                "2026-03-15",
            ),
            1,
            "bonus never pushes past 1.0",
        );
        assert.ok(
            Math.abs(
                scoreClientNameMatch(
                    "Jane A Doe",
                    candidate({
                        client_name_normalized: "jane doe",
                        date_of_loss: "2026-03-16",
                    }),
                    "2026-03-15",
                ) -
                    2 / 3,
            ) < 1e-9,
            "differing DOLs add nothing",
        );
    });

    await test("scoreNameInText: fraction of candidate-name tokens present in the text", () => {
        assert.equal(
            scoreNameInText("Invoice INV-1 — records for Jane Doe", "jane doe"),
            1,
        );
        assert.equal(
            scoreNameInText("records for Jane only", "jane doe"),
            0.5,
        );
        assert.equal(scoreNameInText("nothing relevant", "jane doe"), 0);
        assert.equal(scoreNameInText("anything", null), 0);
        assert.equal(scoreNameInText("", "jane doe"), 0);
    });

    await test("caseNumberInText: verbatim (normalized) case-number hit", () => {
        assert.equal(caseNumberInText("Re: Case CV-2026-001", "CV-2026-001"), true);
        assert.equal(caseNumberInText("re case cv 2026 001", "CV-2026-001"), true);
        assert.equal(caseNumberInText("Case CV-2026-0011", "CV-2026-001"), false);
        assert.equal(caseNumberInText("anything", null), false);
        assert.equal(caseNumberInText("anything", "  "), false);
    });

    await test("toIsoDate: ISO and US formats normalize; junk → null", () => {
        assert.equal(toIsoDate("2026-03-15"), "2026-03-15");
        assert.equal(toIsoDate("03/15/2026"), "2026-03-15");
        assert.equal(toIsoDate("3/5/2026"), "2026-03-05");
        assert.equal(toIsoDate("March 15, 2026"), null, "prose dates are not guessed");
        assert.equal(toIsoDate("15/03/2026"), null, "an impossible US date is rejected");
        assert.equal(toIsoDate(""), null);
        assert.equal(toIsoDate(undefined), null);
    });

    await test("decideFuzzyMatch: min_score floor, then auto/confirm thresholds", () => {
        const scored = (score: number) => [{ caseId: "c1", score }];
        assert.deepEqual(decideFuzzyMatch(scored(0.96), thresholds), {
            kind: "auto",
            caseId: "c1",
            score: 0.96,
        });
        assert.deepEqual(decideFuzzyMatch(scored(0.85), thresholds), {
            kind: "confirm",
            caseId: "c1",
            score: 0.85,
        });
        assert.equal(decideFuzzyMatch(scored(0.7), thresholds), null);
        assert.equal(
            decideFuzzyMatch(scored(0.85), { ...thresholds, minScore: 0.9 }),
            null,
            "the min_score floor excludes candidates below it even above match_confirm",
        );
        assert.equal(decideFuzzyMatch([], thresholds), null);
        const best = decideFuzzyMatch(
            [
                { caseId: "low", score: 0.81 },
                { caseId: "high", score: 0.97 },
            ],
            thresholds,
        );
        assert.equal(best?.caseId, "high", "the best-scoring candidate wins");
    });

    await test("matchClaimRun: claim-number exact match wins immediately", async () => {
        const result = await matchClaimRun(
            null as never,
            "user-1",
            claimExtraction({ claimNumbers: ["24-1", "24-1"] }),
            thresholds,
            {},
            makeDeps({
                findCaseIdByClaimNumberFn: async (_db, userId, claimNumber) => {
                    assert.equal(userId, "user-1");
                    return claimNumber === "24-1" ? "case-9" : null;
                },
            }),
        );
        assert.deepEqual(result, {
            caseId: "case-9",
            method: "claim_number",
            confidence: 1,
            needsCaseConfirm: false,
        });
    });

    await test("matchClaimRun: claims resolving to DIFFERENT cases → triage", async () => {
        const result = await matchClaimRun(
            null as never,
            "user-1",
            claimExtraction({ claimNumbers: ["24-1", "24-2"] }),
            thresholds,
            {},
            makeDeps({
                findCaseIdByClaimNumberFn: async (_db, _u, claimNumber) =>
                    claimNumber === "24-1" ? "case-a" : "case-b",
            }),
        );
        assert.deepEqual(result, {
            triage: "multiple claims map to different cases",
        });
    });

    await test("matchClaimRun: fuzzy auto-match above match_auto", async () => {
        const result = await matchClaimRun(
            null as never,
            "user-1",
            claimExtraction({ claimNumbers: ["24-1"], clientName: "Jane Doe" }),
            thresholds,
            {},
            makeDeps({
                listCandidatesFn: async () => [
                    candidate({ id: "case-jane" }),
                    candidate({
                        id: "case-other",
                        client_name_normalized: "bob smith",
                    }),
                ],
            }),
        );
        assert.deepEqual(result, {
            caseId: "case-jane",
            method: "client_name_fuzzy",
            confidence: 1,
            needsCaseConfirm: false,
        });
    });

    await test("matchClaimRun: between confirm and auto → matched with needsCaseConfirm", async () => {
        // 2/3 Jaccard + 0.1 DOL bonus ≈ 0.767: inside [confirm, auto) for
        // these test thresholds, so the match is proposed but flagged for
        // human confirmation.
        const confirmBand: MatchThresholds = {
            matchAuto: 0.9,
            matchConfirm: 0.7,
            minScore: 0.5,
        };
        const result = await matchClaimRun(
            null as never,
            "user-1",
            claimExtraction({
                claimNumbers: ["24-1"],
                clientName: "Jane A Doe",
                dol: "2026-03-15",
            }),
            confirmBand,
            {},
            makeDeps({
                listCandidatesFn: async () => [
                    candidate({
                        id: "case-jane",
                        client_name_normalized: "jane doe",
                        date_of_loss: "2026-03-15",
                    }),
                ],
            }),
        );
        assert.equal((result as { caseId?: string }).caseId, "case-jane");
        assert.equal((result as { method?: string }).method, "client_name_fuzzy");
        assert.equal(
            (result as { needsCaseConfirm?: boolean }).needsCaseConfirm,
            true,
        );
        const confidence = (result as { confidence?: number }).confidence ?? 0;
        assert.ok(Math.abs(confidence - (2 / 3 + 0.1)) < 1e-9);
    });

    await test("matchClaimRun: no candidate above thresholds → provisional case", async () => {
        let created: Record<string, unknown> | null = null;
        const result = await matchClaimRun(
            null as never,
            "user-1",
            claimExtraction({
                claimNumbers: ["24-1"],
                clientName: "Jane Doe",
                dol: "03/15/2026",
            }),
            thresholds,
            { senderDisplayName: "Example Mutual Claims" },
            makeDeps({
                listCandidatesFn: async () => [],
                createCaseFn: async (_db, input) => {
                    created = input as unknown as Record<string, unknown>;
                    return { id: "case-new" };
                },
            }),
        );
        assert.deepEqual(result, {
            caseId: "case-new",
            method: "provisional",
            confidence: 0,
            needsCaseConfirm: false,
        });
        assert.ok(created, "a provisional case was created");
        const row = created as unknown as Record<string, unknown>;
        assert.equal(row.userId, "user-1");
        assert.equal(row.clientName, "Jane Doe");
        assert.equal(row.origin, "auto_created");
        assert.equal(row.needsReview, true);
        assert.equal(row.status, "provisional");
        assert.equal(row.dateOfLoss, "2026-03-15", "DOL normalized to ISO");
    });

    await test("matchClaimRun: provisional falls back to the sender display name", async () => {
        let created: Record<string, unknown> | null = null;
        await matchClaimRun(
            null as never,
            "user-1",
            claimExtraction({ claimNumbers: ["24-1"] }),
            thresholds,
            { senderDisplayName: "Example Mutual Claims" },
            makeDeps({
                createCaseFn: async (_db, input) => {
                    created = input as unknown as Record<string, unknown>;
                    return { id: "case-new" };
                },
            }),
        );
        assert.equal(
            (created as unknown as Record<string, unknown>)?.clientName,
            "Example Mutual Claims",
        );
    });

    await test("matchInvoiceRun: matter_reference fuzzy match", async () => {
        const result = await matchInvoiceRun(
            null as never,
            "user-1",
            invoiceExtraction("Jane Doe"),
            thresholds,
            { subject: "Invoice INV-1" },
            makeDeps({
                listCandidatesFn: async () => [candidate({ id: "case-jane" })],
            }),
        );
        assert.deepEqual(result, {
            caseId: "case-jane",
            method: "client_name_fuzzy",
            confidence: 1,
            needsCaseConfirm: false,
        });
    });

    await test("matchInvoiceRun: client-name tokens in the SUBJECT match too — but only into the confirm band", async () => {
        const result = await matchInvoiceRun(
            null as never,
            "user-1",
            invoiceExtraction(),
            thresholds,
            { subject: "Records invoice — Jane Doe — DOL 3/15" },
            makeDeps({
                listCandidatesFn: async () => [candidate({ id: "case-jane" })],
            }),
        );
        assert.equal((result as { caseId?: string }).caseId, "case-jane");
        assert.equal(
            (result as { needsCaseConfirm?: boolean }).needsCaseConfirm,
            true,
            "containment-only evidence always requires human case confirmation",
        );
    });

    await test("matchInvoiceRun: containment alone can NEVER reach the auto band", async () => {
        // Full containment of a short name in a busy subject: real signal,
        // weak evidence. The score is capped just below match_auto, so the
        // match stages with needsCaseConfirm true — never auto.
        const result = await matchInvoiceRun(
            null as never,
            "user-1",
            invoiceExtraction(),
            thresholds,
            { subject: "Invoice for Jane Doe records retrieval" },
            makeDeps({
                listCandidatesFn: async () => [candidate({ id: "case-jane" })],
            }),
        );
        assert.equal((result as { caseId?: string }).caseId, "case-jane");
        const confidence = (result as { confidence?: number }).confidence ?? 0;
        assert.ok(
            Math.abs(
                confidence - (thresholds.matchAuto - CONTAINMENT_AUTO_MARGIN),
            ) < 1e-9,
            `containment is capped at matchAuto - margin, got ${confidence}`,
        );
        assert.ok(confidence < thresholds.matchAuto);
        assert.equal(
            (result as { needsCaseConfirm?: boolean }).needsCaseConfirm,
            true,
        );
    });

    await test("matchInvoiceRun: a genuine matter_reference Jaccard match still reaches auto", async () => {
        // The cap applies to containment only — a full-name Jaccard match on
        // matter_reference is strong evidence and keeps its auto band.
        const result = await matchInvoiceRun(
            null as never,
            "user-1",
            invoiceExtraction("Jane Doe"),
            thresholds,
            { subject: "Invoice INV-1" },
            makeDeps({
                listCandidatesFn: async () => [candidate({ id: "case-jane" })],
            }),
        );
        assert.equal((result as { confidence?: number }).confidence, 1);
        assert.equal(
            (result as { needsCaseConfirm?: boolean }).needsCaseConfirm,
            false,
        );
    });

    await test("matchInvoiceRun: a case_number appearing verbatim scores 1.0 (auto)", async () => {
        const result = await matchInvoiceRun(
            null as never,
            "user-1",
            invoiceExtraction("Re: CV-2026-001"),
            thresholds,
            { subject: "Invoice" },
            makeDeps({
                listCandidatesFn: async () => [
                    candidate({
                        id: "case-num",
                        client_name_normalized: "totally different person",
                        case_number: "CV-2026-001",
                    }),
                ],
            }),
        );
        assert.equal((result as { caseId?: string }).caseId, "case-num");
        assert.equal((result as { confidence?: number }).confidence, 1);
        assert.equal(
            (result as { needsCaseConfirm?: boolean }).needsCaseConfirm,
            false,
            "a verbatim case-number hit is strong evidence — auto stays reachable",
        );
    });

    await test("matchInvoiceRun: below match_confirm → triage, NO provisional case", async () => {
        let createCalled = false;
        const result = await matchInvoiceRun(
            null as never,
            "user-1",
            invoiceExtraction("Someone Unrelated"),
            thresholds,
            { subject: "Invoice INV-1" },
            makeDeps({
                listCandidatesFn: async () => [candidate({})],
                createCaseFn: async () => {
                    createCalled = true;
                    return { id: "x" };
                },
            }),
        );
        assert.deepEqual(result, {
            triage: "no confident case match for invoice",
        });
        assert.equal(createCalled, false, "invoices never create cases");
    });

    await test("matchFromRun reconstructs a MatchResult from persisted run fields", () => {
        assert.deepEqual(
            matchFromRun(
                {
                    case_id: "c1",
                    match_method: "client_name_fuzzy",
                    match_confidence: 0.85,
                },
                thresholds,
            ),
            {
                caseId: "c1",
                method: "client_name_fuzzy",
                confidence: 0.85,
                needsCaseConfirm: true,
            },
            "a fuzzy match persisted below match_auto still needs confirmation on re-entry",
        );
        assert.deepEqual(
            matchFromRun(
                {
                    case_id: "c1",
                    match_method: "claim_number",
                    match_confidence: 1,
                },
                thresholds,
            ),
            {
                caseId: "c1",
                method: "claim_number",
                confidence: 1,
                needsCaseConfirm: false,
            },
        );
        assert.equal(
            matchFromRun(
                { case_id: null, match_method: null, match_confidence: null },
                thresholds,
            ),
            null,
        );
    });

    console.log("automation/match.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
