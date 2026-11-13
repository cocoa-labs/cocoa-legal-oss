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
