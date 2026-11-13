# CRE Practice Mode — Test Script

A manual QA pass for the Commercial Real Estate feature set, with deliberate variation to exercise every path. Budget ~20 minutes. Companion to `cre-demo-script.md` (this one is for *validating*; that one is for *showing*).

## Pre-flight (30 sec)
- Sanity-check SQL reads **`1 · 7 · 1`** (`represented_party` column, 7 `cre.*` keys, `013` enrichment applied).
- Account → Models: `tabular_model = claude-sonnet-4-6`; Anthropic API key set.
- New matter "CRE Test"; upload the three samples from `fixtures/legal/` (`sample-commercial-lease.docx`, `sample-psa.docx`, `sample-tenant-estoppel.docx`).

## Test 1 — Flagship, happy path (lease as Tenant)
**Do:** Workflows → **Commercial Real Estate** section (confirm pack descriptions + a **"Flagship"** cue on *US Commercial Lease Abstraction*, and the **UK** pack is hidden here) → open it → **I represent: Tenant** → select the sample lease → **Create Review** → Generate.

**Expect:**
- CreReviewCard on top: **"Reviewing as: Tenant"** + exec summary ("N/M terms · K flagged").
- **Four red deal-breakers** in *Key Issues* (pinned): uncapped CAM, no-burn-off personal guaranty, 200% holdover + consequential damages, missing SNDA.
- **EscalationDraft** auto-appears, pre-filled with the flagged terms.
- Citations are clickable **"p. N"** chips that jump to the clause.
- **Export DOCX** (real memo doc), **Export XLSX** (grid), **Copy** ("Copied").

## Variations
- **V1 — Side flip (steering proof).** New review on the same lease as **Landlord** → analysis reframes: the uncapped CAM / holdover that were *red for the Tenant* are now **favorable to you (Landlord)** with a note the tenant will push back. (Side is set at creation, so "other side" = a new review.)
- **V2 — Chat path.** In chat, attach the lease + "review this lease?" → the inline **"Run a Commercial Real Estate review?"** chip → click → review opens **with the lease already loaded** (Create Review enabled immediately).
- **V3 — PSA as Buyer.** Run *Purchase & Sale Agreement (US) Review* on the PSA as **Buyer** → flags **no survival clause (reps merge into deed)** + **liquidated-damages = deposit**. Re-run as **Seller** → reframes.
- **V4 — Lease↔estoppel gap.** *Estoppel Certificate Review* on the estoppel (Tenant) → flags the **"no defaults" missing a knowledge qualifier** + the **waiver of the TI allowance the lease grants**.
- **V5 — Empty state.** Open a CRE review before generating → **"Run the review to populate…"** and **no risk badge** (no false green "Low").
- **V6 — Reliability rails.** A **>120k-char** doc → **truncation advisory** banner + late-row icons. A **scanned/image-only PDF** → **"couldn't be read (no text layer)"** advisory (fails loudly, not silently). *Guardrail test — not a demo doc.*
- **V7 — Negative / out-of-scope.** Attach a **non-CRE** doc in chat → **no** CRE proposal, normal answer.
- **V8 — Playbook moat (optional).** If the Playbooks editor is exposed, edit a `cre.lease.deal_breakers` position / set a firm override → re-run → output reflects *your* standard. (If not surfaced, V1 already proves steering is live.)

## Pass/fail checklist
- [ ] CRE gallery: descriptions + Flagship cue + UK hidden
- [ ] Lease (Tenant): 4 red deal-breakers + EscalationDraft + clickable citations
- [ ] Side flip (Landlord) reframes the same clauses
- [ ] Chat → proposal chip → review opens **with doc loaded**
- [ ] PSA + estoppel flag their engineered traps
- [ ] Empty review: **no** false "Low" badge
- [ ] Long/scanned doc: advisory banner shows
- [ ] Non-CRE doc: no CRE steering
- [ ] DOCX + XLSX exports + Copy work

## Gotchas
- Represented side is chosen **at review creation** — to test the other side, make a new review.
- Only **text DOCX/PDF** extract; scanned = the V6 guardrail, not a hero doc.
- The tabular path uses the account's stored `tabular_model`, not the chat picker.
