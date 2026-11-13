-- Provider-neutral model certification and privacy-safe runtime health.
-- No prompts, outputs, filenames, user ids, or conversation ids are stored.

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

-- These three native models are the deliberately small automatic-rescue set.
-- Their adapters already have streaming/tool fixture coverage; all other
-- configured and OpenRouter models begin selectable but visibly Unverified.
insert into public.model_runtime_health (
  model_id,
  provider,
  verification_status,
  health_status,
  capability_results,
  last_checked_at
) values
  (
    'claude-sonnet-5',
    'claude',
    'verified',
    'healthy',
    '{"certification_version":1,"streaming":true,"tools_then_final_prose":true,"citations":true,"structured_output":true,"declared_modalities":true}'::jsonb,
    now()
  ),
  (
    'gemini-3-flash-preview',
    'gemini',
    'verified',
    'healthy',
    '{"certification_version":1,"streaming":true,"tools_then_final_prose":true,"citations":true,"structured_output":true,"declared_modalities":true}'::jsonb,
    now()
  ),
  (
    'gpt-5.4-mini',
    'openai',
    'verified',
    'healthy',
    '{"certification_version":1,"streaming":true,"tools_then_final_prose":true,"citations":true,"structured_output":true,"declared_modalities":true}'::jsonb,
    now()
  )
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
    model_id,
    provider,
    verification_status,
    health_status,
    last_used_at,
    last_success_at,
    last_failure_at,
    consecutive_failures,
    success_count,
    failure_count,
    last_error_code,
    updated_at
  ) values (
    p_model_id,
    p_provider,
    'unverified',
    'unverified',
    now(),
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
    last_success_at = case
      when p_success then now()
      else model_runtime_health.last_success_at
    end,
    last_failure_at = case
      when p_success then model_runtime_health.last_failure_at
      else now()
    end,
    consecutive_failures = case
      when p_success then 0
      else model_runtime_health.consecutive_failures + 1
    end,
    success_count = model_runtime_health.success_count + case when p_success then 1 else 0 end,
    failure_count = model_runtime_health.failure_count + case when p_success then 0 else 1 end,
    last_error_code = case
      when p_success then null
      else left(coalesce(p_error_code, 'unknown'), 80)
    end,
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
