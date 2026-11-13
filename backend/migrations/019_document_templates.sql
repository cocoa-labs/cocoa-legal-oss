-- 019_document_templates.sql — document authoring: templates, clause library,
-- authoring jobs. Idempotent. Service-role only (revoke + RLS no-policy), same
-- posture as playbook tables.

create table if not exists public.document_templates (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  slug text not null,
  title text not null,
  doc_type text not null,
  practice text not null default 'Real Estate',
  jurisdiction text,
  description text,
  source_kind text not null default 'ai_generated'
    check (source_kind = any (array['ai_generated'::text,'coco_seed'::text,'firm_parameterized'::text])),
  source_document_id uuid references public.documents(id) on delete set null,
  current_version_id uuid,
  status text not null default 'active'
    check (status = any (array['draft'::text,'active'::text,'archived'::text])),
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists document_templates_firm_slug_unique
  on public.document_templates(firm_id, slug);
create index if not exists document_templates_doc_type_idx
  on public.document_templates(firm_id, doc_type, status);

create table if not exists public.template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete cascade,
  version_number integer not null default 1,
  skeleton_json jsonb not null default '[]'::jsonb,
  variable_schema_json jsonb not null default '[]'::jsonb,
  clause_slots_json jsonb not null default '[]'::jsonb,
  generation_notes_md text not null default '',
  created_by_operation_id uuid references public.agent_operations(id) on delete set null,
  created_by_user_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists template_versions_tmpl_vnum_unique
  on public.template_versions(template_id, version_number);
create index if not exists template_versions_tmpl_idx
  on public.template_versions(template_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint
    where conname = 'document_templates_current_version_id_fkey'
      and conrelid = 'public.document_templates'::regclass) then
    alter table public.document_templates
      add constraint document_templates_current_version_id_fkey
      foreign key (current_version_id) references public.template_versions(id) on delete set null;
  end if;
end $$;

create table if not exists public.clause_library (
  id uuid primary key default gen_random_uuid(),
  firm_id text not null,
  clause_key text not null,
  title text not null,
  doc_types text[] not null default '{}',
  body_md text not null,
  variables_used text[] not null default '{}',
  jurisdiction text,
  is_default boolean not null default false,
  notes_md text not null default '',
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists clause_library_firm_key_unique
  on public.clause_library(firm_id, clause_key);
create index if not exists clause_library_key_idx on public.clause_library(clause_key);

create table if not exists public.authoring_jobs (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references public.document_templates(id) on delete set null,
  template_version_id uuid references public.template_versions(id) on delete set null,
  user_id text not null,
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  chat_message_id uuid references public.chat_messages(id) on delete set null,
  agent_operation_id uuid references public.agent_operations(id) on delete set null,
  variables_json jsonb not null default '{}'::jsonb,
  result_document_id uuid references public.documents(id) on delete set null,
  result_version_id uuid references public.document_versions(id) on delete set null,
  qa_findings_json jsonb not null default '[]'::jsonb,
  qa_status text not null default 'pending'
    check (qa_status = any (array['pending'::text,'passed'::text,'advisory'::text,'blocked'::text])),
  status text not null default 'assembling'
    check (status = any (array['assembling'::text,'qa'::text,'ready'::text,'failed'::text])),
  provenance_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists authoring_jobs_user_idx on public.authoring_jobs(user_id, created_at desc);
create index if not exists authoring_jobs_doc_idx on public.authoring_jobs(result_document_id);

alter table public.document_templates enable row level security;
alter table public.template_versions  enable row level security;
alter table public.clause_library      enable row level security;
alter table public.authoring_jobs      enable row level security;
revoke all on public.document_templates from anon, authenticated;
revoke all on public.template_versions  from anon, authenticated;
revoke all on public.clause_library      from anon, authenticated;
revoke all on public.authoring_jobs      from anon, authenticated;
