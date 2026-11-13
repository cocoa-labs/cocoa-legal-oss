# PI automation fixtures

100% synthetic inbound mail for rehearsing the PI email-automation pipeline (`scripts/rehearsePipeline.ts`) and for the fixture-validation test (`src/lib/automation/rehearsalFixtures.test.ts`). **Every person, claim number, policy number, invoice number, address, and amount is invented** — carrier/vendor names come from the fictional example registries seeded by migration 024, and both PDFs carry an explicit "synthetic test fixture" line. Nothing here is copied from real correspondence.

Each `*.json` file is a `ParsedEmail` (the exact shape the Gmail connector's `getMessage` returns — `src/lib/connectors/types.ts`). An attachment's `attachmentId` doubles as its filename in this directory; the rehearsal script reads the bytes from disk where production ingest would call `connector.getAttachment`.

The PDFs are **generated, not hand-made**: `npx tsx scripts/generateFixturePdfs.ts` (pdf-lib, real text layer) writes `dec-page.pdf` and `invoice.pdf` here. Regenerate after editing the generator and keep the values in lockstep with the test and this README.

Synthetic cast: clients **Jordan Sample** / **Casey Example** (the rehearsal script seeds matching cases `PI-TEST-0001` / `PI-TEST-0002`), adverse insured **Dana Specimen**, adjuster **Taylor Mock**, firm **Sample & Example LLP**. Phone numbers use the reserved 555-01xx range.

## What each fixture exercises

| Fixture | Exercises | Expected pipeline outcome |
| --- | --- | --- |
| `claim-email-1.json` | Carrier-domain classification (`claims@examplemutual.test`), dec-page PDF extraction with page citations, fuzzy client-name + date-of-loss case match. | Classified `claim_correspondence`; extracts claim `26-4400123`, policy `904412345`, BI limits `25/50`, PD limit, adjuster block (citations verify against `dec-page.pdf` pages 1–2 and the body); matches case `PI-TEST-0001` "Jordan Sample" via `client_name_fuzzy` (name + DOL 03/14/2026); run `staged` with one pending `update_case_insurance` operation + a `pending_approval` ack draft. If the model keys on the *insured* ("Dana Specimen") instead of the client, a `provisional` needs-review case is created — also a correct, reviewable outcome; the run still stages. |
| `claim-email-2.json` | Policy-limits-demand variant with a **response deadline** (extension request — surfaces in `requested_action`/summary for demand escalation) and **two claim numbers in one letter** (multi-claim edge). Body-only: no PDF, citations verify against the email body. | Classified `claim_correspondence` (samplecasualty.test domain); extracts **2 claims** (`SCC-26-887701`, `SCC-26-887702`) for the same client; both map to the same case → `staged` with **two** policy upserts and one ack draft whose `{{claim_number}}` lists both numbers. Claims mapping to *different* cases would triage — same client here, so they must not. |
| `invoice-email-1.json` | Vendor-domain classification (`examplecasefunding.test`), ECF-style policy-limits invoice, amount in body **and** PDF, matter-reference case match. | Classified `vendor_invoice`; extracts `INV-002417`, total due `$1,850.00` (185000 cents — the *balance*, not the `$1,750.00` line item), matter reference "Casey Example"; matches `PI-TEST-0002` via name containment (nominally the **confirm** band → `needs_case_confirm: true`); run `staged` with a `pending_approval` expense + `record_case_expense` operation, invoice PDF filed into the case's project. Payment portal shows "(not configured)" until `portal_url` is set in the vendor registry. |
| `invoice-email-2.json` | Records-vendor invoice (ChartExample-style), client-name matter reference, body-only extraction. | Classified `vendor_invoice` (chartexample.test domain); extracts `CE-778812`, `$64.50` (6450 cents); matches `PI-TEST-0002` "Casey Example" from the subject/matter reference (confirm band); run `staged` with a pending expense. No document is filed (no PDF). |
| `nonmatch-email.json` | Cold outreach matching no registry and carrying no PDF. | Deterministic classifier finds no carrier/vendor match; the LLM fallback is gated off (no PDF attachment) — run `skipped` with **zero** LLM calls. Nothing staged, nothing drafted. |

## Notes

- The ack draft's `To` is the fixture's synthetic carrier address; the rehearsal **never approves or sends** anything, so no mail can leave the building.
- Rehearsal runs are owned by `GMAIL_AGENT_OWNER_USER_ID`, so they appear in that user's `/automation` queue and `/cases` views.
- Repeated rehearsals mint fresh provider ids (a per-invocation stamp), so re-running creates new rows instead of tripping the one-run-per-email dedupe.
