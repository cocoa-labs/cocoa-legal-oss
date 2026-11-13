# CRE demo script — Commercial Real Estate Review (2–3 minutes)

A tight, repeatable walkthrough of the Coco Legal **Commercial Real Estate Review**
capability for a client demo. The flagship beat is the **US Commercial Lease
Abstraction**: attach a real-looking lease, run it, and watch ~29 columns extract,
grade against the firm playbook (green = Market, yellow = Off-market / Material,
red = Deal-breaker), surface a red **deal-breaker**, and auto-prefill an
**EscalationDraft**. A second hero (the PSA) repeats the beat from the Buyer side.

Sample documents live in [`fixtures/legal/`](../fixtures/legal/) and are
**text-based `.docx`** (the app has no OCR — never demo a scanned PDF). See
[`fixtures/legal/README.md`](../fixtures/legal/README.md) for what each sample
plants.

---

## Pre-flight checklist (do this BEFORE the client is on the call)

- [ ] **Migrations applied in Supabase** (SQL editor, in order; the startup hook only
      inspects, it never applies). The three that make this demo light up:
  - [ ] `009_cre_playbook_seed.sql` — seeds the 7 `cre.*` playbook keys (standard
        positions, **deal-breakers**, estoppel, SNDA, PSA, diligence, escalation
        template) on the `default-shared` firm.
  - [ ] `013_cre_playbook_enrich.sql` — re-seeds the same 7 keys with the deeper
        dual-valence positions. **Apply 013 after 009** (it supersedes via
        `ON CONFLICT DO UPDATE`).
  - [ ] `014_tabular_review_represented_party.sql` — adds `represented_party` to
        `tabular_reviews` so the Tenant/Landlord (or Buyer/Seller) choice steers the
        analysis.
  - Run the **verification SQL** below — expect **3 rows**, each `is_default = true`.
- [ ] **Account model is set for tabular review.** In **Account → Models & API Keys**,
      confirm **`tabular_model = claude-sonnet-4-6`** (migration `010` makes this the
      default for new profiles; an older account may still be on a previous tier —
      set it explicitly). *Project note: CLAUDE.md prefers Opus 4.7 for shipped
      defaults; this account is intentionally on Sonnet for cost during demos — leave
      it unless the client wants to see the Opus tier.*
- [ ] **Provider API key present** for the selected model (Anthropic key for the
      `claude-*` tier) in **Account → Models & API Keys**. No key → cells error out.
- [ ] **Use the text DOCX samples**, never a scanned PDF. Confirm each opens in Word
      with **selectable text** (`fixtures/legal/sample-commercial-lease.docx`,
      `sample-psa.docx`, `sample-tenant-estoppel.docx`).
- [ ] **Fallback ready:** keep a **pre-run lease review open in a second browser tab**
      so that if the live extraction stalls (cold model, slow network), you can switch
      tabs and narrate the finished result without dead air.
- [ ] Browser zoom ~100–110%, notifications silenced, single clean chat thread open.

### Verification SQL (run in Supabase → expect exactly 3 rows, each `is_default = t`)

```sql
-- Confirms the three load-bearing CRE seeds are present on the default-shared
-- firm playbook: the standard positions, the deal-breakers (which drive the red
-- flags), and the escalation template (which fills the EscalationDraft).
select e.key,
       left(e.value_json::text, 80) as value_preview,
       e.is_default
from public.playbook_entries e
join public.firm_playbooks p on p.id = e.playbook_id
where p.firm_id = 'default-shared'
  and e.key in (
    'cre.lease.standard_positions',
    'cre.lease.deal_breakers',
    'cre.escalation.notification_template'
  )
order by e.key;
```

If you get **0 rows**, migration `009` (and `013`) was not applied — apply it and
re-run. If a row shows `is_default = f`, a firm override exists; that is fine for a
customized demo but the out-of-box red flags assume the seeded defaults.

---

## The script

### 0. Frame it (15 sec)
> "This is our Commercial Real Estate review. I'll drop in a commercial lease the
> way an associate would, and it'll abstract the deal, grade every term against our
> firm's negotiation playbook, and flag anything that's a deal-breaker — from the
> tenant's side."

### 1. Chat-attach the lease (20 sec)
- In the assistant chat, **attach `sample-commercial-lease.docx`** and send a short
  message — e.g. *"Can you review this office lease for us?"*
- The intent router recognizes it as a commercial lease and drops an inline
  **proposal chip** with a confirm prompt and a **"Run review"** button.

### 2. Configure as Tenant and run (25 sec)
- Click **Run review**. The workflow modal opens on the **US Commercial Lease**
  pack with the lease pre-attached.
- In the **represented-side** control, leave it on **Tenant** (the default).
- Click **Run** / **Generate**. Narrate while cells stream:
> "It's pulling the parties, the premises and rentable square footage, the rent and
> escalations, CAM, options, SNDA, estoppel — about twenty-nine columns — and
> grading each one green, yellow, or red against our playbook."

### 3. Land on the flagged card (45 sec) — the hero beat
The **CRE result card** renders with:
- a risk badge reading **"At least one deal-breaker term flagged"**, and a
  **"{done}/{total} terms reviewed · {n} flagged"** line;
- a **Key issues** list, deal-breakers pinned on top. Call out the four planted reds:
  1. **CAM / Operating Expenses** — *uncapped controllable expenses* (no annual cap).
  2. **Guarantor / Personal Guaranty** — *full personal guaranty, no burn-off, no cap*
     (not a "good-guy" guaranty).
  3. **Holdover** — *200% holdover rent layered with consequential-damages exposure.*
  4. **SNDA Required** — *no non-disturbance obligation* (the tenant can be wiped out
     on a lender foreclosure).
> "Each red ties back to a specific section of the lease and to the exact playbook
> position it violates — these aren't generic warnings, they're the firm's
> non-negotiables."

### 4. The EscalationDraft (20 sec)
Because a red is present, the card auto-surfaces an **EscalationDraft** — a
pre-filled senior-counsel escalation (subject + body listing the flagged terms),
built from the firm's `cre.escalation.notification_template`.
> "Anything graded deal-breaker auto-drafts the escalation to senior counsel — the
> reviewer doesn't write it from scratch."

### 5. Export (15 sec)
- Click **Export DOCX** (a clean abstract memo) and/or **Export XLSX** (the full
  abstract grid) to show the work product leaves the app in the formats a deal team
  actually uses.

### 6. Toggle to Landlord (20 sec) — show dual representation
- Re-run (or open a fresh review) with the **represented-side** set to **Landlord**.
> "Same lease, opposite chair. The grading and the framing flip to the landlord's
> side — the model argues the other way."

### 7. Second hero — the PSA as Buyer (25 sec)
- Attach **`sample-psa.docx`**, **Run review**, and set the side to **Buyer**.
- Call out the two planted flags:
  - **No survival clause** — the seller's reps *merge into the deed and die at
    closing* (an auto-flag for the buyer).
  - **Buyer-default liquidated damages = the deposit** as the seller's sole remedy.
> "Different document type, same playbook discipline — purchase-and-sale terms graded
> from the buyer's side."

### (Optional) 8. Lease ↔ estoppel gap (20 sec)
- Mention/attach **`sample-tenant-estoppel.docx`**, which references the same lease.
  It (a) states "no defaults" **without a knowledge qualifier**, and (b) confirms the
  landlord owes **no outstanding TI allowance** — even though the lease *grants*
  one. Both are tenant traps a careful reviewer would catch against the lease.

### Close (10 sec)
> "Attach to abstract, grade against our playbook, escalate the deal-breakers, export
> — minutes instead of hours, and consistent with how this firm actually negotiates."

---

## If something goes wrong
- **Cells error / stay empty:** missing or wrong provider API key, or no
  `tabular_model` set → fix in **Account → Models & API Keys**; switch to the
  **fallback tab** and narrate the pre-run result.
- **No red flags appear:** the deal-breaker seeds aren't applied (or a firm override
  replaced them) → re-run the **verification SQL**; apply `009` then `013`.
- **A PDF won't extract:** you used a scanned/image PDF — the app has no OCR. Use the
  **text `.docx`** samples.
- **"Run review" chip never appears:** the router didn't classify the upload — say
  "review this commercial lease" in the message, or launch the **US Commercial Lease**
  pack directly from the workflow gallery and attach the file there.
