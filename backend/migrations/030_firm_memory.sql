-- Shared firm memory + suggest-then-approve queue. Quill proposes firm-wide
-- learnings (propose_firm_memory); a firm admin approves them; approved entries
-- are read into the system prompt for EVERY colleague (backend/src/lib/
-- memory.ts, firm tier). Pending candidates are NEVER injected. Every approval
-- snapshots the active set into firm_memory_versions for auditability.
--
-- Service-role only, like every other table here: RLS deny-by-default + revoke
-- from anon/authenticated (mirrors 007_playbook_rls.sql). Idempotent; apply via
-- the Supabase SQL editor.

-- Approved shared knowledge, keyed by the firm slug (resolveFirmId).
create table if not exists public.firm_memory_entries (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  kind text not null
    check (kind = any (array[
      'preference'::text, 'fact'::text, 'working_style'::text, 'note'::text
    ])),
  key text,
  content text not null,
  value_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  approved_from_candidate_id uuid,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists firm_memory_key_unique
  on public.firm_memory_entries(firm_id, key) where key is not null;
create index if not exists firm_memory_active_idx
  on public.firm_memory_entries(firm_id, is_active, updated_at desc);

-- Point-in-time snapshot of the active firm-memory set, one per approve/retire.
create table if not exists public.firm_memory_versions (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  version int not null,
  snapshot_json jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

-- Unique (firm_id, version) detects a concurrent version allocation so approve
-- retries instead of double-writing a version.
create unique index if not exists firm_memory_versions_unique
  on public.firm_memory_versions(firm_id, version);
create index if not exists firm_memory_versions_idx
  on public.firm_memory_versions(firm_id, version desc);

-- The suggest-then-approve queue.
create table if not exists public.firm_memory_candidates (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  status text not null default 'pending'
    check (status = any (array[
      'pending'::text, 'approved'::text, 'rejected'::text, 'superseded'::text
    ])),
  kind text not null
    check (kind = any (array[
      'preference'::text, 'fact'::text, 'working_style'::text, 'note'::text
    ])),
  proposed_key text,
  proposed_content text not null,
  proposed_value_json jsonb not null default '{}'::jsonb,
  rationale text not null default '',
  origin text not null default 'tool'
    check (origin = any (array['tool'::text, 'distiller'::text])),
  proposed_by_user_id text not null,
  source_chat_id uuid,
  source_message_id uuid,
  -- The private-fact tripwire surfaced to the reviewer (which matter a proposal
  -- came from), plus the heuristic flags computed at propose time.
  source_matter_id uuid,
  private_fact_flags jsonb not null default '[]'::jsonb,
  dedup_hash text not null,
  reviewed_by_user_id text,
  reviewed_at timestamptz,
  review_note text,
  resulting_firm_memory_id uuid,
  resulting_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A second identical STILL-PENDING proposal is a no-op.
create unique index if not exists firm_memory_candidates_dedup
  on public.firm_memory_candidates(firm_id, dedup_hash) where status = 'pending';
create index if not exists firm_memory_candidates_queue_idx
  on public.firm_memory_candidates(firm_id, status, created_at desc);

alter table public.firm_memory_entries enable row level security;
alter table public.firm_memory_versions enable row level security;
alter table public.firm_memory_candidates enable row level security;

revoke all on public.firm_memory_entries from anon, authenticated;
revoke all on public.firm_memory_versions from anon, authenticated;
revoke all on public.firm_memory_candidates from anon, authenticated;
