// backend/src/lib/legalCapabilities/piProfiles.ts
//
// PI (Personal Injury) practice-mode shared constants.
//
// This module is the SINGLE backend source of truth for the Personal Injury
// playbook-key set and document-hint vocabulary. The two capability modules
// (piClaimsTriage.ts, piInvoiceProcessing.ts), the upload classifier
// (piClassifier.ts), and the capability↔seed guard test
// (personalInjury.test.ts) all import the shared constants here so the
// hint vocabulary and the key set never drift across the call sites —
// mirroring creProfiles.ts exactly.
//
// Unlike CRE (whose two capabilities read the identical full key set), the
// PI capabilities each read a SUBSET of the canonical keys: the claims
// module inlines the claims prompt keys, the invoice module inlines the
// invoice prompt keys, and the remaining keys (carrier/vendor registries,
// reply-to, confidence thresholds, matching rules) are configuration the
// phase-4 automation pipeline reads directly from the playbook — they are
// seeded by the same migration but never inlined into a prompt.

/**
 * The canonical pi.* playbook-key set. Every key listed here MUST be seeded
 * by 024_pi_playbook_seed.sql, and every pi.* key any PI capability or
 * builtin workflow references MUST appear in this list. The capability↔seed
 * guard test (personalInjury.test.ts) reads the migration file and asserts
 * both directions, so adding a key here without seeding it — or seeding a
 * key not listed here — is caught in CI.
 */
export const PI_PLAYBOOK_KEYS = [
    "pi.claims.carrier_registry",
    "pi.claims.extraction_guidance",
    "pi.claims.ack_template",
    "pi.claims.reply_to",
    "pi.claims.signature_block",
    "pi.invoices.vendor_registry",
    "pi.invoices.extraction_guidance",
    "pi.invoices.expense_approval_threshold",
    "pi.automation.confidence_thresholds",
    "pi.cases.matching_rules",
] as const;

/**
 * The subset of PI_PLAYBOOK_KEYS the claims-triage capability inlines into
 * its prompts via `{{playbook:...}}` placeholders. The capability's
 * playbookKeys MUST equal this array (guard-tested) — the substitution
 * machinery only resolves declared keys.
 */
export const PI_CLAIMS_PROMPT_KEYS = [
    "pi.claims.extraction_guidance",
    "pi.claims.ack_template",
    "pi.claims.signature_block",
] as const;

/**
 * The subset of PI_PLAYBOOK_KEYS the invoice-processing capability inlines
 * into its prompts. Same lockstep rule as PI_CLAIMS_PROMPT_KEYS.
 */
export const PI_INVOICE_PROMPT_KEYS = [
    "pi.invoices.extraction_guidance",
    "pi.invoices.expense_approval_threshold",
] as const;

/**
 * Lowercased document-hint phrases shared by both PI capabilities'
 * intentSignals and the upload classifier (piClassifier.ts). Keep every
 * entry lowercased — all consumers match against lowercased haystacks
 * (message text / filename / extracted body text / document_type slug).
 * Ordering here is not significant; the classifier applies its own
 * specific-before-generic ordering. Short single-token entries ("uim") are
 * boundary-matched by the shared matcher in intent.ts, so they cannot fire
 * inside unrelated words.
 */
export const PI_DOCUMENT_HINTS = [
    "declaration page",
    "dec page",
    "policy limits",
    "policy limit demand",
    "claim number",
    "letter of representation",
    "uim",
    "um/uim",
    "bodily injury",
    "invoice",
    "legal funding",
    "chartexample",
    "samplerecords",
    "medical records invoice",
] as const;
