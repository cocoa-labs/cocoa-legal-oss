-- Native, self-owned e-signature (no third-party signing vendor).
--
-- An envelope wraps one document plus N parallel signers. Each signer is
-- accessed through a single-use, expiring magic-link token — only the SHA-256
-- of the token is stored, never the token itself. On completion the pipeline
-- stamps the captured signatures into the PDF, embeds a cryptographic PDF
-- signature, hashes the original and executed files, and emits a Certificate
-- of Completion assembled from signature_events.
--
-- Sending a signature request is approval-gated (envelope starts
-- 'pending_approval'). Backend-only access via the Supabase service role (RLS
-- deny-by-default, mirroring 007_playbook_rls.sql); the public signer page
-- authenticates by token, not by Supabase session. Idempotent; apply via the
-- Supabase dashboard SQL editor (per CLAUDE.md).

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

alter table public.signature_envelopes enable row level security;
alter table public.signature_signers enable row level security;
alter table public.signature_events enable row level security;

revoke all on public.signature_envelopes from anon, authenticated;
revoke all on public.signature_signers from anon, authenticated;
revoke all on public.signature_events from anon, authenticated;
