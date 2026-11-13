-- Migration 013: Commercial Real Estate playbook ENRICHMENT.
--
-- Re-seeds the same 7 cre.* keys first written by 009_cre_playbook_seed.sql
-- with deeper, lawyer-grade DUAL-VALENCE positions: each entry now states
-- the represented side's position AND the counterparty's likely ask AND the
-- market middle, with asset-class deltas (office / retail / industrial /
-- multifamily) and missing-protection cues. notes_md cites authority CLASSES
-- (ABA RPTE, Friedman on Leases, ALTA / ALTA-NSPS 2021, BOMA by version,
-- ICSC) — standards and treatise classes, NOT case law.
--
-- This migration does NOT add, rename, or remove any key: it touches exactly
-- the 7 keys in creProfiles.ts CRE_PLAYBOOK_KEYS, so the capability↔seed
-- guard test (commercialRealEstate.test.ts) stays green. It supersedes the
-- 009 values via ON CONFLICT DO UPDATE; 009 remains the original seed and
-- 013 layers the richer copy on top. Re-runnable / idempotent.
--
-- The shared, cross-capability risk.escalation_thresholds key is re-seeded
-- with ON CONFLICT DO NOTHING so this CRE enrichment never clobbers a value
-- a shared/escalation migration may already have written.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook only
-- inspects migrations — it never auto-applies). Apply 013 manually after 009.

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
      to_jsonb($val$Commercial lease — standard positions, stated dual-valence (represented side / counterparty's likely ask / market middle). Mirror tenant<->landlord depending on who the user represents.

PREMISES & RSF / MEASUREMENT
- Tenant: fix the RSF as a hard number, cap the load (add-on) factor (~1.10-1.15 office), and name the measurement standard + version. Landlord: reserve a remeasurement right and a load factor stated as "landlord's reasonable determination." Middle: RSF fixed at signing per a NAMED standard, remeasurement only on a material reconfiguration, load factor capped.
- Name the BOMA standard AND version, not just "BOMA": Office ANSI/BOMA Z65.1-2024 (or -2017) — distinguish Method A (legacy/Exterior Wall) vs Method B (single-load-factor); Industrial Z65.2-2025; Retail Z65.5-2025; Multifamily Z65.4-2023. An unspecified-version measurement clause is an off-market ambiguity — flag it.

OPERATING EXPENSES / CAM
- Gross-up: on a base-year (gross/full-service) lease, gross up variable OpEx to 95-100% occupancy so the base year is not artificially low (which would inflate later pass-throughs). Tenant wants 100% and a fairly-stated base year; landlord wants 95% and discretion. Missing gross-up on a base-year lease = a tenant-adverse trap.
- Controllable cap: ~3-5%/yr on controllable expenses; CUMULATIVE vs COMPOUNDED matters — cumulative (unused headroom carries forward) favors the landlord, compounded (annual ceiling on a compounding base) favors the tenant. Taxes, insurance, utilities, snow/security are typically carved out as non-controllable.
- Exclusions tenant should demand: capital expenditures (except amortized, cost-saving, or code-mandated, amortized over useful life at a stated rate); landlord-default / negligence costs; affiliate overcharges above market; leasing, marketing, and brokerage costs; ground-rent and debt service; costs reimbursed by insurance/warranty.
- Audit right: tenant audit of OpEx/CAM, time-boxed (e.g., within 90-180 days of the reconciliation); tenant pays unless the overcharge exceeds ~3-5%, in which case landlord pays the audit cost and refunds with interest.

USE / EXCLUSIVE / CO-TENANCY (retail-weighted)
- Exclusive use: tenant wants a real exclusive with teeth (injunctive relief + rent reduction on breach); landlord wants narrow scope + existing-tenant and incidental-sales carve-outs.
- Co-tenancy (retail): distinguish OPENING co-tenancy (named anchors + ~65-70% occupancy open on the rent-commencement date) from ONGOING co-tenancy; remedy ladder = substitute/percentage-only rent or ~50% abatement, then termination if the failure persists (~9-12 months); cure window ~60-180 days; pair with a go-dark right. Co-tenancy with no abatement and no termination remedy is off-market for the tenant.
- Percentage rent / radius (retail): percentage rent over a natural or stated breakpoint, with gross-sales carve-outs (returns, employee sales, inter-store transfers, gift cards until redeemed, online unless fulfilled from store). An over-broad radius restriction raises enforceability risk in several states — narrow it in scope/time and flag.

ASSIGNMENT / SUBLETTING / CHANGE OF CONTROL
- Tenant: consent "not to be unreasonably withheld, conditioned, or delayed," with a deemed-consent clock; landlord: "sole and absolute discretion" + recapture + 50/50 (or better) profit-share on excess rent/consideration.
- Tenant MUST-HAVE: a permitted-transfer / affiliate-transfer carve-out (to affiliates, successors by merger, and entities acquiring substantially all assets) PLUS an express change-of-control carve-out so an equity sale or reorganization is not a deemed assignment requiring consent. Absence of the change-of-control carve-out is a frequently-missed tenant trap.

CASUALTY / CONDEMNATION
- Termination thresholds (damage in the last N months of term; % of premises/building taken or destroyed; restoration not feasible within a stated period); restoration obligation tied to availability of insurance/condemnation proceeds and lender release of those proceeds; rent abatement during restoration proportional to the untenantable area.

DEFAULT / REMEDIES / HOLDOVER
- Notice-and-cure symmetry: tenant wants written notice + cure for monetary (e.g., 5-10 business days) and non-monetary (e.g., 30 days, extended if not reasonably curable) defaults, and reciprocal landlord-default + self-help/offset rights; landlord wants short/no notice and no offset.
- Holdover: market is 150-200% of the last month's rent; a holdover clause that also exposes the tenant to CONSEQUENTIAL damages (e.g., the landlord's liability to a successor tenant) is a tenant deal-breaker — cap holdover at a percentage of rent and expressly exclude consequential/special damages.

OPTIONS & PROTECTIONS
- Renewal/extension (FMV or fixed, with a 9-12 month notice and a baseball/arbitration FMV mechanic); expansion / ROFO vs ROFR — a RIGHT OF FIRST OFFER (landlord must offer before marketing) is cleaner and more enforceable than a RIGHT OF FIRST REFUSAL (tenant matches a third-party deal); early-termination option with a stated fee/unamortized-cost recapture.
- Security deposit / letter of credit (burn-down over the term on good payment history; LC preferred over cash for bankruptcy-remoteness); good-guy guaranty (esp. NYC retail/office) capping personal exposure to the surrender-in-good-condition date.
- Embedded SNDA / estoppel obligations: confirm the lease obligates the landlord to deliver an SNDA from current and future lenders and that estoppel turnaround is reasonable (10-20 days); preserve lender notice-and-cure.

ASSET-CLASS DELTAS
- Office: load/add-on factor, base-year gross-up, OpEx exclusions, TI allowance + amortization of over-allowance work.
- Retail: co-tenancy, exclusive use, percentage rent, radius, REA/CC&R compliance and continuous-operation covenants.
- Industrial/logistics: true NNN economics, clear height (32-40'), dock/trailer-parking ratios, floor-load, power, and an environmental-indemnity allocation tied to a baseline Phase I.
- Multifamily: rent-roll accuracy, fair-housing compliance, and local rent-regulation overlays.$val$::text),
      'Grounded in ABA RPTE Commercial Real Estate Lease Manual & Commercial Lease Formbook; Friedman on Leases (PLI); BOMA floor-measurement standards cited by version (Office ANSI/BOMA Z65.1, Industrial Z65.2, Retail Z65.5, Multifamily Z65.4); ICSC for retail co-tenancy/percentage-rent/radius conventions. Figures reflect prevailing US market practice, not case law.',
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
      to_jsonb($val$Lease deal-breakers — escalate to senior counsel before agreeing (each is a material, off-market deviation against the represented side, not a line item to wave through):
- Uncapped controllable CAM / operating expenses — no annual cap on the controllable bucket (or a cap so high it is illusory), exposing the tenant to open-ended escalation.
- No SNDA / no non-disturbance — the lease is subordinate to a lender with no agreement that possession survives foreclosure; the tenant can be wiped out on a default it did not cause.
- Broad landlord relocation right WITHOUT comparable-space, moving-cost-reimbursement, and rent-protection (no rent increase / same economics) guardrails.
- Co-tenancy obligation with NO abatement and NO termination remedy when the co-tenancy fails (a co-tenancy "right" with no remedy is cosmetic).
- Personal guaranty with no burn-off and no cap where a guaranty is not market for the tenant's credit (vs. a good-guy guaranty limited to surrender in good condition).
- Landlord demolition / recapture / termination right without meaningful advance notice and, where applicable, a termination fee or tenant-protection package.
- Holdover that exposes the tenant to CONSEQUENTIAL damages (e.g., the landlord's liability to a successor tenant) on top of premium holdover rent.
Frame each from the represented party's side: state the deviation, the counterparty's likely justification, and the minimum market protection that would move it from deal-breaker back toward the middle.$val$::text),
      'Reflects institutional tenant-side risk thresholds consistent with ABA RPTE lease commentary and Friedman on Leases; market-practice non-negotiables, not case law.',
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
      to_jsonb($val$Tenant estoppel certificate — dual-valence (landlord/buyer/lender want broad, unqualified certs as a closing condition; tenant wants a minimal, knowledge-qualified cert that does not modify the lease).

REQUIRED CONFIRMATIONS (what a proper estoppel covers)
- The lease is in full force and effect and, to the certifying party's KNOWLEDGE, there are no defaults by either party and no events that with notice/lapse would ripen into a default.
- Commencement and expiration dates; current base rent; current additional-rent / CAM estimate; the escalation schedule.
- Security deposit held and any prepaid rent.
- No outstanding landlord obligations — no unfunded TI allowance, no unperformed landlord work, no free-rent or concession still owed.
- Options (renewal, expansion, purchase, ROFR/ROFO) stated accurately.
- All amendments, side letters, and guaranties identified.

TRAPS TO FLAG (tenant protection)
- A flat "there are no defaults" statement WITHOUT a knowledge qualifier — add "to the certifying party's knowledge."
- Estoppel language that MODIFIES the lease (changes a date, rate, or right) — add "in the event of conflict, the lease controls" so the estoppel cannot rewrite the deal.
- A request to confirm the ABSENCE of an obligation the landlord actually owes (e.g., "no TI allowance remains" when it does) — confirming it would WAIVE the tenant's right; correct it to the true facts.
- Forward-looking covenants or new agreements smuggled into the estoppel (an estoppel certifies present facts; it is not an amendment).

WHY IT MATTERS / DEAL POSTURE
- Once signed, an estoppel is CONCLUSIVELY BINDING on the certifying party as to the facts stated, even if erroneous — errors are not later correctable against a good-faith relying buyer/lender, so accuracy and qualifiers are the whole game.
- Buyer/lender side: estoppels are a closing condition; expect ~100% of anchors and ~65-85% of all tenants (often a stated percentage by RSF) returned in approved form, with a landlord-estoppel backstop for tenants who do not deliver.$val$::text),
      'Based on institutional estoppel-certificate practice as reflected in ABA RPTE forms and lender/purchaser diligence standards (conclusive-effect and knowledge-qualifier conventions); not case law.',
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
      to_jsonb($val$Subordination, Non-Disturbance and Attornment (SNDA) — dual-valence (lender wants subordination + attornment with maximum successor-liability carve-outs on ITS form; tenant wants unconditional non-disturbance that preserves the full lease bargain).

THE THREE LEGS
- SUBORDINATION: the lease is made subordinate to the mortgage. Tenant accepts this only when paired with real non-disturbance.
- NON-DISTURBANCE: so long as the tenant is not in default beyond applicable cure periods, the lease survives foreclosure and possession/rights are NOT disturbed. Reject non-disturbance left to the lender's "sole discretion" or hung on conditions that make it illusory.
- ATTORNMENT: tenant attorns to the foreclosure purchaser/successor, with market limits on successor liability.

WHOSE FORM GOVERNS
- Lender form vs. tenant/lease form is itself a negotiation. Anchor/credit tenants push their own SNDA; the tenant's leverage is its covenant strength.

LENDER CARVE-OUTS (successor NOT bound by)
- Prepaid rent more than ~1 month in advance; prior-landlord defaults; offsets/credits accrued before the successor took title; security deposits not actually delivered to the successor; lease amendments made without lender consent; and unfinished/unfunded TI or landlord work.

TENANT PROTECTIONS TO PRESERVE
- Push the LEASE cure periods (and lender notice-and-cure) into the SNDA so the tenant is not cut off; preserve offset/abatement rights, renewal/expansion/purchase options, and (critically) the casualty/condemnation proceeds -> rebuild mechanic, which can COLLIDE with the loan documents' requirement to apply proceeds to the debt — resolve the collision in the SNDA; obtain a permitted-amendment carve-out so ordinary lease amendments do not require lender consent.

CAUTION
- Amending the lease AFTER an SNDA is in place can VOID the non-disturbance protection if the amendment is outside the SNDA's permitted-amendment carve-out — sequence amendments and lender consents accordingly.$val$::text),
      'Reflects institutional/CMBS SNDA practice consistent with the NYSBA model SNDA and ABA RPTE lender SNDA forms (non-disturbance conditions, successor-liability carve-outs, proceeds collision); market terms, not case law.',
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
      to_jsonb($val$Purchase and Sale Agreement (PSA) — dual-valence (buyer vs. seller). Frame each from the represented side; the middle is what institutional deals actually close on.

DEPOSIT / DUE DILIGENCE
- Earnest money ~1-3% of price; buyer wants it fully refundable through the DD period, then "going hard" at DD expiry; seller wants a smaller free-look and earlier hard money. DD period 30-90 days with a free-look termination right (buyer) vs. a short, info-only review (seller).

TITLE & SURVEY
- Buyer objection -> cure: seller MUST cure/remove monetary liens and other mandatory-cure items (mortgages, judgments, mechanics' liens) and use commercially reasonable (often capped-dollar) efforts on discretionary objections; seller wants "may cure" discretion and an as-is title take.

SELLER REPS & SURVIVAL
- Reps qualified "to seller's knowledge," defined by reference to NAMED individuals, limited to ACTUAL (not constructive/imputed) knowledge, with a bring-down at closing.
- Survival 6 months-2 years post-closing, behind a basket/floor and a cap, sometimes backed by a holdback/escrow. CRITICAL: absent an express survival clause, the reps MERGE into the deed and DIE at closing — a PSA with no survival provision is an auto-flag for the buyer.
- As-is / reliance: seller wants an as-is sale with an express disclaimer of reliance on extra-contractual statements; buyer narrows the disclaimer to preserve reliance on the express reps and on fraud.

INTERIM / CONDITIONS / REMEDIES
- Interim operating covenants (no new leases/amendments/encumbrances or service contracts outside the ordinary course without buyer consent between signing and closing).
- Casualty/condemnation termination (or price credit) above stated materiality thresholds; estoppels and SNDAs as closing conditions (with a minimum-threshold and a landlord-estoppel backstop).
- Remedies: buyer default -> liquidated damages = the deposit (seller's sole remedy); seller default -> buyer elects specific performance OR capped damages. Liquidated-damages and specific-performance enforceability is STATE-SPECIFIC — treat as a consult-counsel trigger, not boilerplate.

PRORATIONS
- Taxes, rents, CAM, and operating expenses prorated as of closing with a post-closing true-up; handle delinquent rents (collected-first-applied-to-current, then turned over), percentage-rent and CAM reconciliations, and credit/transfer of security deposits.

ASSET-CLASS DELTAS
- Multifamily: rent-roll certification and fair-housing/rent-regulation diligence.
- Retail: percentage-rent and CAM true-up mechanics, co-tenancy status, REA/CC&R estoppels.
- Industrial: environmental Phase I (and Phase II / REC follow-up) and an environmental rep/indemnity allocation.
- Office: assumed leasing commissions, TI obligations, and free-rent carry as assumed liabilities / closing credits.$val$::text),
      'Grounded in ABA RPTE model PSA conventions, ICSC retail practice, and Practical Law institutional acquisition standards (knowledge qualifiers, survival/merger doctrine, liquidated-damages enforceability as state-specific); market terms, not case law.',
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
      to_jsonb($val$Acquisition / financing diligence checklist — documents to collect and review.

LEASE & INCOME LAYER
- Current rent roll (reconciled to the leases).
- Tenant estoppel certificates (and a landlord-estoppel backstop for non-delivering tenants).
- SNDAs (existing, and those required for the new lender).
- All leases, amendments, side letters, and guaranties.
- Service and maintenance contracts.
- Trailing-12-month operating statements (T-12) and CAM/OpEx reconciliations.
- Real estate tax bills and any pending assessment appeals.
- Insurance certificates / loss-run history.
- Existing loan documents (for assumption or payoff).
- Environmental Phase I (and any Phase II / recognized-environmental-condition follow-up).
- Zoning report and certificate(s) of occupancy.

TITLE / SURVEY LAYER (read the policy, not just the pro forma)
- Title commitment SCHEDULE A: the vested owner, the estate/interest insured, the legal description, and the policy amount — confirm these match the seller and the deal.
- Title commitment SCHEDULE B-I (Requirements): treat as a CURE LOG — every requirement (payoffs, releases, entity good-standing, authority docs) must be satisfied or waived before/at closing.
- Title commitment SCHEDULE B-II (Exceptions): READ the underlying recorded documents (easements, CC&Rs/REAs, restrictions, leases, liens), do not rely on the one-line description; deleting the standard SURVEY exception requires a current ALTA/NSPS survey.
- ALTA/NSPS 2021 Land Title Survey with the relevant Table A items selected (e.g., 1, 2, 3, 4, 6(b), 7, 8, 11, 13, 16, 17, 18, 19, 20).
- Common ALTA 2021 endorsements to request by type: 3 / 3.1 (zoning, with parking/loading on 3.1), 9 (comprehensive / restrictions-encroachments-minerals), 17 (access / direct access to a public street), 18 (single tax parcel), 19 (contiguity), 22 (location / improvement address), 25 (survey-matches-legal), 28 (easement — damage / encroachment). Match the endorsement set to the asset and lender requirements.$val$::text),
      'Aligned with ALTA 2021 title policy forms (Schedule A / B-I / B-II structure and endorsement series) and the ALTA/NSPS 2021 Land Title Survey standard with Table A, plus ABA RPTE institutional acquisition/financing diligence checklists; not case law.',
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
Represented party: {{representedParty}}
Severity: {{severity}}
Summary: {{summary}}
Market-standard basis / citation: {{citation}}

This item is a deal-breaker or material deviation from the firm playbook, assessed from the represented party's side against market-standard positions, and should receive senior counsel review before proceeding. Please advise on whether to proceed, renegotiate, or decline.$val$
      ),
      'EscalationDraft template prefilled by the CRE capability when a finding''s severity is in severities_requiring_escalation (deal-breaker / material). Placeholders ({{document_name}}, {{representedParty}}, {{severity}}, {{summary}}, {{citation}}) are filled at render time.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- risk.escalation_thresholds (SHARED) -----------------------------------
  -- Cross-capability key. ON CONFLICT DO NOTHING so a shared escalation
  -- migration's value is never clobbered by this CRE enrichment (009 already
  -- seeds it; this is a no-op if present).
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
