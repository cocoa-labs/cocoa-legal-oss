-- Coco Legal production foundation
-- Adds first-class organization/matter tenancy, immutable agent operation
-- logging, document lifecycle fields, and version lineage. Existing legacy
-- sharing columns remain in place for staged migration.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organization / matter tenancy
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null,
  email text,
  role text not null default 'owner'
    check (role = any (array[
      'owner'::text,
      'admin'::text,
      'lawyer'::text,
      'editor'::text,
      'reviewer'::text,
      'viewer'::text
    ])),
  status text not null default 'active'
    check (status = any (array[
      'active'::text,
      'invited'::text,
      'disabled'::text
    ])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists organization_memberships_user_idx
  on public.organization_memberships(user_id, status);

create index if not exists organization_memberships_email_idx
  on public.organization_memberships(lower(email), status);

create table if not exists public.matters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  name text not null,
  cm_number text,
  lifecycle_status text not null default 'active'
    check (lifecycle_status = any (array[
      'active'::text,
      'archived'::text,
      'deleted_pending_purge'::text,
      'legal_hold'::text
    ])),
  retention_until timestamptz,
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists matters_org_idx
  on public.matters(organization_id, lifecycle_status);

create index if not exists matters_project_idx
  on public.matters(project_id);

create table if not exists public.matter_memberships (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  user_id text not null,
  email text,
  role text not null default 'lawyer'
    check (role = any (array[
      'owner'::text,
      'admin'::text,
      'lawyer'::text,
      'editor'::text,
      'reviewer'::text,
      'viewer'::text
    ])),
  status text not null default 'active'
    check (status = any (array[
      'active'::text,
      'invited'::text,
      'disabled'::text
    ])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (matter_id, user_id)
);

create index if not exists matter_memberships_user_idx
  on public.matter_memberships(user_id, status);

create index if not exists matter_memberships_email_idx
  on public.matter_memberships(lower(email), status);

-- ---------------------------------------------------------------------------
-- Legacy table tenancy / lifecycle columns
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null,
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists retention_until timestamptz,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.documents
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null,
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists retention_until timestamptz,
  add column if not exists legal_hold_until timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.workflows
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null;

alter table public.chats
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null;

alter table public.tabular_reviews
  add column if not exists org_id uuid references public.organizations(id) on delete set null,
  add column if not exists matter_id uuid references public.matters(id) on delete set null,
  add column if not exists lifecycle_status text not null default 'active',
  add column if not exists deleted_at timestamptz;

alter table public.document_versions
  add column if not exists parent_version_id uuid references public.document_versions(id) on delete set null,
  add column if not exists created_by_operation_id uuid,
  add column if not exists content_status text not null default 'ready'
    check (content_status = any (array[
      'queued'::text,
      'scanning'::text,
      'extracting'::text,
      'rendering'::text,
      'ready'::text,
      'error'::text
    ])),
  add column if not exists extraction_quality jsonb not null default '{}'::jsonb;

create index if not exists projects_org_matter_idx
  on public.projects(org_id, matter_id);

create index if not exists documents_org_matter_idx
  on public.documents(org_id, matter_id);

create index if not exists document_versions_parent_idx
  on public.document_versions(parent_version_id);

-- ---------------------------------------------------------------------------
-- Immutable agent operation ledger
-- ---------------------------------------------------------------------------

create table if not exists public.agent_operations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  actor_user_id text not null,
  actor_role text,
  tool_name text not null,
  action_type text not null,
  status text not null default 'running'
    check (status = any (array[
      'pending_approval'::text,
      'approved'::text,
      'running'::text,
      'succeeded'::text,
      'failed'::text,
      'undone'::text,
      'cancelled'::text
    ])),
  approval_status text not null default 'not_required'
    check (approval_status = any (array[
      'not_required'::text,
      'required'::text,
      'approved'::text,
      'rejected'::text
    ])),
  mutating boolean not null default false,
  requires_approval boolean not null default false,
  source_document_id uuid references public.documents(id) on delete set null,
  source_version_id uuid references public.document_versions(id) on delete set null,
  result_document_id uuid references public.documents(id) on delete set null,
  result_version_id uuid references public.document_versions(id) on delete set null,
  input_hash text,
  arguments jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  providers jsonb not null default '[]'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  anchors jsonb not null default '[]'::jsonb,
  affected_ranges jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  inverse_operation text,
  parent_operation_id uuid references public.agent_operations(id) on delete set null,
  idempotency_key text,
  approved_by_user_id text,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_operations_idempotency_idx
  on public.agent_operations(idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_operations_actor_idx
  on public.agent_operations(actor_user_id, created_at desc);

create index if not exists agent_operations_project_idx
  on public.agent_operations(project_id, created_at desc);

create index if not exists agent_operations_document_idx
  on public.agent_operations(source_document_id, result_document_id, created_at desc);

create index if not exists agent_operations_chat_idx
  on public.agent_operations(chat_id, created_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_versions_created_by_operation_id_fkey'
      and conrelid = 'public.document_versions'::regclass
  ) then
    alter table public.document_versions
      add constraint document_versions_created_by_operation_id_fkey
      foreign key (created_by_operation_id)
      references public.agent_operations(id)
      on delete set null;
  end if;
end;
$$;

revoke all on public.organizations from anon, authenticated;
revoke all on public.organization_memberships from anon, authenticated;
revoke all on public.matters from anon, authenticated;
revoke all on public.matter_memberships from anon, authenticated;
revoke all on public.agent_operations from anon, authenticated;
