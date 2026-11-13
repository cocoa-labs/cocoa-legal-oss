// backend/src/lib/legalIntentRouter.ts
//
// Deterministic chat intent router (Phase 6.1).
//
// Given a free-form chat turn — the user's message, any attachments, and the
// prior history — this proposes the single best-matching registered legal
// capability, or null. Detection is PURELY lexical/structural: there is NO
// LLM call here. It reuses the same phrase-matching primitive
// (countPhraseHits) the playbook key-selector uses (legalCapabilities/
// intent.ts), so the router and the key-selector can never diverge on
// case-handling or substring semantics.
//
// ── The trigger rule (authoritative) ────────────────────────────────────
// For each registered capability we count signal hits from its intentSignals:
//   • keywordHits  = DISTINCT intentSignals.keywords found (case-insensitive
//                    substring) in the user's message text.
//   • docHits      = DISTINCT intentSignals.document_hints found in ANY of:
//                    attachment filenames, the first ~2KB of each attachment's
//                    extracted text, or the attachment's persisted
//                    `documents.document_type` slug.
// A capability FIRES when:  docHits >= 1  OR  keywordHits >= 2.
// (A single document hint is a strong structural signal — an attached lease /
// estoppel; one stray keyword is not enough, so we require two.) The top
// firing capability by score wins; ties break by registration order.
//
// `confidence` is a normalized score in (0,1] that AGREES with the rule: the
// fire threshold maps to ~0.7, so callers can gate on either. The rule above
// is authoritative; confidence is advisory metadata for the UI/telemetry.

import { allCapabilities, runTargetFor } from "./legalCapabilities/index";
import type { LegalCapability } from "./legalCapabilities/types";
import { countPhraseHits } from "./legalCapabilities/intent";

/** Longest slice of an attachment's `extractedText` the router scans. The
 * attachment builder (intentDetection.ts) supplies TITLE LINES, not body
 * prose, so 2 KB is already dozens of headings. This is unrelated to the
 * upload classifier's own 16 KB body-text window (creClassifier.ts
 * SCAN_LIMIT) — the two scan different material. */
const EXTRACTED_TEXT_SCAN_LIMIT = 2048;

/** A capability fires at or above this normalized confidence. Kept in lockstep
 * with the docHits>=1 || keywordHits>=2 rule below. */
export const INTENT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * A lexical-only proposal (no LLM classifier in the loop) may be surfaced to
 * the user only at or above this confidence — which the scoring below reaches
 * ONLY through a structural hit (a typed slug, a filename, or an attachment
 * title line), never through message keywords alone. Keyword co-occurrence is
 * evidence for the classifier to weigh, not grounds to interrupt a lawyer.
 */
export const LEXICAL_ONLY_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Weakest score {@link detectIntentCandidates} reports. 0.4 is what
 * {@link scoreCapability} assigns a single keyword hit — the floor at which a
 * capability has ANY lexical signal at all.
 */
const CANDIDATE_MIN_CONFIDENCE = 0.4;

/**
 * One attachment on the current turn, as much as the router needs to scan.
 * The chat route builds these from the existing doc context (filename +
 * extracted text) plus the persisted `documents.document_type` slug.
 */
export interface IntentAttachment {
    filename?: string | null;
    /** Extracted document text (PDF/DOCX). Only the first ~2KB is scanned. */
    extractedText?: string | null;
    /** The slug stamped by the upload classifier on `documents.document_type`. */
    documentType?: string | null;
    /**
     * The persisted `documents.id` of this attachment, when it resolves to a
     * stored document. Not used for matching (detection stays purely
     * lexical/structural); carried through so a firing proposal can name the
     * document the user just attached and the confirm path opens the review
     * with it already selected.
     */
    documentId?: string | null;
    /**
     * How this document reached the turn. Omitted (or "attached") means the
     * user put it there — a real act of intent. "displayed" means it was
     * merely open in the matter's document panel, which is context, not a
     * request: the orchestrator (intentDetection.ts) shows it to the
     * classifier but excludes it from the trivial-turn test and from the
     * structural fallback, so a document sitting in the panel can never
     * re-propose a chip turn after turn. Detection HERE ignores the field —
     * `detectIntent` / `detectIntentCandidates` scan every attachment.
     */
    origin?: "attached" | "displayed";
}

/** Minimal prior-turn shape. Reserved for future heuristics; the v1 rule is
 * stateless, so history does not currently change the outcome. */
export interface IntentHistoryMessage {
    role: string;
    content: string | null;
}

/** A proposal to run a capability for the current chat turn. */
export interface IntentProposal {
    /** Registry id of the proposed capability (e.g. "cre-review"). */
    capabilityId: string;
    /** Normalized confidence in (0,1] — agrees with the fire threshold. */
    confidence: number;
    /** The capability's confirm_prompt, surfaced verbatim in the UI. */
    confirmPrompt: string;
    /** Inputs to seed the workflow form when the user confirms. */
    prefilledInputs?: Record<string, unknown>;
    /** UUID minted by the orchestrator so a confirm can be tied to the
     * proposal that produced it. Absent on a bare `detectIntent` result. */
    proposalId?: string;
    /** The capability's title. */
    title?: string;
    /** The capability's `intentSignals.run_label` — fixed per capability,
     * never model-authored. */
    runLabel?: string;
    /** Where a confirmed run executes (see `runTargetFor`). */
    runTarget?: "chat" | "modal";
    /** Which layer produced this proposal. */
    source?: "llm" | "lexical";
    /** Inputs the chip must collect before the run can start. */
    intake?: ("represented_party")[];
}

/** One capability with a lexical signal on this turn, with its raw counts. */
export interface IntentCandidate {
    capabilityId: string;
    confidence: number;
    keywordHits: number;
    docHits: number;
}

/**
 * Build the document-hint haystack set for a turn: every filename, the first
 * ~2KB of every extracted text, and every document_type slug. Shared by
 * `detectIntent` and `detectIntentCandidates` so the two can never scan
 * different material.
 */
function buildAttachmentHaystacks(
    attachments: readonly IntentAttachment[],
): string[] {
    const haystacks: string[] = [];
    for (const a of attachments) {
        if (a.filename) haystacks.push(a.filename);
        if (a.extractedText)
            haystacks.push(a.extractedText.slice(0, EXTRACTED_TEXT_SCAN_LIMIT));
        if (a.documentType) haystacks.push(a.documentType);
    }
    return haystacks;
}

/**
 * Score one capability for the current turn. Returns the raw hit counts plus
 * a normalized confidence; the caller applies the fire rule + picks the top.
 */
function scoreCapability(
    keywords: readonly string[],
    documentHints: readonly string[],
    messageText: string,
    attachmentHaystacks: readonly string[],
): { keywordHits: number; docHits: number; confidence: number } {
    const keywordHits = countPhraseHits(keywords, [messageText]);
    const docHits = countPhraseHits(documentHints, attachmentHaystacks);

    // Normalize so the fire boundary lands at the threshold:
    //   • a single document hit is a strong signal → 0.85
    //   • two keyword hits → 0.7 (exactly the threshold), each extra +0.1
    //   • a document hit dominates and stacks lightly with keywords
    // Capped at 1. A capability that does not fire scores below threshold.
    let confidence = 0;
    if (docHits >= 1) {
        confidence = Math.min(1, 0.85 + 0.05 * (docHits - 1) + 0.05 * keywordHits);
    } else if (keywordHits >= 2) {
        confidence = Math.min(1, 0.7 + 0.1 * (keywordHits - 2));
    } else if (keywordHits === 1) {
        // Below threshold on purpose — one stray keyword must not fire.
        confidence = 0.4;
    }
    return { keywordHits, docHits, confidence };
}

/**
 * Detect the best-matching capability for a chat turn, or null.
 *
 * Deterministic and side-effect free. `history` is accepted to fix the public
 * signature (message, attachments, history) but does not affect the v1 rule.
 */
export function detectIntent(
    message: string | null | undefined,
    attachments: readonly IntentAttachment[] | null | undefined,
    history?: readonly IntentHistoryMessage[] | null,
): IntentProposal | null {
    void history; // reserved; v1 detection is stateless.

    const messageText = message ?? "";
    const atts = attachments ?? [];
    const attachmentHaystacks = buildAttachmentHaystacks(atts);

    let best: { cap: ReturnType<typeof allCapabilities>[number]; confidence: number } | null =
        null;

    for (const cap of allCapabilities()) {
        const { keywords, document_hints } = cap.intentSignals;
        const { keywordHits, docHits, confidence } = scoreCapability(
            keywords,
            document_hints,
            messageText,
            attachmentHaystacks,
        );

        const fires = docHits >= 1 || keywordHits >= 2;
        if (!fires) continue;

        // Tie-break by registration order: only replace on a STRICTLY higher
        // confidence, so the first-registered capability wins a tie.
        if (!best || confidence > best.confidence) {
            best = { cap, confidence };
        }
    }

    if (!best || best.confidence < INTENT_CONFIDENCE_THRESHOLD) return null;

    // Carry the ids of the documents the user attached on this turn so the
    // confirm path can open the review with the document(s) already selected.
    // Distinct, order-preserving; detection above is unaffected — this only
    // shapes the prefill metadata for a proposal that already fired.
    const documentIds = [
        ...new Set(
            atts
                .map((a) => a.documentId)
                .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
    ];

    return {
        capabilityId: best.cap.id,
        confidence: best.confidence,
        confirmPrompt: best.cap.intentSignals.confirm_prompt,
        ...(documentIds.length > 0
            ? { prefilledInputs: { documentIds } }
            : {}),
    };
}

/**
 * Every registered capability with ANY lexical signal on this turn
 * (confidence >= 0.4), highest confidence first; ties keep registration order
 * (Array.prototype.sort is stable). Pure — no LLM, no I/O.
 *
 * This is the "lexical proposes" half of detection: the caller hands the
 * shortlist to the classifier, which disposes. It deliberately reports
 * capabilities far below the firing bar, because a weak lexical signal is
 * still useful evidence for a model that can read the whole turn.
 */
export function detectIntentCandidates(
    message: string | null | undefined,
    attachments: readonly IntentAttachment[] | null | undefined,
): IntentCandidate[] {
    const messageText = message ?? "";
    const attachmentHaystacks = buildAttachmentHaystacks(attachments ?? []);

    const candidates: IntentCandidate[] = [];
    for (const cap of allCapabilities()) {
        const { keywords, document_hints } = cap.intentSignals;
        const { keywordHits, docHits, confidence } = scoreCapability(
            keywords,
            document_hints,
            messageText,
            attachmentHaystacks,
        );
        if (confidence < CANDIDATE_MIN_CONFIDENCE) continue;
        candidates.push({
            capabilityId: cap.id,
            confidence,
            keywordHits,
            docHits,
        });
    }

    return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * The registry-owned presentation metadata for a proposal: what the chip is
 * called, what its button says, where a confirmed run goes, and what it must
 * collect first. All of it comes from the capability declaration — none of it
 * is ever model-authored.
 */
export function describeProposalCapability(cap: LegalCapability): {
    title: string;
    runLabel: string;
    runTarget: "chat" | "modal" | null;
    intake?: ("represented_party")[];
} {
    return {
        title: cap.title,
        runLabel: cap.intentSignals.run_label,
        runTarget: runTargetFor(cap),
        ...(cap.intake ? { intake: cap.intake } : {}),
    };
}
