-- Operational controls required for the controlled beta.

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  actor_user_id text,
  actor_role text,
  event_type text not null,
  target_type text,
  target_id text,
  outcome text not null default 'succeeded'
    check (outcome = any (array['succeeded'::text, 'denied'::text, 'failed'::text])),
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_org_idx
  on public.audit_events(org_id, created_at desc);
create index if not exists audit_events_project_idx
  on public.audit_events(project_id, created_at desc);
create index if not exists audit_events_actor_idx
  on public.audit_events(actor_user_id, created_at desc);

create or replace function public.prevent_audit_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'AUDIT_EVENTS_ARE_IMMUTABLE';
end;
$$;
drop trigger if exists audit_events_immutable on public.audit_events;
create trigger audit_events_immutable
  before update or delete on public.audit_events
  for each row execute procedure public.prevent_audit_event_mutation();

create table if not exists public.rate_limit_buckets (
  bucket_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists rate_limit_buckets_expiry_idx
  on public.rate_limit_buckets(expires_at);

create or replace function public.consume_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_requests integer
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  current_row public.rate_limit_buckets%rowtype;
  current_time timestamptz := clock_timestamp();
begin
  insert into public.rate_limit_buckets(
    bucket_key, window_started_at, request_count, expires_at, updated_at
  ) values (
    p_bucket_key, current_time, 1,
    current_time + make_interval(secs => p_window_seconds), current_time
  )
  on conflict (bucket_key) do update
  set window_started_at = case
        when public.rate_limit_buckets.expires_at <= current_time then current_time
        else public.rate_limit_buckets.window_started_at end,
      request_count = case
        when public.rate_limit_buckets.expires_at <= current_time then 1
        else public.rate_limit_buckets.request_count + 1 end,
      expires_at = case
        when public.rate_limit_buckets.expires_at <= current_time
          then current_time + make_interval(secs => p_window_seconds)
        else public.rate_limit_buckets.expires_at end,
      updated_at = current_time
  returning * into current_row;

  return query select
    current_row.request_count <= p_max_requests,
    greatest(p_max_requests - current_row.request_count, 0),
    current_row.expires_at;
end;
$$;

create table if not exists public.worker_leases (
  lease_key text primary key,
  owner_id text not null,
  leased_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create or replace function public.claim_worker_lease(
  p_lease_key text,
  p_owner_id text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  claimed_owner text;
begin
  insert into public.worker_leases(lease_key, owner_id, leased_until, updated_at)
  values (
    p_lease_key,
    p_owner_id,
    clock_timestamp() + make_interval(secs => greatest(p_ttl_seconds, 1)),
    clock_timestamp()
  )
  on conflict (lease_key) do update
  set owner_id = excluded.owner_id,
      leased_until = excluded.leased_until,
      updated_at = excluded.updated_at
  where public.worker_leases.leased_until <= clock_timestamp()
     or public.worker_leases.owner_id = excluded.owner_id
  returning owner_id into claimed_owner;
  return claimed_owner = p_owner_id;
end;
$$;

create table if not exists public.purge_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  target_type text not null,
  target_id_hash text not null,
  database_rows_purged integer not null default 0,
  objects_purged integer not null default 0,
  manifest_sha256 text,
  purged_at timestamptz not null default now()
);
drop trigger if exists purge_receipts_immutable on public.purge_receipts;
create trigger purge_receipts_immutable
  before update or delete on public.purge_receipts
  for each row execute procedure public.prevent_audit_event_mutation();

create table if not exists public.organization_beta_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  data_policy_accepted_at timestamptz,
  data_policy_accepted_by_user_id text,
  allowed_recipient_emails jsonb not null default '[]'::jsonb,
  allowed_recipient_domains jsonb not null default '[]'::jsonb,
  signatures_nonbinding boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.upload_intakes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete set null,
  quarantine_object_key text not null unique,
  byte_size bigint not null check (byte_size >= 0),
  status text not null default 'scanning'
    check (status = any (array['scanning'::text, 'clean'::text, 'rejected'::text])),
  result_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists upload_intakes_status_idx
  on public.upload_intakes(status, created_at);

insert into public.organization_beta_policies(organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

create table if not exists public.app_schema_migrations (
  version integer primary key,
  filename text not null unique,
  checksum text,
  applied_at timestamptz not null default now()
);

alter table public.document_versions
  drop constraint if exists document_versions_content_status_check;
alter table public.document_versions
  add constraint document_versions_content_status_check check (
    content_status = any (array[
      'queued'::text, 'scanning'::text, 'extracting'::text,
      'rendering'::text, 'ready'::text, 'rejected'::text, 'error'::text
    ])
  );

revoke all on public.audit_events from public, anon, authenticated;
revoke all on public.rate_limit_buckets from public, anon, authenticated;
revoke all on public.worker_leases from public, anon, authenticated;
revoke all on public.purge_receipts from public, anon, authenticated;
revoke all on public.organization_beta_policies from public, anon, authenticated;
revoke all on public.upload_intakes from public, anon, authenticated;
revoke all on public.app_schema_migrations from public, anon, authenticated;
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
revoke all on function public.claim_worker_lease(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_worker_lease(text, text, integer) to service_role;
