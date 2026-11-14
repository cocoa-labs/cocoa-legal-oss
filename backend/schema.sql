-- Historical reference snapshot of the Cocoa Legal schema. NOT an install path.
--
-- Create databases with `npm run migrate` (backend/), which applies
-- backend/migrations/000_base_schema.sql and every later file in order and
-- records each one in the migration ledger that the readiness check verifies.
-- This snapshot predates several migrations and is kept for reference and tests.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- User profiles
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  organisation text,
  tier text not null default 'Free',
  message_credits_used integer not null default 0,
  credits_reset_date timestamptz not null default (now() + interval '30 days'),
  tabular_model text not null default 'claude-sonnet-4-6',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_profiles_user
  on public.user_profiles(user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
exception when others then
  -- Never block signup if the profile insert fails.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'gemini', 'openai')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider)
);

create index if not exists idx_user_api_keys_user
  on public.user_api_keys(user_id);

-- ---------------------------------------------------------------------------
-- Projects and documents
-- ---------------------------------------------------------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  cm_number text,
  visibility text not null default 'private',
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_user
  on public.projects(user_id);

create index if not exists projects_shared_with_idx
  on public.projects using gin (shared_with);

create table if not exists public.project_subfolders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  name text not null,
  parent_folder_id uuid references public.project_subfolders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_subfolders_project
  on public.project_subfolders(project_id);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  filename text not null,
  file_type text,
  document_type text,
  size_bytes integer not null default 0,
  page_count integer,
  structure_tree jsonb,
  status text not null default 'pending',
  folder_id uuid references public.project_subfolders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_documents_user_project
  on public.documents(user_id, project_id);

create index if not exists idx_documents_project_folder
  on public.documents(project_id, folder_id);

-- CRE document-type classification (see migrations/008_cre_document_type.sql).
create index if not exists idx_documents_document_type
  on public.documents(document_type);

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text not null,
  pdf_storage_path text,
  source text not null default 'upload',
  version_number integer,
  display_name text,
  created_by_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'assistant_highlight'::text,
      'assistant_undo'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'authored'::text,
      'clean_final'::text
    ]))
);

create index if not exists document_versions_document_id_idx
  on public.document_versions(document_id, created_at desc);

create index if not exists document_versions_doc_vnum_idx
  on public.document_versions(document_id, version_number);

alter table public.document_versions
  add column if not exists layout_qa_status text not null default 'unverified',
  add column if not exists layout_qa_report jsonb,
  add column if not exists layout_qa_checked_at timestamptz;

alter table public.document_versions
  drop constraint if exists document_versions_layout_qa_status_check;

alter table public.document_versions
  add constraint document_versions_layout_qa_status_check
  check (layout_qa_status = any (array[
    'source'::text,
    'unverified'::text,
    'passed'::text,
    'failed'::text
  ]));

update public.document_versions
set layout_qa_status = 'source',
    layout_qa_report = null,
    layout_qa_checked_at = null
where source in ('upload', 'user_upload')
  and layout_qa_status = 'unverified';

create index if not exists document_versions_layout_qa_pending_idx
  on public.document_versions(layout_qa_status, created_at)
  where layout_qa_status in ('unverified', 'failed');

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'assistant_highlight'::text,
      'assistant_undo'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'authored'::text,
      'clean_final'::text
    ]));

alter table public.documents
  add column if not exists current_version_id uuid
  references public.document_versions(id) on delete set null;

create table if not exists public.document_edits (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  chat_message_id uuid,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  change_id text not null,
  del_w_id text,
  ins_w_id text,
  deleted_text text not null default '',
  inserted_text text not null default '',
  context_before text,
  context_after text,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text,
      'accepted'::text,
      'rejected'::text
    ])),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists document_edits_document_id_idx
  on public.document_edits(document_id, created_at desc);

create index if not exists document_edits_message_id_idx
  on public.document_edits(chat_message_id);

create index if not exists document_edits_version_id_idx
  on public.document_edits(version_id);

create table if not exists public.document_highlight_sets (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete set null,
  user_id text not null,
  chat_message_id uuid,
  title text not null default 'Document highlights',
  query text,
  status text not null default 'reviewing'
    check (status = any (array[
      'reviewing'::text,
      'applied'::text
    ])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_highlight_sets_document_id_idx
  on public.document_highlight_sets(document_id, created_at desc);

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null default 'image'
    check (kind = any (array['image'::text])),
  filename text not null,
  mime_type text not null,
  size_bytes integer not null default 0,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_attachments_user_idx
  on public.chat_attachments(user_id, created_at desc);

create index if not exists chat_attachments_project_idx
  on public.chat_attachments(project_id, created_at desc);

create index if not exists document_highlight_sets_user_idx
  on public.document_highlight_sets(user_id, created_at desc);

create table if not exists public.document_highlights (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.document_highlight_sets(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete set null,
  quote text not null,
  context text not null default '',
  label text not null default 'Highlight',
  color text not null default 'yellow',
  occurrence_index integer not null default 0,
  page integer,
  status text not null default 'kept'
    check (status = any (array[
      'kept'::text,
      'removed'::text,
      'applied'::text
    ])),
  created_at timestamptz not null default now()
);

create index if not exists document_highlights_set_id_idx
  on public.document_highlights(set_id, created_at);

create index if not exists document_highlights_document_id_idx
  on public.document_highlights(document_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  title text not null,
  type text not null,
  prompt_md text,
  columns_config jsonb,
  practice text,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_workflows_user
  on public.workflows(user_id);

create table if not exists public.hidden_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  workflow_id text not null,
  created_at timestamptz not null default now(),
  unique(user_id, workflow_id)
);

create index if not exists idx_hidden_workflows_user
  on public.hidden_workflows(user_id);

create table if not exists public.workflow_shares (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  shared_by_user_id text not null,
  shared_with_email text not null,
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_shares_workflow_email_unique
    unique(workflow_id, shared_with_email)
);

create index if not exists workflow_shares_workflow_id_idx
  on public.workflow_shares(workflow_id);

create index if not exists workflow_shares_email_idx
  on public.workflow_shares(shared_with_email);

-- ---------------------------------------------------------------------------
-- Assistant chats
-- ---------------------------------------------------------------------------

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists idx_chats_user
  on public.chats(user_id);

create index if not exists idx_chats_project
  on public.chats(project_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null,
  content jsonb,
  files jsonb,
  annotations jsonb,
  workflow jsonb,
  version_context jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_messages_chat
  on public.chat_messages(chat_id);

create index if not exists chat_messages_chat_chronological_idx
  on public.chat_messages(chat_id, created_at, id);

-- Fork lineage on chats (mirrors migration 017). Added here, after
-- chat_messages exists, so forked_from_message_id's FK resolves.
alter table public.chats
  add column if not exists parent_chat_id uuid
    references public.chats(id) on delete set null,
  add column if not exists root_chat_id uuid
    references public.chats(id) on delete set null,
  add column if not exists forked_from_message_id uuid
    references public.chat_messages(id) on delete set null,
  add column if not exists anchor_document_id uuid
    references public.documents(id) on delete set null,
  add column if not exists anchor_version_id uuid
    references public.document_versions(id) on delete set null,
  add column if not exists branch_tip_version_id uuid
    references public.document_versions(id) on delete set null,
  add column if not exists fork_label text,
  add column if not exists conversation_summary jsonb,
  add column if not exists conversation_summary_through_message_id uuid
    references public.chat_messages(id) on delete set null,
  add column if not exists conversation_summary_version integer not null default 1,
  add column if not exists conversation_summary_status text not null default 'clean',
  add column if not exists conversation_summary_updated_at timestamptz;

create index if not exists chats_parent_idx on public.chats(parent_chat_id);
create index if not exists chats_root_idx on public.chats(root_chat_id);
create index if not exists chats_conversation_summary_status_idx
  on public.chats(conversation_summary_status)
  where conversation_summary_status <> 'clean';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_edits_chat_message_id_fkey'
      and conrelid = 'public.document_edits'::regclass
  ) then
    alter table public.document_edits
      add constraint document_edits_chat_message_id_fkey
      foreign key (chat_message_id)
      references public.chat_messages(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tabular reviews
-- ---------------------------------------------------------------------------

create table if not exists public.tabular_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id text not null,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid references public.workflows(id) on delete set null,
  practice text,
  -- Which side the user represents for a CRE review (e.g. 'Tenant',
  -- 'Landlord', 'Buyer', 'Seller'). Nullable: legacy/non-CRE reviews leave
  -- it NULL. Steers the {{representedParty}} substitution in the tabular
  -- path. See migration 014_tabular_review_represented_party.sql.
  represented_party text,
  shared_with jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_reviews_user
  on public.tabular_reviews(user_id);

create index if not exists idx_tabular_reviews_project
  on public.tabular_reviews(project_id);

create index if not exists tabular_reviews_shared_with_idx
  on public.tabular_reviews using gin (shared_with);

create table if not exists public.tabular_cells (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  column_index integer not null,
  content text,
  citations jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_cells_review
  on public.tabular_cells(review_id, document_id, column_index);

create table if not exists public.tabular_review_chats (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id text not null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tabular_review_chats_review_idx
  on public.tabular_review_chats(review_id, updated_at desc);

create index if not exists tabular_review_chats_user_idx
  on public.tabular_review_chats(user_id);

create table if not exists public.tabular_review_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.tabular_review_chats(id) on delete cascade,
  role text not null,
  content jsonb,
  annotations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tabular_review_chat_messages_chat_idx
  on public.tabular_review_chat_messages(chat_id, created_at);

create index if not exists tabular_review_chat_messages_chat_chronological_idx
  on public.tabular_review_chat_messages(chat_id, created_at, id);

alter table public.tabular_review_chats
  add column if not exists conversation_summary jsonb,
  add column if not exists conversation_summary_through_message_id uuid
    references public.tabular_review_chat_messages(id) on delete set null,
  add column if not exists conversation_summary_version integer not null default 1,
  add column if not exists conversation_summary_status text not null default 'clean',
  add column if not exists conversation_summary_updated_at timestamptz;

alter table public.tabular_review_chat_messages
  add column if not exists model_id text,
  add column if not exists generation_status text,
  add column if not exists finish_reason text,
  add column if not exists generation_usage_json jsonb not null default '{}'::jsonb,
  add column if not exists generation_updated_at timestamptz;

create index if not exists tabular_review_chats_conversation_summary_status_idx
  on public.tabular_review_chats(conversation_summary_status)
  where conversation_summary_status <> 'clean';

create or replace function public.claim_chat_conversation_summary()
returns setof public.chats
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select id from public.chats
    where conversation_summary_status = 'queued'
       or (conversation_summary_status = 'running'
           and conversation_summary_updated_at < now() - interval '10 minutes')
    order by conversation_summary_updated_at nulls first, created_at
    for update skip locked limit 1
  )
  update public.chats c
  set conversation_summary_status = 'running',
      conversation_summary_updated_at = now()
  from candidate where c.id = candidate.id
  returning c.*;
end;
$$;

create or replace function public.claim_tabular_conversation_summary()
returns setof public.tabular_review_chats
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select id from public.tabular_review_chats
    where conversation_summary_status = 'queued'
       or (conversation_summary_status = 'running'
           and conversation_summary_updated_at < now() - interval '10 minutes')
    order by conversation_summary_updated_at nulls first, created_at
    for update skip locked limit 1
  )
  update public.tabular_review_chats c
  set conversation_summary_status = 'running',
      conversation_summary_updated_at = now()
  from candidate where c.id = candidate.id
  returning c.*;
end;
$$;

revoke all on function public.claim_chat_conversation_summary()
  from public, anon, authenticated;
revoke all on function public.claim_tabular_conversation_summary()
  from public, anon, authenticated;
grant execute on function public.claim_chat_conversation_summary()
  to service_role;
grant execute on function public.claim_tabular_conversation_summary()
  to service_role;

-- ---------------------------------------------------------------------------
-- Firm playbooks
-- ---------------------------------------------------------------------------
--
-- Firm-customizable legal playbooks (see migrations/005_firm_playbooks.sql).
-- Each capability reads keyed entries (e.g. cre.lease.standard_positions,
-- risk.escalation_thresholds) from the firm's playbook at runtime. v1 resolves
-- firm_id to the user's auth.users id; firm_id = 'default-shared' holds the
-- built-in defaults every firm inherits until it overrides a key.

create table if not exists public.firm_playbooks (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  version int not null default 1,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists firm_playbooks_firm_id_unique
  on public.firm_playbooks(firm_id);

create table if not exists public.playbook_entries (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.firm_playbooks(id) on delete cascade,
  key text not null,
  value_json jsonb not null default '{}'::jsonb,
  notes_md text not null default '',
  is_default boolean not null default false,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists playbook_entries_key_unique
  on public.playbook_entries(playbook_id, key);

create index if not exists playbook_entries_key_idx
  on public.playbook_entries(key);

create table if not exists public.playbook_versions (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.firm_playbooks(id) on delete cascade,
  version int not null,
  snapshot_json jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists playbook_versions_playbook_idx
  on public.playbook_versions(playbook_id, version desc);

-- Placeholder seed confirming the playbook plumbing end-to-end
-- (migrations/006_playbook_default_seed.sql). Idempotent.
do $$
declare
  default_firm text := 'default-shared';
  pb_id uuid;
begin
  insert into public.firm_playbooks (firm_id, updated_by)
  values (default_firm, 'migration')
  on conflict (firm_id) do update set updated_at = now()
  returning id into pb_id;

  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'meta.playbook_seeded',
      jsonb_build_object('seeded_at', now()::text),
      'Placeholder confirming the playbook layer is wired. Replace with real per-capability seeds.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md;
end $$;

-- Commercial Real Estate playbook seed — fold of migrations 009 + 013. 013
-- re-seeds the same 7 cre.* keys from 009 with the enriched dual-valence
-- copy via ON CONFLICT DO UPDATE, so only the superseding 013 values appear
-- here. The shared risk.escalation_thresholds key keeps ON CONFLICT DO
-- NOTHING so a later shared/escalation migration's value is never clobbered.
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

-- ---------------------------------------------------------------------------
-- Production foundation: org/matter tenancy and operation ledger
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null,
  email text,
  role text not null default 'owner'
    check (role = any (array[
      'owner'::text,
      'admin'::text,
      'lawyer'::text,
      'editor'::text,
      'reviewer'::text,
      'viewer'::text
    ])),
  status text not null default 'active'
    check (status = any (array[
      'active'::text,
      'invited'::text,
      'disabled'::text
    ])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists organization_memberships_user_idx
  on public.organization_memberships(user_id, status);

create index if not exists organization_memberships_email_idx
  on public.organization_memberships(lower(email), status);

create table if not exists public.matters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  name text not null,
  cm_number text,
  lifecycle_status text not null default 'active'
    check (lifecycle_status = any (array[
      'active'::text,
      'archived'::text,
      'deleted_pending_purge'::text,
      'legal_hold'::text
    ])),
  retention_until timestamptz,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists matters_org_idx
  on public.matters(organization_id, lifecycle_status);

create index if not exists matters_project_idx
  on public.matters(project_id);

create table if not exists public.matter_memberships (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  user_id text not null,
  email text,
  role text not null default 'lawyer'
    check (role = any (array[
      'owner'::text,
      'admin'::text,
      'lawyer'::text,
      'editor'::text,
      'reviewer'::text,
      'viewer'::text
    ])),
  status text not null default 'active'
    check (status = any (array[
      'active'::text,
      'invited'::text,
      'disabled'::text
    ])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (matter_id, user_id)
);

create index if not exists matter_memberships_user_idx
  on public.matter_memberships(user_id, status);

create index if not exists matter_memberships_email_idx
  on public.matter_memberships(lower(email), status);

alter table public.projects
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null,
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists retention_until timestamptz,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.documents
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null,
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists retention_until timestamptz,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.workflows
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null;

alter table public.chats
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null;

alter table public.tabular_reviews
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null,
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists deleted_at timestamptz;

alter table public.document_versions
  add column if not exists parent_version_id uuid references public.document_versions(id) on delete set null,
  add column if not exists created_by_operation_id uuid,
  add column if not exists content_status text not null default 'ready'
    check (content_status = any (array[
      'queued'::text,
      'scanning'::text,
      'extracting'::text,
      'rendering'::text,
      'ready'::text,
      'error'::text
    ])),
  add column if not exists extraction_quality jsonb not null default '{}'::jsonb;

create index if not exists projects_org_matter_idx
  on public.projects(org_id, matter_id);

create index if not exists documents_org_matter_idx
  on public.documents(org_id, matter_id);

create index if not exists document_versions_parent_idx
  on public.document_versions(parent_version_id);

create table if not exists public.agent_operations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  chat_message_id uuid references public.chat_messages(id) on delete set null,
  actor_user_id text not null,
  actor_role text,
  tool_name text not null,
  action_type text not null,
  status text not null default 'running'
    check (status = any (array[
      'pending_approval'::text,
      'approved'::text,
      'running'::text,
      'succeeded'::text,
      'failed'::text,
      'undone'::text,
      'cancelled'::text
    ])),
  approval_status text not null default 'not_required'
    check (approval_status = any (array[
      'not_required'::text,
      'required'::text,
      'approved'::text,
      'rejected'::text
    ])),
  mutating boolean not null default false,
  requires_approval boolean not null default false,
  source_document_id uuid references public.documents(id) on delete set null,
  source_version_id uuid references public.document_versions(id) on delete set null,
  result_document_id uuid references public.documents(id) on delete set null,
  result_version_id uuid references public.document_versions(id) on delete set null,
  input_hash text,
  arguments jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  providers jsonb not null default '[]'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  anchors jsonb not null default '[]'::jsonb,
  affected_ranges jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  inverse_operation text,
  parent_operation_id uuid references public.agent_operations(id) on delete set null,
  idempotency_key text,
  approved_by_user_id text,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_operations_idempotency_idx
  on public.agent_operations(idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_operations_actor_idx
  on public.agent_operations(actor_user_id, created_at desc);

create index if not exists agent_operations_project_idx
  on public.agent_operations(project_id, created_at desc);

create index if not exists agent_operations_document_idx
  on public.agent_operations(source_document_id, result_document_id, created_at desc);

create index if not exists agent_operations_chat_idx
  on public.agent_operations(chat_id, created_at desc);

create index if not exists agent_operations_chat_message_idx
  on public.agent_operations(chat_message_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_created_by_operation_id_fkey'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_created_by_operation_id_fkey
      foreign key (created_by_operation_id)
      references public.agent_operations(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Agent email and native e-signature
-- ---------------------------------------------------------------------------
--
-- Outbound + inbound email for the agent's dedicated Workspace mailbox
-- (migrations/011_email_messages.sql). Outbound is approval-gated: the
-- send_email tool inserts rows as 'pending_approval' and they are only
-- dispatched after explicit user approval. Inbound rows are ingested from the
-- agent inbox, deduped by provider_message_id, and threaded to the
-- originating outbound message or signature envelope.

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  user_id text not null,
  project_id uuid,
  chat_id uuid,
  agent_operation_id uuid,
  direction text not null default 'outbound'
    check (direction = any (array['outbound'::text, 'inbound'::text])),
  status text not null default 'pending_approval'
    check (status = any (array[
      'pending_approval'::text, 'approved'::text, 'sending'::text,
      'sent'::text, 'failed'::text, 'cancelled'::text, 'received'::text
    ])),
  from_address text,
  to_addresses jsonb not null default '[]'::jsonb,
  cc_addresses jsonb not null default '[]'::jsonb,
  bcc_addresses jsonb not null default '[]'::jsonb,
  subject text not null default '',
  body_text text not null default '',
  body_html text,
  -- [{document_id, version_id, filename, content_type, size}]
  attachments jsonb not null default '[]'::jsonb,
  provider text not null default 'gmail',
  provider_message_id text,
  provider_thread_id text,
  in_reply_to text,
  -- Inbound Reply-To header, so automation acknowledgements answer the
  -- sender's preferred address (migrations/023_pi_cases_automation.sql).
  reply_to_address text,
  signature_envelope_id uuid,
  error text,
  approved_by text,
  approved_at timestamptz,
  sent_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_messages_user_idx
  on public.email_messages(user_id, created_at desc);
create index if not exists email_messages_status_idx
  on public.email_messages(status);
create index if not exists email_messages_direction_idx
  on public.email_messages(direction, created_at desc);
create index if not exists email_messages_thread_idx
  on public.email_messages(provider_thread_id);
create index if not exists email_messages_operation_idx
  on public.email_messages(agent_operation_id);
create index if not exists email_messages_envelope_idx
  on public.email_messages(signature_envelope_id);
-- Dedupe ingested inbound messages by Gmail message id.
create unique index if not exists email_messages_provider_message_unique
  on public.email_messages(provider_message_id)
  where provider_message_id is not null;

-- Native, self-owned e-signature (migrations/012_signature_envelopes.sql).
-- An envelope wraps one document plus N parallel signers. Each signer is
-- accessed through a single-use, expiring magic-link token — only the SHA-256
-- of the token is stored, never the token itself. On completion the pipeline
-- stamps the captured signatures into the PDF, embeds a cryptographic PDF
-- signature, hashes the original and executed files, and emits a Certificate
-- of Completion assembled from signature_events. Sending a signature request
-- is approval-gated (envelope starts 'pending_approval'); the public signer
-- page authenticates by token, not by Supabase session.

create table if not exists public.signature_envelopes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  user_id text not null,
  project_id uuid,
  chat_id uuid,
  agent_operation_id uuid,
  document_id uuid references public.documents(id) on delete set null,
  source_version_id uuid,
  status text not null default 'pending_approval'
    check (status = any (array[
      'draft'::text, 'pending_approval'::text, 'sent'::text,
      'partially_signed'::text, 'completed'::text, 'declined'::text,
      'expired'::text, 'cancelled'::text
    ])),
  subject text not null default '',
  message text not null default '',
  original_pdf_path text,
  original_sha256 text,
  executed_pdf_path text,
  executed_sha256 text,
  executed_document_id uuid references public.documents(id) on delete set null,
  executed_version_id uuid,
  certificate_path text,
  expires_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists signature_envelopes_user_idx
  on public.signature_envelopes(user_id, created_at desc);
create index if not exists signature_envelopes_status_idx
  on public.signature_envelopes(status);
create index if not exists signature_envelopes_document_idx
  on public.signature_envelopes(document_id);
create index if not exists signature_envelopes_operation_idx
  on public.signature_envelopes(agent_operation_id);

create table if not exists public.signature_signers (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null
    references public.signature_envelopes(id) on delete cascade,
  name text not null default '',
  email text not null,
  order_index int not null default 0,
  role text not null default 'signer'
    check (role = any (array['signer'::text, 'cc'::text])),
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text, 'viewed'::text, 'signed'::text, 'declined'::text
    ])),
  -- SHA-256 of the single-use magic-link token. Null until the envelope is
  -- approved and sent (tokens are minted at send time so they are short-lived).
  access_token_hash text,
  token_expires_at timestamptz,
  signature_image_path text,
  typed_name text,
  consent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  signer_ip text,
  signer_user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists signature_signers_token_unique
  on public.signature_signers(access_token_hash)
  where access_token_hash is not null;
create index if not exists signature_signers_envelope_idx
  on public.signature_signers(envelope_id);
create index if not exists signature_signers_email_idx
  on public.signature_signers(email);

create table if not exists public.signature_events (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null
    references public.signature_envelopes(id) on delete cascade,
  signer_id uuid references public.signature_signers(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists signature_events_envelope_idx
  on public.signature_events(envelope_id, created_at);

-- Sender-placed signature field positions (migrations/015_signature_fields.sql).
-- Coordinate convention (canonical, end-to-end): TOP-LEFT origin, normalized
-- to the page. x_pct/y_pct are the box's top-left corner as a fraction of
-- page width/height (y measured DOWN from the top); w_pct/h_pct are size
-- fractions. The backend converts to pdf-lib's bottom-left space exactly
-- once, at stamp time.

create table if not exists public.signature_fields (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null
    references public.signature_envelopes(id) on delete cascade,
  signer_id uuid not null
    references public.signature_signers(id) on delete cascade,
  -- 'signature' | 'initials' | 'date' | 'name'
  type text not null default 'signature',
  page int not null default 0,            -- 0-based page index
  x_pct double precision not null,        -- top-left corner X, fraction of width
  y_pct double precision not null,        -- top-left corner Y, fraction of height (from top)
  w_pct double precision not null,        -- box width, fraction of page width
  h_pct double precision not null,        -- box height, fraction of page height
  created_at timestamptz not null default now()
);

create index if not exists signature_fields_envelope_idx
  on public.signature_fields(envelope_id);
create index if not exists signature_fields_signer_idx
  on public.signature_fields(signer_id);

-- ---------------------------------------------------------------------------
-- Document authoring: templates, clause library, authoring jobs
-- ---------------------------------------------------------------------------
--
-- Template-centric authoring engine. document_templates/template_versions hold
-- a versioned, parameterized document skeleton (firm-overridable like the
-- playbook tables, where firm_id = 'default-shared' is the built-in
-- default). clause_library is a reusable clause bank. authoring_jobs is the
-- audit spine of one authoring run. See migrations/019_document_templates.sql.

create table if not exists public.document_templates (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  slug text not null,
  title text not null,
  doc_type text not null,
  practice text not null default 'Real Estate',
  jurisdiction text,
  description text,
  source_kind text not null default 'ai_generated'
    check (source_kind = any (array['ai_generated'::text,'cocoa_seed'::text,'firm_parameterized'::text])),
  source_document_id uuid references public.documents(id) on delete set null,
  current_version_id uuid,
  status text not null default 'active'
    check (status = any (array['draft'::text,'active'::text,'archived'::text])),
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists document_templates_firm_slug_unique
  on public.document_templates(firm_id, slug);
create index if not exists document_templates_doc_type_idx
  on public.document_templates(firm_id, doc_type, status);

create table if not exists public.template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete cascade,
  version_number integer not null default 1,
  skeleton_json jsonb not null default '[]'::jsonb,
  variable_schema_json jsonb not null default '[]'::jsonb,
  clause_slots_json jsonb not null default '[]'::jsonb,
  generation_notes_md text not null default '',
  created_by_operation_id uuid references public.agent_operations(id) on delete set null,
  created_by_user_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists template_versions_tmpl_vnum_unique
  on public.template_versions(template_id, version_number);
create index if not exists template_versions_tmpl_idx
  on public.template_versions(template_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint
    where conname = 'document_templates_current_version_id_fkey'
      and conrelid = 'public.document_templates'::regclass) then
    alter table public.document_templates
      add constraint document_templates_current_version_id_fkey
      foreign key (current_version_id) references public.template_versions(id) on delete set null;
  end if;
end $$;

create table if not exists public.clause_library (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  clause_key text not null,
  title text not null,
  doc_types text[] not null default '{}',
  body_md text not null,
  variables_used text[] not null default '{}',
  jurisdiction text,
  is_default boolean not null default false,
  notes_md text not null default '',
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists clause_library_firm_key_unique
  on public.clause_library(firm_id, clause_key);
create index if not exists clause_library_key_idx on public.clause_library(clause_key);

create table if not exists public.authoring_jobs (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.document_templates(id) on delete set null,
  template_version_id uuid references public.template_versions(id) on delete set null,
  user_id text not null,
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  chat_message_id uuid references public.chat_messages(id) on delete set null,
  agent_operation_id uuid references public.agent_operations(id) on delete set null,
  variables_json jsonb not null default '{}'::jsonb,
  result_document_id uuid references public.documents(id) on delete set null,
  result_version_id uuid references public.document_versions(id) on delete set null,
  qa_findings_json jsonb not null default '[]'::jsonb,
  qa_status text not null default 'pending'
    check (qa_status = any (array['pending'::text,'passed'::text,'advisory'::text,'blocked'::text])),
  status text not null default 'assembling'
    check (status = any (array['assembling'::text,'qa'::text,'ready'::text,'failed'::text])),
  provenance_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists authoring_jobs_user_idx on public.authoring_jobs(user_id, created_at desc);
create index if not exists authoring_jobs_doc_idx on public.authoring_jobs(result_document_id);

-- Default-shared CRE templates + starter clauses
-- (migrations/020_authoring_seed.sql). Idempotent: fixed UUIDs with
-- on conflict do nothing, current_version_id only set when still null.

-- Commercial lease (complete exemplar) -----------------------------------
insert into public.document_templates (id, firm_id, slug, title, doc_type, practice, jurisdiction, description, source_kind, status)
values ('00000000-0000-4000-a000-000000000101', 'default-shared', 'commercial-lease',
        'Commercial Lease Agreement', 'commercial_lease', 'Real Estate', null,
        'Standard U.S. commercial lease skeleton.', 'cocoa_seed', 'active')
on conflict (firm_id, slug) do nothing;

insert into public.template_versions (id, template_id, version_number, skeleton_json, variable_schema_json, clause_slots_json, generation_notes_md)
values ('00000000-0000-4000-a000-000000000201', '00000000-0000-4000-a000-000000000101', 1,
  $json$[
    {"id":"parties","heading":"Parties","body_md":"This Commercial Lease Agreement (the \"Lease\") is entered into as of {{var.effective_date}} by and between {{var.landlord}} (\"Landlord\") and {{var.tenant}} (\"Tenant\")."},
    {"id":"premises","heading":"Premises","body_md":"Landlord leases to Tenant the premises located at {{var.premises_address}} (the \"Premises\")."},
    {"id":"term","heading":"Term","body_md":"The term of this Lease is {{var.term}}, commencing on {{var.commencement_date}}."},
    {"id":"rent","heading":"Base Rent","body_md":"Tenant shall pay base rent of {{var.base_rent}} per month, payable in advance on the first day of each month."},
    {"id":"use","heading":"Permitted Use","body_md":""},
    {"id":"maintenance","heading":"Maintenance and Repairs","body_md":""},
    {"id":"default","heading":"Default and Remedies","body_md":""},
    {"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{cocoa-sign:0}}\nLANDLORD:\nBy: ____________________\nName: ____________________\nTitle: ____________________\n\n{{cocoa-sign:1}}\nTENANT:\nBy: ____________________\nName: ____________________\nTitle: ____________________"}
  ]$json$::jsonb,
  $json$[
    {"name":"landlord","label":"Landlord","type":"party","required":true,"group":"Parties"},
    {"name":"tenant","label":"Tenant","type":"party","required":true,"group":"Parties"},
    {"name":"effective_date","label":"Effective Date","type":"date","required":true,"group":"Dates"},
    {"name":"commencement_date","label":"Commencement Date","type":"date","required":true,"group":"Dates"},
    {"name":"premises_address","label":"Premises Address","type":"text","required":true,"group":"Premises"},
    {"name":"term","label":"Lease Term","type":"duration","required":true,"group":"Economics"},
    {"name":"base_rent","label":"Base Monthly Rent","type":"money","required":true,"group":"Economics"},
    {"name":"jurisdiction","label":"Governing-Law State","type":"jurisdiction","required":true,"group":"Legal"}
  ]$json$::jsonb,
  '[]'::jsonb,
  'Expand empty-body sections (Permitted Use, Maintenance, Default) using the firm playbook standard positions. Keep numbering automatic.')
on conflict (template_id, version_number) do nothing;

update public.document_templates set current_version_id = '00000000-0000-4000-a000-000000000201'
  where id = '00000000-0000-4000-a000-000000000101' and current_version_id is null;

-- Five minimal templates (psa, loi, estoppel, snda, amendment) ------------
insert into public.document_templates (id, firm_id, slug, title, doc_type, practice, source_kind, status) values
  ('00000000-0000-4000-a000-000000000102','default-shared','purchase-and-sale-agreement','Purchase and Sale Agreement','psa','Real Estate','cocoa_seed','active'),
  ('00000000-0000-4000-a000-000000000103','default-shared','letter-of-intent','Letter of Intent','loi','Real Estate','cocoa_seed','active'),
  ('00000000-0000-4000-a000-000000000104','default-shared','estoppel-certificate','Estoppel Certificate','estoppel','Real Estate','cocoa_seed','active'),
  ('00000000-0000-4000-a000-000000000105','default-shared','snda','Subordination, Non-Disturbance and Attornment Agreement','snda','Real Estate','cocoa_seed','active'),
  ('00000000-0000-4000-a000-000000000106','default-shared','lease-amendment','Lease Amendment','amendment','Real Estate','cocoa_seed','active')
on conflict (firm_id, slug) do nothing;

insert into public.template_versions (id, template_id, version_number, skeleton_json, variable_schema_json, clause_slots_json, generation_notes_md) values
  ('00000000-0000-4000-a000-000000000202','00000000-0000-4000-a000-000000000102',1,
   $json$[{"id":"parties","heading":"Parties","body_md":"This Purchase and Sale Agreement is entered into as of {{var.effective_date}} between {{var.seller}} (\"Seller\") and {{var.buyer}} (\"Buyer\")."},{"id":"property","heading":"Property","body_md":"The property is {{var.property_address}}."},{"id":"price","heading":"Purchase Price","body_md":"The purchase price is {{var.purchase_price}}."},{"id":"terms","heading":"Terms and Conditions","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{cocoa-sign:0}}\nSELLER:\nBy: ____________________\n\n{{cocoa-sign:1}}\nBUYER:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"seller","label":"Seller","type":"party","required":true},{"name":"buyer","label":"Buyer","type":"party","required":true},{"name":"effective_date","label":"Effective Date","type":"date","required":true},{"name":"property_address","label":"Property Address","type":"text","required":true},{"name":"purchase_price","label":"Purchase Price","type":"money","required":true},{"name":"jurisdiction","label":"Governing-Law State","type":"jurisdiction","required":true}]$json$::jsonb,
   '[]'::jsonb,'Expand Terms and Conditions from the PSA standard positions.'),
  ('00000000-0000-4000-a000-000000000203','00000000-0000-4000-a000-000000000103',1,
   $json$[{"id":"parties","heading":"Letter of Intent","body_md":"This non-binding Letter of Intent dated {{var.effective_date}} sets out the principal terms between {{var.party_a}} and {{var.party_b}}."},{"id":"terms","heading":"Principal Terms","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{cocoa-sign:0}}\nBy: ____________________\n\n{{cocoa-sign:1}}\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"party_a","label":"Party A","type":"party","required":true},{"name":"party_b","label":"Party B","type":"party","required":true},{"name":"effective_date","label":"Date","type":"date","required":true},{"name":"jurisdiction","label":"Governing-Law State","type":"jurisdiction","required":false}]$json$::jsonb,
   '[]'::jsonb,'LOI is non-binding except confidentiality/exclusivity; state that explicitly.'),
  ('00000000-0000-4000-a000-000000000204','00000000-0000-4000-a000-000000000104',1,
   $json$[{"id":"intro","heading":"Estoppel Certificate","body_md":"The undersigned tenant {{var.tenant}} certifies to {{var.beneficiary}} as follows regarding the lease for {{var.premises_address}}."},{"id":"certs","heading":"Certifications","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{cocoa-sign:0}}\nTENANT:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"tenant","label":"Tenant","type":"party","required":true},{"name":"beneficiary","label":"Beneficiary","type":"party","required":true},{"name":"premises_address","label":"Premises Address","type":"text","required":true}]$json$::jsonb,
   '[]'::jsonb,'Expand Certifications from the estoppel requirements playbook key.'),
  ('00000000-0000-4000-a000-000000000205','00000000-0000-4000-a000-000000000105',1,
   $json$[{"id":"intro","heading":"SNDA","body_md":"This Subordination, Non-Disturbance and Attornment Agreement dated {{var.effective_date}} is among {{var.lender}}, {{var.landlord}}, and {{var.tenant}}."},{"id":"terms","heading":"Terms","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{cocoa-sign:0}}\nLENDER:\nBy: ____________________\n\n{{cocoa-sign:1}}\nTENANT:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"lender","label":"Lender","type":"party","required":true},{"name":"landlord","label":"Landlord","type":"party","required":true},{"name":"tenant","label":"Tenant","type":"party","required":true},{"name":"effective_date","label":"Date","type":"date","required":true}]$json$::jsonb,
   '[]'::jsonb,'Expand Terms from the SNDA requirements playbook key.'),
  ('00000000-0000-4000-a000-000000000206','00000000-0000-4000-a000-000000000106',1,
   $json$[{"id":"intro","heading":"Lease Amendment","body_md":"This Amendment dated {{var.effective_date}} amends the lease between {{var.landlord}} and {{var.tenant}} dated {{var.original_lease_date}}."},{"id":"changes","heading":"Amendments","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{cocoa-sign:0}}\nLANDLORD:\nBy: ____________________\n\n{{cocoa-sign:1}}\nTENANT:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"landlord","label":"Landlord","type":"party","required":true},{"name":"tenant","label":"Tenant","type":"party","required":true},{"name":"effective_date","label":"Amendment Date","type":"date","required":true},{"name":"original_lease_date","label":"Original Lease Date","type":"date","required":true}]$json$::jsonb,
   '[]'::jsonb,'State that all other lease terms remain in effect.')
on conflict (template_id, version_number) do nothing;

update public.document_templates t set current_version_id = v.id
  from public.template_versions v
  where v.template_id = t.id and v.version_number = 1
    and t.firm_id = 'default-shared' and t.current_version_id is null;

-- ---------------------------------------------------------------------------
-- Personal-injury practice: cases, policies, expenses + automation runs
-- ---------------------------------------------------------------------------
--
-- (migrations/023_pi_cases_automation.sql). pi_cases is the per-user PI case
-- registry (CSV-imported, created manually, or auto-created as 'provisional'
-- when automation sees an unknown case); pi_case_policies holds carrier/claim
-- facts extracted from claim correspondence; pi_case_expenses tracks vendor
-- invoices through approval → payment. automation_runs is one row per
-- processed inbound email — the state machine the automation pipeline drives,
-- with exactly one run per email via the unique email_id index and retry
-- backoff via next_attempt_at. automation_state is a small key/value table
-- for the scheduler lease and cursors.

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

-- ---------------------------------------------------------------------------
-- Recordings & transcription
-- ---------------------------------------------------------------------------
--
-- (migrations/025_recordings.sql). recordings is one row per captured audio
-- (mic or upload) — the state machine the recordings worker drives (queued →
-- transcribing → summarizing → ready, with a failed exit and retry backoff via
-- next_attempt_at). Raw audio lives in R2 keyed by audio_storage_key; the
-- generated transcript PDF, briefing MP3, and timeline PNG are documents rows
-- referenced by *_document_id. recordings_state is a small key/value table for
-- the worker lease, column-identical to automation_state.

create table if not exists public.recordings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  chat_message_id uuid references public.chat_messages(id) on delete set null,
  title text not null default 'Untitled recording',
  source text not null default 'mic' check (source in ('mic','upload')),
  status text not null default 'queued'
    check (status in ('queued','transcribing','summarizing','ready','failed')),
  audio_storage_key text not null,
  audio_mime text not null,
  audio_size_bytes bigint not null default 0,
  duration_seconds numeric,
  consent_ack_at timestamptz not null,
  assemblyai_transcript_id text,
  utterances jsonb not null default '[]'::jsonb,      -- [{speaker,text,start_ms,end_ms}]
  transcript_text text,
  summary_md text,
  action_items jsonb not null default '[]'::jsonb,    -- [{id,text,owner,due,done}]
  transcript_document_id uuid references public.documents(id) on delete set null,
  voice_briefing_document_id uuid references public.documents(id) on delete set null,
  timeline_image_document_id uuid references public.documents(id) on delete set null,
  email_id uuid references public.email_messages(id) on delete set null,
  error text,
  retry_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recordings_user_idx on public.recordings(user_id, created_at desc);
create index if not exists recordings_due_idx on public.recordings(status, next_attempt_at);
create index if not exists recordings_project_idx on public.recordings(project_id);
create index if not exists recordings_chat_idx on public.recordings(chat_id);

create table if not exists public.recordings_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  claimed_by text,
  claimed_until timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Direct client grant hardening
-- ---------------------------------------------------------------------------
--
-- The frontend uses Supabase directly only for authentication. Application
-- data access goes through the backend API with the service role after the
-- backend verifies the user's JWT. Do not grant the browser anon/authenticated
-- roles direct table privileges for backend-owned data.

revoke all on public.user_profiles from anon, authenticated;
revoke all on public.projects from anon, authenticated;
revoke all on public.project_subfolders from anon, authenticated;
revoke all on public.documents from anon, authenticated;
revoke all on public.document_versions from anon, authenticated;
revoke all on public.document_edits from anon, authenticated;
revoke all on public.document_highlight_sets from anon, authenticated;
revoke all on public.document_highlights from anon, authenticated;
revoke all on public.workflows from anon, authenticated;
revoke all on public.hidden_workflows from anon, authenticated;
revoke all on public.workflow_shares from anon, authenticated;
revoke all on public.chats from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;
revoke all on public.chat_attachments from anon, authenticated;
revoke all on public.tabular_reviews from anon, authenticated;
revoke all on public.tabular_cells from anon, authenticated;
revoke all on public.tabular_review_chats from anon, authenticated;
revoke all on public.tabular_review_chat_messages from anon, authenticated;
revoke all on public.user_api_keys from anon, authenticated;
revoke all on public.organizations from anon, authenticated;
revoke all on public.organization_memberships from anon, authenticated;
revoke all on public.matters from anon, authenticated;
revoke all on public.matter_memberships from anon, authenticated;
revoke all on public.agent_operations from anon, authenticated;

-- Firm-playbook tables (see migrations/007_playbook_rls.sql). These are
-- service-role-only like everything above; additionally enable RLS
-- deny-by-default so the deny posture is explicit at the table level. No
-- permissive auth.uid() policies — the service role bypasses RLS and the
-- browser has no direct grants.
alter table public.firm_playbooks enable row level security;
alter table public.playbook_entries enable row level security;
alter table public.playbook_versions enable row level security;

revoke all on public.firm_playbooks from anon, authenticated;
revoke all on public.playbook_entries from anon, authenticated;
revoke all on public.playbook_versions from anon, authenticated;

-- Document-authoring tables (see migrations/019_document_templates.sql).
-- Service-role-only like everything above; RLS deny-by-default with no
-- permissive policies — the service role bypasses RLS and the browser has no
-- direct grants.
alter table public.document_templates enable row level security;
alter table public.template_versions  enable row level security;
alter table public.clause_library      enable row level security;
alter table public.authoring_jobs      enable row level security;

revoke all on public.document_templates from anon, authenticated;
revoke all on public.template_versions  from anon, authenticated;
revoke all on public.clause_library      from anon, authenticated;
revoke all on public.authoring_jobs      from anon, authenticated;

-- Durable, crash-safe document packet drafting (migration 031).
alter table public.chat_messages
  add column if not exists model_id text,
  add column if not exists generation_status text,
  add column if not exists finish_reason text,
  add column if not exists generation_usage_json jsonb not null default '{}'::jsonb,
  add column if not exists generation_updated_at timestamptz;

create table if not exists public.document_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  initiating_message_id uuid references public.chat_messages(id) on delete set null,
  assistant_message_id uuid references public.chat_messages(id) on delete set null,
  model_id text not null,
  compact_brief jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status = any (array['queued','running','completed','partial','failed','cancelled'])),
  total_items integer not null default 0,
  completed_items integer not null default 0,
  failed_items integer not null default 0,
  cancel_requested_at timestamptz,
  claimed_by text,
  heartbeat_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create table if not exists public.document_generation_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.document_generation_jobs(id) on delete cascade,
  position integer not null,
  title text not null,
  document_type text not null,
  drafting_instructions text not null default '',
  jurisdiction text,
  layout_json jsonb not null default '{}'::jsonb,
  source_versions_json jsonb not null default '[]'::jsonb,
  status text not null default 'queued' check (status = any (array['queued','planning','drafting','assembling','qa','ready','failed','cancelled'])),
  progress integer not null default 0,
  outline_json jsonb,
  qa_status text not null default 'pending' check (qa_status = any (array['pending','passed','advisory','blocked'])),
  qa_findings_json jsonb not null default '[]'::jsonb,
  result_document_id uuid references public.documents(id) on delete set null,
  result_version_id uuid references public.document_versions(id) on delete set null,
  retries integer not null default 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, position)
);
create index if not exists document_generation_jobs_claim_idx on public.document_generation_jobs(status, heartbeat_at, created_at);
create index if not exists document_generation_jobs_user_idx on public.document_generation_jobs(user_id, created_at desc);
create index if not exists document_generation_items_job_idx on public.document_generation_items(job_id, position);
alter table public.document_generation_jobs enable row level security;
alter table public.document_generation_items enable row level security;
revoke all on public.document_generation_jobs from anon, authenticated;
revoke all on public.document_generation_items from anon, authenticated;

create or replace function public.claim_document_generation_job(p_worker_id text)
returns setof public.document_generation_jobs language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select id from public.document_generation_jobs
    where status = 'queued' or (status = 'running' and coalesce(heartbeat_at, updated_at) < now() - interval '2 minutes')
    order by created_at for update skip locked limit 1
  )
  update public.document_generation_jobs j
  set status = 'running', claimed_by = p_worker_id, heartbeat_at = now(), updated_at = now()
  from candidate where j.id = candidate.id returning j.*;
end;
$$;
revoke all on function public.claim_document_generation_job(text) from public, anon, authenticated;
grant execute on function public.claim_document_generation_job(text) to service_role;

-- Email + e-signature tables (see migrations/011, 012 and the
-- 022_signature_fields_rls.sql retrofit — signature_fields shipped in 015
-- with neither RLS nor a revoke and was reachable through PostgREST with the
-- anon key). Service-role-only like everything above: RLS deny-by-default
-- with no permissive policies, zero direct browser grants.
alter table public.email_messages enable row level security;
alter table public.signature_envelopes enable row level security;
alter table public.signature_signers enable row level security;
alter table public.signature_events enable row level security;
alter table public.signature_fields enable row level security;

revoke all on public.email_messages from anon, authenticated;
revoke all on public.signature_envelopes from anon, authenticated;
revoke all on public.signature_signers from anon, authenticated;
revoke all on public.signature_events from anon, authenticated;
revoke all on public.signature_fields from anon, authenticated;

-- Personal-injury + automation tables (see
-- migrations/023_pi_cases_automation.sql). Service-role-only like everything
-- above: RLS deny-by-default with no permissive policies, zero direct browser
-- grants.
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

-- Recordings + transcription tables (see migrations/025_recordings.sql).
-- Service-role-only like everything above: RLS deny-by-default with no
-- permissive policies, zero direct browser grants.
alter table public.recordings enable row level security;
alter table public.recordings_state enable row level security;

revoke all on public.recordings from anon, authenticated;
revoke all on public.recordings_state from anon, authenticated;

-- Atomic, immutable document edit commits (migration 033).
-- Existing alpha databases may contain duplicate non-null version numbers.
-- Deterministically repair only those documents before enforcing uniqueness;
-- UUIDs, storage paths, lineage, and current pointers remain unchanged.
with duplicate_documents as (
  select document_id
    from public.document_versions
   where version_number is not null
   group by document_id
  having count(*) <> count(distinct version_number)
), ranked_versions as (
  select v.id,
         row_number() over (
           partition by v.document_id
           order by v.created_at, v.id
         )::integer as repaired_version_number
    from public.document_versions v
    join duplicate_documents d on d.document_id = v.document_id
   where v.version_number is not null
)
update public.document_versions v
   set version_number = ranked.repaired_version_number
  from ranked_versions ranked
 where v.id = ranked.id
   and v.version_number is distinct from ranked.repaired_version_number;

create unique index if not exists document_versions_document_number_unique
  on public.document_versions(document_id, version_number)
  where version_number is not null;

create or replace function public.commit_document_edit(
  p_operation_id uuid,
  p_document_id uuid,
  p_expected_version_id uuid,
  p_result_version_id uuid,
  p_storage_path text,
  p_display_name text,
  p_created_by_user_id text,
  p_chat_message_id uuid,
  p_branch_chat_id uuid,
  p_edits jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version_id uuid;
  v_branch_tip_version_id uuid;
  v_next_version_number integer;
  v_inserted_edits jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text, 0));

  select current_version_id
    into v_current_version_id
    from public.documents
   where id = p_document_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'DOCUMENT_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.document_versions
     where id = p_expected_version_id and document_id = p_document_id
  ) then
    raise exception using errcode = 'P0002', message = 'DOCUMENT_VERSION_UNAVAILABLE';
  end if;

  if p_branch_chat_id is null then
    if v_current_version_id is distinct from p_expected_version_id then
      raise exception using errcode = '40001', message = 'DOCUMENT_VERSION_CONFLICT';
    end if;
  else
    select branch_tip_version_id
      into v_branch_tip_version_id
      from public.chats
     where id = p_branch_chat_id
     for update;
    if not found or v_branch_tip_version_id is distinct from p_expected_version_id then
      raise exception using errcode = '40001', message = 'DOCUMENT_VERSION_CONFLICT';
    end if;
  end if;

  select coalesce(max(version_number), 0) + 1
    into v_next_version_number
    from public.document_versions
   where document_id = p_document_id
     and version_number is not null;

  insert into public.document_versions (
    id, document_id, storage_path, source, version_number, display_name,
    created_by_user_id, parent_version_id, created_by_operation_id
  ) values (
    p_result_version_id, p_document_id, p_storage_path, 'assistant_edit',
    v_next_version_number, p_display_name, p_created_by_user_id,
    p_expected_version_id, p_operation_id
  );

  with inserted as (
    insert into public.document_edits (
      document_id, chat_message_id, version_id, change_id, del_w_id, ins_w_id,
      deleted_text, inserted_text, context_before, context_after, status
    )
    select
      p_document_id,
      p_chat_message_id,
      p_result_version_id,
      edit->>'change_id',
      nullif(edit->>'del_w_id', ''),
      nullif(edit->>'ins_w_id', ''),
      coalesce(edit->>'deleted_text', ''),
      coalesce(edit->>'inserted_text', ''),
      coalesce(edit->>'context_before', ''),
      coalesce(edit->>'context_after', ''),
      'pending'
    from jsonb_array_elements(coalesce(p_edits, '[]'::jsonb)) edit
    returning id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text,
              context_before, context_after
  )
  select coalesce(jsonb_agg(to_jsonb(inserted)), '[]'::jsonb)
    into v_inserted_edits
    from inserted;

  if p_branch_chat_id is null then
    update public.documents
       set current_version_id = p_result_version_id,
           updated_at = now()
     where id = p_document_id;
  else
    update public.chats
       set branch_tip_version_id = p_result_version_id,
           updated_at = now()
     where id = p_branch_chat_id;
  end if;

  update public.agent_operations
     set status = 'succeeded',
         result_document_id = p_document_id,
         result_version_id = p_result_version_id,
         affected_ranges = coalesce(p_edits, '[]'::jsonb),
         errors = '[]'::jsonb,
         completed_at = now(),
         updated_at = now()
   where id = p_operation_id
     and status = 'running';

  if not found then
    raise exception using errcode = 'P0002', message = 'AGENT_OPERATION_UNAVAILABLE';
  end if;

  return jsonb_build_object(
    'version_id', p_result_version_id,
    'version_number', v_next_version_number,
    'storage_path', p_storage_path,
    'edits', v_inserted_edits
  );
end;
$$;

revoke all on function public.commit_document_edit(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_document_edit(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) to service_role;

-- Provider-neutral model certification and privacy-safe runtime health.
create table if not exists public.model_runtime_health (
  model_id text primary key,
  provider text not null,
  verification_status text not null default 'unverified'
    check (verification_status in ('verified', 'unverified')),
  health_status text not null default 'unverified'
    check (health_status in ('healthy', 'degraded', 'unverified', 'unhealthy')),
  capability_results jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  last_used_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  success_count bigint not null default 0 check (success_count >= 0),
  failure_count bigint not null default 0 check (failure_count >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists model_runtime_health_status_idx
  on public.model_runtime_health(verification_status, health_status, updated_at);

alter table public.model_runtime_health enable row level security;
revoke all on table public.model_runtime_health from public, anon, authenticated;
grant all on table public.model_runtime_health to service_role;

insert into public.model_runtime_health (
  model_id, provider, verification_status, health_status,
  capability_results, last_checked_at
) values
  ('claude-sonnet-5', 'claude', 'verified', 'healthy',
   '{"certification_version":1,"streaming":true,"tools_then_final_prose":true,"citations":true,"structured_output":true,"declared_modalities":true}'::jsonb, now()),
  ('gemini-3-flash-preview', 'gemini', 'verified', 'healthy',
   '{"certification_version":1,"streaming":true,"tools_then_final_prose":true,"citations":true,"structured_output":true,"declared_modalities":true}'::jsonb, now()),
  ('gpt-5.4-mini', 'openai', 'verified', 'healthy',
   '{"certification_version":1,"streaming":true,"tools_then_final_prose":true,"citations":true,"structured_output":true,"declared_modalities":true}'::jsonb, now())
on conflict (model_id) do nothing;

create or replace function public.record_model_runtime_outcome(
  p_model_id text,
  p_provider text,
  p_success boolean,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.model_runtime_health (
    model_id, provider, verification_status, health_status, last_used_at,
    last_success_at, last_failure_at, consecutive_failures, success_count,
    failure_count, last_error_code, updated_at
  ) values (
    p_model_id, p_provider, 'unverified', 'unverified', now(),
    case when p_success then now() else null end,
    case when not p_success then now() else null end,
    case when p_success then 0 else 1 end,
    case when p_success then 1 else 0 end,
    case when p_success then 0 else 1 end,
    case when p_success then null else left(coalesce(p_error_code, 'unknown'), 80) end,
    now()
  )
  on conflict (model_id) do update set
    provider = excluded.provider,
    last_used_at = now(),
    last_success_at = case when p_success then now() else model_runtime_health.last_success_at end,
    last_failure_at = case when p_success then model_runtime_health.last_failure_at else now() end,
    consecutive_failures = case when p_success then 0 else model_runtime_health.consecutive_failures + 1 end,
    success_count = model_runtime_health.success_count + case when p_success then 1 else 0 end,
    failure_count = model_runtime_health.failure_count + case when p_success then 0 else 1 end,
    last_error_code = case when p_success then null else left(coalesce(p_error_code, 'unknown'), 80) end,
    health_status = case
      when model_runtime_health.verification_status <> 'verified' then 'unverified'
      when p_success then 'healthy'
      when model_runtime_health.consecutive_failures + 1 >= 3 then 'unhealthy'
      else 'degraded'
    end,
    updated_at = now();
end;
$$;

revoke all on function public.record_model_runtime_outcome(text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_model_runtime_outcome(text, text, boolean, text)
  to service_role;
-- Durable intake manifest. Provider part IDs, not filenames, identify files.
alter table public.email_messages add column if not exists attachments_reconciled_at timestamptz;
create table if not exists public.inbound_email_attachments (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references public.email_messages(id) on delete cascade,
  provider_part_id text not null,
  provider_attachment_id text,
  ordinal integer not null,
  filename text not null,
  content_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  inline boolean not null default false,
  content_id text,
  -- Retain IDs after purge so reconciliation cannot resurrect deleted files.
  document_id uuid,
  version_id uuid,
  raw_storage_path text,
  sha256 text,
  status text not null default 'pending' check (status in ('pending','processing','ready','partial','failed','unsupported','blocked','deleted')),
  read_status text,
  read_error text,
  error_code text,
  retryable boolean not null default true,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(email_id, provider_part_id)
);
create unique index if not exists inbound_email_attachments_ordinal_idx on public.inbound_email_attachments(email_id, ordinal);
create index if not exists inbound_email_attachments_due_idx on public.inbound_email_attachments(next_attempt_at) where retryable;
create index if not exists inbound_email_attachments_document_idx on public.inbound_email_attachments(document_id);
create table if not exists public.document_extractions (
  version_id uuid not null references public.document_versions(id) on delete cascade,
  content_hash text not null,
  extractor_version text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(version_id, content_hash, extractor_version)
);
-- Extracted text lives in the database and is removed by version retention.
create or replace function public.tombstone_email_attachment() returns trigger
language plpgsql set search_path = public as $$
begin
  update public.inbound_email_attachments set status = 'deleted', retryable = false,
    raw_storage_path = null, error_code = 'ATTACHMENT_DELETED', updated_at = now()
    where document_id = old.id;
  return old;
end;
$$;
drop trigger if exists tombstone_email_attachment on public.documents;
create trigger tombstone_email_attachment before delete on public.documents
for each row execute function public.tombstone_email_attachment();
-- A worker that was in flight during deletion cannot recreate a reserved ID.
create or replace function public.reject_deleted_attachment_document() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.inbound_email_attachments where document_id = new.id and status = 'deleted') then
    raise exception 'ATTACHMENT_DELETED' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists reject_deleted_attachment_document on public.documents;
create trigger reject_deleted_attachment_document before insert on public.documents
for each row execute function public.reject_deleted_attachment_document();
alter table public.inbound_email_attachments enable row level security;
alter table public.document_extractions enable row level security;
revoke all on public.inbound_email_attachments, public.document_extractions from public, anon, authenticated;
grant all on public.inbound_email_attachments, public.document_extractions to service_role;

-- Serialize the compatibility projection per parent email, including competing files.
create or replace function public.refresh_inbound_attachment_refs(p_email_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform id from public.email_messages where id = p_email_id and direction = 'inbound' for update;
  update public.email_messages set attachments = coalesce((
    select jsonb_agg(jsonb_build_object('document_id', document_id, 'version_id', version_id,
      'filename', filename, 'content_type', content_type, 'size', size_bytes, 'inline', inline,
      'content_id', content_id) order by ordinal)
    from public.inbound_email_attachments
    where email_id = p_email_id and version_id is not null and status in ('ready', 'partial')
  ), '[]'::jsonb) where id = p_email_id and direction = 'inbound';
end;
$$;
revoke all on function public.refresh_inbound_attachment_refs(uuid) from public, anon, authenticated;
grant execute on function public.refresh_inbound_attachment_refs(uuid) to service_role;
