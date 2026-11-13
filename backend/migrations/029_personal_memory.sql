-- Per-user durable memory: facts / preferences / working-style that Quill
-- carries ACROSS conversations (today it remembers nothing between threads
-- beyond the user's email). Read and merged into the system prompt per turn by
-- backend/src/lib/memory.ts (personal tier; the shared firm tier arrives in
-- 030_firm_memory.sql).
--
-- Like every other table here, this is service-role-only: the backend reaches
-- it through SUPABASE_SECRET_KEY (which bypasses RLS); the browser holds zero
-- direct grants. We enable RLS deny-by-default and revoke from anon/
-- authenticated, mirroring 007_playbook_rls.sql. Idempotent; apply via the
-- Supabase SQL editor.

create table if not exists public.personal_memory_entries (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  kind text not null
    check (kind = any (array[
      'preference'::text,
      'fact'::text,
      'working_style'::text,
      'note'::text
    ])),
  -- Stable slug for updatable structured entries (e.g. 'style.citation');
  -- NULL for free-text notes so they never collide (see partial index below).
  key text,
  content text not null,
  value_json jsonb not null default '{}'::jsonb,
  source_chat_id uuid,
  source_message_id uuid,
  is_active boolean not null default true,
  priority int not null default 0,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keyed entries upsert in place; null-key notes never conflict.
create unique index if not exists personal_memory_key_unique
  on public.personal_memory_entries(user_id, key) where key is not null;

-- The batched active-memory read (backend/src/lib/memory.ts listPersonalMemory).
create index if not exists personal_memory_active_idx
  on public.personal_memory_entries(user_id, is_active, updated_at desc);

alter table public.personal_memory_entries enable row level security;
revoke all on public.personal_memory_entries from anon, authenticated;
