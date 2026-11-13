-- 025_recordings.sql — Recordings capture + transcription pipeline.
--
-- recordings is one row per captured audio (mic MediaRecorder or an uploaded
-- mp3/wav/… from an external recorder) — the state machine the recordings
-- worker drives: queued → transcribing → summarizing → ready, with a failed
-- exit and retry backoff via next_attempt_at. Raw audio lives in R2 keyed by
-- audio_storage_key (NOT a documents row — documents rails assume text/PDF
-- extraction); transcript/summary/action_items live on the row; the generated
-- transcript PDF, voice-briefing MP3, and timeline PNG are documents rows
-- referenced by *_document_id so they inherit download + email-attachment
-- rails. recordings_state is a small key/value table for the worker lease and
-- cursors — column-identical to automation_state (023) so the store reuses the
-- same lease-claiming SQL.
--
-- The backend reaches these tables only through the Supabase service role; the
-- browser holds zero direct grants (RLS deny-by-default, no permissive
-- policies — mirroring 007/019/022/023). Every statement is idempotent and
-- safe to re-run. Apply via the Supabase dashboard SQL editor (per CLAUDE.md;
-- the startup hook only inspects, never auto-applies).

create table if not exists public.recordings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete set null,
  chat_id uuid references public.chats(id) on delete set null,
  chat_message_id uuid references public.chat_messages(id) on delete set null,
  title text not null default 'Untitled recording',
  source text not null default 'mic' check (source in ('mic','upload')),
  status text not null default 'queued'
    check (status in ('queued','transcribing','summarizing','ready','failed')),
  audio_storage_key text not null,
  audio_mime text not null,
  audio_size_bytes bigint not null default 0,
  duration_seconds numeric,
  consent_ack_at timestamptz not null,
  assemblyai_transcript_id text,
  utterances jsonb not null default '[]'::jsonb,      -- [{speaker,text,start_ms,end_ms}]
  transcript_text text,
  summary_md text,
  action_items jsonb not null default '[]'::jsonb,    -- [{id,text,owner,due,done}]
  transcript_document_id uuid references public.documents(id) on delete set null,
  voice_briefing_document_id uuid references public.documents(id) on delete set null,
  timeline_image_document_id uuid references public.documents(id) on delete set null,
  email_id uuid references public.email_messages(id) on delete set null,
  error text,
  retry_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recordings_user_idx on public.recordings(user_id, created_at desc);
create index if not exists recordings_due_idx on public.recordings(status, next_attempt_at);
create index if not exists recordings_project_idx on public.recordings(project_id);
create index if not exists recordings_chat_idx on public.recordings(chat_id);

-- Single-row lease table for the recordings worker (mirror of automation_state).
create table if not exists public.recordings_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  claimed_by text,
  claimed_until timestamptz,
  updated_at timestamptz not null default now()
);

-- Service-role only, like every other table (see 007/019/022/023): RLS
-- deny-by-default with no permissive policies, zero direct browser grants.
alter table public.recordings enable row level security;
alter table public.recordings_state enable row level security;

revoke all on public.recordings from anon, authenticated;
revoke all on public.recordings_state from anon, authenticated;
