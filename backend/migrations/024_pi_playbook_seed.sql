-- Migration 024: Personal Injury playbook seed.
--
-- Seeds the `default-shared` firm playbook with sensible public defaults for
-- every pi.* key the Personal Injury capabilities and the phase-4 email
-- automation pipeline read (see backend/src/lib/legalCapabilities/piProfiles.ts
-- PI_PLAYBOOK_KEYS — the capability↔seed guard test reads this file and
-- asserts the two stay in lockstep, in both directions). Every firm inherits
-- these via getEffectivePlaybookEntries' default-shared fallback until it
-- sets its own override for a key.
--
-- Two kinds of entries live here:
--   • PROMPT keys ({{playbook:...}}-inlined by the capabilities/builtins):
--     pi.claims.extraction_guidance / ack_template / signature_block and
--     pi.invoices.extraction_guidance / expense_approval_threshold.
--   • AUTOMATION configuration the phase-4 pipeline reads directly:
--     pi.claims.carrier_registry / reply_to, pi.invoices.vendor_registry,
--     pi.automation.confidence_thresholds, pi.cases.matching_rules. The
--     carrier/vendor registries drive deterministic inbound-email
--     classification; the registries shipped here are public defaults the
--     firm extends via the playbook UI.
--
-- Every pi.* key uses ON CONFLICT DO UPDATE so re-running this migration
-- keeps the shipped defaults current. Entries a firm is EXPECTED to override
-- before enabling automation sends (reply_to, signature_block, portal URLs)
-- say so in notes_md.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook only
-- inspects migrations — it never auto-applies). Idempotent / re-runnable.

do $$
declare
  default_firm text := 'default-shared';
  pb_id uuid;
begin
  insert into public.firm_playbooks (firm_id, updated_by)
  values (default_firm, 'migration')
  on conflict (firm_id) do update set updated_at = now()
  returning id into pb_id;

  -- pi.claims.carrier_registry ---------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.claims.carrier_registry',
      $val$[
        {"name": "Example Mutual", "domains": ["examplemutual.test", "email.examplemutual.test"], "subject_patterns": ["claim", "policy"]},
        {"name": "Sample Casualty", "domains": ["samplecasualty.test"], "subject_patterns": ["claim", "policy"]},
        {"name": "Demo Auto", "domains": ["demoauto.test", "demoautoinsurance.test"], "subject_patterns": ["claim", "policy"]},
        {"name": "Placeholder General Insurance", "domains": ["placeholdergeneral.test"], "subject_patterns": ["claim", "policy"]},
        {"name": "Fixture Indemnity", "domains": ["fixtureindemnity.test"], "subject_patterns": ["claim", "policy"]},
        {"name": "Test Underwriters", "domains": ["testunderwriters.test"], "subject_patterns": ["claim", "policy"]}
      ]$val$::jsonb,
      'Carrier registry driving deterministic classification of inbound claim correspondence (sender domain first, subject patterns as the secondary signal). Shipped with sensible public defaults — the firm is expected to EXTEND/OVERRIDE this list via the playbook UI with the carriers it actually sees.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.claims.extraction_guidance ------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.claims.extraction_guidance',
      to_jsonb($val$Claim-correspondence extraction — field definitions:
- Claim number: formats VARY BY CARRIER — alphanumeric, often with hyphens or letter prefixes (e.g. 24-1234567, XX-12345-01, AB123456789). Preserve EXACTLY as written, character by character; never strip leading zeros, hyphens, prefixes, or spacing. A single letter may carry multiple claim numbers (one per coverage or claimant) — capture each and note which coverage it attaches to.
- Policy number: distinct from the claim number; preserve exactly as written.
- Policy limits: commonly stated per-person / per-accident in thousands (e.g. "25/50" means $25,000 per person / $50,000 per accident) or as a single combined single limit (CSL). Record the limits as stated AND the normalized dollar reading; if limits are not stated, record "not stated" — never infer a limit from the coverage type or state minimums.
- Coverage type: BI (bodily injury), PD (property damage), UM (uninsured motorist), UIM (underinsured motorist), MedPay/PIP. A dec page typically lists several — capture each row.
- Adjuster: name, email, phone, and any direct extension; note the assigned department if no individual is named.
- Date of loss: the accident/incident date, not the letter date; record both when both appear.
- Never infer unstated values: an absent field is "not stated" and should be surfaced as a gap, not filled.$val$::text),
      'Field definitions inlined into the claims-triage prompts via {{playbook:pi.claims.extraction_guidance}}. Defaults reflect common US auto-carrier conventions; the firm can sharpen formats per carrier via the playbook UI.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.claims.ack_template --------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.claims.ack_template',
      to_jsonb($val$RE: Claim No. {{claim_number}} — {{client_name}}

To the claims team at {{carrier}}:

We confirm receipt of your correspondence regarding the above-referenced claim. This office represents {{client_name}} in connection with this matter; any adjuster contact {{adjuster_name}} identified in your correspondence has been noted in our file.

Your correspondence is under review, and we will respond substantively in due course. In the meantime, please direct all future correspondence regarding this matter to this office, and reference claim number {{claim_number}} in all communications.

This acknowledgement is sent for administrative purposes only; nothing in it constitutes an admission, a waiver of any right or defense, or a position on coverage, liability, or damages, all of which are expressly reserved.$val$::text),
      'Acknowledgement email body inlined via {{playbook:pi.claims.ack_template}}. Placeholders ({{claim_number}}, {{carrier}}, {{client_name}}, {{adjuster_name}}) are filled from the extracted claim facts at draft time; an unreliable/missing adjuster name renders as an empty string, so the template deliberately uses a neutral salutation and mentions the adjuster only mid-sentence where its absence still reads naturally (never "Dear ,"). Deliberately neutral — no admissions, no legal positions. Drafts are ALWAYS human-approved before sending. Override-expected: firms typically tailor the tone and letterhead conventions.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.claims.reply_to ------------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.claims.reply_to',
      to_jsonb(''::text),
      'OVERRIDE REQUIRED: set to the firm''s handling paralegal/attorney address before enabling automation sends. While empty, acknowledgement drafts carry no Reply-To and outbound automation must not be enabled.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.claims.signature_block -----------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.claims.signature_block',
      to_jsonb($val$Sincerely,

[Firm Name]
Sent on behalf of the firm by its legal operations assistant
[Firm Address] | [Firm Phone]$val$::text),
      'Signature block appended to acknowledgement drafts via {{playbook:pi.claims.signature_block}}. OVERRIDE EXPECTED: replace the bracketed placeholders with the firm''s actual name, address, and phone before enabling sends.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.invoices.vendor_registry ---------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.invoices.vendor_registry',
      $val$[
        {"name": "Example Case Funding", "domains": ["examplecasefunding.test"], "category": "policy_limits_invoice", "portal_url": ""},
        {"name": "ECF Legal Funding", "domains": ["examplecasefunding.test"], "category": "legal_funding", "portal_url": ""},
        {"name": "SampleRecords", "domains": ["samplerecords.test"], "category": "records_invoice", "portal_url": ""},
        {"name": "ChartExample", "domains": ["chartexample.test"], "category": "records_invoice", "portal_url": ""}
      ]$val$::jsonb,
      'Vendor registry driving deterministic classification of inbound invoices (sender domain → vendor → category). portal_url is OVERRIDE-EXPECTED: set each vendor''s payment-portal URL so staged expenses can link to where the human actually pays. Extend with the firm''s own vendors via the playbook UI.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.invoices.extraction_guidance -----------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.invoices.extraction_guidance',
      to_jsonb($val$Invoice extraction — field definitions:
- Invoice number: common formats include INV-###### and FC-#####, but formats vary by vendor — preserve EXACTLY as printed, including prefixes, hyphens, and leading zeros.
- Amount: the TOTAL DUE (balance / amount due), not a line item or subtotal. When an invoice shows line items, a subtotal, and a balance, extract the balance and state which figure was used.
- Invoice date: the issue date printed on the invoice; capture any due date separately if stated.
- Matter reference: the client name and/or case number, typically in the email subject, the invoice reference/RE field, or the body. Capture the reference verbatim and say where it appeared.
- Vendor: the issuing entity as printed on the invoice (which may differ from the sending email domain — capture both when they differ).
- Never infer unstated values: an absent invoice number, date, or amount is "not stated" and should be surfaced as a gap, not filled.$val$::text),
      'Field definitions inlined into the invoice-processing prompts via {{playbook:pi.invoices.extraction_guidance}}. Defaults cover the shipped vendor registry''s conventions; sharpen per-vendor formats via the playbook UI.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.invoices.expense_approval_threshold ----------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.invoices.expense_approval_threshold',
      jsonb_build_object('flag_above_usd', 2500),
      'Invoices above flag_above_usd are flagged prominently for elevated approval (inlined via {{playbook:pi.invoices.expense_approval_threshold}}). Every expense still goes through human approval; the threshold only changes the flag''s prominence. Adjust to the firm''s approval policy via the playbook UI.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.automation.confidence_thresholds -------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.automation.confidence_thresholds',
      jsonb_build_object(
        'extraction_min', 0.75,
        'field_min', 0.7,
        'match_auto', 0.95,
        'match_confirm', 0.8
      ),
      'Confidence gates for the email-automation pipeline: extraction_min is the overall extraction floor below which a run routes to triage; field_min is the per-field floor below which a field is treated as unreliable; match_auto is the case-match score at or above which a match is accepted automatically; match_confirm is the score at or above which a match is proposed for human confirmation (below it, the run routes to manual matching). Tune conservatively via the playbook UI.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- pi.cases.matching_rules --------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'pi.cases.matching_rules',
      jsonb_build_object('min_score', 0.85),
      'Case-matching rules for the automation pipeline: min_score is the floor a candidate case must reach (over normalized client name, claim number, and date-of-loss signals) to be considered a match at all. Tune via the playbook UI.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;
end $$;
