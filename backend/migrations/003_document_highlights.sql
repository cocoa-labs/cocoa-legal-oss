-- Durable assistant highlight review sets.
-- Highlight proposals must survive reloads, backend restarts, and multi-worker
-- deployments so users can later apply kept anchors to native DOCX versions.

alter table public.document_versions
  add column if not exists created_by_user_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.document_highlight_sets (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete set null,
  user_id text not null,
  chat_message_id uuid,
  title text not null default 'Document highlights',
  query text,
  status text not null default 'reviewing'
    check (status = any (array[
      'reviewing'::text,
      'applied'::text
    ])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_highlight_sets_document_id_idx
  on public.document_highlight_sets(document_id, created_at desc);

create index if not exists document_highlight_sets_user_idx
  on public.document_highlight_sets(user_id, created_at desc);

create table if not exists public.document_highlights (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.document_highlight_sets(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid references public.document_versions(id) on delete set null,
  quote text not null,
  context text not null default '',
  label text not null default 'Highlight',
  color text not null default 'yellow',
  occurrence_index integer not null default 0,
  page integer,
  status text not null default 'kept'
    check (status = any (array[
      'kept'::text,
      'removed'::text,
      'applied'::text
    ])),
  created_at timestamptz not null default now()
);

create index if not exists document_highlights_set_id_idx
  on public.document_highlights(set_id, created_at);

create index if not exists document_highlights_document_id_idx
  on public.document_highlights(document_id, created_at desc);

revoke all on public.document_highlight_sets from anon, authenticated;
revoke all on public.document_highlights from anon, authenticated;
