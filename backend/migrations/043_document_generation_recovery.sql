-- 043_document_generation_recovery.sql — retain drafts and retry failed packets.
-- Additive/idempotent. The backend performs user/project authorization before
-- invoking the service-role-only retry RPC.

alter table public.document_generation_items
  add column if not exists draft_sections_json jsonb,
  add column if not exists layout_attempts_json jsonb not null default '[]'::jsonb,
  add column if not exists failure_stage text,
  add column if not exists failure_code text,
  add column if not exists retryable boolean not null default false,
  add column if not exists run_attempts integer not null default 0;

create or replace function public.retry_document_generation_job(p_job_id uuid)
returns setof public.document_generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_failed_count integer;
  v_completed_count integer;
begin
  -- Lock the packet so counters and item state change as one transaction.
  perform 1
  from public.document_generation_jobs
  where id = p_job_id
    and status = any (array['failed', 'partial'])
  for update;

  if not found then
    return;
  end if;

  select count(*)::integer into v_failed_count
  from public.document_generation_items
  where job_id = p_job_id and status = 'failed';

  if v_failed_count = 0 then
    return;
  end if;

  update public.document_generation_items
  set status = 'queued',
      progress = 0,
      qa_status = 'pending',
      qa_findings_json = '[]'::jsonb,
      result_document_id = null,
      result_version_id = null,
      error = null,
      failure_stage = null,
      failure_code = null,
      retryable = false,
      started_at = null,
      completed_at = null,
      updated_at = now()
  where job_id = p_job_id and status = 'failed';

  select count(*)::integer into v_completed_count
  from public.document_generation_items
  where job_id = p_job_id and status = 'ready';

  return query
  update public.document_generation_jobs
  set status = 'queued',
      completed_items = v_completed_count,
      failed_items = 0,
      cancel_requested_at = null,
      claimed_by = null,
      heartbeat_at = null,
      error = null,
      completed_at = null,
      updated_at = now()
  where id = p_job_id
  returning *;
end;
$$;

revoke all on function public.retry_document_generation_job(uuid)
  from public, anon, authenticated;
grant execute on function public.retry_document_generation_job(uuid)
  to service_role;
