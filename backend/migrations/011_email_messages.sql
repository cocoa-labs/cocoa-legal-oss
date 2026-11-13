-- Outbound + inbound email for the agent's dedicated Workspace mailbox.
--
-- Outbound is approval-gated: the send_email tool inserts rows as
-- 'pending_approval' and they are only dispatched after explicit user
-- approval. Inbound rows are ingested from the agent inbox (Gmail
-- history/watch), deduped by provider_message_id, and threaded to the
-- originating outbound message or signature envelope.
--
-- The backend reaches this table only through the Supabase service role; the
-- browser holds zero direct grants (RLS deny-by-default, mirroring
-- 007_playbook_rls.sql). Every statement is idempotent and safe to re-run.
-- Apply via the Supabase dashboard SQL editor (per CLAUDE.md).

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

alter table public.email_messages enable row level security;
revoke all on public.email_messages from anon, authenticated;
