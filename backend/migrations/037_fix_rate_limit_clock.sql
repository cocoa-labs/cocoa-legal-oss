-- Fix the distributed limiter clock variable. `current_time` is a PostgreSQL
-- special value of type timetz, so using it as a PL/pgSQL variable name made
-- the original function try to store timetz in timestamptz columns.

create or replace function public.consume_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_requests integer
)
returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  current_row public.rate_limit_buckets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if nullif(trim(p_bucket_key), '') is null
     or p_window_seconds <= 0
     or p_max_requests <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_RATE_LIMIT_ARGUMENTS';
  end if;

  insert into public.rate_limit_buckets(
    bucket_key, window_started_at, request_count, expires_at, updated_at
  ) values (
    p_bucket_key, v_now, 1,
    v_now + make_interval(secs => p_window_seconds), v_now
  )
  on conflict (bucket_key) do update
  set window_started_at = case
        when public.rate_limit_buckets.expires_at <= v_now then v_now
        else public.rate_limit_buckets.window_started_at end,
      request_count = case
        when public.rate_limit_buckets.expires_at <= v_now then 1
        else public.rate_limit_buckets.request_count + 1 end,
      expires_at = case
        when public.rate_limit_buckets.expires_at <= v_now
          then v_now + make_interval(secs => p_window_seconds)
        else public.rate_limit_buckets.expires_at end,
      updated_at = v_now
  returning * into current_row;

  return query select
    current_row.request_count <= p_max_requests,
    greatest(p_max_requests - current_row.request_count, 0),
    current_row.expires_at;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer)
  to service_role;
