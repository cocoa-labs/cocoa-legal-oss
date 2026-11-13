// backend/src/lib/automation/match.ts
//
// Case matching for the automation pipeline: resolve WHICH pi_case an
// extracted claim/invoice belongs to. Resolution order for claims:
//   1. exact claim-number lookup (pi_case_policies) — authoritative;
//   2. fuzzy client-name scoring (token-set Jaccard over normalizeClientName
//      output, +0.1 when dates of loss match exactly) against the user's
//      open + provisional cases, gated by the playbook thresholds
//      (min_score floor, then match_auto / match_confirm);
//   3. a PROVISIONAL case (origin auto_created, needs_review) so the claim
//      facts have somewhere reviewable to land.
// Invoices stop at step 2: an invoice that can't be confidently matched is
// a triage, never a new case. Ambiguity is always a triage — multiple
// claims resolving to different cases must be untangled by a human.
//
// Everything DB-touching takes injectable deps (MatchDeps) so the decision
// logic is testable without Supabase; the scorers and threshold decision
// are pure.

import type { createServerSupabase } from "../supabase";
import {
    createCase,
    findCaseIdByClaimNumber,
    listCases,
    normalizeClientName,
    type PiCaseInsert,
} from "../pi/store";
import { normalizeForVerify } from "./extract/verify";
import type { AutomationRun, ClaimExtraction, InvoiceExtraction } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/** Playbook-configured gates (pi.automation.confidence_thresholds +
 * pi.cases.matching_rules.min_score). */
export interface MatchThresholds {
    matchAuto: number;
    matchConfirm: number;
    minScore: number;
}

/** The candidate-case projection the scorers work over. */
export interface CaseCandidate {
    id: string;
    client_name: string;
    client_name_normalized: string | null;
    case_number: string | null;
    date_of_loss: string | null;
}

export type MatchMethod =
    | "claim_number"
    | "client_name_fuzzy"
    | "provisional"
    | "manual";

export type MatchResult =
    | {
          caseId: string;
          method: MatchMethod;
          confidence: number;
          needsCaseConfirm: boolean;
      }
    | { triage: string };

/** How many candidate cases the fuzzy matcher will score in memory. */
export const MATCH_CANDIDATE_CAP = 500;

/** Injectable seams (default to the real pi/store functions). */
export interface MatchDeps {
    findCaseIdByClaimNumberFn?: (
        db: Db,
        userId: string,
        claimNumber: string,
    ) => Promise<string | null>;
    listCandidatesFn?: (db: Db, userId: string) => Promise<CaseCandidate[]>;
    createCaseFn?: (db: Db, input: PiCaseInsert) => Promise<{ id: string }>;
}

/**
 * Normalize a date string to YYYY-MM-DD. Accepts ISO (YYYY-M-D) and US
 * (M/D/YYYY) forms ONLY — prose dates and ambiguous/impossible values
 * return null rather than a guess. Pure string surgery, no Date parsing
 * (which is timezone-dependent and over-accepting).
 */
export function toIsoDate(value: string | null | undefined): string | null {
    const raw = (value ?? "").trim();
    if (!raw) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    const build = (year: number, month: number, day: number): string | null =>
        month >= 1 && month <= 12 && day >= 1 && day <= 31
            ? `${year}-${pad(month)}-${pad(day)}`
            : null;

    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
        return build(
            Number.parseInt(iso[1], 10),
            Number.parseInt(iso[2], 10),
            Number.parseInt(iso[3], 10),
        );
    }
    const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) {
        return build(
            Number.parseInt(us[3], 10),
            Number.parseInt(us[1], 10),
            Number.parseInt(us[2], 10),
        );
    }
    return null;
}

function tokenSet(normalized: string): Set<string> {
    return new Set(normalized.split(" ").filter(Boolean));
}

/**
 * Token-set Jaccard similarity between the extracted client name and a
 * candidate's stored client_name_normalized (both sides through
 * normalizeClientName, so they can never disagree on folding), plus a
 * +0.1 bonus (capped at 1.0) when both dates of loss are present and
 * exactly equal after ISO normalization.
 */
export function scoreClientNameMatch(
    extractedName: string,
    candidate: {
        client_name_normalized: string | null;
        date_of_loss: string | null;
    },
    extractedDol?: string | null,
): number {
    const a = tokenSet(normalizeClientName(extractedName ?? ""));
    const b = tokenSet(candidate.client_name_normalized ?? "");
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection += 1;
    const union = a.size + b.size - intersection;
    let score = union === 0 ? 0 : intersection / union;

    const dolA = toIsoDate(extractedDol);
    const dolB = toIsoDate(candidate.date_of_loss);
    if (dolA && dolB && dolA === dolB) score = Math.min(1, score + 0.1);
    return score;
}

/**
 * Containment score: the fraction of the candidate's name tokens that
 * appear in the (normalized) text. Suits "is this client mentioned in the
 * subject / matter reference?", where Jaccard would be diluted by all the
 * other words around the name.
 */
export function scoreNameInText(
    text: string,
    candidateNormalized: string | null,
): number {
    const nameTokens = tokenSet(candidateNormalized ?? "");
    if (nameTokens.size === 0) return 0;
    const textTokens = tokenSet(normalizeClientName(text ?? ""));
    if (textTokens.size === 0) return 0;
    let present = 0;
    for (const token of nameTokens) if (textTokens.has(token)) present += 1;
    return present / nameTokens.size;
}

/** True when the case number appears verbatim (whole, punctuation-folded)
 * in the text — the strongest non-claim-number signal an invoice carries. */
export function caseNumberInText(
    text: string,
    caseNumber: string | null,
): boolean {
    const normNumber = normalizeForVerify(caseNumber ?? "");
    if (!normNumber) return false;
    const normText = normalizeForVerify(text ?? "");
    if (!normText) return false;
    return ` ${normText} `.includes(` ${normNumber} `);
}

/**
 * Pure threshold decision over scored candidates: candidates below the
 * playbook min_score floor are excluded entirely; the best survivor is an
 * "auto" match at/above match_auto, a "confirm" match at/above
 * match_confirm (→ needsCaseConfirm), and no match below that.
 */
export function decideFuzzyMatch(
    scored: { caseId: string; score: number }[],
    thresholds: MatchThresholds,
): { kind: "auto" | "confirm"; caseId: string; score: number } | null {
    let best: { caseId: string; score: number } | null = null;
    for (const entry of scored) {
        if (entry.score < thresholds.minScore) continue;
        if (!best || entry.score > best.score) best = entry;
    }
    if (!best) return null;
    if (best.score >= thresholds.matchAuto) {
        return { kind: "auto", caseId: best.caseId, score: best.score };
    }
    if (best.score >= thresholds.matchConfirm) {
        return { kind: "confirm", caseId: best.caseId, score: best.score };
    }
    return null;
}

/** Default candidate listing: the user's open + provisional cases, paged
 * through lib/pi/store's listCases (its limit caps at 100 per page) up to
 * MATCH_CANDIDATE_CAP total. */
async function defaultListCandidates(
    db: Db,
    userId: string,
): Promise<CaseCandidate[]> {
    const out: CaseCandidate[] = [];
    for (const status of ["open", "provisional"] as const) {
        let offset = 0;
        while (out.length < MATCH_CANDIDATE_CAP) {
            const page = await listCases(db, userId, {
                status,
                limit: 100,
                offset,
            });
            for (const c of page) {
                out.push({
                    id: c.id,
                    client_name: c.client_name,
                    client_name_normalized: c.client_name_normalized,
                    case_number: c.case_number,
                    date_of_loss: c.date_of_loss,
                });
            }
            if (page.length < 100) break;
            offset += 100;
        }
    }
    return out.slice(0, MATCH_CANDIDATE_CAP);
}

async function defaultCreateCase(
    db: Db,
    input: PiCaseInsert,
): Promise<{ id: string }> {
    const created = await createCase(db, input);
    return { id: created.id };
}

/**
 * Resolve the case for a claim-correspondence extraction. See the module
 * header for the three-step resolution order. `opts.senderDisplayName` is
 * the fallback client name for a provisional case when the extraction
 * carries none.
 */
export async function matchClaimRun(
    db: Db,
    userId: string,
    extraction: ClaimExtraction,
    thresholds: MatchThresholds,
    opts: { senderDisplayName?: string | null },
    deps: MatchDeps = {},
): Promise<MatchResult> {
    const findByClaim = deps.findCaseIdByClaimNumberFn ?? findCaseIdByClaimNumber;
    const listCandidates = deps.listCandidatesFn ?? defaultListCandidates;
    const create = deps.createCaseFn ?? defaultCreateCase;

    // Step 1: exact claim-number resolution. Every claim number is looked
    // up; ANY disagreement between resolved cases is a human problem.
    const resolvedCaseIds = new Set<string>();
    for (const claim of extraction.claims) {
        const claimNumber = claim.claim_number.value.trim();
        if (!claimNumber) continue;
        const caseId = await findByClaim(db, userId, claimNumber);
        if (caseId) resolvedCaseIds.add(caseId);
    }
    if (resolvedCaseIds.size > 1) {
        return { triage: "multiple claims map to different cases" };
    }
    if (resolvedCaseIds.size === 1) {
        return {
            caseId: [...resolvedCaseIds][0],
            method: "claim_number",
            confidence: 1,
            needsCaseConfirm: false,
        };
    }

    // Step 2: fuzzy client-name matching, per distinct extracted name.
    const names = [
        ...new Set(
            extraction.claims
                .map((c) => c.client_or_insured_name?.value.trim() ?? "")
                .filter(Boolean),
        ),
    ];
    const extractedDol =
        extraction.claims
            .map((c) => c.date_of_loss?.value)
            .find((v) => v && v.trim()) ?? null;

    if (names.length > 0) {
        const candidates = await listCandidates(db, userId);
        const decisions = names
            .map((name) =>
                decideFuzzyMatch(
                    candidates.map((candidate) => ({
                        caseId: candidate.id,
                        score: scoreClientNameMatch(
                            name,
                            candidate,
                            extractedDol,
                        ),
                    })),
                    thresholds,
                ),
            )
            .filter((d): d is NonNullable<typeof d> => d !== null);
        const matchedCaseIds = new Set(decisions.map((d) => d.caseId));
        if (matchedCaseIds.size > 1) {
            return { triage: "multiple claims map to different cases" };
        }
        if (decisions.length > 0) {
            const best = decisions.reduce((a, b) => (b.score > a.score ? b : a));
            return {
                caseId: best.caseId,
                method: "client_name_fuzzy",
                confidence: best.score,
                needsCaseConfirm: best.kind === "confirm",
            };
        }
    }

    // Step 3: provisional case. Deterministic naming only — extracted
    // client name, else the sender's display name; neither → triage
    // (pi_cases.client_name is NOT NULL and we never invent a name).
    const clientName = names[0] ?? opts.senderDisplayName?.trim() ?? "";
    if (!clientName) {
        return { triage: "no client name available for a provisional case" };
    }
    const created = await create(db, {
        userId,
        clientName,
        status: "provisional",
        origin: "auto_created",
        needsReview: true,
        dateOfLoss: toIsoDate(extractedDol),
    });
    return {
        caseId: created.id,
        method: "provisional",
        confidence: 0,
        needsCaseConfirm: false,
    };
}

/**
 * Containment-derived invoice scores are capped this far below match_auto:
 * full token containment ("Jane Doe" appearing in a busy subject) is real
 * signal but WEAK evidence — short/common names fully contain easily — so
 * containment alone may reach at most the confirm band (needsCaseConfirm
 * true, a human validates the case). The AUTO band stays reachable only
 * via a verbatim case-number hit or a genuine full-name Jaccard match on
 * matter_reference at/above match_auto.
 */
export const CONTAINMENT_AUTO_MARGIN = 0.01;

/**
 * Resolve the case for an invoice extraction: fuzzy over matter_reference
 * and client-name tokens in the subject (plus a 1.0 score when a
 * candidate's case_number appears verbatim in either). Containment-only
 * evidence is capped below match_auto (see CONTAINMENT_AUTO_MARGIN).
 * Below match_confirm → triage; invoices NEVER create provisional cases.
 */
export async function matchInvoiceRun(
    db: Db,
    userId: string,
    extraction: InvoiceExtraction,
    thresholds: MatchThresholds,
    opts: { subject: string },
    deps: MatchDeps = {},
): Promise<MatchResult> {
    const listCandidates = deps.listCandidatesFn ?? defaultListCandidates;
    const reference = extraction.matter_reference?.value.trim() ?? "";
    const subject = opts.subject ?? "";
    const containmentCap = Math.max(
        0,
        thresholds.matchAuto - CONTAINMENT_AUTO_MARGIN,
    );

    const candidates = await listCandidates(db, userId);
    const scored = candidates.map((candidate) => {
        const jaccard = reference
            ? scoreClientNameMatch(reference, candidate)
            : 0;
        const containment = Math.max(
            reference
                ? scoreNameInText(reference, candidate.client_name_normalized)
                : 0,
            scoreNameInText(subject, candidate.client_name_normalized),
        );
        let score = Math.max(jaccard, Math.min(containment, containmentCap));
        if (
            caseNumberInText(reference, candidate.case_number) ||
            caseNumberInText(subject, candidate.case_number)
        ) {
            score = 1;
        }
        return { caseId: candidate.id, score };
    });

    const decision = decideFuzzyMatch(scored, thresholds);
    if (!decision) {
        return { triage: "no confident case match for invoice" };
    }
    return {
        caseId: decision.caseId,
        method: "client_name_fuzzy",
        confidence: decision.score,
        needsCaseConfirm: decision.kind === "confirm",
    };
}

/**
 * Reconstruct the MatchResult a staged/re-entered run persisted (case_id +
 * match_method + match_confidence), so the stage step can resume after a
 * crash between match and stage without re-matching. A fuzzy match whose
 * stored confidence sits below match_auto still needs human confirmation.
 */
export function matchFromRun(
    run: Pick<AutomationRun, "case_id" | "match_method" | "match_confidence">,
    thresholds: MatchThresholds,
): Extract<MatchResult, { caseId: string }> | null {
    if (!run.case_id || !run.match_method) return null;
    const method = run.match_method as MatchMethod;
    const confidence = run.match_confidence ?? 0;
    return {
        caseId: run.case_id,
        method,
        confidence,
        needsCaseConfirm:
            method === "client_name_fuzzy" && confidence < thresholds.matchAuto,
    };
}
