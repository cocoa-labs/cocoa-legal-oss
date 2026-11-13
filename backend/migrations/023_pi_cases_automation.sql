-- 023_pi_cases_automation.sql — Personal-injury practice data model + the
-- email-automation run state machine.
--
-- pi_cases is the per-user PI case registry (CSV-imported, created manually,
-- or auto-created as 'provisional' when automation sees an unknown case).
-- pi_case_policies holds carrier/claim/policy facts extracted from claim
-- correspondence; pi_case_expenses tracks vendor invoices through
-- approval → payment. automation_runs is one row per processed inbound email
-- — the state machine the automation pipeline drives (queued → classifying →
-- extracting → matching → staging → staged → approved/rejected, with
-- failed/triage/skipped exits and retry backoff via next_attempt_at; the
-- unique email_id index guarantees exactly one run per email).
-- automation_state is a small key/value table for the scheduler lease and
-- cursors. email_messages.reply_to_address captures the inbound Reply-To
-- header so automation acknowledgements answer the right address.
--
-- The backend reaches these tables only through the Supabase service role;
-- the browser holds zero direct grants (RLS deny-by-default, no permissive
-- policies — mirroring 007/019/022). Every statement is idempotent and safe
-- to re-run. Apply via the Supabase dashboard SQL editor (per CLAUDE.md; the
-- startup hook only inspects, never auto-applies).

create table if not exists public.pi_cases (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete set null,
  case_number text,
  client_name text not null,
  client_name_normalized text,
  date_of_loss date,
  status text not null default 'open'
    check (status in ('open','settled','closed','provisional')),
  origin text not null default 'manual'
    check (origin in ('csv_import','manual','auto_created')),
  needs_review boolean not null default false,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pi_cases_user_case_number_unique
  on public.pi_cases(user_id, case_number) where case_number is not null;
create index if not exists pi_cases_client_idx on public.pi_cases(user_id, client_name_normalized);

create table if not exists public.pi_case_policies (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.pi_cases(id) on delete cascade,
  carrier text not null,
  claim_number text,
  policy_number text,
  coverage_type text,
  policy_limits jsonb not null default '{}'::jsonb,
  adjuster jsonb not null default '{}'::jsonb,
  effective_dates jsonb,
  source_document_id uuid references public.documents(id) on delete set null,
  source_run_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pi_case_policies_case_idx  on public.pi_case_policies(case_id);
create index if not exists pi_case_policies_claim_idx on public.pi_case_policies(claim_number);
-- Backstop for upsertPolicy's lookup-then-insert: concurrent runs citing the
-- same claim number must not double-insert a policy row.
create unique index if not exists pi_case_policies_case_claim_unique
  on public.pi_case_policies(case_id, claim_number) where claim_number is not null;

create table if not exists public.pi_case_expenses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.pi_cases(id) on delete set null,
  user_id text not null,
  vendor text not null,
  invoice_number text,
  amount_cents bigint,
  currency text not null default 'USD',
  status text not null default 'pending_approval'
    check (status in ('pending_approval','approved','paid','rejected','void')),
  payment_portal_url text,
  document_id uuid references public.documents(id) on delete set null,
  agent_operation_id uuid references public.agent_operations(id) on delete set null,
  automation_run_id uuid,
  incurred_at date,
  paid_at timestamptz,
  paid_by text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pi_case_expenses_vendor_invoice_unique
  on public.pi_case_expenses(user_id, vendor, invoice_number) where invoice_number is not null;
create index if not exists pi_case_expenses_case_idx on public.pi_case_expenses(case_id);

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  email_id uuid references public.email_messages(id) on delete set null,
  workflow_kind text
    check (workflow_kind is null or workflow_kind in ('claim_correspondence','vendor_invoice')),
  status text not null default 'queued'
    check (status in ('queued','classifying','extracting','matching','staging','staged',
                      'approved','rejected','failed','triage','skipped')),
  case_id uuid references public.pi_cases(id) on delete set null,
  match_method text,
  match_confidence numeric,
  extracted jsonb not null default '{}'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  confidence numeric,
  verification jsonb not null default '{}'::jsonb,
  proposal jsonb not null default '{}'::jsonb,
  ack_email_id uuid,
  operation_ids jsonb not null default '[]'::jsonb,
  error text,
  retry_count integer not null default 0,
  next_attempt_at timestamptz,
  triage_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists automation_runs_email_unique on public.automation_runs(email_id);
create index if not exists automation_runs_due_idx on public.automation_runs(status, next_attempt_at);

create table if not exists public.automation_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  claimed_by text,
  claimed_until timestamptz,
  updated_at timestamptz not null default now()
);

-- Inbound Reply-To header, so automation acknowledgements answer the sender's
-- preferred address instead of the From.
alter table public.email_messages add column if not exists reply_to_address text;

-- Service-role only, like every other table (see 007/019/022): RLS
-- deny-by-default with no permissive policies, zero direct browser grants.
alter table public.pi_cases enable row level security;
alter table public.pi_case_policies enable row level security;
alter table public.pi_case_expenses enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_state enable row level security;

revoke all on public.pi_cases from anon, authenticated;
revoke all on public.pi_case_policies from anon, authenticated;
revoke all on public.pi_case_expenses from anon, authenticated;
revoke all on public.automation_runs from anon, authenticated;
revoke all on public.automation_state from anon, authenticated;
