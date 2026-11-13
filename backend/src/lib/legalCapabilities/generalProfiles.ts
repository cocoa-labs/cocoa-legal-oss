// backend/src/lib/legalCapabilities/generalProfiles.ts
//
// General (non-practice-specific) capability shared constants.
//
// This module is the SINGLE backend source of truth for the playbook-key
// set and document-hint vocabulary of the four general capabilities:
// compliance-check, legal-risk-assessment, triage-nda and review-contract.
// The four capability modules and the capability↔seed guard test
// (generalCapabilities.test.ts) all import from here, so the key set and
// the hint vocabulary can never drift across call sites — the same pattern
// creProfiles.ts and piProfiles.ts follow.
//
// Every key listed in GENERAL_PLAYBOOK_KEYS MUST be seeded by
// 042_general_capabilities.sql, and the migration MUST NOT seed a general
// key that is not listed here; the guard test reads the SQL file and
// asserts both directions.

/**
 * The canonical playbook-key set the four general capabilities read.
 * Each capability's `playbookKeys` is one of the per-capability subsets
 * below, and the union of those subsets is exactly this list.
 *
 * NOTE: the shared, cross-capability `risk.escalation_thresholds` key is
 * intentionally NOT in this array — it is seeded by 009 (with ON CONFLICT
 * DO NOTHING so no later migration clobbers a firm-tuned value) and is
 * exported separately as SHARED_RISK_KEY.
 */
export const GENERAL_PLAYBOOK_KEYS = [
    // compliance-check
    "compliance.regulation_reference",
    "compliance.dpa_standard_positions",
    "compliance.dsr_response_timelines",
    "compliance.escalation_criteria",
    "compliance.escalation.notification_template",
    // legal-risk-assessment
    "risk.severity_likelihood_matrix",
    "risk.band_actions",
    "risk.outside_counsel_criteria",
    "risk.escalation.notification_template",
    // triage-nda
    "nda.standard_positions",
    "nda.screening_criteria",
    "nda.classification_rules",
    "nda.term_limits",
    "nda.routing_rules",
    "nda.escalation.notification_template",
    // review-contract
    "contract.standard_positions",
    "contract.clause_review_checklist",
    "contract.deviation_tiers",
    "contract.negotiation_priority_framework",
    "contract.escalation.notification_template",
] as const;

/**
 * The shared escalation-threshold key seeded by 009_cre_playbook_seed.sql.
 * legal-risk-assessment declares it (its bands ARE the thresholds the rest
 * of the suite escalates on) but does not inline it as a placeholder, so
 * the guard test whitelists it in the "declared but unreferenced" check.
 */
export const SHARED_RISK_KEY = "risk.escalation_thresholds";

/** compliance-check's playbook keys — every one is inlined by its prompts. */
export const COMPLIANCE_PROMPT_KEYS = [
    "compliance.regulation_reference",
    "compliance.dpa_standard_positions",
    "compliance.dsr_response_timelines",
    "compliance.escalation_criteria",
    "compliance.escalation.notification_template",
] as const;

/**
 * legal-risk-assessment's playbook keys. SHARED_RISK_KEY is declared here
 * so the firm's escalation thresholds resolve alongside the band actions.
 */
export const RISK_PROMPT_KEYS = [
    "risk.severity_likelihood_matrix",
    "risk.band_actions",
    "risk.outside_counsel_criteria",
    SHARED_RISK_KEY,
    "risk.escalation.notification_template",
] as const;

/** triage-nda's playbook keys — every one is inlined by its prompts. */
export const NDA_PROMPT_KEYS = [
    "nda.standard_positions",
    "nda.screening_criteria",
    "nda.classification_rules",
    "nda.term_limits",
    "nda.routing_rules",
    "nda.escalation.notification_template",
] as const;

/** review-contract's playbook keys — every one is inlined by its prompts. */
export const CONTRACT_PROMPT_KEYS = [
    "contract.standard_positions",
    "contract.clause_review_checklist",
    "contract.deviation_tiers",
    "contract.negotiation_priority_framework",
    "contract.escalation.notification_template",
] as const;

// ---------------------------------------------------------------------------
// Document hints.
//
// Keep every entry lowercased — consumers match against lowercased haystacks
// (message text / filename / extracted body text). Document hints are
// STRUCTURAL signals that can fire a suggestion chip on their own, so each
// one must be a specific document-type phrase: a bare "agreement",
// "contract", "license", "lease" or "policy" would fire on almost any legal
// document and is exactly the false positive this suite exists to avoid.
// ---------------------------------------------------------------------------

/** Privacy/compliance document types. */
export const COMPLIANCE_DOCUMENT_HINTS = [
    "data processing agreement",
    "dpa",
    "privacy policy",
    "privacy notice",
    "dpia",
    "compliance checklist",
] as const;

/** Risk-workproduct document types. */
export const RISK_DOCUMENT_HINTS = [
    "risk register",
    "risk assessment",
    "risk memo",
] as const;

/** NDA document types. */
export const NDA_DOCUMENT_HINTS = [
    "nda",
    "non-disclosure",
    "nondisclosure",
    "confidentiality agreement",
    "mutual confidentiality",
    "confidential disclosure",
] as const;

/** Commercial-agreement document types (never bare "agreement"). */
export const CONTRACT_DOCUMENT_HINTS = [
    "master services agreement",
    "msa",
    "services agreement",
    "saas agreement",
    "license agreement",
    "licence agreement",
    "supply agreement",
    "vendor agreement",
    "consulting agreement",
    "subscription agreement",
    "statement of work",
    "sow",
    "terms of service",
] as const;
