-- 031_document_generation_jobs.sql — crash-safe multi-document drafting.
-- Additive and idempotent. All access is through authenticated backend routes.

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
  status text not null default 'queued'
    check (status = any (array['queued','running','completed','partial','failed','cancelled'])),
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
  status text not null default 'queued'
    check (status = any (array['queued','planning','drafting','assembling','qa','ready','failed','cancelled'])),
  progress integer not null default 0,
  outline_json jsonb,
  qa_status text not null default 'pending'
    check (qa_status = any (array['pending','passed','advisory','blocked'])),
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

create index if not exists document_generation_jobs_claim_idx
  on public.document_generation_jobs(status, heartbeat_at, created_at);
create index if not exists document_generation_jobs_user_idx
  on public.document_generation_jobs(user_id, created_at desc);
create index if not exists document_generation_items_job_idx
  on public.document_generation_items(job_id, position);

alter table public.document_generation_jobs enable row level security;
alter table public.document_generation_items enable row level security;
revoke all on public.document_generation_jobs from anon, authenticated;
revoke all on public.document_generation_items from anon, authenticated;

create or replace function public.claim_document_generation_job(p_worker_id text)
returns setof public.document_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select id
    from public.document_generation_jobs
    where status = 'queued'
       or (status = 'running' and coalesce(heartbeat_at, updated_at) < now() - interval '2 minutes')
    order by created_at
    for update skip locked
    limit 1
  )
  update public.document_generation_jobs j
  set status = 'running', claimed_by = p_worker_id,
      heartbeat_at = now(), updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

revoke all on function public.claim_document_generation_job(text) from public, anon, authenticated;
grant execute on function public.claim_document_generation_job(text) to service_role;
