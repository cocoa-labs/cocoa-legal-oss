-- Migration 009: Commercial Real Estate playbook seed.
--
-- Seeds the `default-shared` firm playbook with strong US market-standard
-- default positions for every cre.* key the Commercial Real Estate Review
-- capability reads (see backend/src/lib/legalCapabilities/creProfiles.ts
-- CRE_PLAYBOOK_KEYS — the capability↔seed guard test asserts these stay in
-- lockstep). Every firm inherits these via getEffectivePlaybookEntries'
-- default-shared fallback until it sets its own override for a key.
--
-- The shared, cross-capability `risk.escalation_thresholds` key is seeded
-- with ON CONFLICT DO NOTHING so this CRE migration never clobbers a value
-- a future shared/escalation migration may already have written. Every
-- cre.* key uses ON CONFLICT DO UPDATE so re-running this migration keeps
-- the shipped defaults current.
--
-- The notes_md for each entry cites the market-standard authority CLASS the
-- default is grounded in (e.g. the ABA Model Commercial Lease, ALTA 2021
-- policy/survey forms, institutional estoppel/SNDA practice) — standards and
-- treatise classes, NOT case law.
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

  -- cre.lease.standard_positions ------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.lease.standard_positions',
      to_jsonb($val$Firm standard lease positions (tenant-favorable defaults; mirror for landlord representation):
- Expense structure: NNN acceptable with an operating-expense gross-up to 95-100% occupancy; for gross/full-service leases require a base-year expense stop with the base year fairly stated.
- CAM cap: controllable operating expenses capped at ~3-5% per year (cumulative, compounding preferred); taxes, insurance, and utilities may be excluded from the cap as non-controllable.
- SNDA & estoppel: require landlord to deliver an SNDA from each existing and future lender, and cap estoppel/SNDA turnaround at 10-20 days.
- Assignment & subletting: landlord consent not to be unreasonably withheld, conditioned, or delayed; recapture and profit-sharing on excess rent are common landlord asks — resist or narrow; permitted transfers to affiliates/successors without consent.
- Holdover: 150-200% of the last month's rent; resist consequential-damages exposure for holdover.
- Escalations: fixed annual bumps of ~2.5-3%, or CPI with a reasonable cap; resist uncapped CPI.
- Renewal: one or more options at fair market value (FMV) with a 9-12 month exercise notice and an arbitration/baseball mechanism if the parties cannot agree on FMV.$val$::text),
      'Grounded in ABA Model Commercial Lease and institutional/BOMA operating-expense and gross-up conventions; figures reflect prevailing US market practice, not case law.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- cre.lease.deal_breakers -----------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.lease.deal_breakers',
      to_jsonb($val$Lease deal-breakers — escalate to senior counsel before agreeing:
- Uncapped controllable CAM / operating expenses (no annual cap on the controllable bucket).
- No SNDA or no non-disturbance protection (tenant subordinate to a lender with no agreement that the lease survives foreclosure).
- Broad landlord relocation right without comparable-space, cost-reimbursement, and rent-protection guardrails.
- Co-tenancy obligation with no abatement and no termination remedy if the co-tenancy fails.
- Personal guaranty with no burn-off / no cap where a guaranty is not market for the tenant's credit.
- Landlord demolition or recapture/termination right without meaningful advance notice and (where applicable) a termination fee or tenant-protection package.$val$::text),
      'Reflects institutional tenant-side risk thresholds consistent with ABA Model Commercial Lease commentary; market-practice non-negotiables, not case law.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- cre.estoppel.requirements ---------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.estoppel.requirements',
      to_jsonb($val$Tenant estoppel certificate — required confirmations:
- The lease is in full force and effect and (to the certifying party's knowledge) there are no defaults by either party, and no events that with notice/lapse would become defaults.
- Commencement and expiration dates and the current base rent (and current additional-rent/CAM estimate).
- Security deposit held and any prepaid rent.
- No outstanding landlord obligations, including no unfunded TI allowance or unperformed landlord work.
- Options (renewal, expansion, purchase, ROFR/ROFO) stated accurately.
- All amendments, side letters, and guaranties identified.
- Knowledge/materiality qualifications: only "to the certifying party's knowledge" qualifications are acceptable; reject blanket disclaimers that gut the certificate.$val$::text),
      'Based on institutional estoppel certificate practice as reflected in ABA Model Commercial Lease forms and lender/purchaser diligence standards; not case law.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- cre.snda.requirements -------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.snda.requirements',
      to_jsonb($val$Subordination, Non-Disturbance and Attornment (SNDA) — required terms:
- Unconditional non-disturbance: so long as the tenant is not in default beyond applicable cure periods, the lease survives foreclosure and the tenant's possession is not disturbed.
- Attornment to the successor/foreclosure purchaser, with market limits on successor liability (successor not liable for prior landlord defaults, not bound by prepaid rent more than one month in advance, not bound by amendments it did not consent to).
- Tenant notice-and-cure rights to the lender (lender gets notice of landlord default and an opportunity to cure before tenant exercises remedies).
- Reject non-disturbance left to the lender's sole discretion or conditioned on terms that make non-disturbance illusory.$val$::text),
      'Reflects institutional/CMBS SNDA practice consistent with ABA and lender model SNDA forms; market terms, not case law.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- cre.psa.standard_positions --------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.psa.standard_positions',
      to_jsonb($val$Purchase and Sale Agreement (PSA) — standard buyer positions:
- Earnest money: ~1-3% of purchase price, refundable through the due-diligence period, then non-refundable ("going hard") absent a seller default or failed closing condition.
- Due diligence: 30-60 day inspection/feasibility period with a free-look termination right.
- Title: buyer may object to exceptions; seller must cure (or remove at closing) monetary liens and other mandatory-cure items, and use commercially reasonable efforts on other objections.
- Prorations: standard prorations of taxes, rents, CAM, and operating expenses as of closing, with a post-closing true-up.
- Casualty / condemnation: buyer termination (or purchase-price credit) above stated materiality thresholds.
- Representations: seller reps survive ~6-12 months post-closing, subject to a floor (basket) and a cap on liability.
- Condition: property sold as-is except for the limited, expressly surviving reps and warranties.$val$::text),
      'Grounded in ABA model asset purchase / commercial real estate PSA conventions and institutional acquisition practice; market terms, not case law.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- cre.diligence.required_documents --------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.diligence.required_documents',
      to_jsonb($val$Acquisition / financing diligence checklist — documents to collect and review:
- Current rent roll.
- Tenant estoppel certificates.
- SNDAs (existing and required for the new lender).
- All leases, amendments, side letters, and guaranties.
- Title commitment with all exception documents, plus an ALTA/NSPS Land Title Survey.
- Service and maintenance contracts.
- Environmental Phase I (and any Phase II / recognized-environmental-condition follow-up).
- Zoning report and certificate(s) of occupancy.
- Trailing-12-month operating statements (T-12) and CAM reconciliations.
- Real estate tax bills and any pending assessment appeals.
- Insurance certificates / loss-run history.
- Existing loan documents (for assumptions or payoff).$val$::text),
      'Aligned with ALTA 2021 title policy and ALTA/NSPS 2021 survey standards and institutional acquisition/financing diligence checklists; not case law.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- cre.escalation.notification_template ----------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'cre.escalation.notification_template',
      jsonb_build_object(
        'subject',
        'CRE Review Escalation — {{severity}} — {{document_name}}',
        'body',
        $val$A commercial real estate review has surfaced an issue requiring senior-counsel attention.

Document: {{document_name}}
Severity: {{severity}}
Summary: {{summary}}
Market-standard basis / citation: {{citation}}

This item is a deal-breaker or material deviation from the firm playbook and should receive senior counsel review before proceeding. Please advise on whether to proceed, renegotiate, or decline.$val$
      ),
      'EscalationDraft template prefilled by the CRE capability when a finding''s severity is in severities_requiring_escalation (deal-breaker / material). Placeholders are filled at render time.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- risk.escalation_thresholds (SHARED) -----------------------------------
  -- Cross-capability key. ON CONFLICT DO NOTHING so a future shared
  -- escalation migration's value is never clobbered by this CRE seed.
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'risk.escalation_thresholds',
      jsonb_build_object(
        'escalate_to_senior_counsel',
        to_jsonb(array[
          'RED (traffic-light)',
          'deal-breaker (deviation)',
          'Critical (severity)'
        ]),
        'action_on_escalation',
        'Notify senior counsel and generate an EscalationDraft before proceeding.',
        'reviewer_signoff_required',
        'Material deviations (High severity / material) require reviewer sign-off before the work product is finalized.'
      ),
      'Shared escalation thresholds used across capabilities: RED / deal-breaker / Critical route to senior-counsel escalation with an EscalationDraft; material deviations require reviewer sign-off. Consistent with the legal-risk-assessment severity-by-likelihood framework.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do nothing;
end $$;
