-- Chat message attachments for visual context uploads.

create table if not exists public.chat_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null default 'image'
    check (kind = any (array['image'::text])),
  filename text not null,
  mime_type text not null,
  size_bytes integer not null default 0,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_attachments_user_idx
  on public.chat_attachments(user_id, created_at desc);

create index if not exists chat_attachments_project_idx
  on public.chat_attachments(project_id, created_at desc);

revoke all on public.chat_attachments from anon, authenticated;
