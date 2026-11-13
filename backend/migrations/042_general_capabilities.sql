-- Migration 042: general capability playbook seed + chat suggestion columns.
--
-- Section A seeds the `default-shared` firm playbook with public defaults for
-- every key the four GENERAL capabilities read — compliance-check,
-- legal-risk-assessment, triage-nda and review-contract (see
-- backend/src/lib/legalCapabilities/generalProfiles.ts GENERAL_PLAYBOOK_KEYS;
-- the capability↔seed guard test reads this file and asserts the two stay in
-- lockstep, in both directions). Every firm inherits these via
-- getEffectivePlaybookEntries' default-shared fallback until it sets its own
-- override for a key.
--
-- The shared, cross-capability risk.escalation_thresholds key is NOT seeded
-- here: 009_cre_playbook_seed.sql already inserts it with ON CONFLICT DO
-- NOTHING, and re-asserting it from this migration would risk clobbering a
-- firm-tuned value. legal-risk-assessment declares it and reads whatever 009
-- (or the firm) put there.
--
-- The notes_md for each entry names the authority CLASS the default is
-- grounded in — GDPR/CCPA-CPRA statutory text and supervisory-authority
-- guidance, EU Article 28 processor requirements, ISO 31000-style
-- severity-by-likelihood risk practice, and prevailing US commercial NDA /
-- MSA drafting practice — and says the firm should override it with its own
-- positions. These are starting defaults, not the firm's playbook.
--
-- Section B adds the two chat columns the in-chat capability run path needs:
-- per-chat suggestion settings and the per-message capability-run record.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook only
-- inspects migrations — it never auto-applies). Idempotent / re-runnable.

-- ===========================================================================
-- Section A — playbook seed
-- ===========================================================================

do $$
declare
  default_firm text := 'default-shared';
  pb_id uuid;
begin
  insert into public.firm_playbooks (firm_id, updated_by)
  values (default_firm, 'migration')
  on conflict (firm_id) do update set updated_at = now()
  returning id into pb_id;

  -- compliance.regulation_reference -----------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'compliance.regulation_reference',
      to_jsonb($val$Regulation reference — which regimes to screen for and what each requires:

GDPR (EU/EEA personal data, wherever the processor sits):
- Identify and document a lawful basis for each processing activity (consent, contract, legitimate interest, legal obligation, vital interest, public task).
- Honour data subject rights (access, rectification, erasure, portability, restriction, objection) within the statutory deadline.
- Run a DPIA where processing is likely to result in a high risk to individuals.
- Notify the supervisory authority within 72 hours of becoming aware of a personal data breach; notify individuals without undue delay where the risk is high.
- Maintain Article 30 records of processing.
- Use a valid transfer mechanism for transfers outside the EEA (SCCs, adequacy decision, BCRs) plus a transfer impact assessment where there is no adequacy decision.
- Appoint a DPO where required (public authority, large-scale special-category processing, large-scale systematic monitoring).

CCPA / CPRA (personal information of California residents, above the revenue / volume / sale thresholds):
- Consumer rights: know, delete, correct, opt out of sale or sharing, limit use of sensitive personal information.
- No discrimination against a consumer who exercises a right.
- Privacy notice at or before collection, describing the categories collected and the purposes.
- Service provider contracts must restrict use of personal information to the specified business purpose.

Other regimes to screen when the activity touches them: UK GDPR (ICO; UK addendum for transfers), LGPD (Brazil), PIPEDA (Canada), PDPA (Singapore), Privacy Act / APPs (Australia), PIPL (China; strict cross-border transfer and localisation rules), POPIA (South Africa).

Sector regimes are NOT covered by this default entry. Where the proposal touches financial services (CFTC/NFA, FINRA/SEC, state money transmission), healthcare (HIPAA), advertising (FTC Act, state UDAP), employment, or export control, say so explicitly and treat the specific requirements as an open item for the firm's own reference or outside counsel rather than asserting them.$val$::text),
      'Grounded in the statutory text and supervisory-authority guidance for the named privacy regimes (GDPR, CCPA/CPRA, UK GDPR, LGPD and peers) — regulatory frameworks, not case law. Deliberately silent on sector regimes. OVERRIDE EXPECTED: the firm should replace this with the regimes it actually advises on and its own internal policies.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- compliance.dpa_standard_positions ---------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'compliance.dpa_standard_positions',
      to_jsonb($val$Data processing agreement — required elements and standard positions:

Required elements (GDPR Article 28): subject matter and duration; nature and purpose of the processing; type of personal data; categories of data subjects; the controller's instructions and oversight rights.

Processor obligations to require:
- Processes only on the controller's documented instructions (save where law requires otherwise).
- Personnel bound by confidentiality.
- Appropriate technical and organisational security measures (Article 32).
- Sub-processors: written authorisation; where authorisation is general, notice of changes with an opportunity to object; sub-processors bound by equivalent terms; processor remains liable for them.
- Assistance with data subject requests, security, breach notification, DPIAs and prior consultation.
- On termination, deletion or return of all personal data at the controller's choice, with copies deleted unless retention is legally required.
- Audit rights: right to audit and inspect, or acceptance of a current third-party report (SOC 2 Type II) plus a right to audit on cause.
- Breach notification to the controller without undue delay — 24 to 48 hours, so the controller can meet a 72-hour regulatory deadline.

International transfers: identify the transfer mechanism; use the current (2021) EU SCCs with the correct module (C2P, C2C, P2P, P2C); complete a transfer impact assessment where there is no adequacy decision; add supplementary measures for identified gaps; include the UK International Data Transfer Addendum where UK data is in scope.

Standard positions on the common issues:
- Blanket sub-processor authorisation with no notification — require notification with a right to object.
- Breach notification longer than 72 hours — require 24 to 48 hours.
- No audit rights at all — accept SOC 2 Type II plus audit on cause.
- No stated deletion timeline — require deletion within 30 to 90 days of termination.
- No stated processing locations — require disclosure of processing locations.
- Outdated SCCs — require the current 2021 EU SCCs.
- Check that the DPA's liability and term provisions do not conflict with the main services agreement.$val$::text),
      'Grounded in GDPR Article 28 processor requirements, the 2021 EU standard contractual clauses, and prevailing vendor-DPA negotiation practice — regulatory instruments and market practice, not case law. OVERRIDE EXPECTED: the firm should set its own acceptable ranges (breach-notice window, audit posture, retention period).',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- compliance.dsr_response_timelines ---------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'compliance.dsr_response_timelines',
      $val${
        "gdpr": {"response_days": 30, "extension_days": 60},
        "ccpa": {"ack_business_days": 10, "response_days": 45, "extension_days": 45},
        "uk_gdpr": {"response_days": 30, "extension_days": 60},
        "lgpd": {"response_days": 15}
      }$val$::jsonb,
      'Statutory data-subject / consumer request deadlines: GDPR and UK GDPR one month, extendable by two further months for complex requests; CCPA/CPRA acknowledgement within 10 business days and substantive response within 45 calendar days, extendable by 45 days with notice; LGPD 15 days. Grounded in the statutory text of each regime. The firm should override only to record a shorter internal SLA — never a longer one than the statute allows.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- compliance.escalation_criteria ------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'compliance.escalation_criteria',
      to_jsonb($val$Escalate a compliance check to senior counsel (and prepare an escalation notice) when any of these is true:
- The proposed action would proceed without a required registration, licence, or regulatory approval.
- A high risk area is unmitigated, or a requirement is marked Not met with no remediation before launch.
- Personal data of EU/UK/California residents is processed with no lawful basis, no DPA, or no valid transfer mechanism.
- The activity falls under a sector regime the firm has not cleared (financial services, healthcare, export control, advertising claims).
- A regulator has opened an inquiry, or a transfer mechanism the proposal relies on has been challenged or invalidated.
- A compliance deadline requiring organisational change is inside the planning horizon.
- The proposal is novel for the firm, or the applicable rule is genuinely unsettled.$val$::text),
      'Escalation triggers assembled from the regulatory-monitoring and escalation guidance of the compliance-check capability source; a starting policy, not a legal standard. OVERRIDE EXPECTED: the firm should align these with its own delegation of authority.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- compliance.escalation.notification_template -----------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'compliance.escalation.notification_template',
      jsonb_build_object(
        'subject',
        'Compliance Escalation — {{severity}} — {{title}}',
        'body',
        $val$A compliance check has surfaced an issue requiring senior-counsel attention.

Matter: {{title}}
Severity: {{severity}}
Summary: {{summary}}

This item meets the firm's compliance escalation criteria and should be reviewed before the proposed action proceeds. Please advise whether to proceed, proceed with conditions, or hold pending further review.$val$
      ),
      'EscalationDraft template prefilled by the compliance-check capability when a risk area is high. Placeholders ({{title}}, {{severity}}, {{summary}}) are filled at render time. Mirrors the shape of the CRE escalation template seeded by 009. OVERRIDE EXPECTED: firms tailor the wording and the addressee conventions.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- risk.severity_likelihood_matrix -----------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'risk.severity_likelihood_matrix',
      $val${
        "score": "risk score = severity x likelihood (1-25)",
        "severity": [
          {"level": 1, "label": "Negligible", "description": "Minor inconvenience; no material financial, operational or reputational impact; handled within normal operations."},
          {"level": 2, "label": "Low", "description": "Limited impact; financial exposure under 1% of the relevant contract or deal value; minor operational disruption; no public attention."},
          {"level": 3, "label": "Moderate", "description": "Meaningful impact; financial exposure of 1-5% of the relevant value; noticeable operational disruption; potential for limited public attention."},
          {"level": 4, "label": "High", "description": "Significant impact; financial exposure of 5-25% of the relevant value; significant operational disruption; likely public attention; potential regulatory scrutiny."},
          {"level": 5, "label": "Critical", "description": "Severe impact; financial exposure above 25% of the relevant value; fundamental business disruption; significant reputational damage; regulatory action likely; potential personal liability for officers or directors."}
        ],
        "likelihood": [
          {"level": 1, "label": "Remote", "description": "Highly unlikely; no known precedent; would require exceptional circumstances."},
          {"level": 2, "label": "Unlikely", "description": "Could occur but not expected; limited precedent; would require specific triggering events."},
          {"level": 3, "label": "Possible", "description": "May occur; some precedent exists; triggering events are foreseeable."},
          {"level": 4, "label": "Likely", "description": "Probably will occur; clear precedent; triggering events are common in similar situations."},
          {"level": 5, "label": "Almost Certain", "description": "Expected to occur; strong precedent or pattern; triggering events are present or imminent."}
        ],
        "bands": [
          {"min": 1, "max": 4, "band": "GREEN", "level": "Low Risk"},
          {"min": 5, "max": 9, "band": "YELLOW", "level": "Medium Risk"},
          {"min": 10, "max": 15, "band": "ORANGE", "level": "High Risk"},
          {"min": 16, "max": 25, "band": "RED", "level": "Critical Risk"}
        ]
      }$val$::jsonb,
      'Five-by-five severity-by-likelihood risk matrix in the ISO 31000 / enterprise-risk-register tradition, with the percentage-of-value severity bands from the legal-risk-assessment capability source. A starting framework, not a legal standard. OVERRIDE EXPECTED: the firm should calibrate the severity bands and the score cut-offs to its own risk appetite.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- risk.band_actions -------------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'risk.band_actions',
      to_jsonb($val$Recommended actions by risk band:

GREEN — Low risk (score 1-4): accept and proceed under standard controls; record the risk in the register; monitor at the periodic review (quarterly or annually); no escalation required — the responsible team member can manage it.

YELLOW — Medium risk (score 5-9): mitigate with specific controls or negotiate the exposure down; monitor actively (monthly, or on defined triggers); document the risk, the mitigations and the rationale; assign a named owner; brief the affected business stakeholders; define the trigger events that would elevate the band.

ORANGE — High risk (score 10-15): escalate to the head of legal or designated senior counsel; build a specific, actionable mitigation plan; brief business leadership; review weekly or at defined milestones; consider outside counsel for specialist advice; document a full risk memo with options and a recommendation; define a contingency plan for the risk materialising.

RED — Critical risk (score 16-25): escalate immediately to the General Counsel and, as appropriate, the executive team or board; engage specialist outside counsel; stand up a response team with clear roles; consider insurer notification; activate crisis management where reputational harm is in play; issue a litigation hold where proceedings are possible; review daily until the risk is resolved or reduced; make any required regulatory notifications.$val$::text),
      'Band-appropriate response ladder from the legal-risk-assessment capability source, expressed in the same GREEN/YELLOW/ORANGE/RED bands as the severity-by-likelihood matrix. Market practice, not a legal standard. OVERRIDE EXPECTED: the firm should name its own escalation recipients, review cadences and sign-off roles.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- risk.outside_counsel_criteria -------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'risk.outside_counsel_criteria',
      to_jsonb($val$When to engage outside counsel:

Mandatory: any filed litigation for or against the organisation; any government or regulator inquiry or investigation; any matter carrying potential criminal liability; any matter affecting securities disclosures or filings; any matter requiring board notification or approval.

Strongly recommended: novel or unsettled legal questions where the position could set precedent; unfamiliar jurisdictions or conflicting cross-border requirements; exposure above the organisation's risk tolerance; specialist expertise not held in house (antitrust, FCPA, patent prosecution and similar); new regulation requiring a compliance programme; M&A diligence, structuring or regulatory approvals.

Consider: complex contract disputes with material counterparties; employment claims (discrimination, harassment, wrongful termination, whistleblower); data incidents that may trigger notification duties; IP infringement allegations touching material products; insurance coverage disputes on material claims.

When recommending an engagement, note the selection factors: subject-matter expertise, jurisdictional experience, industry understanding, conflicts clearance, budget and fee arrangement, and any existing panel relationship.$val$::text),
      'Engagement thresholds from the legal-risk-assessment capability source, reflecting common in-house practice on the in-house / outside-counsel boundary. Not a legal standard. OVERRIDE EXPECTED: the firm should set its own thresholds and name its panel firms.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- risk.escalation.notification_template -----------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'risk.escalation.notification_template',
      jsonb_build_object(
        'subject',
        'Legal Risk Escalation — {{severity}} — {{title}}',
        'body',
        $val$A legal risk assessment has scored a risk in an escalating band.

Matter: {{title}}
Risk band / score: {{severity}}
Summary: {{summary}}

This risk sits in the ORANGE or RED band and calls for senior-counsel attention, a documented mitigation plan, and a decision on whether to engage outside counsel. Please advise on the recommended approach and the review cadence.$val$
      ),
      'EscalationDraft template prefilled by the legal-risk-assessment capability when the scored band is ORANGE or RED. Placeholders ({{title}}, {{severity}}, {{summary}}) are filled at render time. Mirrors the shape of the CRE escalation template seeded by 009. OVERRIDE EXPECTED: firms tailor the wording and the addressee conventions.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- nda.standard_positions --------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'nda.standard_positions',
      to_jsonb($val$NDA standard positions and redline approaches:

Structure: mutual obligations by default, unless the firm's client is only disclosing or only receiving; the NDA should be a standalone agreement, not a confidentiality section inside a commercial agreement.

Definition of confidential information: limited to non-public information disclosed for the stated purpose, with the standard exclusions. Redline an overbroad definition ("all information of any kind, whether or not marked") down to information marked or identified as confidential, or that a reasonable person would understand to be confidential from its nature and the circumstances of disclosure. Where marking is required, written confirmation within 30 days of an oral disclosure is workable.

Required carveouts (all five): publicly available through no fault of the receiving party; already known before disclosure; independently developed without use of or reference to the confidential information; rightfully received from a third party without restriction; disclosure compelled by law or legal process, with notice to the disclosing party where legally permitted. A missing independent-development carveout is the highest-consequence gap — it invites a claim that internally built features were derived from the counterparty's information.

Term: agreement term of 1-3 years; confidentiality survival of 2-5 years from disclosure or termination, whichever is later. Replace a perpetual obligation with a defined term, offering a trade-secret carveout for as long as the information remains a trade secret.

Non-solicitation and non-compete: these do not belong in an NDA — delete them. If the counterparty insists on a non-solicit, limit it to targeted solicitation (not general recruitment) and a 12-month term.

Residuals: resist. If unavoidable, limit to general ideas, concepts, know-how or techniques retained in the unaided memory of individuals who had authorised access; exclude trade secrets and patentable information; grant no IP licence.

Return and destruction: triggered on termination or request, covering copies, with a retention exception for legal, regulatory, compliance and backup copies; certification of destruction is reasonable, a sworn affidavit is not.

Remedies: an acknowledgement that breach may cause irreparable harm and that equitable relief may be appropriate is standard; reject liquidated damages or penalty provisions; in a mutual NDA remedies must run both ways.

Governing law: a well-established commercial jurisdiction, consistent with the venue; litigation is generally preferred to mandatory arbitration for NDA disputes.$val$::text),
      'Prevailing US commercial NDA drafting practice as reflected in the triage-nda capability source — market positions and redline conventions, not case law. OVERRIDE EXPECTED: the firm should substitute its own standard form positions and preferred jurisdiction.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- nda.screening_criteria --------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'nda.screening_criteria',
      $val$[
        {
          "group": "Agreement structure",
          "items": [
            "Type identified: mutual, unilateral (disclosing), or unilateral (receiving)",
            "Type is appropriate for the business relationship",
            "Standalone agreement, not a confidentiality section inside a larger commercial agreement"
          ]
        },
        {
          "group": "Definition of confidential information",
          "items": [
            "Scope is reasonable and not overbroad",
            "Any marking requirement is workable (written confirmation within 30 days of oral disclosure)",
            "Standard exclusions are present",
            "Publicly available and independently developed material are not swept in"
          ]
        },
        {
          "group": "Obligations of the receiving party",
          "items": [
            "Standard of care is reasonable care, or the care used for its own confidential information",
            "Use is limited to the stated purpose",
            "Disclosure limited to those with a need to know who are bound by similar obligations",
            "No impractical operational obligations"
          ]
        },
        {
          "group": "Standard carveouts",
          "items": [
            "Public knowledge through no fault of the receiving party",
            "Prior possession before disclosure",
            "Independent development without use of or reference to the confidential information",
            "Rightful receipt from a third party without restriction",
            "Disclosure compelled by law or legal process, with notice where legally permitted"
          ]
        },
        {
          "group": "Permitted disclosures",
          "items": [
            "Employees with a need to know",
            "Contractors, advisors and professional consultants under similar obligations",
            "Affiliates where needed for the business purpose",
            "Disclosures required by law or regulation"
          ]
        },
        {
          "group": "Term and duration",
          "items": [
            "Agreement term within the standard range",
            "Confidentiality survival within the standard range",
            "Not perpetual, except for trade secrets"
          ]
        },
        {
          "group": "Return and destruction",
          "items": [
            "Triggered on termination or on request",
            "Covers the confidential information and all copies",
            "Retention exception for legal, regulatory, compliance and backup copies",
            "Certification of destruction rather than a sworn affidavit"
          ]
        },
        {
          "group": "Remedies",
          "items": [
            "Irreparable-harm and equitable-relief acknowledgement is acceptable",
            "No liquidated damages or penalty provisions",
            "Remedies apply equally to both parties in a mutual NDA"
          ]
        },
        {
          "group": "Problematic provisions",
          "items": [
            "No employee non-solicitation",
            "No non-compete",
            "No exclusivity restricting similar discussions with others",
            "No standstill outside an M&A context",
            "No residuals clause, or narrowly scoped to unaided memory and excluding trade secrets and patentable information",
            "No IP assignment or licence grant",
            "No audit rights"
          ]
        },
        {
          "group": "Governing law and jurisdiction",
          "items": [
            "Well-established commercial jurisdiction",
            "Governing law and venue are consistent",
            "No mandatory arbitration in a standard NDA"
          ]
        }
      ]$val$::jsonb,
      'The ten screening groups from the triage-nda capability source, in review order — prevailing US commercial NDA screening practice, not case law. OVERRIDE EXPECTED: the firm should add its own organisation-specific criteria and drop any group it does not screen.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- nda.classification_rules ------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'nda.classification_rules',
      $val${
        "GREEN": {
          "label": "Standard approval",
          "rule": "all_of",
          "all_of": [
            "Mutual, or unilateral in the appropriate direction",
            "All standard carveouts present",
            "Term and survival within the standard ranges",
            "No non-solicitation, non-compete or exclusivity",
            "No residuals clause, or narrowly scoped",
            "Reasonable governing law jurisdiction",
            "Standard remedies, with no liquidated damages",
            "Permitted disclosures cover employees, contractors and advisors",
            "Return and destruction includes a legal/compliance retention exception",
            "Definition of confidential information reasonably scoped"
          ]
        },
        "YELLOW": {
          "label": "Counsel review",
          "rule": "any_of",
          "any_of": [
            "Definition broader than preferred but not unreasonable",
            "Term longer than standard but within market range",
            "One standard carveout missing that could be added without difficulty",
            "Residuals clause present but narrowly scoped to unaided memory",
            "Governing law acceptable but not preferred",
            "Minor asymmetry in a mutual NDA",
            "Marking requirements present but workable",
            "Return and destruction lacks an explicit retention exception",
            "Unusual but non-harmful provisions"
          ]
        },
        "RED": {
          "label": "Full legal review — do not sign",
          "rule": "any_of",
          "any_of": [
            "Unilateral where mutual is required, or the wrong direction for the relationship",
            "Missing a critical carveout, especially independent development or legal compulsion",
            "Non-solicitation or non-compete embedded in the NDA",
            "Exclusivity or standstill without appropriate business context",
            "Unreasonable term (10 or more years, or perpetual without trade-secret justification)",
            "Overbroad definition capturing public or independently developed material",
            "Broad residuals clause amounting to a licence to use the information",
            "IP assignment or licence grant hidden in the NDA",
            "Liquidated damages or penalty provisions",
            "Audit rights without reasonable scope or notice",
            "Highly unfavourable jurisdiction with mandatory arbitration",
            "The document is not actually an NDA — it carries substantive commercial terms"
          ]
        }
      }$val$::jsonb,
      'Classification rules from the triage-nda capability source: GREEN requires every listed condition to hold, while a single matching YELLOW or RED condition sets that band. Market screening practice, not a legal standard. OVERRIDE EXPECTED: the firm should tune the conditions to its own delegation of authority.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- nda.term_limits ---------------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'nda.term_limits',
      $val${
        "agreement_years": {"standard": [1, 3], "yellow_max": 5, "red_min": 10},
        "survival_years": {"standard": [2, 5], "yellow_max": 7},
        "perpetual_allowed": false,
        "trade_secret_exception": true,
        "oral_marking_days": 30
      }$val$::jsonb,
      'Duration limits from the triage-nda capability source: 1-3 year agreement term and 2-5 year survival are standard; 5 years (term) and 7 years (survival) are the YELLOW ceilings; 10 or more years is RED. Perpetual obligations are not accepted except for trade secrets, and written confirmation of an oral disclosure within 30 days is workable. Prevailing US commercial practice, not a legal standard. OVERRIDE EXPECTED: the firm should set its own ranges.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- nda.routing_rules -------------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'nda.routing_rules',
      $val${
        "GREEN": {
          "action": "Approve and route for signature under the delegation of authority",
          "sla": "Same day",
          "reviewer": "Requesting business owner"
        },
        "YELLOW": {
          "action": "Send to the designated reviewer with the specific issues flagged; counsel can likely resolve in a single review pass",
          "sla": "1-2 business days",
          "reviewer": "Designated counsel"
        },
        "RED": {
          "action": "Full legal review — do not sign; negotiate or reject",
          "sla": "3-5 business days",
          "reviewer": "Senior counsel",
          "counterproposal": "Send the firm's standard form NDA as a counterproposal"
        }
      }$val$::jsonb,
      'Routing and turnaround expectations by classification, from the triage-nda capability source. Operational policy, not a legal standard. OVERRIDE EXPECTED: the firm should name the actual reviewers and its own SLAs.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- nda.escalation.notification_template ------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'nda.escalation.notification_template',
      jsonb_build_object(
        'subject',
        'NDA Triage Escalation — {{severity}} — {{title}}',
        'body',
        $val$An NDA triage has classified an agreement as requiring full legal review.

Agreement: {{title}}
Classification: {{severity}}
Summary: {{summary}}

This NDA should not be signed as drafted. It requires negotiation, a counterproposal on the firm's standard form, or rejection. Please advise on the preferred route.$val$
      ),
      'EscalationDraft template prefilled by the triage-nda capability on a RED classification. Placeholders ({{title}}, {{severity}}, {{summary}}) are filled at render time. Mirrors the shape of the CRE escalation template seeded by 009. OVERRIDE EXPECTED: firms tailor the wording and the addressee conventions.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- contract.standard_positions ---------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'contract.standard_positions',
      $val${
        "limitation_of_liability": "Mutual cap, expressed as a multiple of fees paid in the preceding 12 months, with the usual carveouts (confidentiality breach, indemnity obligations, gross negligence, wilful misconduct) stated symmetrically. Mutual exclusion of consequential, indirect, special and punitive damages. Resist a cap set at a fraction of fees, asymmetric carveouts, and carveouts broad enough to swallow the cap.",
        "indemnification": "Mutual where both parties contribute IP or data. Scope limited to defined triggers (third-party IP infringement, data breach, bodily injury or property damage, breach of representations), not 'any breach'. Clear procedure: prompt notice, control of defence, no settlement admitting liability without consent. State how the indemnity interacts with the liability cap.",
        "ip_ownership": "Each party retains its pre-existing IP. Deliverables and developed IP allocated expressly, with any work-for-hire scoped to the deliverables only. Licence grants limited in scope, territory and sublicensing to what the relationship needs. Resist unrestricted feedback clauses granting perpetual irrevocable licences; address open-source use.",
        "data_protection": "A DPA is required wherever personal data is processed. Controller / processor roles stated; sub-processor notification with a right to object; breach notification within 24-48 hours; a valid cross-border transfer mechanism; deletion or return on termination; defined security standards with audit rights or an accepted third-party report; purpose limitation.",
        "confidentiality": "Mutual obligations; scope limited to information disclosed for the purpose with the standard carveouts; survival of 2-5 years (trade secrets for as long as they remain trade secrets); return or destruction on termination with a legal/compliance retention exception.",
        "reps_warranties": "Core warranties on authority, non-infringement, conformity with documentation, and compliance with law. Resist a blanket 'as is' disclaimer of all warranties; survival period stated rather than silent.",
        "term_termination": "Stated initial term; renewal only on notice, or auto-renewal with a workable notice window (90 days preferred); termination for convenience with reasonable notice; termination for cause with a cure period (30 days is typical); defined effects of termination including data return, transition assistance and a scoped survival clause.",
        "governing_law": "A well-established commercial jurisdiction, with venue consistent with the governing law. Litigation preferred; where arbitration is required, agree the rules, seat and number of arbitrators. Escalate a jury waiver, class waiver or a remote or unusual venue.",
        "insurance": "Coverage appropriate to the risk (commercial general liability, professional liability / errors and omissions, cyber where data is processed, workers' compensation where personnel are on site) at commercially standard minimums, with certificates on request and notice of cancellation.",
        "assignment": "No assignment without consent, not to be unreasonably withheld, with a carveout for assignment to an affiliate or to a successor in a merger or sale of substantially all assets. Address change of control expressly rather than leaving it implied.",
        "force_majeure": "Reciprocal; limited to events genuinely beyond reasonable control; prompt notice and mitigation required; payment obligations excluded; a termination right if the event continues beyond a stated period (30-90 days).",
        "payment_terms": "Net 30-45 from a valid invoice; disputed amounts excluded from late fees while disputed in good faith; late fees at a reasonable rate; taxes allocated expressly; price increases capped and only on renewal with notice."
      }$val$::jsonb,
      'Standard positions for the twelve clause categories reviewed by the review-contract capability — prevailing US commercial contracting practice (the sort of positions an in-house playbook records), not case law. OVERRIDE EXPECTED: the firm must replace these with its own positions and acceptable ranges before relying on the review.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- contract.clause_review_checklist ----------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'contract.clause_review_checklist',
      $val$[
        "limitation_of_liability",
        "indemnification",
        "ip_ownership",
        "data_protection",
        "confidentiality",
        "reps_warranties",
        "term_termination",
        "governing_law",
        "insurance",
        "assignment",
        "force_majeure",
        "payment_terms"
      ]$val$::jsonb,
      'The twelve clause categories the review-contract capability walks, in review order — the most material risk-allocation clauses first, from the review-contract capability source. OVERRIDE EXPECTED: the firm should add categories it always reviews (e.g. service levels, security addendum) and reorder to its own priorities. Every entry must have a matching position in contract.standard_positions.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- contract.deviation_tiers ------------------------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'contract.deviation_tiers',
      $val${
        "GREEN": {
          "label": "Acceptable",
          "meaning": "The clause aligns with, or is better than, the firm standard position; any variation is commercially reasonable and does not materially increase risk.",
          "action": "Note for awareness. No negotiation needed.",
          "required_fields": ["clause", "contract_says", "playbook_position"]
        },
        "YELLOW": {
          "label": "Negotiate",
          "meaning": "The clause falls outside the standard position but within a negotiable range — common in the market, not preferred.",
          "action": "Generate specific redline language, give a fallback position, and state the impact of accepting as-is versus negotiating.",
          "required_fields": ["clause", "contract_says", "playbook_position", "deviation", "business_impact", "redline", "fallback", "priority"]
        },
        "RED": {
          "label": "Escalate",
          "meaning": "The clause falls outside the acceptable range, triggers an escalation criterion, or poses material risk.",
          "action": "Explain the specific risk, give market-standard alternative language, estimate the exposure, and name the escalation path. Do not concede without senior-counsel sign-off.",
          "required_fields": ["clause", "contract_says", "playbook_position", "deviation", "risk", "market_standard", "business_impact", "redline", "escalation_path"]
        }
      }$val$::jsonb,
      'Three-tier deviation grading from the review-contract capability source, with the fields each tier must carry so a graded finding is actionable rather than a bare colour. Market practice, not a legal standard. OVERRIDE EXPECTED: the firm should set its own tier boundaries and sign-off requirements.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- contract.negotiation_priority_framework ---------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'contract.negotiation_priority_framework',
      to_jsonb($val$Negotiation priority framework — organise every redline into one of three tiers:

Tier 1 — Must-haves (deal-breakers). Issues the firm cannot proceed without resolving: uncapped or materially insufficient liability protection; missing data protection requirements where regulated data is processed; IP provisions that could jeopardise core assets; terms that conflict with a regulatory obligation.

Tier 2 — Should-haves (strong preferences). Issues that materially affect risk but leave negotiating room: liability cap adjustments within range; indemnification scope and mutuality; termination flexibility; audit and compliance rights.

Tier 3 — Nice-to-haves (concession candidates). Issues that improve the position but can be traded: preferred governing law where the alternative is acceptable; notice-period preferences; minor definitional improvements; insurance certificate mechanics.

Strategy: lead with Tier 1. Trade Tier 3 concessions to win Tier 2. Never concede a Tier 1 item without escalation and sign-off. Adjust tone to the relationship — new vendor, strategic partner, or commodity supplier — and to any deadline the business has stated.$val$::text),
      'Negotiation prioritisation from the review-contract capability source — commercial negotiation practice, not a legal standard. OVERRIDE EXPECTED: the firm should move items between tiers to match its own risk appetite and sign-off matrix.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;

  -- contract.escalation.notification_template -------------------------------
  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'contract.escalation.notification_template',
      jsonb_build_object(
        'subject',
        'Contract Review Escalation — {{severity}} — {{title}}',
        'body',
        $val$A contract review has surfaced a clause requiring senior-counsel attention.

Document: {{title}}
Severity: {{severity}}
Summary: {{summary}}

This item is outside the firm's acceptable range under the contract playbook and should not be conceded without sign-off. Please advise whether to hold the position, accept the proposed redline, or escalate further.$val$
      ),
      'EscalationDraft template prefilled by the review-contract capability when a clause is graded RED. Placeholders ({{title}}, {{severity}}, {{summary}}) are filled at render time. Mirrors the shape of the CRE escalation template seeded by 009. OVERRIDE EXPECTED: firms tailor the wording and the addressee conventions.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md,
    is_default = excluded.is_default,
    updated_by = excluded.updated_by;
end $$;

-- ===========================================================================
-- Section B — chat columns for the in-chat capability run path
-- ===========================================================================

alter table public.chats
  add column if not exists suggestion_settings jsonb not null default '{}'::jsonb;

comment on column public.chats.suggestion_settings is
  'Per-chat capability-suggestion settings (e.g. muted capability ids, whether the user dismissed suggestions for this chat). Defaults to an empty object, which means "firm defaults apply".';

alter table public.chat_messages
  add column if not exists capability_run jsonb;

comment on column public.chat_messages.capability_run is
  'Structured capability-run record for this message: the capability id, the intake the user supplied, and the structured result the run produced (shaped by the capability outputSpec). Null on every ordinary chat message.';
