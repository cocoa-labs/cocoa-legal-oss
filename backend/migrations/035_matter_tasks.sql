-- Matter tasks are user intent linked to authoritative evidence. They do not
-- duplicate delivery/signature state: deterministic completion references the
-- exact domain event that proved the work was done.

create table if not exists public.matter_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  matter_id uuid not null references public.matters(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 300),
  description text,
  status text not null default 'open'
    check (status = any (array['open'::text, 'completed'::text, 'cancelled'::text])),
  assignee_user_id text,
  document_id uuid references public.documents(id) on delete set null,
  document_version_id uuid references public.document_versions(id) on delete set null,
  email_message_id uuid references public.email_messages(id) on delete set null,
  signature_envelope_id uuid references public.signature_envelopes(id) on delete set null,
  agent_operation_id uuid references public.agent_operations(id) on delete set null,
  completion_rule jsonb not null default '{"type":"manual"}'::jsonb,
  completion_evidence_type text,
  completion_evidence_id text,
  completion_evidence_at timestamptz,
  due_at timestamptz,
  completed_at timestamptz,
  completed_by_user_id text,
  reopened_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint matter_tasks_completion_rule_check check (
    completion_rule ? 'type' and completion_rule->>'type' = any (array[
      'manual'::text,
      'email_sent'::text,
      'signature_completed'::text,
      'document_version_created'::text,
      'operation_succeeded'::text
    ])
  )
);

create index if not exists matter_tasks_project_status_idx
  on public.matter_tasks(project_id, status, updated_at desc);
create index if not exists matter_tasks_matter_idx
  on public.matter_tasks(matter_id, updated_at desc);
create index if not exists matter_tasks_email_idx
  on public.matter_tasks(email_message_id) where email_message_id is not null;
create index if not exists matter_tasks_envelope_idx
  on public.matter_tasks(signature_envelope_id) where signature_envelope_id is not null;
create index if not exists matter_tasks_operation_idx
  on public.matter_tasks(agent_operation_id) where agent_operation_id is not null;
create index if not exists matter_tasks_version_idx
  on public.matter_tasks(document_version_id) where document_version_id is not null;

alter table public.matter_tasks enable row level security;
revoke all on public.matter_tasks from anon, authenticated;
