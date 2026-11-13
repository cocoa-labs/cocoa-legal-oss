# PI Automation — Onboarding Runbook

The step-by-step path that takes your firm from zero to **shadow mode** on the Personal Injury email automation. Companion to `backend/fixtures/pi/README.md` (fixture-by-fixture expectations) and `docs/safe-local-testing.md` (disposable-infrastructure rules — they apply here too). Work the sections in order; nothing sends email until the very last step of §8, and even then only after a human approval.

## 1. What this is

The PI automation watches the agent mailbox for two kinds of cold inbound mail — **claim correspondence from insurance carriers** and **vendor invoices** (records retrieval, legal funding) — and turns each into a reviewable package instead of an unread email. A run walks ingest → classify → extract (with verbatim, page-cited quotes) → verify citations → match to a case → **stage**. Staging is the hard stop: it creates a pending case-write operation, a pending acknowledgement **draft**, and (for invoices) a `pending_approval` expense ledger row — then parks the run in the **/automation** approval queue.

Nothing executes without a human. Approving a run applies the case writes; the acknowledgement email stays a draft under the default **drafts-only** safety, and payments are never automated at all (the pipeline preps the expense + portal link; a person pays in the vendor portal and marks it paid). Anything the pipeline is not sure about — unverified fields, low confidence, ambiguous case match, unknown duplicate — lands in **triage** for a person, never in the case file.

## 2. Apply migrations

`npm run migrate` applies **023 and 024** with every other migration (see the README).

1. `backend/migrations/023_pi_cases_automation.sql` — PI case tables + the `automation_runs` state machine + `email_messages.reply_to_address`.
2. `backend/migrations/024_pi_playbook_seed.sql` — the 10 `pi.*` playbook defaults (registries, guidance, ack template, thresholds).

**Verify (any SQL client):**

```sql
-- 5 rows: the 023 tables exist
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('pi_cases','pi_case_policies','pi_case_expenses',
                     'automation_runs','automation_state');

-- 1 row: the Reply-To column landed on email_messages
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'email_messages'
  and column_name = 'reply_to_address';

-- exactly 10 rows: the pi.* seed
select pe.key
from public.playbook_entries pe
join public.firm_playbooks fp on fp.id = pe.playbook_id
where fp.firm_id = 'default-shared' and pe.key like 'pi.%'
order by pe.key;
```

Expected keys: `pi.automation.confidence_thresholds`, `pi.cases.matching_rules`, `pi.claims.ack_template`, `pi.claims.carrier_registry`, `pi.claims.extraction_guidance`, `pi.claims.reply_to`, `pi.claims.signature_block`, `pi.invoices.expense_approval_threshold`, `pi.invoices.extraction_guidance`, `pi.invoices.vendor_registry`.

## 3. Environment

All automation env lives in `backend/.env`. The scheduler starts **once at boot**, so changing any of these requires a backend restart. **`AUTOMATION_ENABLED` stays `false` (or unset) until the §7 rehearsal passes.**

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTOMATION_ENABLED` | `false` | Master kill-switch. Gates the scheduler at boot **and** the cold-inbound enqueue hook in ingest. Only the literal `true` (case-insensitive) turns it on. |
| `AUTOMATION_DRAFTS_ONLY` | `true` | Safety: approving a run applies case writes but leaves the acknowledgement as a `pending_approval` draft. Only an explicit `false` disarms it (junk values never do). |
| `AUTOMATION_POLL_INTERVAL_MS` | `120000` | Scheduler tick cadence (ingest + run processing), ms. |
| `AUTOMATION_MAX_RETRIES` | `3` | Retries per run before it lands in `failed` (exponential backoff, 30s → 30min cap). |
| `AUTOMATION_LLM_CLASSIFY_ENABLED` | `true` | LLM fallback classification for mail the deterministic registries miss (only fires when the email carries a PDF). Explicit `false` disables; the registries still classify. |
| `AUTOMATION_MODEL` | `claude-sonnet-4-6` | Model for the pipeline's LLM stages (classify fallback, extraction, citation audit). Defaults to the product runtime default. |
| `AUTOMATION_RECONCILE_EVERY_N_TICKS` | `30` | Every Nth tick re-scans the last 2 days by query instead of the cursor walk, healing messages a transient Gmail error skipped (~hourly at the default cadence). |
| `GMAIL_AGENT_OWNER_USER_ID` | — | **Must be your firm's operator user id** (Supabase dashboard → Authentication → Users → the operator account's UUID). Inbound rows, runs, cases, and expenses are owned by this user — without it they will not appear in the operator's `/automation` and `/cases` views. |

Prerequisites from earlier phases (already documented elsewhere, listed for completeness): Supabase (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`), R2 storage (`R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), an LLM key for the pipeline model (`ANTHROPIC_API_KEY` for the default), and — for live intake only, not for rehearsal — the Gmail agent mailbox (`GMAIL_AGENT_ADDRESS`, `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`).

## 4. Playbook overrides (firm-specific)

Every firm inherits the `default-shared` seed until it overrides a key. The surface is the playbook API (`requireAuth` — use the same `Authorization: Bearer <token>` the app sends; grab it from the browser's Network tab while signed in as the operator account):

```bash
# Inspect a key (effective value = firm override, else the seed)
curl -s "$API/playbooks/entries/pi.claims.reply_to" -H "Authorization: Bearer $TOKEN"

# Override a key
curl -s -X PUT "$API/playbooks/entries/pi.claims.reply_to" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"value": "paralegal@example-firm.test"}'
```

| Key | Kind | Before enabling sends |
| --- | --- | --- |
| `pi.claims.reply_to` | **REQUIRED override** | Seeded **empty**. Set to the handling paralegal/attorney address; while empty, ack drafts carry no Reply-To and `AUTOMATION_DRAFTS_ONLY=false` must not be considered. |
| `pi.claims.signature_block` | **REQUIRED override** | Seed contains bracketed `[Firm Name]` / `[Firm Address]` placeholders — replace with your firm's real block. |
| `pi.invoices.vendor_registry` | **REQUIRED override** (portal_url) | Seed ships the 4 vendors with **empty `portal_url`**. Set each vendor's payment-portal URL (staged expenses link to where the human actually pays) and extend `domains` with any vendors your firm uses. |
| `pi.claims.carrier_registry` | **REQUIRED override** (domains) | Seed ships 6 fictional example carriers. Extend/adjust `domains` + `subject_patterns` to the carriers your firm actually sees — the registry is the deterministic classifier. |
| `pi.automation.confidence_thresholds` | Tunable default | `extraction_min 0.75`, `field_min 0.7`, `match_auto 0.95`, `match_confirm 0.8`. Tune conservatively after shadow-mode data. |
| `pi.cases.matching_rules` | Tunable default | `min_score 0.85` — the floor a candidate case must reach to be considered at all. |
| `pi.invoices.expense_approval_threshold` | Tunable default | `flag_above_usd 2500` — invoices above it are flagged prominently (every expense is still human-approved). |
| `pi.claims.extraction_guidance` | Tunable default | Field definitions for claim extraction; sharpen per-carrier formats as they come up. |
| `pi.invoices.extraction_guidance` | Tunable default | Field definitions for invoice extraction; sharpen per-vendor formats. |
| `pi.claims.ack_template` | Tunable default | Neutral acknowledgement body (`{{claim_number}}`, `{{carrier}}`, `{{client_name}}`, `{{adjuster_name}}`). Reads correctly with or without an adjuster name; tailor tone/letterhead if desired. |

## 5. Case seeding (CasePeer CSV)

1. Export the active case list from CasePeer as CSV (any columns; you map them next).
2. **Cases** page (`/cases`) → **Import CSV** wizard: pick the file → **column mapping** → **dry-run preview** → **Import**.
   - `case_number` and `client_name` mappings are **required** (the import upserts on `(user, case_number)`; a row without a case number can never import safely).
   - `date_of_loss` (`MM/DD/YYYY` or `YYYY-MM-DD`) and `status` (`open`/`settled`/`closed`/`provisional`) are optional; any other mapped column lands in the case's `attributes`.
   - The **dry run** shows per-row plans and row errors without writing anything; header/mapping-level problems reject the whole file loudly (nothing partially imports).
3. **Re-run safety:** imports are idempotent — re-importing updates existing cases by case number, only overwrites the fields the row provides, and merges `attributes`. Rejected rows are listed in the result and never silently vanish. Cap: 2,000 rows per request (split larger exports).

API equivalent: `POST /cases/import` (multipart `file`, `mapping` JSON, `dry_run=true|false`).

## 6. Email intake

v1 intake is **forwarding into the agent mailbox** (`GMAIL_AGENT_ADDRESS`): in your firm's mail system, create forwarding/routing rules that copy inbound mail **from the 6 carriers and 4 vendors** to the agent address —

- Carriers: `examplemutual.test` (+ `email.examplemutual.test`), `samplecasualty.test`, `demoauto.test` / `demoautoinsurance.test`, `placeholdergeneral.test` (Placeholder General Insurance), `fixtureindemnity.test`, `testunderwriters.test`.
- Vendors: `examplecasefunding.test` (Example Case Funding / ECF Legal Funding), `samplerecords.test`, `chartexample.test`.

The scheduler ingests the agent inbox incrementally (Gmail history cursor, with the periodic 2-day reconciliation sweep); the queue UI's **Poll now** button (`POST /automation/poll`) forces a pass on demand. Mail from anyone else still ingests but the classifier marks it `skipped` — forwarding rules keep the mailbox focused, they are not a security boundary.

**Later phase (not now):** service-account delegation directly into your firm's own mailboxes so nothing needs forwarding. The pipeline is unchanged when that lands; only the listing side moves.

## 7. Rehearsal

Run this against **dev** (migrations applied, §3 env set, `AUTOMATION_ENABLED` still `false` — the rehearsal drives the pipeline directly and does not need the scheduler):

```bash
cd backend
npx tsx scripts/generateFixturePdfs.ts      # regenerate the synthetic PDFs
npx tsx scripts/rehearsePipeline.ts --all   # or --fixture <name>
```

The script fails fast with a named missing variable if the env is incomplete. It seeds two synthetic cases (`PI-TEST-0001` "Jordan Sample", `PI-TEST-0002` "Casey Example") through the production CSV-import upsert, then drives each fixture through the **real** ingest-store → enqueue → `processRun` path and prints the full walk-through: classification, extracted fields with quotes/pages and per-citation verification, match outcome, staged proposal, and the ack draft body. It **never approves or sends anything** — staging only — and ends with a PASS/FAIL summary (exit code 0 only when all pass).

Then verify in the UI (`/automation`), per fixture — expected outcomes in detail live in `backend/fixtures/pi/README.md`:

- **claim-email-1** — *Ready for review*, `claim_correspondence`; open it: extracted claim `26-4400123` + limits `25/50` with ✓ citations onto the dec-page PDF; matched to "Jordan Sample"; one pending case write + a `pending_approval` ack draft whose body has **no dangling salutation**.
- **claim-email-2** — *Ready for review*; **two** policy upserts (multi-claim), ack references both claim numbers, summary reflects the demand deadline.
- **invoice-email-1** — *Ready for review*, `vendor_invoice`; expense `INV-002417` / `$1,850.00` pending; **Confirm case** required (containment match); invoice PDF filed on the case.
- **invoice-email-2** — *Ready for review*; expense `CE-778812` / `$64.50` pending against "Casey Example".
- **nonmatch-email** — under *Done* as `skipped`; nothing staged, no drafts.

Exercise the human paths on the staged runs: **Reject** one (with a reason — its operations cancel and the draft is cancelled), **Reassign** one to the other PI-TEST case, **Approve** one and confirm the case detail (`/cases/<id>`) shows the policy/expense while the ack stays a pending draft (drafts-only). Rejecting the rest cleans up the rehearsal.

## 8. Shadow mode → live

**Shadow mode (≥ 1 week):** set `AUTOMATION_ENABLED=true`, leave `AUTOMATION_DRAFTS_ONLY` at its default (`true`), restart the backend. The scheduler now ingests real forwarded mail and stages runs. Everything still waits for a human: approvals apply case writes; ack emails remain drafts (send them manually from the email surface when you want a live acknowledgement out). During the week, review the queue daily for **accuracy**: triage rate and reasons, wrong-case matches (how often *Reassign* was needed), extraction errors caught in *Edit & approve*, and whether the confidence thresholds need tuning (§4).

**Go live (sends):** only after the shadow week looks clean **and** the §4 REQUIRED overrides are set — set `AUTOMATION_DRAFTS_ONLY=false`, restart. The single behavior change: approving a **claim** run now also dispatches its acknowledgement draft (with the playbook Reply-To). Invoices are unchanged — payment stays human, always.

**Pause everything:** set `AUTOMATION_ENABLED=false`, restart. The scheduler does not start and cold inbound mail is not enqueued; already-staged runs simply wait in the queue (approve/reject still work). Drop back to shadow at any time with `AUTOMATION_DRAFTS_ONLY=true`.

## 9. Safety model

- **Approval-gated everything.** The pipeline's terminal state is `staged`; only a human decision (`/automation` approve) executes case writes, and every staged artifact (operation, draft, expense) is `pending_approval` until then. Doubt routes to `triage`, and triage/failed runs mutate nothing.
- **Tool-free extraction.** Every LLM call in the pipeline goes through `completeStructured`, which never carries tools — inbound content is framed as untrusted data, so a malicious email can at worst produce a bad *proposal* a human reviews, never an action. Extracted fields must carry verbatim quotes that are deterministically re-verified against the email/PDF; unverifiable required fields park the run in triage.
- **Deterministic outbound templates.** The acknowledgement body is `{{placeholder}}` substitution over the firm's playbook template plus the firm's signature block — no LLM prose can reach an outbound email, and drafts thread as replies on the carrier's own message.
- **Payment never automated.** Invoices become `pending_approval` ledger rows with the vendor's portal link; approval records the expense against the case. A person pays in the portal and marks it paid — the system never holds payment credentials or initiates a transfer.
