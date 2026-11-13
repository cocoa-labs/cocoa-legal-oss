-- Migration 032: Move the out-of-box tabular-review model default to Sonnet 5.
--
-- The product runtime default advanced from claude-sonnet-4-6 to
-- claude-sonnet-5 across main chat, title generation, and tabular review (see
-- CLAUDE.md → Model policy). This changes the column default so NEW
-- user_profiles rows start on Sonnet 5. Opus 5, Fable 5, and the other tiers
-- remain selectable per user in Account → Models & API Keys.
--
-- Existing rows keep their stored tabular_model value — this only changes the
-- default for newly created profiles. We deliberately do NOT mass-UPDATE
-- existing users (no backfill); a user's explicit choice is preserved. This
-- follows the precedent set by migration 010.
--
-- The superseded model ids stay registered in backend/src/lib/llm/models.ts,
-- so any profile still holding 'claude-sonnet-4-6' keeps working.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook only
-- inspects migrations — it never auto-applies). Idempotent / re-runnable.

alter table public.user_profiles
  alter column tabular_model set default 'claude-sonnet-5';
