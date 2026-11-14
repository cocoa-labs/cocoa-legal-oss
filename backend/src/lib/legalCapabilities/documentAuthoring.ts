// backend/src/lib/legalCapabilities/documentAuthoring.ts
//
// The Commercial Real Estate Authoring capability — the DRAFTING half of
// the CRE suite. Where commercialRealEstate.ts REVIEWS an inbound document
// against the playbook, this capability DRAFTS a new CRE instrument (lease,
// PSA, LOI, estoppel, SNDA, amendment) from a reusable template via guided,
// variable-driven assembly.
//
// It reuses the EXISTING cre.* playbook-key set verbatim (no new keys), so
// it introduces no capability↔seed drift: every key it reads is already
// seeded by 009_cre_playbook_seed.sql and listed in CRE_PLAYBOOK_KEYS. The
// guard test (documentAuthoring.test.ts) pins that invariant on this side.
//
// Like every capability, the persona framing is tightly scoped — here, to
// the case where the user wants to DRAFT/CREATE a CRE document — so a
// registered capability never steers an unrelated chat. With no firm
// context (empty resolvedPlaybook) buildSystemPrompt returns the legacy
// base prompt byte-for-byte regardless of what is registered; the
// authoring fragment only surfaces on the firm-aware path.

import type { LegalCapability } from "./types";
import { registerCapability } from "./index";
import { CRE_PLAYBOOK_KEYS, CRE_DOCUMENT_HINTS } from "./creProfiles";

export const documentAuthoringCapability: LegalCapability = {
    id: "cre-authoring",
    title: "Commercial Real Estate Drafting",
    practice: "Real Estate",
    description:
        "Draft U.S. commercial real estate documents — leases, purchase and sale agreements, LOIs, estoppels, SNDAs, and amendments — from reusable firm templates through guided, variable-driven assembly.",
    workflow: {
        type: "assistant",
        prompt_md: [
            "You are drafting a U.S. commercial real estate document. Prefer template-anchored assembly: if a suitable template exists, collect the required variables and call assemble_document; if none exists, call generate_template first, then assemble from it.",
            "Expand any open clauses using the firm's standard positions in {{playbook:cre.lease.standard_positions}}, and avoid the non-negotiables in {{playbook:cre.lease.deal_breakers}}. For an estoppel apply {{playbook:cre.estoppel.requirements}}; for an SNDA apply {{playbook:cre.snda.requirements}}; for a purchase and sale agreement apply {{playbook:cre.psa.standard_positions}}.",
            "Keep clause numbering automatic from 1 (never 0). End any contract with an unnumbered signature block on its own page, using 0-based {{cocoa-sign:N}} anchors. Assembled documents are produced as approval-gated drafts; refine them with edit_document (tracked changes) rather than regenerating.",
        ].join(" "),
    },
    systemPromptFragment: {
        // Scoped to DRAFTING so the fragment never steers a review or an
        // unrelated chat.
        persona_framing:
            "When the user wants to DRAFT or CREATE a U.S. commercial real estate document (lease, purchase and sale agreement, letter of intent, estoppel certificate, SNDA, or amendment), act as CRE drafting counsel assembling the instrument from the firm's reusable templates. This guidance applies only when the user is authoring a commercial real estate document — ignore it for review or unrelated requests.",
        methodology: [
            // Template-anchored assembly is the preferred drafting path.
            "Prefer TEMPLATE-ANCHORED ASSEMBLY over single-pass generation: if a suitable template exists for the requested document type, collect the required variables from the user (and from any provided source documents) and call assemble_document with those variables; if no suitable template exists, call generate_template first to create one, then assemble from it.",

            // Approval gating + QA expectations.
            "Assembled documents are produced as approval-gated DRAFTS, not send-ready instruments. Each runs through a four-point QA pass (defined-term & cross-reference integrity, playbook compliance, jurisdiction-appropriate language, and legal-research grounding); surface any blocking findings to the user and do not treat a blocked draft as final or send-ready.",

            // Firm steering when expanding open clauses.
            "When expanding open clauses, use the firm's standard positions in {{playbook:cre.lease.standard_positions}} and steer clear of the non-negotiables in {{playbook:cre.lease.deal_breakers}}. Apply the document-type playbook where one fits — {{playbook:cre.estoppel.requirements}} for an estoppel, {{playbook:cre.snda.requirements}} for an SNDA, {{playbook:cre.psa.standard_positions}} for a purchase and sale agreement.",

            // Numbering + signature-block discipline (mirrors the base DOCX rules).
            "Keep clause numbering automatic and starting from 1 (never 0). End any contract with an unnumbered signature block on its own page, using 0-based {{cocoa-sign:N}} anchors (the first party's block uses {{cocoa-sign:0}}). Refine an assembled draft with edit_document (tracked changes); never regenerate the whole document to make a change.",
        ].join(" "),
    },
    // Reuse the canonical cre.* set verbatim — NO new playbook keys, so no
    // seed-guard violation. Already seeded by 009_cre_playbook_seed.sql.
    playbookKeys: [...CRE_PLAYBOOK_KEYS],
    intentSignals: {
        keywords: [
            "draft a lease",
            "create a lease",
            "draft an loi",
            "draft a letter of intent",
            "generate a psa",
            "draft a psa",
            "new estoppel",
            "prepare an snda",
            "draft amendment",
            "create a contract",
            "draft a purchase and sale",
        ],
        document_hints: [...CRE_DOCUMENT_HINTS],
        confirm_prompt:
            "Draft this commercial real estate document from a template?",
        run_label: "Draft document",
    },
    resultCard: "AuthoringCard",
    outputs: { docx: true, in_app_document: true },
    connectorRequirements: [],
};

registerCapability(documentAuthoringCapability);
