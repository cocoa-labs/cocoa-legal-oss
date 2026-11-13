-- Durable, database-authoritative conversation context.
--
-- The message bodies already contain the canonical user text and assistant
-- event arrays.  These indexes make chronological episode reconstruction
-- efficient, while the summary columns hold only context older than the exact
-- replay window.  The source-message watermark keeps every summary auditable.

create index if not exists chat_messages_chat_chronological_idx
  on public.chat_messages(chat_id, created_at, id);

create index if not exists tabular_review_chat_messages_chat_chronological_idx
  on public.tabular_review_chat_messages(chat_id, created_at, id);

alter table public.tabular_review_chat_messages
  add column if not exists model_id text,
  add column if not exists generation_status text,
  add column if not exists finish_reason text,
  add column if not exists generation_usage_json jsonb not null default '{}'::jsonb,
  add column if not exists generation_updated_at timestamptz;

alter table public.chats
  add column if not exists conversation_summary jsonb,
  add column if not exists conversation_summary_through_message_id uuid
    references public.chat_messages(id) on delete set null,
  add column if not exists conversation_summary_version integer not null default 1,
  add column if not exists conversation_summary_status text not null default 'clean',
  add column if not exists conversation_summary_updated_at timestamptz;

alter table public.tabular_review_chats
  add column if not exists conversation_summary jsonb,
  add column if not exists conversation_summary_through_message_id uuid
    references public.tabular_review_chat_messages(id) on delete set null,
  add column if not exists conversation_summary_version integer not null default 1,
  add column if not exists conversation_summary_status text not null default 'clean',
  add column if not exists conversation_summary_updated_at timestamptz;

create index if not exists chats_conversation_summary_status_idx
  on public.chats(conversation_summary_status)
  where conversation_summary_status <> 'clean';

create index if not exists tabular_review_chats_conversation_summary_status_idx
  on public.tabular_review_chats(conversation_summary_status)
  where conversation_summary_status <> 'clean';

create or replace function public.claim_chat_conversation_summary()
returns setof public.chats
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select id
    from public.chats
    where conversation_summary_status = 'queued'
       or (
         conversation_summary_status = 'running'
         and conversation_summary_updated_at < now() - interval '10 minutes'
       )
    order by conversation_summary_updated_at nulls first, created_at
    for update skip locked
    limit 1
  )
  update public.chats c
  set conversation_summary_status = 'running',
      conversation_summary_updated_at = now()
  from candidate
  where c.id = candidate.id
  returning c.*;
end;
$$;

create or replace function public.claim_tabular_conversation_summary()
returns setof public.tabular_review_chats
language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidate as (
    select id
    from public.tabular_review_chats
    where conversation_summary_status = 'queued'
       or (
         conversation_summary_status = 'running'
         and conversation_summary_updated_at < now() - interval '10 minutes'
       )
    order by conversation_summary_updated_at nulls first, created_at
    for update skip locked
    limit 1
  )
  update public.tabular_review_chats c
  set conversation_summary_status = 'running',
      conversation_summary_updated_at = now()
  from candidate
  where c.id = candidate.id
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
