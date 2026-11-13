// backend/src/lib/legalCapabilities/creProfiles.ts
//
// CRE (Commercial Real Estate) workflow profiles and shared constants.
//
// This module is the SINGLE backend source of truth for the US Commercial
// Lease Abstraction tabular column set. Phase 4's frontend tabular pack
// MUST mirror these columns rather than redefining them. The capability
// module (commercialRealEstate.ts), the upload classifier (creClassifier.ts),
// and the capability↔seed guard test all import the shared constants here so
// the document-hint vocabulary and the playbook-key set never drift across
// the three call sites.
//
// Column formats map ONLY onto the 9 existing ColumnFormat values declared
// in workflowShared.ts (no new formats are introduced here):
//   - base / percentage rent / TI allowance → monetary_amount
//   - dates (lease/commencement/expiration/rent commencement) → date
//   - RSF → number
//   - pro-rata share → percentage
//   - options / exclusives / co-tenancy / lists → bulleted_list
//   - SNDA-required / estoppel-required / personal-guaranty → yes_no
//   - lease type (NNN / Gross / MG) → tag
//   - everything else → text
//
// Selected column prompts reference the firm playbook via
// `{{playbook:cre.lease.standard_positions}}` / `{{playbook:cre.lease.deal_breakers}}`
// so the tabular extraction is firm-steered: the runtime substitutes the
// firm's current playbook entry into the column prompt before extraction
// (see systemPrompt/substitute.ts + the tabular path).

import type { ColumnConfig } from "./workflowShared";

/**
 * The canonical CRE playbook-key set. The capability's `playbookKeys` MUST
 * equal this array, and the seed migration (009_cre_playbook_seed.sql) MUST
 * seed every key listed here. The capability↔seed guard test
 * (commercialRealEstate.test.ts) asserts that every `cre.*` key referenced
 * by the capability is present in this list, so adding a key here without
 * seeding it — or seeding a key not listed here — is caught in CI.
 *
 * NOTE: the shared `risk.escalation_thresholds` key is intentionally NOT in
 * this array. It is a cross-capability shared key referenced via the
 * escalation declaration; the seed migration inserts it with
 * ON CONFLICT DO NOTHING so a future shared value is never clobbered.
 */
export const CRE_PLAYBOOK_KEYS = [
    "cre.lease.standard_positions",
    "cre.lease.deal_breakers",
    "cre.estoppel.requirements",
    "cre.snda.requirements",
    "cre.psa.standard_positions",
    "cre.diligence.required_documents",
    "cre.escalation.notification_template",
] as const;

/**
 * Lowercased document-hint phrases shared by the capability's intentSignals
 * and the upload classifier. Keep every entry lowercased — both consumers
 * match against lowercased haystacks (message text / filename / extracted
 * body text). Ordering here is not significant; the classifier applies its
 * own specific-before-generic ordering.
 *
 * A document hint fires a proposal on its own (docHits >= 1 is the router's
 * structural signal), so every phrase here must be SPECIFIC to a CRE
 * instrument. Bare "subordination" and bare "purchase and sale" were removed
 * for that reason: they name ordinary transactional concepts (a subordinated
 * loan, the purchase and sale of shares or futures) and produced confident
 * CRE proposals on non-CRE matters. The specific forms
 * ("subordination, non-disturbance", "purchase and sale agreement") carry the
 * same recall for real CRE documents without the false positives.
 */
export const CRE_DOCUMENT_HINTS = [
    "commercial lease",
    "estoppel certificate",
    "subordination, non-disturbance",
    "non-disturbance",
    "purchase and sale agreement",
    "psa",
    "rent roll",
    "title commitment",
    "snda",
    "cam",
    "co-tenancy",
] as const;

/**
 * Default represented side for a CRE review whose `represented_party` was
 * never persisted (legacy rows, or a review created before P2). The tabular
 * substitution path uses this as the fallback so the {{representedParty}}
 * placeholder still resolves to a concrete, sensible side rather than the
 * generic neutral default. The choice mirrors the modal defaults: a
 * purchase-and-sale review defaults to "Buyer"; every other CRE document
 * type (lease, estoppel, SNDA) defaults to "Tenant".
 *
 * Built-in CRE packs are system workflows, so a review created from one does
 * NOT persist a `workflow_id` — we therefore sniff the column names rather
 * than the workflow id. A PSA pack is identified by its buyer/seller/purchase
 * vocabulary; anything else falls through to the lease-side default.
 */
export function defaultRepresentedPartyForColumns(
    columns: { name: string }[] | null | undefined,
): "Buyer" | "Tenant" {
    const names = (columns ?? []).map((c) => c.name.toLowerCase());
    const looksLikePsa = names.some(
        (n) =>
            n === "purchaser" ||
            n === "seller" ||
            n.includes("purchase price") ||
            n.includes("earnest money"),
    );
    return looksLikePsa ? "Buyer" : "Tenant";
}

/**
 * US Commercial Lease Abstraction column set. Indices are 0-based and
 * contiguous in declaration order, matching the existing tabular convention.
 *
 * DUAL SOURCE — keep BYTE-IDENTICAL with the frontend `builtin-us-commercial-lease`
 * pack in frontend/src/app/components/workflows/builtinWorkflows.ts. The
 * frontend tabular store is a separate hand-authored array (it carries the
 * full CocoLegalWorkflow shape the UI needs); this constant is the backend
 * capability source. The two MUST mirror the same column names / prompts /
 * formats / tags / indices 0-28. The P1b demo-polish pass sharpened the
 * high-value prompts (anchor-to-clause, grade-against-playbook with the
 * green/yellow/red risk vocabulary, the {{representedParty}} dual-representation
 * placeholder, and elite-counsel sub-points); edit both files together.
 */
export const US_COMMERCIAL_LEASE_COLUMNS: ColumnConfig[] = [
    {
        index: 0,
        name: "Landlord",
        prompt:
            "Identify the landlord / lessor as named in the lease, including the full legal entity name and entity type (e.g., LLC, LP). If the lease is later assigned, note the current landlord of record.",
        format: "text",
    },
    {
        index: 1,
        name: "Tenant",
        prompt:
            "Identify the tenant / lessee as named in the lease, including the full legal entity name and entity type. Note any trade name / d/b/a if stated.",
        format: "text",
    },
    {
        index: 2,
        name: "Guarantor / Personal Guaranty",
        prompt:
            "Is there a guaranty of the tenant's obligations? Answer Yes only if a guaranty exists; anchor to the guaranty section/exhibit and page. Identify the guarantor and the TYPE: full payment-and-performance guaranty vs. a good-guy guaranty (personal exposure capped at vacating and surrendering in good condition, rent current). Capture whether liability burns off or steps down over the term and any net-worth/credit covenant. Grade against {{playbook:cre.lease.standard_positions}}: a good-guy guaranty is the tenant-favorable market middle; a full personal guaranty with no burn-off and no cap, where one would not be market for the tenant's credit, is a Material/Deal-breaker deviation per {{playbook:cre.lease.deal_breakers}} (red) — say so and frame from {{representedParty}}'s side (the counterparty will resist a burn-off). Absence of any guaranty where the represented party would expect one is a missing-but-material gap (grey), not compliance.",
        format: "yes_no",
    },
    {
        index: 3,
        name: "Premises & RSF",
        prompt:
            "State the rentable square footage (RSF) of the demised premises as a number, anchored to the premises/measurement clause and page. Capture the RSF-vs-usable (USF) distinction and the load / add-on factor (RSF÷USF); if only USF is given, derive RSF and note the basis. Identify the named measurement standard AND VERSION (e.g., ANSI/BOMA Z65.1-2024 office, Z65.2 industrial, Z65.5 retail), not merely 'BOMA'. Grade against {{playbook:cre.lease.standard_positions}}: an unspecified-version standard or an uncapped load factor (office market ~1.10-1.15) is an off-market ambiguity (yellow); a landlord remeasurement right that can reset RSF/rent without a material-reconfiguration trigger cuts against a tenant — frame from {{representedParty}}'s side (the counterparty will want remeasurement discretion). If the figure is not stated, leave blank (grey).",
        format: "number",
    },
    {
        index: 4,
        name: "Lease Type",
        prompt:
            "Classify the lease structure as one of: NNN (triple net), Gross (full-service), or MG (modified gross). Base the call on how operating expenses, taxes, and insurance are allocated, not solely on the lease's label.",
        format: "tag",
        tags: ["NNN", "Gross", "MG"],
    },
    {
        index: 5,
        name: "Lease Date",
        prompt:
            "The date the lease was executed / dated (the effective date of the agreement itself), not the commencement date. Report as a date.",
        format: "date",
    },
    {
        index: 6,
        name: "Commencement Date",
        prompt:
            "The lease commencement date (the start of the lease term). Distinguish from the rent commencement date if they differ. Report as a date.",
        format: "date",
    },
    {
        index: 7,
        name: "Expiration Date",
        prompt:
            "The scheduled expiration / termination date of the initial lease term (excluding unexercised renewal options). Report as a date.",
        format: "date",
    },
    {
        index: 8,
        name: "Rent Commencement",
        prompt:
            "The date on which the tenant's obligation to pay base rent begins, after any free-rent / abatement period. Report as a date.",
        format: "date",
    },
    {
        index: 9,
        name: "Base Rent",
        prompt:
            "The initial base / minimum rent, anchored to the rent clause/schedule and page. Report the monetary amount, state the period (per month or per year), and give the rate per RSF if derivable. Use the rent for the first full rent-paying period and note that it is the starting rate that the escalation column then steps. This is an ECONOMIC term — quantify it; it is the denominator for grading escalations, holdover, and percentage rent.",
        format: "monetary_amount",
    },
    {
        index: 10,
        name: "Rent Escalations",
        prompt:
            "Summarize how base rent escalates over the term, anchored to the escalation clause and page. State the MECHANIC and capture the distinction: FIXED bumps (percentage or dollar steps — predictable, tenant-favorable) vs. CPI/index-linked (state whether there is a CAP and FLOOR, and whether CPI is capped-and-collared or uncapped) vs. to-FMV / market resets. Include the rate/step and frequency. Grade against {{playbook:cre.lease.standard_positions}}: uncapped CPI indexing is an off-market, open-ended economic exposure to a tenant (yellow/red) — frame from {{representedParty}}'s side (the counterparty resists a cap; the market middle is a fixed bump or capped-and-collared CPI). This is an ECONOMIC term.",
        format: "text",
    },
    {
        index: 11,
        name: "Free Rent / Abatement",
        prompt:
            "List any rent abatement / free-rent concessions, anchored to the concession clause and page: the number of abated months/periods; whether abatement covers base rent ONLY or also additional rent (CAM/taxes/insurance) — abatement of base rent only still leaves the tenant paying OpEx; and any conditions or recapture-on-default CLAWBACK (which lets the landlord recover abated rent if the tenant later defaults). This is an ECONOMIC concession; frame from {{representedParty}}'s side (a tenant wants gross abatement and no clawback).",
        format: "bulleted_list",
    },
    {
        index: 12,
        name: "TI Allowance",
        prompt:
            "The tenant improvement (TI) allowance, anchored to the work-letter / TI clause and page. Report the monetary amount and whether it is a lump sum or per-RSF, plus the key sub-points: any unused-allowance FORFEITURE (use-it-or-lose-it) or right to apply the balance to rent; whether over-allowance work the landlord funds is AMORTIZED back into rent (and at what rate); and who controls/owns the improvements. This is an ECONOMIC term; frame from {{representedParty}}'s side (a tenant wants a larger allowance, the unused balance applied to rent, and no above-market amortization).",
        format: "monetary_amount",
    },
    {
        index: 13,
        name: "CAM / Operating Expenses",
        prompt:
            "Summarize the operating-expense / CAM structure, anchored to the OpEx/CAM clause and page. Capture, as distinct sub-points: (a) the pass-through method (NNN pro-rata vs. base-year/expense-stop for a gross lease); (b) the CAP on controllable expenses — state the cap %/yr AND whether it is CUMULATIVE (unused headroom carries forward — landlord-favorable) or COMPOUNDED (annual ceiling on a compounding base — tenant-favorable), and which categories are carved out as non-controllable (taxes, insurance, utilities, snow/security); (c) the GROSS-UP provision and the occupancy % it grosses up to (95-100%) — a missing gross-up on a base-year lease is a tenant-adverse trap that understates the base year; (d) key EXCLUSIONS the tenant should have (capital expenditures except amortized/cost-saving/code-mandated, landlord negligence/default, affiliate overcharges, leasing/marketing/brokerage, ground rent and debt service); (e) the AUDIT RIGHT (time-boxed, with landlord paying on a >3-5% overcharge). Grade against {{playbook:cre.lease.standard_positions}}; UNCAPPED controllable CAM (or an illusory cap) is a Deal-breaker per {{playbook:cre.lease.deal_breakers}} (red). Frame from {{representedParty}}'s side; this is an ECONOMIC exposure.",
        format: "text",
    },
    {
        index: 14,
        name: "Pro-Rata Share",
        prompt:
            "The tenant's pro-rata share of operating expenses / taxes, expressed as a percentage. If stated as RSF-over-building-RSF, compute the percentage. Leave blank if not determinable.",
        format: "percentage",
    },
    {
        index: 15,
        name: "Percentage Rent",
        prompt:
            "If the lease includes percentage rent (typical in retail), anchor to the percentage-rent clause and page and report the percentage rate and the breakpoint as a monetary amount — state whether the breakpoint is NATURAL (base rent ÷ percentage rate) or an artificial stated figure. Capture the gross-sales DEFINITION and its carve-outs (returns, employee sales, inter-store transfers, gift cards until redeemed, online sales unless fulfilled from the store), and any related radius restriction. Grade against {{playbook:cre.lease.standard_positions}}: a below-natural breakpoint or a gross-sales definition with no exclusions cuts against a tenant; an over-broad radius restriction raises STATE-SPECIFIC enforceability concerns (consult-counsel trigger). Frame from {{representedParty}}'s side. If there is no percentage rent, leave blank (grey).",
        format: "monetary_amount",
    },
    {
        index: 16,
        name: "Permitted Use",
        prompt:
            "The permitted-use clause: the specific use(s) the tenant may make of the premises, and any express prohibition on change of use without landlord consent.",
        format: "text",
    },
    {
        index: 17,
        name: "Exclusive Use",
        prompt:
            "List any exclusive-use rights granted to the tenant (a covenant barring the landlord from leasing to competing uses), anchored to the exclusive clause and page. For each, capture: the SCOPE of the protected use; whether the exclusive has TEETH (injunctive relief plus a rent-reduction / percentage-only-rent remedy on breach, vs. a bare covenant with no remedy); and the carve-outs (existing tenants, incidental/ancillary sales, anchor exceptions). Grade against {{playbook:cre.lease.standard_positions}}: a narrowly-scoped exclusive, or one with no breach remedy, is off-market for a retail tenant (yellow). Frame from {{representedParty}}'s side (the counterparty wants a narrow exclusive with broad carve-outs). Absence where the represented party would expect protection is a missing-but-material gap (grey).",
        format: "bulleted_list",
    },
    {
        index: 18,
        name: "Co-Tenancy",
        prompt:
            "List any co-tenancy conditions, anchored to the co-tenancy clause and page. Distinguish OPENING co-tenancy (named anchors + an occupancy threshold, e.g., ~65-70%, open as of rent commencement) from ONGOING co-tenancy (maintained during the term), and capture the full REMEDY LADDER: substitute/percentage-only or reduced rent (e.g., ~50% abatement) while the failure persists, then a TERMINATION right if it continues past a cure window (~9-12 months), ideally paired with a go-dark right. Grade against {{playbook:cre.lease.standard_positions}}: co-tenancy with NO abatement and NO termination remedy is cosmetic and a Deal-breaker for a retail tenant per {{playbook:cre.lease.deal_breakers}} (red). This is a CONTINGENT risk (triggers only on a co-tenancy failure). Frame from {{representedParty}}'s side (the counterparty resists ongoing co-tenancy and long abatements).",
        format: "bulleted_list",
    },
    {
        index: 19,
        name: "Renewal / Extension Options",
        prompt:
            "List each renewal / extension option, anchored to the option clause and page: the number of options and length of each; the NOTICE WINDOW to exercise (and whether time is of the essence — a missed window forfeits the option); whether the option is personal or assignable and conditioned on no-default; and how renewal rent is set — FIXED/escalated (predictable) vs. FMV/market, and if FMV, whether there is a determination mechanic (broker/baseball arbitration) and a floor at the prior rent. Also distinguish renewal from any EXPANSION option. Grade the notice window and rent-setting method against {{playbook:cre.lease.standard_positions}} (market is ~9-12 months' notice with an arbitrated FMV); frame from {{representedParty}}'s side. Absence of a renewal right where the represented party expects one is a missing-but-material gap (grey).",
        format: "bulleted_list",
    },
    {
        index: 20,
        name: "Purchase Option / ROFR / ROFO",
        prompt:
            "List any purchase option, right of first offer (ROFO), or right of first refusal (ROFR) over the premises or building, anchored to the clause and page. CRITICAL distinction: a ROFO (landlord must offer to the tenant before marketing to third parties) is cleaner and more enforceable than a ROFR (tenant must MATCH a bona fide third-party offer — which chills third-party bids and is harder to exercise); state which one this is. For each, capture the trigger, the pricing mechanism (fixed, formula, or match), and the notice/response periods. Grade against {{playbook:cre.lease.standard_positions}} and frame from {{representedParty}}'s side (a tenant prefers a ROFO; a landlord/seller prefers a ROFR or neither). Note that purchase-option and ROFR enforceability can be STATE-SPECIFIC (consult-counsel trigger).",
        format: "bulleted_list",
    },
    {
        index: 21,
        name: "Assignment & Subletting",
        prompt:
            "Summarize the assignment and subletting provisions, anchored to the clause and page, capturing each high-value sub-point: (a) the CONSENT STANDARD — 'sole and absolute discretion' (landlord-favorable) vs. 'not to be unreasonably withheld, conditioned, or delayed' (tenant-favorable), and whether there is a deemed-consent clock; (b) any RECAPTURE / termination right letting the landlord take back the space on a proposed transfer; (c) PROFIT-SHARING on excess rent or other consideration (state the split, e.g., 50/50); (d) PERMITTED-TRANSFER / affiliate carve-outs (transfers to affiliates, successors by merger, or a buyer of substantially all assets without consent); and (e) — frequently missed — an express CHANGE-OF-CONTROL carve-out so an equity sale or reorganization is NOT a deemed assignment requiring consent. Grade against {{playbook:cre.lease.standard_positions}}: a sole-discretion consent with recapture and no permitted-transfer or change-of-control carve-out is off-market/Material against a tenant; absence of the change-of-control carve-out is a missing-but-material tenant trap (grey/red). Frame from {{representedParty}}'s side (the counterparty wants discretion + recapture + profit share).",
        format: "text",
    },
    {
        index: 22,
        name: "SNDA Required",
        prompt:
            "Does the lease OBLIGATE the landlord to deliver an SNDA (subordination, non-disturbance, and attornment agreement) from current and FUTURE lenders, or merely subordinate the lease to the mortgage? Answer Yes only if a non-disturbance right / SNDA-delivery obligation is actually provided for; anchor to the subordination clause and page. Distinguish self-operative subordination (lease automatically subordinate) from a true delivery obligation, and capture whether lender notice-and-cure is preserved. Evaluate against {{playbook:cre.snda.requirements}}: a lease that subordinates with NO non-disturbance obligation is a Deal-breaker per {{playbook:cre.lease.deal_breakers}} (the tenant can be wiped out on a foreclosure of a default it did not cause) — grade red and treat the absence as a missing-but-material gap, NOT compliance. This is a CONTINGENT risk (triggers on foreclosure). Frame from {{representedParty}}'s side.",
        format: "yes_no",
    },
    {
        index: 23,
        name: "Estoppel Required",
        prompt:
            "Does the lease obligate the tenant (or landlord) to deliver an estoppel certificate on request? Answer Yes if an estoppel obligation exists; anchor to the clause and page. Capture the delivery deadline (market turnaround ~10-20 days), whether the form is knowledge-qualified, whether it is capped in frequency, and whether a failure-to-respond deems the estoppel given or appoints the requesting party attorney-in-fact (a tenant-adverse self-executing mechanic). Evaluate against {{playbook:cre.estoppel.requirements}} and frame from {{representedParty}}'s side (a buyer/lender wants a broad, unqualified cert as a closing condition; a tenant wants a minimal, knowledge-qualified cert that cannot modify the lease). An unreasonably short deadline or a deemed-given default is off-market (yellow).",
        format: "yes_no",
    },
    {
        index: 24,
        name: "Insurance & Indemnity",
        prompt:
            "Summarize the tenant's insurance and indemnity obligations, anchored to the clause and page: CGL limits, property/casualty coverage, the WAIVER OF SUBROGATION (mutual is market — it stops insurers from suing the other party), and additional-insured requirements; and the INDEMNIFICATION allocation — whether it is mutual or one-sided, and whether the tenant must indemnify the landlord even for the landlord's OWN negligence (off-market and unenforceable in some states). Grade against {{playbook:cre.lease.standard_positions}} and frame from {{representedParty}}'s side; flag a one-sided indemnity or a missing mutual waiver of subrogation (yellow). Note that anti-indemnity enforceability is STATE-SPECIFIC (consult-counsel trigger).",
        format: "text",
    },
    {
        index: 25,
        name: "Holdover",
        prompt:
            "State the holdover terms, anchored to the holdover clause and page: the holdover rent as a MULTIPLE of the last month's rent (market is 150-200%) and whether holdover is month-to-month or at sufferance. CRITICALLY, capture whether the clause also exposes the tenant to CONSEQUENTIAL / special damages (e.g., the landlord's liability to a successor tenant it cannot deliver to) — that exposure, layered on premium holdover rent, is a tenant Deal-breaker per {{playbook:cre.lease.deal_breakers}} (red); the market protection is a percentage-of-rent cap with consequential damages expressly excluded. Grade the multiple against {{playbook:cre.lease.standard_positions}} and frame from {{representedParty}}'s side (the counterparty wants a high multiple and consequential exposure to force timely surrender). This is a CONTINGENT risk.",
        format: "text",
    },
    {
        index: 26,
        name: "Default & Remedies",
        prompt:
            "Summarize the events of default and remedies, anchored to the clause and page. Separate MONETARY from NON-MONETARY defaults and state the NOTICE-AND-CURE period for each (market: written notice + a few business days for monetary, ~30 days for non-monetary, extended if not reasonably curable). Assess SYMMETRY: does the tenant get reciprocal landlord-default notice-and-cure and self-help/OFFSET / abatement rights, or are the remedies one-sided in the landlord's favor (acceleration, re-letting, termination, no offset)? Grade against {{playbook:cre.lease.standard_positions}}: no cure period, or landlord remedies with no reciprocal tenant offset/self-help, is off-market against a tenant (yellow/red). Frame from {{representedParty}}'s side. Note that acceleration and liquidated-damages enforceability can be STATE-SPECIFIC (consult-counsel trigger).",
        format: "text",
    },
    {
        index: 27,
        name: "Casualty & Condemnation",
        prompt:
            "Summarize the casualty and condemnation provisions, anchored to the clause and page, capturing: (a) the TERMINATION THRESHOLDS — damage in the last N months of the term, a stated percentage of the premises/building damaged or taken, or restoration not feasible within a stated period — and WHICH PARTY may terminate on each; (b) the RESTORATION obligation and whether it is conditioned on availability of insurance/condemnation PROCEEDS and the lender's release of those proceeds (a tenant wants a self-help or termination right if the landlord/lender will not fund the rebuild — this can COLLIDE with loan documents requiring proceeds be applied to the debt); (c) the rent-ABATEMENT mechanic during restoration (proportional to the untenantable area). Grade against {{playbook:cre.lease.standard_positions}}: a landlord termination right with no tenant reciprocal right, or no rent abatement during restoration, is off-market against a tenant (yellow). This is a CONTINGENT risk. Frame from {{representedParty}}'s side.",
        format: "text",
    },
    {
        index: 28,
        name: "Governing Law",
        prompt:
            "The governing-law / choice-of-law jurisdiction stated in the lease (typically the state where the property is located). Report the jurisdiction.",
        format: "text",
    },
];
