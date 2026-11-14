# Legal demo fixtures — CRE sample documents

Text-based `.docx` sample documents that stage the **Commercial Real Estate
Review** walkthrough (see [`docs/cre-test-script.md`](../../docs/cre-test-script.md)).
All parties are **fictional**, the content is **US** jurisdiction, and every file
carries a `SAMPLE — for demonstration only` footer.

**These are text-based Word files (selectable text), not scanned images** — the app
has no OCR, so a scanned PDF would extract nothing. Each `.docx` is engineered so the
flagship lease abstraction lights up with real values, a red **deal-breaker**, and
the auto **EscalationDraft**, grading against the seeded firm playbook
(`backend/migrations/009_cre_playbook_seed.sql` + `013_cre_playbook_enrich.sql`,
key `cre.lease.deal_breakers`).

## Files

| File | What it is | Planted issues (how it grades) |
|------|------------|--------------------------------|
| `sample-commercial-lease.docx` | ~16–22 pp office lease (Sample Tower, Exampleville CT). Example Analytics, Inc. (Tenant) / Sample Tower Owner, LLC (Landlord); Morgan R. Placeholder, Guarantor. | **4 red deal-breakers** + otherwise market terms (see below). |
| `sample-psa.docx` | ~10–15 pp retail Purchase & Sale Agreement (Sample Crossing Shopping Center, Sampletown TX). Sample Crossing Holdings, L.P. (Seller) / Example Retail Partners, LLC (Buyer); $28.5M. | **2 buyer-side flags** (see below). |
| `sample-tenant-estoppel.docx` | 1–2 pp tenant estoppel that **references the same lease/parties** as `sample-commercial-lease.docx`. | **2 estoppel traps** (see below). |
| `generate.py` | python-docx generator that builds all three `.docx`. Re-run with `python3 fixtures/legal/generate.py` (needs `pip3 install python-docx`). | — |

## `sample-commercial-lease.docx` — the four engineered deal-breakers

Each maps to a non-negotiable in the seeded `cre.lease.deal_breakers` playbook and
grades **red (Deal-breaker)**; their presence triggers the **EscalationDraft**.

1. **Uncapped controllable CAM / operating expenses** — *Article 7, Section 7.3*
   ("No Cap on Controllable Expenses"): expressly **no annual cap** on controllable
   OpEx; tenant waives any cap. → flags **CAM / Operating Expenses** red.
2. **Personal guaranty with no burn-off / no cap** — *Article 24 + Exhibit D
   (Guaranty of Lease)*: a **full** personal payment-and-performance guaranty,
   **not capped**, **does not burn off**, expressly **"not a good-guy guaranty."**
   → flags **Guarantor / Personal Guaranty** red.
3. **Holdover at 200% + consequential damages** — *Article 20, Sections 20.1–20.2*:
   **200%** holdover rent **plus** uncapped **consequential/special damages** and
   successor-tenant exposure, expressly **not waived**. → flags **Holdover** red.
4. **No SNDA / non-disturbance** — *Article 16 (Subordination) + Article 22*:
   self-operative subordination with the landlord under **no obligation to obtain any
   non-disturbance agreement**; continuation after foreclosure is at the lender's sole
   election (the protection is **omitted**). → flags **SNDA Required** red (a
   missing-but-material gap).

**Everything else is drafted to market** so the rest of the ~29 columns read
green/yellow: parties + guarantor; 24,500 RSF with a 1.124 load factor under
**ANSI/BOMA Z65.1-2017, Method A**; **NNN**; lease dated 3/14/2025, commencement
6/1/2025, **rent commencement 12/1/2025** (after 6 months' free rent), expiration
5/31/2035; base rent **$42.00/RSF ($1,029,000/yr)** with **fixed 3% annual
escalations**; **$70.00/RSF ($1,715,000) TI allowance**; 8.97% pro-rata share with an
audit right; office permitted use; **assignment consent not unreasonably withheld**
with permitted-affiliate **and change-of-control** carve-outs and 50/50 profit share;
**one renewal option at FMV** (9–12 mo notice, baseball arbitration, floor at prior
rent); casualty + condemnation with reciprocal termination and rent abatement;
**15-business-day estoppel** obligation ("lease controls"); CGL insurance with a
**mutual waiver of subrogation**; default notice-and-cure with **tenant self-help /
offset**; letter-of-credit security with a burn-down; parking, signage, a **ROFO**
expansion right; **governing law Connecticut**.

## `sample-psa.docx` — the two engineered flags

Graded against `cre.psa.standard_positions`:

- **No express survival clause** — *Article 5, Section 5.2* ("No Survival of
  Representations"): the seller's reps **merge into the special warranty deed and die
  at closing**. The playbook calls this an **auto-flag for the buyer**.
- **Buyer-default liquidated damages = the deposit** — *Article 11, Section 11.1*: on
  a buyer default, the seller's **sole and exclusive remedy** is to retain the 2%
  earnest money as liquidated damages (state-specific enforceability — a
  consult-counsel trigger).

Otherwise market: $28.5M price; **2% earnest money** going hard at DD expiry; **45-day
due diligence** with a free look; title objection / mandatory-cure; reps **"to
seller's knowledge"** (named individual); **as-is** with a release; standard
prorations and a true-up; full closing deliveries (deed, FIRPTA, estoppels).

## `sample-tenant-estoppel.docx` — the two estoppel traps

References the same lease (Example Analytics / Example Plaza, Suite 1800) and confirms
rent/dates, then plants two traps graded against `cre.estoppel.requirements`:

- **"No defaults" without a knowledge qualifier** — *Paragraph 5*: states there are
  no defaults **absolutely**, expressly **not** qualified by the certifying party's
  knowledge.
- **Waiver of the lease-granted TI allowance** — *Paragraph 6*: confirms **no
  outstanding / unfunded TI allowance** even though the lease (Section 5.1) **grants a
  $1,715,000 TI allowance** — confirming it would **waive** the tenant's right. This is
  the lease ↔ estoppel-gap beat.

## Re-staging / regenerating

```bash
pip3 install python-docx          # one-time
python3 fixtures/legal/generate.py
```

The generator is self-contained and idempotent; it overwrites the three `.docx` in
place. After editing it, re-verify that each file still opens with selectable text and
that the lease still contains the four deal-breakers (open in Word, or re-read the
paragraphs with python-docx).
