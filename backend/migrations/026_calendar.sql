-- 026_calendar.sql — App-side calendar metadata for Quill's Google Calendar(s).
--
-- Google Calendar is the source of truth for event CONTENT (recurrence
-- expansion, invite/cancellation delivery, Meet provisioning, timezone, native
-- reminders). These tables hold ONLY what Google cannot: the drafted/applied
-- write rows the approval + undo flow needs, event↔matter/recording links plus
-- legal-deadline semantics, and the firm calendar id / sync cursors + worker
-- lease.
--
-- calendar_writes is the calendar analogue of email_messages (011): a mutation
-- is drafted here first when it is outward-facing (has attendees → invitations),
-- approved via the agent-operations rails, then applied to Google; internal
-- no-attendee writes are recorded here too (with a prior_snapshot) so every
-- action is undoable. calendar_sync_state is a small key/value + lease table —
-- column-identical to recordings_state (025) / automation_state (023) — so the
-- store reuses the same lease-claiming SQL.
--
-- The backend reaches these tables only through the Supabase service role; the
-- browser holds zero direct grants (RLS deny-by-default, no permissive
-- policies — mirroring 007/019/022/023/025). Every statement is idempotent and
-- safe to re-run. Apply via the Supabase dashboard SQL editor (per CLAUDE.md;
-- the startup hook only inspects, never auto-applies).

-- A drafted or applied calendar mutation (create / update / delete).
create table if not exists public.calendar_writes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  org_id uuid references public.organizations(id) on delete set null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  agent_operation_id uuid references public.agent_operations(id) on delete set null,
  calendar_id text not null,                       -- 'primary' | firm calendar id
  op_kind text not null check (op_kind in ('create','update','delete')),
  target_event_id text,                            -- null for create; google event id for update/delete
  requires_approval boolean not null default false,
  status text not null default 'pending_approval'
    check (status in ('pending_approval','applying','applied','failed','cancelled','undone')),
  event_input jsonb not null default '{}'::jsonb,  -- intended EventInput payload
  prior_snapshot jsonb,                            -- pre-change CalendarEvent, for undo of update/delete
  result_event_id text,                            -- google event id after apply (create/update)
  send_updates text not null default 'none' check (send_updates in ('all','none')),
  error text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_writes_user_idx on public.calendar_writes(user_id, created_at desc);
create index if not exists calendar_writes_op_idx on public.calendar_writes(agent_operation_id);
create index if not exists calendar_writes_status_idx on public.calendar_writes(status);

-- Event ↔ app links + legal-deadline semantics. One row per Google event we
-- attach metadata to (mostly Phase B; table created now so links can be added
-- without a follow-up migration).
create table if not exists public.calendar_event_meta (
  id uuid primary key default gen_random_uuid(),
  calendar_id text not null,
  google_event_id text not null,
  matter_id uuid references public.matters(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  recording_id uuid references public.recordings(id) on delete set null,
  deadline_type text check (deadline_type in ('court_date','filing','statute_of_limitations','other')),
  deadline_at timestamptz,
  reminder_lead_days integer,
  reminder_sent_at timestamptz,
  created_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (calendar_id, google_event_id)
);

create index if not exists calendar_meta_matter_idx on public.calendar_event_meta(matter_id);
create index if not exists calendar_meta_project_idx on public.calendar_event_meta(project_id);
create index if not exists calendar_meta_recording_idx on public.calendar_event_meta(recording_id);
create index if not exists calendar_meta_deadline_idx on public.calendar_event_meta(deadline_at, reminder_sent_at);

-- Single-row-per-key config + worker lease (mirror of recordings_state /
-- automation_state). Holds 'firm_calendar_id', 'sync:<calendarId>' cursors, and
-- the reminder-worker lease.
create table if not exists public.calendar_sync_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  claimed_by text,
  claimed_until timestamptz,
  updated_at timestamptz not null default now()
);

-- Service-role only, like every other table (see 007/019/022/023/025): RLS
-- deny-by-default with no permissive policies, zero direct browser grants.
alter table public.calendar_writes enable row level security;
alter table public.calendar_event_meta enable row level security;
alter table public.calendar_sync_state enable row level security;

revoke all on public.calendar_writes from anon, authenticated;
revoke all on public.calendar_event_meta from anon, authenticated;
revoke all on public.calendar_sync_state from anon, authenticated;
