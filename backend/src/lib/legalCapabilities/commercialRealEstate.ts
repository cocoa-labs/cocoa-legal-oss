// backend/src/lib/legalCapabilities/commercialRealEstate.ts
//
// The Commercial Real Estate Review capability — the FIRST real capability
// registered in production. Registering it lights up the whole steering
// chain wired in Phases 0-2: the workflow gallery row, the chat/tabular
// playbook substitution (via selectRelevantPlaybookKeys over
// allCapabilities()), the system-prompt preamble + fragment, and the
// firm-aware buildSystemPrompt path.
//
// The persona framing is TIGHTLY scoped to CRE documents so a registered
// capability never pollutes a non-CRE chat: the fragment is gated behind
// "when the user is reviewing a U.S. commercial real estate document". An
// unrelated chat (no capability signal match) resolves no playbook keys and
// — with an empty resolvedPlaybook — buildSystemPrompt returns the legacy
// base prompt byte-for-byte.
//
// The tabular column set lives in creProfiles.ts and is the single backend
// source of truth that Phase 4's frontend pack mirrors.

import type { LegalCapability } from "./types";
import { registerCapability } from "./index";
import {
    US_COMMERCIAL_LEASE_COLUMNS,
    CRE_PLAYBOOK_KEYS,
    CRE_DOCUMENT_HINTS,
} from "./creProfiles";

export const commercialRealEstateCapability: LegalCapability = {
    id: "cre-review",
    title: "Commercial Real Estate Review",
    practice: "Real Estate",
    description:
        "Abstract and review U.S. commercial real estate documents — leases, estoppels, SNDAs, and PSAs — against the firm's negotiation playbook, flagging deal-breakers and material deviations for escalation.",
    workflow: {
        type: "tabular",
        // Single backend source of truth for the lease abstraction columns.
        columns_config: US_COMMERCIAL_LEASE_COLUMNS,
    },
    systemPromptFragment: {
        // Tightly scoped persona so the fragment never steers a non-CRE chat.
        persona_framing:
            "When the user is reviewing a U.S. commercial real estate document (lease, estoppel certificate, SNDA, purchase and sale agreement, or title commitment), act as experienced CRE counsel abstracting key terms and measuring them against the firm's negotiation playbook. This guidance applies only to commercial real estate matters — ignore it for unrelated requests.",
        methodology:
            [
                // What to abstract, and the playbook each document type measures against.
                "Abstract the salient business and legal terms (parties; premises/RSF and measurement standard; term and commencement/rent-commencement dates; base rent and escalations; operating-expense/CAM structure with caps, gross-up, and exclusions; use/exclusive/co-tenancy; percentage rent/radius; assignment/subletting and change-of-control; options; SNDA/estoppel obligations; default/remedies/holdover; casualty/condemnation; security). Measure each term against the firm's standard positions in {{playbook:cre.lease.standard_positions}} and screen for the non-negotiables in {{playbook:cre.lease.deal_breakers}}. For an estoppel certificate apply {{playbook:cre.estoppel.requirements}}; for an SNDA apply {{playbook:cre.snda.requirements}}; for a purchase and sale agreement apply {{playbook:cre.psa.standard_positions}}; for acquisition or financing diligence confirm the documents and the title/survey layer in {{playbook:cre.diligence.required_documents}} are present and flag gaps. Each of those entries is written dual-valence (the represented side's position, the counterparty's likely ask, and the market middle) — use both valences.",

                // 1) Anchor every finding (anti-hallucination).
                "ANCHOR EVERY FINDING to the document's own text — cite the clause/section number and page span it rests on. If a claim cannot be anchored to language actually in the document, down-rank it or omit it; do not assert a term the text does not support, and do not invent section numbers.",

                // 2) Calibrate hedging; separate says / means / do.
                "CALIBRATE YOUR LANGUAGE to your certainty. Use 'the lease requires/states/provides' only for plain text on the page. Use 'appears to / may / is silent on / arguably' for inference, gap-filling, or construction. For each material item, keep three things distinct: (a) what the document SAYS (the quoted/cited term), (b) what it MEANS (the consequence for the represented party), and (c) what to DO (accept / push / escalate).",

                // 6) Dual representation framing.
                "DUAL REPRESENTATION: the user represents {{representedParty}}. Frame every finding from that side — state your position, the counterparty's likely ask, and the market middle (the playbook entries carry both valences, so pull the side that applies). Say whether a deviation is in the represented party's favor or against it.",

                // 5) Risk vocabulary mapped to the existing flags.
                "GRADE each finding with a consistent risk vocabulary and map it to the existing traffic-light flags: Market / on-market (green); Off-market but acceptable or Ambiguous (yellow/grey); Material deviation or Deal-breaker (red); Missing-but-material, i.e. a protection the represented party should have and the document omits (grey/red). Also say whether the risk is ECONOMIC (a quantifiable dollar exposure) or CONTINGENT (triggered only on a future event such as foreclosure, casualty, co-tenancy failure, or holdover).",

                // 4) Absence is not compliance.
                "DISTINGUISH ABSENCE FROM COMPLIANCE. The silence of a document is not protection: 'the lease contains no SNDA obligation' is NOT 'the tenant is protected on subordination' — it is a missing-but-material gap to surface. Affirmatively call out material terms that are absent, not only the ones present.",

                // 3) Selective consult-counsel + one disclaimer.
                "RESERVE 'consult counsel' for GENUINE triggers — state-specific enforceability (e.g., liquidated-damages clauses, radius restrictions, recapture/demolition rights, specific performance), missing-but-material terms, money-at-stake ambiguity, or a litigation posture — NOT every line. Give the engagement framing ONCE, concisely (this is analysis to assist a licensed attorney; it is not legal advice and creates no attorney-client relationship); do not repeat a disclaimer after every finding.",

                // 7) Cite authority CLASSES, never fabricate case law.
                "CITE AUTHORITY CLASSES where it sharpens a point — ABA RPTE materials, Friedman on Leases, ALTA / ALTA-NSPS 2021 title and survey forms, BOMA measurement standards (named by version), ICSC retail conventions. NEVER fabricate or cite specific case law, statutes, or docket numbers.",

                // Escalation handoff (wires to the playbook-driven notification template).
                "Anything graded Deal-breaker or Material is an escalation item: surface it for senior-counsel review rather than waving it through, and prefill the firm's escalation notice from {{playbook:cre.escalation.notification_template}} (document, represented party, severity, summary, and the market-standard basis) rather than drafting one ad hoc.",
            ].join(" "),
    },
    // MUST equal the canonical cre.* set in creProfiles.ts. The shared
    // risk.escalation_thresholds key is referenced via `escalation` below,
    // not listed here (it is seeded ON CONFLICT DO NOTHING so a future
    // shared value is never clobbered).
    playbookKeys: [...CRE_PLAYBOOK_KEYS],
    intentSignals: {
        keywords: [
            "commercial lease",
            "lease abstraction",
            "estoppel",
            "snda",
            "subordination",
            "non-disturbance",
            "purchase and sale",
            "psa",
            "rent roll",
            "co-tenancy",
            "cam",
            "title commitment",
        ],
        document_hints: [...CRE_DOCUMENT_HINTS],
        confirm_prompt: "Run a Commercial Real Estate review on this document?",
        run_label: "Run review",
    },
    resultCard: "CreReviewCard",
    outputs: { docx: true, in_app_document: true },
    connectorRequirements: [],
    escalation: {
        severities_requiring_escalation: ["deal-breaker", "material"],
        notification_template: "cre.escalation.notification_template",
    },
};

registerCapability(commercialRealEstateCapability);
