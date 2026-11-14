#!/usr/bin/env python3
"""Generate the CRE demo-polish sample documents as text-based .docx files.

These fixtures stage the "US Commercial Lease Abstraction" / PSA / estoppel
demo for the Cocoa Legal app. They are TEXT-BASED Word documents (selectable
text, no scanned images) because the app has no OCR.

The flagship lease is deliberately engineered to trip the four seeded
deal-breakers in backend/migrations/009_cre_playbook_seed.sql
(cre.lease.deal_breakers) so the demo lights up red flags + the EscalationDraft:

  1. Uncapped controllable CAM / operating expenses (no annual cap on the
     controllable bucket)                                          -> Section 7
  2. Personal guaranty with NO burn-off / no cap                   -> Article 24 + Exhibit D
  3. Holdover at 200% with consequential-damages exposure          -> Section 20
  4. NO SNDA / non-disturbance obligation (omitted protection)     -> Section 22 (bare subordination)

Everything else is drafted to market so most columns read green/yellow.

Run:  python3 fixtures/legal/generate.py
Deps: python-docx  (pip3 install python-docx)
"""

from __future__ import annotations

import os

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))

SAMPLE_FOOTER = "SAMPLE — for demonstration only. Fictional parties; not legal advice."


# --------------------------------------------------------------------------
# Shared formatting helpers
# --------------------------------------------------------------------------
def _base_styles(doc: Document) -> None:
    """Set a clean, readable Normal style and consistent heading sizes."""
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    normal.paragraph_format.space_after = Pt(8)
    normal.paragraph_format.line_spacing = 1.15


def add_footer(doc: Document) -> None:
    """Add the SAMPLE watermark line + page number to every section footer."""
    for section in doc.sections:
        footer = section.footer
        footer.is_linked_to_previous = False
        p = footer.paragraphs[0]
        p.text = SAMPLE_FOOTER
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        for run in p.runs:
            run.font.size = Pt(8)
            run.font.color.rgb = RGBColor(0x80, 0x80, 0x80)


def title_block(doc: Document, title: str, subtitle: str | None = None) -> None:
    t = doc.add_paragraph()
    t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = t.add_run(title)
    r.bold = True
    r.font.size = Pt(16)
    if subtitle:
        s = doc.add_paragraph()
        s.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sr = s.add_run(subtitle)
        sr.italic = True
        sr.font.size = Pt(11)
    doc.add_paragraph()


def h(doc: Document, text: str) -> None:
    """Article / major heading."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    r = p.add_run(text)
    r.bold = True
    r.font.size = Pt(12)


def sec(doc: Document, number: str, heading: str, body: str) -> None:
    """A numbered Section: bold 'Section X. Heading.' lead-in, then body text."""
    p = doc.add_paragraph()
    lead = p.add_run(f"{number} {heading}. ")
    lead.bold = True
    p.add_run(body)


def para(doc: Document, text: str) -> None:
    doc.add_paragraph(text)


def bullet(doc: Document, text: str) -> None:
    doc.add_paragraph(text, style="List Bullet")


def sig_block(doc: Document, label: str, lines: list[str]) -> None:
    doc.add_paragraph()
    lp = doc.add_paragraph()
    lr = lp.add_run(label)
    lr.bold = True
    for ln in lines:
        doc.add_paragraph(ln)


# ==========================================================================
# 1) SAMPLE COMMERCIAL LEASE (office, ~18 pp)
# ==========================================================================
def build_lease() -> Document:
    doc = Document()
    _base_styles(doc)

    title_block(
        doc,
        "OFFICE LEASE AGREEMENT",
        "Sample Tower • 1200 Example Plaza Boulevard, Suite 1800 • Exampleville, Connecticut",
    )

    para(
        doc,
        "THIS OFFICE LEASE AGREEMENT (this “Lease”) is made and entered into as of "
        "March 14, 2025 (the “Effective Date”), by and between SAMPLE TOWER "
        "OWNER, LLC, a Delaware limited liability company (“Landlord”), and "
        "EXAMPLE ANALYTICS, INC., a Delaware corporation (“Tenant”). Landlord and "
        "Tenant are each a “Party” and together the “Parties.” The obligations of "
        "Tenant under this Lease are guaranteed by MORGAN R. PLACEHOLDER, an individual "
        "residing in the State of Connecticut (“Guarantor”), pursuant to Article 24 and "
        "the Guaranty attached as Exhibit D.",
    )

    # ---- Recitals
    h(doc, "RECITALS")
    para(
        doc,
        "A. Landlord is the owner of the office building commonly known as Sample Tower "
        "located at 1200 Example Plaza Boulevard, Exampleville, Connecticut (the “Building”), "
        "together with the land, parking, and common areas (collectively, the “Project”).",
    )
    para(
        doc,
        "B. Tenant desires to lease from Landlord, and Landlord desires to lease to Tenant, "
        "certain premises within the Building on the terms and conditions set forth in this Lease.",
    )
    para(
        doc,
        "NOW, THEREFORE, in consideration of the mutual covenants contained herein, the "
        "Parties agree as follows:",
    )

    # ---- Article 1: Premises
    h(doc, "ARTICLE 1 — PREMISES")
    sec(
        doc, "Section 1.1", "Demised Premises",
        "Landlord hereby leases to Tenant, and Tenant hereby leases from Landlord, that "
        "certain office space designated as Suite 1800 on the eighteenth (18th) floor of the "
        "Building (the “Premises”), as more particularly depicted on the floor plan "
        "attached hereto as Exhibit A.",
    )
    sec(
        doc, "Section 1.2", "Rentable Area; Measurement Standard",
        "The Premises are stipulated to contain 24,500 rentable square feet (“Rentable "
        "Square Feet” or “RSF”) and 21,800 usable square feet (“USF”), reflecting "
        "a load (add-on) factor of approximately 1.124. The Premises have been measured in "
        "accordance with ANSI/BOMA Z65.1-2017, Method A (Legacy Method), Office Buildings: "
        "Standard Methods of Measurement. The rentable area so stipulated is conclusive and "
        "binding on the Parties for all purposes of this Lease and shall not be subject to "
        "remeasurement during the initial Term except in connection with a material physical "
        "reconfiguration of the Premises.",
    )
    sec(
        doc, "Section 1.3", "Tenant's Proportionate Share",
        "Tenant's Proportionate Share is 8.97%, computed as the Rentable Square Feet of the "
        "Premises (24,500) divided by the total rentable area of the Building (273,000 RSF).",
    )

    # ---- Article 2: Term
    h(doc, "ARTICLE 2 — TERM; COMMENCEMENT")
    sec(
        doc, "Section 2.1", "Term",
        "The initial term of this Lease (the “Term”) shall be one hundred twenty (120) "
        "months, commencing on the Commencement Date and expiring at 11:59 p.m. on the "
        "Expiration Date, unless sooner terminated or extended as provided herein.",
    )
    sec(
        doc, "Section 2.2", "Commencement Date",
        "The “Commencement Date” shall be June 1, 2025, being the date Landlord delivers "
        "the Premises to Tenant with Landlord's Work substantially complete.",
    )
    sec(
        doc, "Section 2.3", "Rent Commencement Date",
        "Notwithstanding the Commencement Date, Tenant's obligation to pay Base Rent shall "
        "not begin until December 1, 2025 (the “Rent Commencement Date”), following the "
        "Abatement Period described in Section 4.3.",
    )
    sec(
        doc, "Section 2.4", "Expiration Date",
        "The “Expiration Date” of the initial Term shall be May 31, 2035, excluding any "
        "exercised Renewal Term under Article 19.",
    )

    # ---- Article 3: Use
    h(doc, "ARTICLE 3 — USE")
    sec(
        doc, "Section 3.1", "Permitted Use",
        "Tenant shall use and occupy the Premises solely for general business office use, "
        "including data analytics, software development, and administrative functions, and for "
        "no other purpose. Tenant shall not change the use of the Premises without Landlord's "
        "prior written consent, which shall not be unreasonably withheld.",
    )
    sec(
        doc, "Section 3.2", "Compliance with Law",
        "Tenant shall comply with all applicable laws, ordinances, and regulations governing "
        "Tenant's particular use and occupancy of the Premises.",
    )

    # ---- Article 4: Rent (base rent, escalations, free rent)
    h(doc, "ARTICLE 4 — BASE RENT; ESCALATIONS; ABATEMENT")
    sec(
        doc, "Section 4.1", "Base Rent",
        "Commencing on the Rent Commencement Date, Tenant shall pay to Landlord annual base "
        "rent (“Base Rent”) initially equal to $42.00 per Rentable Square Foot, or "
        "$1,029,000.00 per year ($85,750.00 per month), payable in advance in equal monthly "
        "installments on the first day of each calendar month.",
    )
    sec(
        doc, "Section 4.2", "Annual Escalations",
        "Base Rent shall increase by three percent (3.0%) on each anniversary of the Rent "
        "Commencement Date, compounded annually over the Term. The escalation is a fixed "
        "percentage step and is not tied to any consumer price index. The Base Rent schedule "
        "is set forth on Exhibit B.",
    )
    sec(
        doc, "Section 4.3", "Free Rent / Abatement",
        "Tenant shall be entitled to abatement of Base Rent for the first six (6) full calendar "
        "months following the Commencement Date (the “Abatement Period”), being June 1, "
        "2025 through November 30, 2025. The abatement applies to Base Rent only; Tenant shall "
        "remain responsible for Additional Rent (including its Proportionate Share of Operating "
        "Expenses, Taxes, and insurance) during the Abatement Period. If this Lease is "
        "terminated on account of an Event of Default by Tenant, the unamortized portion of the "
        "abated Base Rent shall become immediately due and payable as Additional Rent.",
    )
    sec(
        doc, "Section 4.4", "Additional Rent",
        "All amounts other than Base Rent payable by Tenant under this Lease shall constitute "
        "“Additional Rent,” and Base Rent and Additional Rent are collectively “Rent.”",
    )

    # ---- Article 5: Tenant Improvements
    h(doc, "ARTICLE 5 — TENANT IMPROVEMENTS")
    sec(
        doc, "Section 5.1", "TI Allowance",
        "Landlord shall provide Tenant with a tenant improvement allowance of $70.00 per "
        "Rentable Square Foot, or $1,715,000.00 in the aggregate (the “TI Allowance”), to "
        "be applied toward the cost of Tenant's initial improvements to the Premises pursuant "
        "to the Work Letter attached as Exhibit C. The TI Allowance shall be disbursed against "
        "Tenant's requisitions in accordance with the Work Letter.",
    )
    sec(
        doc, "Section 5.2", "Unused Allowance",
        "Any portion of the TI Allowance not requisitioned by Tenant within twelve (12) months "
        "after the Commencement Date, up to $5.00 per Rentable Square Foot, may be applied by "
        "Tenant as a credit against Base Rent next coming due; the balance, if any, shall be "
        "retained by Landlord.",
    )

    # ---- Article 6: Net Lease structure
    h(doc, "ARTICLE 6 — LEASE STRUCTURE")
    sec(
        doc, "Section 6.1", "Triple Net",
        "This Lease is a triple net (NNN) lease. Except as expressly provided herein, Tenant "
        "shall pay, as Additional Rent, its Proportionate Share of all Operating Expenses, Real "
        "Estate Taxes, and insurance premiums for the Project, without offset or deduction "
        "except as expressly permitted under this Lease.",
    )

    # ---- Article 7: Operating Expenses / CAM  (DEAL-BREAKER #1 — UNCAPPED CONTROLLABLE CAM)
    h(doc, "ARTICLE 7 — OPERATING EXPENSES; COMMON AREA MAINTENANCE")
    sec(
        doc, "Section 7.1", "Pass-Through",
        "Tenant shall pay its Proportionate Share (8.97%) of all Operating Expenses incurred by "
        "Landlord in owning, operating, managing, insuring, maintaining, and repairing the "
        "Project, including common area maintenance (“CAM”), on a triple-net pro-rata "
        "basis, payable in monthly estimated installments subject to annual reconciliation.",
    )
    sec(
        doc, "Section 7.2", "Definition of Operating Expenses",
        "“Operating Expenses” means all costs of every kind and nature incurred by "
        "Landlord in connection with the ownership, operation, management, maintenance, repair, "
        "and replacement of the Project, including without limitation utilities for common "
        "areas, janitorial, landscaping, snow and ice removal, security, management fees, "
        "supplies, insurance, and the cost of capital improvements (amortized over their useful "
        "life).",
    )
    sec(
        doc, "Section 7.3", "No Cap on Controllable Expenses",
        "The Parties acknowledge and agree that there shall be NO ANNUAL CAP or other ceiling "
        "on the amount of Operating Expenses (including the controllable component thereof) "
        "that may be passed through to Tenant. Tenant shall pay its Proportionate Share of "
        "actual Operating Expenses as and when reconciled, without limitation, regardless of "
        "year-over-year increases in any category of controllable or non-controllable expense. "
        "Tenant expressly waives any right to a cap on controllable Operating Expenses.",
    )
    sec(
        doc, "Section 7.4", "Reconciliation; Audit",
        "Within one hundred twenty (120) days after the end of each calendar year, Landlord "
        "shall deliver to Tenant a reconciliation statement of actual Operating Expenses. "
        "Tenant may, upon thirty (30) days' notice and at Tenant's expense, audit Landlord's "
        "books for the reconciled year; if such audit discloses an overstatement exceeding five "
        "percent (5%), Landlord shall reimburse the reasonable cost of the audit and refund the "
        "overcharge.",
    )

    # ---- Article 8: Real Estate Taxes
    h(doc, "ARTICLE 8 — REAL ESTATE TAXES")
    sec(
        doc, "Section 8.1", "Taxes",
        "Tenant shall pay its Proportionate Share of all Real Estate Taxes assessed against the "
        "Project during the Term. “Real Estate Taxes” means all general and special real "
        "property taxes and assessments, but excludes income, franchise, inheritance, estate, "
        "gift, and transfer taxes of Landlord, and any interest or penalties resulting from "
        "Landlord's late payment.",
    )
    sec(
        doc, "Section 8.2", "Tax Contest",
        "Landlord shall have the right (but not the obligation) to contest the Real Estate Taxes. "
        "Any refund obtained, net of the reasonable cost of obtaining it, shall be credited "
        "against Real Estate Taxes for the year to which it relates and Tenant's Proportionate "
        "Share of such net refund shall be credited to Tenant.",
    )
    sec(
        doc, "Section 8.3", "Personal Property Taxes",
        "Tenant shall pay before delinquency all taxes assessed against Tenant's personal "
        "property, trade fixtures, and above-Building-standard improvements in the Premises.",
    )

    # ---- Article 9: Insurance & Indemnity
    h(doc, "ARTICLE 9 — INSURANCE; INDEMNITY")
    sec(
        doc, "Section 9.1", "Tenant's Insurance",
        "Tenant shall maintain commercial general liability insurance with limits of not less "
        "than $2,000,000 per occurrence and $5,000,000 in the aggregate, naming Landlord and "
        "its lender as additional insureds, together with property insurance on Tenant's "
        "personal property and improvements at full replacement cost.",
    )
    sec(
        doc, "Section 9.2", "Waiver of Subrogation",
        "Landlord and Tenant each waive all rights of recovery against the other, and their "
        "respective insurers, for loss or damage to the extent covered by property insurance "
        "carried (or required to be carried) by the waiving party. Each party shall cause its "
        "property insurer to consent to this mutual waiver of subrogation.",
    )
    sec(
        doc, "Section 9.3", "Indemnification",
        "Subject to the mutual waiver of subrogation in Section 9.2, each party shall indemnify, "
        "defend, and hold the other harmless from third-party claims arising out of the "
        "indemnifying party's negligence or willful misconduct in or about the Project, except "
        "to the extent caused by the negligence or willful misconduct of the party seeking "
        "indemnity.",
    )

    # ---- Article 10: Maintenance
    h(doc, "ARTICLE 10 — MAINTENANCE; REPAIRS")
    sec(
        doc, "Section 10.1", "Landlord's Obligations",
        "Landlord shall maintain in good condition and repair the structural elements of the "
        "Building (foundation, roof, exterior walls, and structural columns) and the Building "
        "systems serving the Premises in common with other tenants.",
    )
    sec(
        doc, "Section 10.2", "Tenant's Obligations",
        "Tenant shall maintain the non-structural interior of the Premises in good condition, "
        "ordinary wear and tear and casualty excepted.",
    )

    # ---- Article 11: Alterations
    h(doc, "ARTICLE 11 — ALTERATIONS")
    sec(
        doc, "Section 11.1", "Alterations",
        "Tenant shall not make structural alterations to the Premises without Landlord's prior "
        "written consent, not to be unreasonably withheld, conditioned, or delayed. "
        "Non-structural, cosmetic alterations under $50,000 may be made on prior notice without "
        "consent.",
    )

    # ---- Article 12: Services & Utilities
    h(doc, "ARTICLE 12 — SERVICES; UTILITIES")
    sec(
        doc, "Section 12.1", "Building Services",
        "Landlord shall furnish HVAC during Building business hours (Monday through Friday, 8:00 "
        "a.m. to 6:00 p.m., and Saturday 9:00 a.m. to 1:00 p.m., excluding Building holidays), "
        "electricity for normal office use, domestic water, passenger and freight elevator "
        "service, and Building-standard janitorial service to the Premises, the cost of which is "
        "included in Operating Expenses.",
    )
    sec(
        doc, "Section 12.2", "After-Hours and Excess Use",
        "After-hours HVAC shall be available on request and billed at Landlord's then-standard "
        "hourly rate. If Tenant's use materially exceeds normal office electrical consumption, "
        "Landlord may install a submeter at Tenant's cost and charge Tenant for excess "
        "consumption at Landlord's actual cost without markup.",
    )
    sec(
        doc, "Section 12.3", "Service Interruption Abatement",
        "If an interruption of an essential service within Landlord's reasonable control renders "
        "all or a material portion of the Premises untenantable and Tenant ceases to use the "
        "affected portion for more than five (5) consecutive business days after notice to "
        "Landlord, Base Rent shall abate proportionately for the affected portion from such fifth "
        "business day until the service is restored.",
    )

    # ---- Article 13: Assignment & Subletting  (MARKET — green/yellow)
    h(doc, "ARTICLE 13 — ASSIGNMENT AND SUBLETTING")
    sec(
        doc, "Section 13.1", "Consent Standard",
        "Tenant shall not assign this Lease or sublet all or any part of the Premises without "
        "the prior written consent of Landlord, which consent shall not be unreasonably "
        "withheld, conditioned, or delayed. Landlord shall respond to a written request for "
        "consent within fifteen (15) business days; failure to respond within such period shall "
        "be deemed consent.",
    )
    sec(
        doc, "Section 13.2", "Permitted Transfers",
        "Notwithstanding Section 13.1, Tenant may, without Landlord's consent but on ten (10) "
        "days' prior written notice, assign this Lease or sublet the Premises to (a) an "
        "Affiliate of Tenant, (b) a successor by merger, consolidation, or reorganization, or "
        "(c) a purchaser of all or substantially all of Tenant's assets, provided the "
        "transferee has a tangible net worth not less than Tenant's as of the Effective Date "
        "(each, a “Permitted Transfer”). A change in the direct or indirect ownership or "
        "control of Tenant shall not constitute an assignment requiring Landlord's consent.",
    )
    sec(
        doc, "Section 13.3", "Profit Sharing",
        "If Tenant assigns or sublets other than pursuant to a Permitted Transfer, Tenant and "
        "Landlord shall share equally (50/50) any rent or other consideration received by "
        "Tenant in excess of the Rent allocable to the transferred space, after deduction of "
        "Tenant's reasonable transaction costs.",
    )

    # ---- Article 14: Default & Remedies
    h(doc, "ARTICLE 14 — DEFAULT; REMEDIES")
    sec(
        doc, "Section 14.1", "Events of Default",
        "Each of the following constitutes an “Event of Default”: (a) Tenant fails to pay "
        "Rent when due and such failure continues for five (5) business days after written "
        "notice; or (b) Tenant fails to perform any non-monetary obligation and such failure "
        "continues for thirty (30) days after written notice (or, if not reasonably curable "
        "within thirty (30) days, such longer period as Tenant diligently pursues cure).",
    )
    sec(
        doc, "Section 14.2", "Landlord's Remedies",
        "Upon an Event of Default, Landlord may terminate this Lease, re-enter and relet the "
        "Premises, and recover damages, all remedies being cumulative. Landlord shall use "
        "commercially reasonable efforts to mitigate its damages by reletting the Premises.",
    )
    sec(
        doc, "Section 14.3", "Landlord Default; Tenant Self-Help",
        "If Landlord fails to perform an obligation under this Lease and such failure continues "
        "for thirty (30) days after written notice from Tenant (or such longer period as is "
        "reasonably required), Tenant may perform the obligation and offset the reasonable cost "
        "thereof against the next installments of Rent.",
    )

    # ---- Article 15: Estoppel  (MARKET — green/yellow)
    h(doc, "ARTICLE 15 — ESTOPPEL CERTIFICATES")
    sec(
        doc, "Section 15.1", "Estoppel Delivery",
        "Within fifteen (15) business days after written request, Tenant shall execute and "
        "deliver to Landlord (or to any prospective purchaser or lender designated by Landlord) "
        "an estoppel certificate, in a commercially reasonable form, certifying, to Tenant's "
        "knowledge, the commencement and expiration dates, the then-current Base Rent and "
        "Additional Rent, that this Lease is in full force and effect, and whether any defaults "
        "exist. No estoppel certificate shall be deemed to amend or modify this Lease, and in "
        "the event of any conflict, this Lease shall control.",
    )

    # ---- Article 16: Subordination  (DEAL-BREAKER #4 — NO SNDA / NON-DISTURBANCE)
    h(doc, "ARTICLE 16 — SUBORDINATION")
    sec(
        doc, "Section 16.1", "Subordination",
        "This Lease is and shall be automatically subject and subordinate to any mortgage, deed "
        "of trust, or ground lease now or hereafter encumbering the Project, and to all "
        "renewals, modifications, and extensions thereof. This subordination is self-operative "
        "and no further instrument of subordination shall be required to make it effective.",
    )
    sec(
        doc, "Section 16.2", "Attornment",
        "In the event of a foreclosure or deed in lieu, Tenant shall attorn to and recognize the "
        "successor owner as Landlord under this Lease. Tenant acknowledges that Landlord is "
        "under no obligation to obtain, and makes no representation that it will obtain, any "
        "non-disturbance agreement from any current or future holder of a mortgage or ground "
        "lease, and the continuation of this Lease following a foreclosure shall be at the sole "
        "election of such holder or successor owner.",
    )

    # ---- Article 17: Casualty
    h(doc, "ARTICLE 17 — CASUALTY")
    sec(
        doc, "Section 17.1", "Restoration",
        "If the Premises are damaged by fire or other casualty, Landlord shall repair and "
        "restore the Premises to substantially their prior condition, and Base Rent and "
        "Additional Rent shall abate proportionately to the portion of the Premises rendered "
        "untenantable from the date of casualty until restoration is substantially complete.",
    )
    sec(
        doc, "Section 17.2", "Termination Right",
        "If the damage occurs in the last twelve (12) months of the Term, or if Landlord's "
        "architect reasonably estimates that restoration cannot be completed within two hundred "
        "seventy (270) days, either Landlord or Tenant may terminate this Lease by written "
        "notice given within sixty (60) days after the casualty.",
    )

    # ---- Article 18: Condemnation
    h(doc, "ARTICLE 18 — CONDEMNATION")
    sec(
        doc, "Section 18.1", "Taking",
        "If all or a material portion of the Premises is taken by condemnation or eminent "
        "domain such that the Premises are no longer reasonably suitable for Tenant's permitted "
        "use, either party may terminate this Lease as of the date possession is taken. If only "
        "a portion is taken and the Lease continues, Base Rent shall be equitably reduced. Each "
        "party may pursue its own award; Tenant's claim shall be limited so as not to reduce "
        "Landlord's award.",
    )

    # ---- Article 19: Renewal  (MARKET — green/yellow)
    h(doc, "ARTICLE 19 — RENEWAL OPTION")
    sec(
        doc, "Section 19.1", "Renewal Option",
        "Provided no uncured Event of Default then exists, Tenant shall have one (1) option to "
        "extend the Term for a single renewal period of sixty (60) months (the “Renewal "
        "Term”) by delivering written notice to Landlord not less than nine (9) months and "
        "not more than twelve (12) months prior to the Expiration Date.",
    )
    sec(
        doc, "Section 19.2", "Renewal Rent",
        "Base Rent for the Renewal Term shall equal the then-prevailing fair market rental value "
        "(“FMV”) of the Premises, determined as of the commencement of the Renewal Term "
        "but in no event less than the Base Rent in effect immediately prior thereto. If the "
        "Parties cannot agree on FMV within thirty (30) days, FMV shall be determined by "
        "binding baseball (final-offer) arbitration before a qualified MAI appraiser.",
    )

    # ---- Article 20: Holdover  (DEAL-BREAKER #3 — 200% + CONSEQUENTIAL DAMAGES)
    h(doc, "ARTICLE 20 — HOLDOVER")
    sec(
        doc, "Section 20.1", "Holdover Rent",
        "If Tenant remains in possession of the Premises after the expiration or earlier "
        "termination of this Lease without Landlord's written consent, such occupancy shall be "
        "a tenancy at sufferance, and Tenant shall pay holdover rent equal to two hundred "
        "percent (200%) of the Base Rent and Additional Rent payable for the last month of the "
        "Term, for each month or partial month of holdover.",
    )
    sec(
        doc, "Section 20.2", "Consequential Damages",
        "In addition to holdover rent under Section 20.1, Tenant shall indemnify and hold "
        "Landlord harmless from and against any and all claims, losses, and liabilities "
        "resulting from Tenant's failure to surrender the Premises, INCLUDING WITHOUT "
        "LIMITATION any consequential, special, or indirect damages, lost profits, and any "
        "amounts Landlord becomes obligated to pay to any succeeding tenant to which Landlord is "
        "unable to deliver possession. The Parties agree that consequential damages arising from "
        "a holdover are NOT waived and are expressly recoverable by Landlord.",
    )

    # ---- Article 21: Surrender
    h(doc, "ARTICLE 21 — SURRENDER")
    sec(
        doc, "Section 21.1", "Surrender",
        "Upon expiration or termination, Tenant shall surrender the Premises in good condition, "
        "ordinary wear and tear, casualty, and condemnation excepted, and shall remove its "
        "personal property and any alterations Landlord required to be removed.",
    )

    # ---- Article 22: Quiet Enjoyment / SNDA cross-reference
    h(doc, "ARTICLE 22 — QUIET ENJOYMENT")
    sec(
        doc, "Section 22.1", "Quiet Enjoyment",
        "So long as no Event of Default exists, Tenant shall peaceably and quietly hold and "
        "enjoy the Premises for the Term, subject to the terms of this Lease, including the "
        "subordination provisions of Article 16. For the avoidance of doubt, Tenant's quiet "
        "enjoyment is subject to, and may be extinguished by, the rights of any mortgagee under "
        "Article 16, as to which Landlord has undertaken no non-disturbance obligation.",
    )

    # ---- Article 23: Notices
    h(doc, "ARTICLE 23 — NOTICES")
    sec(
        doc, "Section 23.1", "Notices",
        "All notices shall be in writing and delivered by hand, nationally recognized overnight "
        "courier, or certified mail to the addresses set forth on the signature page, or to "
        "such other address as a party may designate by notice.",
    )

    # ---- Article 24: Guaranty  (DEAL-BREAKER #2 — PERSONAL GUARANTY, NO BURN-OFF, NO CAP)
    h(doc, "ARTICLE 24 — GUARANTY")
    sec(
        doc, "Section 24.1", "Guaranty of Lease",
        "As a material inducement to Landlord to enter into this Lease, Guarantor has executed "
        "and delivered the Guaranty of Lease attached hereto as Exhibit D. Pursuant to the "
        "Guaranty, Guarantor absolutely, unconditionally, and irrevocably guarantees the full "
        "and punctual payment and performance of all of Tenant's obligations under this Lease.",
    )
    sec(
        doc, "Section 24.2", "Full Personal Guaranty; No Burn-Off; No Cap",
        "The Guaranty is a full payment-and-performance guaranty and is the personal obligation "
        "of Guarantor. Guarantor's liability under the Guaranty is NOT capped at any dollar "
        "amount and does NOT burn off, step down, expire, or otherwise diminish at any time "
        "during the Term or any Renewal Term, regardless of Tenant's payment history, financial "
        "condition, or the passage of time. The Guaranty is not a so-called “good guy” "
        "guaranty and is not limited to obligations accruing through any surrender of the "
        "Premises. Guarantor's liability shall continue in full force until all obligations "
        "under this Lease have been fully and finally performed.",
    )

    # ---- Article 25: Security Deposit / Letter of Credit
    h(doc, "ARTICLE 25 — SECURITY")
    sec(
        doc, "Section 25.1", "Security Deposit",
        "Tenant shall not be required to deposit a cash security deposit. In lieu thereof, "
        "Tenant has delivered to Landlord an unconditional, irrevocable standby letter of credit "
        "in the face amount of $257,250.00 (equal to three (3) months' initial Base Rent) issued "
        "by a money-center bank reasonably acceptable to Landlord (the “Letter of Credit”), "
        "as security for Tenant's obligations under this Lease.",
    )
    sec(
        doc, "Section 25.2", "Burn-Down of Letter of Credit",
        "Provided no Event of Default has occurred and is continuing, the face amount of the "
        "Letter of Credit shall be reduced by one-third (1/3) on each of the third and fifth "
        "anniversaries of the Rent Commencement Date, such that from and after the fifth "
        "anniversary the required face amount shall equal one (1) month's then-current Base Rent. "
        "Landlord may draw on the Letter of Credit only after an uncured Event of Default.",
    )

    # ---- Article 26: Parking
    h(doc, "ARTICLE 26 — PARKING")
    sec(
        doc, "Section 26.1", "Parking Rights",
        "Throughout the Term, Tenant shall have the non-exclusive right to use seventy-three "
        "(73) unreserved parking spaces in the Building's parking structure (a ratio of 3.0 "
        "spaces per 1,000 RSF), of which up to seven (7) may be converted to reserved spaces on "
        "request. Parking shall be provided at no separate charge during the initial Term; the "
        "cost of operating and maintaining the parking structure is included in Operating "
        "Expenses.",
    )

    # ---- Article 27: Signage
    h(doc, "ARTICLE 27 — SIGNAGE")
    sec(
        doc, "Section 27.1", "Building-Standard and Directory Signage",
        "Landlord shall provide, at Landlord's cost, Building-standard suite-entry signage and a "
        "listing on the Building lobby directory. So long as Tenant leases the entire eighteenth "
        "(18th) floor, Tenant shall have the non-exclusive right, subject to Landlord's prior "
        "approval of size, materials, and location (not to be unreasonably withheld) and to "
        "applicable law, to install one (1) eyebrow or elevator-lobby sign on its floor at "
        "Tenant's cost.",
    )

    # ---- Article 28: Hazardous Materials
    h(doc, "ARTICLE 28 — HAZARDOUS MATERIALS")
    sec(
        doc, "Section 28.1", "Tenant Covenant",
        "Tenant shall not generate, store, release, or dispose of any Hazardous Materials in, on, "
        "or about the Project, except for de minimis quantities of ordinary office and cleaning "
        "supplies used and stored in compliance with applicable Environmental Laws. Tenant shall "
        "indemnify Landlord for any breach of this Section attributable to Tenant.",
    )
    sec(
        doc, "Section 28.2", "Landlord Representation",
        "To Landlord's knowledge, the Premises are, as of the Commencement Date, free of "
        "Hazardous Materials in violation of applicable Environmental Laws, and Landlord shall be "
        "responsible for remediation of any pre-existing or Building-systems contamination not "
        "caused by Tenant.",
    )

    # ---- Article 29: Rules and Regulations
    h(doc, "ARTICLE 29 — RULES AND REGULATIONS")
    sec(
        doc, "Section 29.1", "Rules",
        "Tenant shall comply with the reasonable, non-discriminatory rules and regulations for "
        "the Building attached as Exhibit E, as Landlord may reasonably amend them from time to "
        "time on prior notice. In the event of any conflict between the rules and regulations and "
        "the express terms of this Lease, this Lease shall control.",
    )

    # ---- Article 30: Expansion Option (ROFO)
    h(doc, "ARTICLE 30 — EXPANSION; RIGHT OF FIRST OFFER")
    sec(
        doc, "Section 30.1", "Right of First Offer",
        "Provided no uncured Event of Default exists, Tenant shall have an ongoing right of first "
        "offer (a “ROFO,” not a right to match a third-party offer) on any contiguous space "
        "on the seventeenth (17th) floor that becomes available during the first sixty (60) "
        "months of the Term. Before marketing such space to a third party, Landlord shall offer "
        "it to Tenant in writing on the economic terms Landlord intends to offer to the market; "
        "Tenant shall have ten (10) business days to accept, failing which Landlord may lease the "
        "space to a third party on terms not materially more favorable than those offered to "
        "Tenant.",
    )

    # ---- Article 31: Late Charges; Interest
    h(doc, "ARTICLE 31 — LATE CHARGES; INTEREST")
    sec(
        doc, "Section 31.1", "Late Charge",
        "If any installment of Rent is not received within five (5) business days after it is "
        "due, Tenant shall pay a late charge equal to three percent (3%) of the overdue amount; "
        "and any amount not paid when due shall bear interest at the lesser of (a) the prime rate "
        "plus three percent (3%) per annum and (b) the maximum rate permitted by applicable law, "
        "from the due date until paid. A late charge shall not be imposed on the first late "
        "payment in any twelve-month period if cured within three (3) business days after notice.",
    )

    # ---- Article 32: Mechanics' Liens
    h(doc, "ARTICLE 32 — MECHANICS' LIENS")
    sec(
        doc, "Section 32.1", "No Liens",
        "Tenant shall keep the Premises and the Project free of any mechanics', materialmen's, or "
        "similar liens arising out of work performed for Tenant, and shall bond over or discharge "
        "any such lien within thirty (30) days after notice. Nothing in this Lease shall be "
        "construed as Landlord's consent to subject Landlord's interest in the Project to any "
        "such lien.",
    )

    # ---- Article 33: Brokers
    h(doc, "ARTICLE 33 — BROKERS")
    sec(
        doc, "Section 33.1", "Brokerage",
        "Each party represents to the other that it has dealt with no broker in connection with "
        "this Lease other than Example Commercial Advisors (representing Landlord) and "
        "Sample Tenant Group (representing Tenant), whose commissions shall be paid by Landlord "
        "pursuant to separate agreement. Each party shall indemnify the other against claims for "
        "a commission by any other broker claiming through the indemnifying party.",
    )

    # ---- Article 34: Force Majeure
    h(doc, "ARTICLE 34 — FORCE MAJEURE")
    sec(
        doc, "Section 34.1", "Force Majeure",
        "Except for the payment of Rent and other monetary obligations, neither party shall be in "
        "default for any delay or failure in performance caused by events beyond its reasonable "
        "control, including acts of God, casualty, governmental restrictions, labor disputes, and "
        "supply shortages; the time for performance shall be extended by the period of the delay.",
    )

    # ---- Article 35: OFAC
    h(doc, "ARTICLE 35 — OFAC COMPLIANCE")
    sec(
        doc, "Section 35.1", "OFAC",
        "Each party represents that neither it nor, to its knowledge, any person owning a "
        "controlling interest in it is a person or entity with whom U.S. persons are restricted "
        "from doing business under the regulations of the Office of Foreign Assets Control "
        "(OFAC), including any person on OFAC's Specially Designated Nationals list.",
    )

    # ---- Article 36: Miscellaneous + Governing Law
    h(doc, "ARTICLE 36 — MISCELLANEOUS")
    sec(
        doc, "Section 36.1", "Governing Law",
        "This Lease shall be governed by and construed in accordance with the laws of the State "
        "of Connecticut, without regard to its conflict-of-laws principles.",
    )
    sec(
        doc, "Section 36.2", "Entire Agreement",
        "This Lease, together with the Exhibits attached hereto, constitutes the entire "
        "agreement between the Parties and supersedes all prior negotiations and understandings. "
        "This Lease may be amended only by a written instrument signed by both Parties.",
    )
    sec(
        doc, "Section 36.3", "Severability",
        "If any provision of this Lease is held invalid or unenforceable, the remainder of this "
        "Lease shall not be affected and shall be enforced to the fullest extent permitted by "
        "law.",
    )
    sec(
        doc, "Section 36.4", "Waiver",
        "No waiver of any provision of this Lease shall be deemed a waiver of any other provision "
        "or of any subsequent breach of the same provision. Landlord's acceptance of Rent shall "
        "not be a waiver of any preceding default.",
    )
    sec(
        doc, "Section 36.5", "Successors and Assigns",
        "This Lease shall bind and inure to the benefit of the Parties and their respective "
        "permitted successors and assigns.",
    )
    sec(
        doc, "Section 36.6", "Counterparts",
        "This Lease may be executed in counterparts, including by electronic signature, each of "
        "which is an original and all of which together constitute one instrument.",
    )

    # ---- Signature page
    doc.add_paragraph()
    para(
        doc,
        "IN WITNESS WHEREOF, the Parties have executed this Lease as of the Effective Date.",
    )
    sig_block(
        doc, "LANDLORD:",
        [
            "SAMPLE TOWER OWNER, LLC,",
            "a Delaware limited liability company",
            "",
            "By: ____________________________",
            "Name: Taylor M. Specimen",
            "Title: Authorized Signatory",
            "Address: 1200 Example Plaza Boulevard, Suite 100, Exampleville, CT 00000",
        ],
    )
    sig_block(
        doc, "TENANT:",
        [
            "EXAMPLE ANALYTICS, INC.,",
            "a Delaware corporation",
            "",
            "By: ____________________________",
            "Name: Morgan R. Placeholder",
            "Title: Chief Executive Officer",
            "Address: 1200 Example Plaza Boulevard, Suite 1800, Exampleville, CT 00000",
        ],
    )
    sig_block(
        doc, "GUARANTOR:",
        [
            "____________________________",
            "MORGAN R. PLACEHOLDER, individually",
        ],
    )

    # ---- Exhibits (named so cross-references resolve)
    doc.add_page_break()
    h(doc, "EXHIBIT A — FLOOR PLAN OF THE PREMISES")
    para(doc, "[Floor plan of Suite 1800, eighteenth (18th) floor, Sample Tower — omitted in this sample.]")

    h(doc, "EXHIBIT B — BASE RENT SCHEDULE")
    para(doc, "Annual Base Rent, escalating 3.0% per Lease Year (rounded):")
    bullet(doc, "Lease Year 1 (Rent Commencement 12/1/2025): $42.00/RSF — $1,029,000/yr")
    bullet(doc, "Lease Year 2: $43.26/RSF — $1,059,870/yr")
    bullet(doc, "Lease Year 3: $44.56/RSF — $1,091,666/yr")
    bullet(doc, "Lease Year 4: $45.89/RSF — $1,124,416/yr")
    bullet(doc, "Lease Year 5: $47.27/RSF — $1,158,148/yr")
    bullet(doc, "Lease Year 6: $48.69/RSF — $1,192,893/yr")
    bullet(doc, "Lease Year 7: $50.15/RSF — $1,228,680/yr")
    bullet(doc, "Lease Year 8: $51.65/RSF — $1,265,540/yr")
    bullet(doc, "Lease Year 9: $53.20/RSF — $1,303,506/yr")
    bullet(doc, "Lease Year 10 (through 5/31/2035): $54.80/RSF — $1,342,611/yr")

    h(doc, "EXHIBIT C — WORK LETTER")
    para(
        doc,
        "Landlord shall deliver the Premises with Landlord's Work (base-building systems, "
        "demising walls, and code-compliant common areas) substantially complete. Tenant shall "
        "design and construct its initial improvements using the TI Allowance of $70.00/RSF "
        "($1,715,000) disbursed against requisitions, with Landlord's approval of plans not to "
        "be unreasonably withheld.",
    )

    h(doc, "EXHIBIT D — GUARANTY OF LEASE")
    para(
        doc,
        "FOR VALUE RECEIVED, and as a material inducement to SAMPLE TOWER OWNER, LLC "
        "(“Landlord”) to enter into the foregoing Office Lease Agreement (the “Lease”) "
        "with EXAMPLE ANALYTICS, INC. (“Tenant”), the undersigned MORGAN R. PLACEHOLDER, "
        "individually (“Guarantor”), hereby absolutely, unconditionally, and irrevocably "
        "guarantees to Landlord the full and punctual payment and performance of each and every "
        "obligation of Tenant under the Lease.",
    )
    para(
        doc,
        "This is a guaranty of payment and performance and not merely of collection. Guarantor's "
        "liability hereunder is unlimited in amount, is not capped, and does not burn off, step "
        "down, or terminate prior to the full and final performance of all obligations under the "
        "Lease, including those arising during any Renewal Term and any holdover period. "
        "Guarantor waives any requirement that Landlord first proceed against Tenant. This is "
        "not a “good guy” guaranty.",
    )
    sig_block(
        doc, "GUARANTOR:",
        [
            "____________________________",
            "MORGAN R. PLACEHOLDER, individually",
            "Dated: March 14, 2025",
        ],
    )

    doc.add_page_break()
    h(doc, "EXHIBIT E — RULES AND REGULATIONS")
    para(doc, "The following rules and regulations apply to the Building (Section 29.1):")
    bullet(doc, "1. The sidewalks, entries, passages, elevators, and stairways shall not be obstructed or used for any purpose other than ingress and egress.")
    bullet(doc, "2. No sign, advertisement, or notice shall be affixed to any part of the Building except as approved by Landlord under Article 27.")
    bullet(doc, "3. Tenant shall not make or permit any noise or odor that is objectionable to other occupants of the Building.")
    bullet(doc, "4. Movement of furniture, freight, or bulky items shall be scheduled with Landlord's property manager and use the designated freight elevator and loading dock.")
    bullet(doc, "5. Tenant shall not place any additional locks on doors without furnishing Landlord a key, and shall return all keys and access cards on surrender.")
    bullet(doc, "6. Tenant shall not overload any floor and shall not install heavy equipment without Landlord's prior approval as to placement and floor loading.")
    bullet(doc, "7. After-hours HVAC may be requested and shall be billed at Landlord's then-standard hourly rate.")
    bullet(doc, "8. Smoking is prohibited throughout the Building and within twenty-five (25) feet of any entrance.")

    add_footer(doc)
    return doc


# ==========================================================================
# 2) SAMPLE PURCHASE & SALE AGREEMENT (~12 pp)
# ==========================================================================
def build_psa() -> Document:
    doc = Document()
    _base_styles(doc)

    title_block(
        doc,
        "PURCHASE AND SALE AGREEMENT",
        "Sample Crossing Shopping Center • 4500 Example Road • Sampletown, Texas",
    )

    para(
        doc,
        "THIS PURCHASE AND SALE AGREEMENT (this “Agreement”) is made as of April 7, 2025 "
        "(the “Effective Date”), by and between SAMPLE CROSSING HOLDINGS, L.P., a Texas "
        "limited partnership (“Seller”), and EXAMPLE RETAIL PARTNERS, LLC, a Delaware "
        "limited liability company (“Buyer”). Seller and Buyer are each a “Party” and "
        "together the “Parties.”",
    )

    h(doc, "RECITALS")
    para(
        doc,
        "A. Seller owns the retail shopping center commonly known as Sample Crossing Shopping "
        "Center located at 4500 Example Road, Sampletown, Texas, together with the underlying land, "
        "improvements, and related personal property and intangibles (collectively, the "
        "“Property”).",
    )
    para(doc, "B. Seller desires to sell, and Buyer desires to purchase, the Property on the terms herein.")

    h(doc, "ARTICLE 1 — PURCHASE AND SALE")
    sec(
        doc, "Section 1.1", "Purchase and Sale",
        "Seller agrees to sell and convey the Property to Buyer, and Buyer agrees to purchase "
        "the Property from Seller, on the terms and conditions set forth in this Agreement.",
    )
    sec(
        doc, "Section 1.2", "Purchase Price",
        "The purchase price for the Property is TWENTY-EIGHT MILLION FIVE HUNDRED THOUSAND AND "
        "00/100 DOLLARS ($28,500,000.00) (the “Purchase Price”), payable in immediately "
        "available funds at Closing, subject to the prorations and adjustments set forth herein.",
    )

    h(doc, "ARTICLE 2 — EARNEST MONEY")
    sec(
        doc, "Section 2.1", "Deposit",
        "Within three (3) business days after the Effective Date, Buyer shall deposit with "
        "Example Title Company (the “Escrow Agent”) earnest money in the amount of FIVE "
        "HUNDRED SEVENTY THOUSAND AND 00/100 DOLLARS ($570,000.00) (the “Earnest Money”), "
        "being two percent (2%) of the Purchase Price.",
    )
    sec(
        doc, "Section 2.2", "Refundable Until DD Expiration; Going Hard",
        "The Earnest Money shall be fully refundable to Buyer if Buyer terminates this Agreement "
        "for any reason or no reason on or before the expiration of the Due Diligence Period. "
        "Upon expiration of the Due Diligence Period, the Earnest Money shall become "
        "non-refundable (“go hard”) and shall be applied to the Purchase Price at Closing, "
        "except in the event of a Seller default or the failure of a condition to Buyer's "
        "obligation to close.",
    )

    h(doc, "ARTICLE 3 — DUE DILIGENCE")
    sec(
        doc, "Section 3.1", "Due Diligence Period",
        "Buyer shall have a period of forty-five (45) days following the Effective Date (the "
        "“Due Diligence Period”) within which to inspect the Property and review all "
        "leases, service contracts, operating statements, the rent roll, title, survey, and "
        "environmental and physical condition of the Property.",
    )
    sec(
        doc, "Section 3.2", "Free-Look Termination",
        "Buyer may terminate this Agreement by written notice to Seller given at any time prior "
        "to the expiration of the Due Diligence Period, in which event the Earnest Money shall "
        "be returned to Buyer and neither Party shall have any further obligation except those "
        "that expressly survive termination.",
    )
    sec(
        doc, "Section 3.3", "Seller Deliveries",
        "Within five (5) business days after the Effective Date, Seller shall deliver or make "
        "available to Buyer the current rent roll, tenant estoppel forms, existing leases and "
        "amendments, service contracts, the most recent operating statements and CAM "
        "reconciliations, the existing title policy, and any environmental reports in Seller's "
        "possession.",
    )

    h(doc, "ARTICLE 4 — TITLE AND SURVEY")
    sec(
        doc, "Section 4.1", "Title Commitment",
        "Buyer shall obtain a current title commitment for an ALTA Owner's Policy of title "
        "insurance, together with copies of all exception documents, and may obtain a current "
        "ALTA/NSPS Land Title Survey of the Property.",
    )
    sec(
        doc, "Section 4.2", "Title Objections and Cure",
        "Buyer may object to any title exception by written notice delivered before the end of "
        "the Due Diligence Period. Seller shall be obligated to cure or remove at or before "
        "Closing all monetary liens and other mandatory-cure items (including mortgages, "
        "judgment liens, and mechanics' liens), and shall use commercially reasonable efforts "
        "to cure other objections, provided Seller's out-of-pocket cost to cure discretionary "
        "objections shall not exceed $250,000. Exceptions not timely objected to, or waived, "
        "shall be “Permitted Exceptions.”",
    )

    h(doc, "ARTICLE 5 — REPRESENTATIONS AND WARRANTIES")
    sec(
        doc, "Section 5.1", "Seller's Representations",
        "Seller represents and warrants to Buyer, to Seller's knowledge, that: (a) the rent roll "
        "delivered to Buyer is true and correct in all material respects, and no tenant has "
        "prepaid rent more than one (1) month in advance; (b) Seller has received no written "
        "notice of any uncured violation of applicable law, zoning, or recorded covenant "
        "affecting the Property; (c) there is no pending or, to Seller's knowledge, threatened "
        "litigation, condemnation, or special assessment affecting the Property; (d) Seller has "
        "received no written notice of any default by Seller or any tenant under the leases, and "
        "the leases delivered to Buyer are the complete leases in effect; (e) Seller has received "
        "no written notice of any pending tax-assessment appeal other than as disclosed; (f) the "
        "service contracts delivered to Buyer are the material service contracts affecting the "
        "Property; (g) Seller has not received written notice of any pending or threatened "
        "termination, offset, or abatement claim by any tenant; and (h) Seller is not a "
        "“foreign person” within the meaning of Section 1445 of the Internal Revenue Code. "
        "As used herein, “to Seller's knowledge” means the actual (not constructive or "
        "imputed) knowledge of Seller's asset manager, Jordan T. Fixture, without any duty of "
        "independent investigation, and Mr. Fixture shall have no personal liability hereunder.",
    )
    sec(
        doc, "Section 5.2", "No Survival of Representations",
        "The representations and warranties of Seller set forth in Section 5.1 are made as of "
        "the Effective Date and again as of the Closing Date. The Parties agree that NONE of "
        "Seller's representations and warranties shall survive the Closing. Upon Closing, all "
        "of Seller's representations and warranties shall merge into the special warranty deed "
        "and shall be of no further force or effect, and Buyer shall have no claim against "
        "Seller with respect thereto from and after the Closing.",
    )
    sec(
        doc, "Section 5.3", "Buyer's Representations",
        "Buyer represents and warrants that it is duly organized, validly existing, and has full "
        "authority to enter into and perform this Agreement.",
    )

    h(doc, "ARTICLE 6 — CONDITION OF THE PROPERTY")
    sec(
        doc, "Section 6.1", "As-Is, Where-Is",
        "EXCEPT FOR SELLER'S EXPRESS REPRESENTATIONS IN SECTION 5.1 (WHICH DO NOT SURVIVE "
        "CLOSING PER SECTION 5.2), BUYER ACKNOWLEDGES THAT IT IS PURCHASING THE PROPERTY ON AN "
        "“AS-IS, WHERE-IS” BASIS, WITH ALL FAULTS, AND WITHOUT ANY OTHER REPRESENTATION OR "
        "WARRANTY OF SELLER, EXPRESS OR IMPLIED. Buyer is relying solely on its own due "
        "diligence investigation of the Property.",
    )

    h(doc, "ARTICLE 7 — INTERIM OPERATIONS")
    sec(
        doc, "Section 7.1", "Operating Covenants",
        "Between the Effective Date and Closing, Seller shall operate and maintain the Property "
        "in the ordinary course and shall not, without Buyer's prior written consent (not to be "
        "unreasonably withheld), enter into any new lease, lease amendment, or service contract "
        "not terminable on thirty (30) days' notice, or encumber the Property.",
    )

    h(doc, "ARTICLE 8 — CONDITIONS TO CLOSING")
    sec(
        doc, "Section 8.1", "Buyer's Conditions",
        "Buyer's obligation to close is conditioned on: (a) Seller's representations being true "
        "in all material respects as of Closing; (b) Seller's delivery of estoppel certificates "
        "from tenants occupying at least seventy-five percent (75%) of the leased rentable area, "
        "including each anchor tenant, in the form required by the applicable lease or reasonably "
        "acceptable to Buyer and dated no earlier than thirty (30) days before Closing; (c) the "
        "Title Company's irrevocable commitment to issue the Owner's Policy subject only to "
        "Permitted Exceptions; and (d) Seller's performance in all material respects of its "
        "covenants under this Agreement.",
    )
    sec(
        doc, "Section 8.2", "Estoppel Shortfall; Landlord Backstop",
        "If Seller is unable to obtain estoppel certificates meeting the threshold in "
        "Section 8.1(b), Seller may (but is not obligated to) deliver its own seller/landlord "
        "estoppel for up to ten percent (10%) of the leased rentable area in lieu of missing "
        "tenant estoppels, which seller estoppel shall be superseded by a conforming tenant "
        "estoppel later delivered. A seller estoppel shall not be available for any anchor "
        "tenant. The estoppels shall confirm the matters customarily covered, including base "
        "rent, term, security deposit, the absence of defaults (to the certifying party's "
        "knowledge), and the absence of any unfunded landlord obligation.",
    )
    sec(
        doc, "Section 8.3", "Seller's Conditions",
        "Seller's obligation to close is conditioned on Buyer's delivery of the Purchase Price "
        "and Buyer's performance in all material respects of its obligations under this "
        "Agreement.",
    )

    h(doc, "ARTICLE 9 — CASUALTY AND CONDEMNATION")
    sec(
        doc, "Section 9.1", "Casualty",
        "If, prior to Closing, the Property is damaged by casualty costing more than five "
        "percent (5%) of the Purchase Price to repair, or a material portion is taken by "
        "condemnation, Buyer may terminate this Agreement and receive a refund of the Earnest "
        "Money, or proceed to Closing with an assignment of insurance or condemnation proceeds "
        "and a credit for any deductible.",
    )

    h(doc, "ARTICLE 10 — CLOSING; PRORATIONS")
    sec(
        doc, "Section 10.1", "Closing",
        "The closing of the purchase and sale (the “Closing”) shall occur through escrow "
        "on the date that is fifteen (15) days after the expiration of the Due Diligence Period, "
        "or such other date as the Parties agree (the “Closing Date”).",
    )
    sec(
        doc, "Section 10.2", "Prorations",
        "Real estate taxes, rents, CAM charges, and operating expenses shall be prorated between "
        "Seller and Buyer as of the Closing Date, with a customary post-closing true-up to be "
        "completed within one hundred twenty (120) days after Closing. Base rents actually "
        "collected shall be prorated as of Closing. Delinquent rents collected after Closing "
        "shall be applied first to the month in which Closing occurs, then to amounts due Buyer "
        "for periods after Closing, and then turned over to Seller for delinquencies relating to "
        "periods before Closing. Percentage rent shall be prorated based on the portion of the "
        "applicable lease year occurring before and after Closing, settled when each tenant "
        "reports its sales. CAM and operating-expense reconciliations for the year of Closing "
        "shall be trued up between the Parties when finalized, based on each party's period of "
        "ownership. Tenant security deposits shall be credited or transferred to Buyer at "
        "Closing.",
    )
    sec(
        doc, "Section 10.3", "Closing Costs",
        "Seller shall pay the basic premium for the Owner's Policy and one-half of escrow fees; "
        "Buyer shall pay for any survey, any title endorsements, the premium for any lender's "
        "policy, recording fees, and one-half of escrow fees. Each party shall pay its own legal "
        "fees.",
    )
    sec(
        doc, "Section 10.4", "Escrow",
        "The Escrow Agent shall hold the Earnest Money in an interest-bearing account, with "
        "interest accruing to Buyer's benefit and credited to the Purchase Price at Closing. The "
        "Escrow Agent shall disburse the Earnest Money in accordance with joint written "
        "instructions or, absent dispute, in accordance with the terms of this Agreement. In the "
        "event of a dispute, the Escrow Agent may interplead the Earnest Money into a court of "
        "competent jurisdiction.",
    )
    sec(
        doc, "Section 10.5", "Possession; Leasing Costs",
        "Seller shall deliver possession of the Property at Closing subject to the rights of "
        "tenants under the leases. Buyer shall receive a credit at Closing for (a) all tenant "
        "security deposits not otherwise transferred, and (b) any unpaid leasing commissions, "
        "free-rent, and unfunded tenant-improvement obligations under leases executed prior to "
        "the Effective Date; Buyer shall assume the same from and after Closing.",
    )
    sec(
        doc, "Section 10.6", "Survival of Closing Obligations",
        "The prorations and true-up obligations under this Article 10, and the indemnity, "
        "brokerage, confidentiality, and as-is release provisions of this Agreement, shall "
        "survive the Closing notwithstanding the non-survival of Seller's representations under "
        "Section 5.2.",
    )

    h(doc, "ARTICLE 11 — DEFAULT; REMEDIES")
    sec(
        doc, "Section 11.1", "Buyer Default; Liquidated Damages",
        "IF BUYER DEFAULTS IN ITS OBLIGATION TO CLOSE AND SUCH DEFAULT IS NOT CURED WITHIN FIVE "
        "(5) BUSINESS DAYS AFTER WRITTEN NOTICE, SELLER'S SOLE AND EXCLUSIVE REMEDY SHALL BE TO "
        "TERMINATE THIS AGREEMENT AND RETAIN THE EARNEST MONEY AS LIQUIDATED DAMAGES. THE "
        "PARTIES AGREE THAT SELLER'S ACTUAL DAMAGES WOULD BE DIFFICULT TO ASCERTAIN AND THAT THE "
        "EARNEST MONEY IS A REASONABLE ESTIMATE THEREOF AND NOT A PENALTY.",
    )
    sec(
        doc, "Section 11.2", "Seller Default",
        "If Seller defaults, Buyer may, as its remedies, either (a) terminate this Agreement and "
        "recover the Earnest Money together with its actual out-of-pocket due diligence costs "
        "not to exceed $100,000, or (b) seek specific performance of this Agreement.",
    )

    h(doc, "ARTICLE 12 — CLOSING DELIVERIES")
    sec(
        doc, "Section 12.1", "Seller's Deliveries",
        "At Closing, Seller shall deliver to the Escrow Agent: (a) a duly executed special "
        "warranty deed conveying the Property subject only to the Permitted Exceptions; (b) a "
        "bill of sale and an assignment and assumption of the leases, security deposits, service "
        "contracts, and intangibles; (c) an updated, certified rent roll; (d) the original tenant "
        "estoppel certificates obtained under Section 8.1; (e) notices to tenants of the change "
        "of ownership; (f) a FIRPTA non-foreign affidavit; (g) an owner's title affidavit "
        "sufficient to delete the standard exceptions; and (h) evidence of Seller's authority.",
    )
    sec(
        doc, "Section 12.2", "Buyer's Deliveries",
        "At Closing, Buyer shall deliver to the Escrow Agent: (a) the balance of the Purchase "
        "Price in immediately available funds; (b) a counterpart of the assignment and assumption "
        "agreement; and (c) evidence of Buyer's authority to consummate the transaction.",
    )

    h(doc, "ARTICLE 13 — DUE DILIGENCE ENTRY; INDEMNITY")
    sec(
        doc, "Section 13.1", "Right of Entry",
        "During the Due Diligence Period, Buyer and its agents may enter the Property to perform "
        "inspections and studies, on not less than one (1) business day's prior notice to Seller, "
        "during normal business hours, and without unreasonably interfering with tenants. Buyer "
        "shall not conduct any invasive or Phase II environmental testing without Seller's prior "
        "written consent.",
    )
    sec(
        doc, "Section 13.2", "Insurance; Restoration; Indemnity",
        "Buyer shall maintain commercial general liability insurance of not less than $2,000,000 "
        "naming Seller as an additional insured, shall restore any damage to the Property caused "
        "by its inspections, and shall indemnify, defend, and hold Seller harmless from any claim "
        "or lien arising out of Buyer's entry, which obligations shall survive any termination of "
        "this Agreement.",
    )

    h(doc, "ARTICLE 14 — AS-IS RELEASE")
    sec(
        doc, "Section 14.1", "Release and Waiver",
        "Effective as of Closing, and except for (i) Seller's express representations in "
        "Section 5.1 (to the extent and only for so long as they survive, which under Section 5.2 "
        "is not at all following Closing), (ii) Seller's covenants that expressly survive Closing, "
        "and (iii) claims arising from Seller's fraud, Buyer, on behalf of itself and its "
        "successors, RELEASES and WAIVES any and all claims against Seller arising out of the "
        "physical or environmental condition of the Property, including claims under any "
        "environmental law. Buyer acknowledges that the Purchase Price reflects the as-is nature "
        "of the sale.",
    )

    h(doc, "ARTICLE 15 — 1031 EXCHANGE")
    sec(
        doc, "Section 15.1", "Cooperation",
        "Either party may structure its purchase or sale as part of a like-kind exchange under "
        "Section 1031 of the Internal Revenue Code, and the other party shall reasonably "
        "cooperate (including consenting to an assignment of this Agreement to a qualified "
        "intermediary), provided that the exchange does not delay Closing, impose additional cost "
        "or liability on the cooperating party, or release the exchanging party from its "
        "obligations under this Agreement.",
    )

    h(doc, "ARTICLE 16 — BROKERS")
    sec(
        doc, "Section 16.1", "Brokerage",
        "Each party represents that it has dealt with no broker in connection with this "
        "transaction other than Sample Retail Brokerage (representing Seller) and Example Retail "
        "Capital Markets (representing Buyer), whose commissions shall be paid by Seller pursuant "
        "to separate agreement. Each party shall indemnify the other against any claim for a "
        "commission asserted by any other broker claiming through the indemnifying party. This "
        "Section shall survive Closing.",
    )

    h(doc, "ARTICLE 17 — NOTICES; CONFIDENTIALITY; ASSIGNMENT")
    sec(
        doc, "Section 17.1", "Notices",
        "All notices under this Agreement shall be in writing and delivered by hand, nationally "
        "recognized overnight courier, or electronic mail (with confirmation) to the addresses "
        "the Parties designate in writing.",
    )
    sec(
        doc, "Section 17.2", "Confidentiality",
        "Prior to Closing, Buyer shall keep the terms of this Agreement and the due diligence "
        "materials confidential, except as required by law or to its lenders, investors, and "
        "advisors who agree to maintain confidentiality. Neither party shall issue a press "
        "release without the other's consent.",
    )
    sec(
        doc, "Section 17.3", "Assignment",
        "Buyer may not assign this Agreement without Seller's prior written consent, except that "
        "Buyer may assign to an entity controlled by, controlling, or under common control with "
        "Buyer (or to a qualified intermediary under Article 15) on notice to Seller, provided "
        "the assignee assumes Buyer's obligations and Buyer remains liable hereunder.",
    )

    h(doc, "ARTICLE 18 — MISCELLANEOUS")
    sec(
        doc, "Section 18.1", "Governing Law",
        "This Agreement shall be governed by the laws of the State of Texas, without regard to "
        "conflict-of-laws principles.",
    )
    sec(
        doc, "Section 18.2", "Entire Agreement",
        "This Agreement constitutes the entire agreement between the Parties and supersedes all "
        "prior negotiations, and may be amended only in a writing signed by both Parties.",
    )
    sec(
        doc, "Section 18.3", "Time of the Essence",
        "Time is of the essence of this Agreement. If any date for performance falls on a weekend "
        "or legal holiday, the date for performance shall be the next business day.",
    )
    sec(
        doc, "Section 18.4", "Severability",
        "If any provision of this Agreement is held invalid or unenforceable, the remainder shall "
        "be enforced to the fullest extent permitted by law.",
    )
    sec(
        doc, "Section 18.5", "Counterparts",
        "This Agreement may be executed in counterparts, including by electronic signature, each "
        "of which is an original and all of which together constitute one instrument.",
    )

    doc.add_paragraph()
    para(doc, "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.")
    sig_block(
        doc, "SELLER:",
        [
            "SAMPLE CROSSING HOLDINGS, L.P.,",
            "a Texas limited partnership",
            "",
            "By: ____________________________",
            "Name: Jordan T. Fixture",
            "Title: Authorized Signatory",
        ],
    )
    sig_block(
        doc, "BUYER:",
        [
            "EXAMPLE RETAIL PARTNERS, LLC,",
            "a Delaware limited liability company",
            "",
            "By: ____________________________",
            "Name: Casey K. Testerson",
            "Title: Managing Member",
        ],
    )

    add_footer(doc)
    return doc


# ==========================================================================
# 3) SAMPLE TENANT ESTOPPEL CERTIFICATE (~1-2 pp)
# ==========================================================================
def build_estoppel() -> Document:
    doc = Document()
    _base_styles(doc)

    title_block(doc, "TENANT ESTOPPEL CERTIFICATE")

    para(
        doc,
        "TO: SAMPLE TOWER OWNER, LLC, and its successors and assigns, and any "
        "prospective purchaser or mortgage lender of the Building (collectively, the "
        "“Reliance Parties”).",
    )
    para(
        doc,
        "RE: Office Lease Agreement dated March 14, 2025 (the “Lease”), between SAMPLE "
        "TOWER OWNER, LLC, as landlord (“Landlord”), and EXAMPLE ANALYTICS, "
        "INC., as tenant (“Tenant”), covering Suite 1800 (24,500 rentable square feet) at "
        "Sample Tower, 1200 Example Plaza Boulevard, Exampleville, Connecticut (the “Premises”).",
    )
    para(
        doc,
        "The undersigned Tenant hereby certifies to the Reliance Parties as follows, knowing "
        "that the Reliance Parties will rely on this certificate:",
    )

    sec(
        doc, "1.", "Lease in Effect",
        "The Lease is in full force and effect and has not been modified, amended, or "
        "supplemented except as described herein (none). The Lease represents the entire "
        "agreement between Landlord and Tenant as to the Premises.",
    )
    sec(
        doc, "2.", "Term",
        "The Commencement Date was June 1, 2025, and the initial Term expires May 31, 2035. "
        "Tenant has one (1) remaining renewal option of sixty (60) months.",
    )
    sec(
        doc, "3.", "Rent",
        "The current annual Base Rent is $1,029,000.00 ($85,750.00 per month). Base Rent "
        "commenced on December 1, 2025, following a six (6) month abatement period. Tenant pays "
        "its 8.97% proportionate share of Operating Expenses as Additional Rent. No Rent has "
        "been prepaid more than one (1) month in advance.",
    )
    sec(
        doc, "4.", "Security Deposit",
        "Landlord holds no cash security deposit under the Lease.",
    )
    # ---- ESTOPPEL TRAP #1: "no defaults" WITHOUT a knowledge qualifier
    sec(
        doc, "5.", "No Defaults",
        "There are no defaults by either Landlord or Tenant under the Lease, and no event has "
        "occurred that, with the giving of notice or the passage of time, would constitute a "
        "default. Tenant has no defenses, offsets, or counterclaims against the enforcement of "
        "the Lease. (This statement is made absolutely and is not qualified by the knowledge of "
        "the undersigned.)",
    )
    # ---- ESTOPPEL TRAP #2: confirms NO outstanding TI allowance even though the lease grants one
    sec(
        doc, "6.", "No Outstanding Landlord Obligations",
        "All obligations of Landlord under the Lease have been fully performed. Without "
        "limitation, Landlord has completed all work required of it, and there is NO unfunded or "
        "outstanding tenant improvement allowance, tenant improvement obligation, or other "
        "concession owed by Landlord to Tenant. Tenant acknowledges and agrees that no tenant "
        "improvement allowance remains payable by Landlord.",
    )
    sec(
        doc, "7.", "No Assignment",
        "Tenant has not assigned, sublet, or otherwise transferred any interest in the Lease or "
        "the Premises.",
    )

    para(
        doc,
        "This certificate may be relied upon by the Reliance Parties and shall be binding upon "
        "the undersigned. Dated this ____ day of __________, 2026.",
    )
    sig_block(
        doc, "TENANT:",
        [
            "EXAMPLE ANALYTICS, INC.,",
            "a Delaware corporation",
            "",
            "By: ____________________________",
            "Name: Morgan R. Placeholder",
            "Title: Chief Executive Officer",
        ],
    )

    add_footer(doc)
    return doc


def main() -> None:
    targets = [
        ("sample-commercial-lease.docx", build_lease),
        ("sample-psa.docx", build_psa),
        ("sample-tenant-estoppel.docx", build_estoppel),
    ]
    for filename, builder in targets:
        path = os.path.join(HERE, filename)
        doc = builder()
        doc.save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
