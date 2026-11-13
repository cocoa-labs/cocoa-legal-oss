-- Firm-customizable legal playbooks. Each capability reads keyed entries
-- (e.g. nda.standard_positions, risk.escalation_thresholds) from the
-- firm's playbook at runtime. v1 resolves firm_id to the user's
-- auth.users id; a future migration will introduce a true firms table
-- and join key.

create table if not exists public.firm_playbooks (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  version int not null default 1,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists firm_playbooks_firm_id_unique
  on public.firm_playbooks(firm_id);

create table if not exists public.playbook_entries (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.firm_playbooks(id) on delete cascade,
  key text not null,
  value_json jsonb not null default '{}'::jsonb,
  notes_md text not null default '',
  is_default boolean not null default false,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists playbook_entries_key_unique
  on public.playbook_entries(playbook_id, key);

create index if not exists playbook_entries_key_idx
  on public.playbook_entries(key);

create table if not exists public.playbook_versions (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.firm_playbooks(id) on delete cascade,
  version int not null,
  snapshot_json jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists playbook_versions_playbook_idx
  on public.playbook_versions(playbook_id, version desc);
