-- Migration 010: Flip the out-of-box tabular-review model default to Sonnet.
--
-- The product runtime now defaults to claude-sonnet-4-6 (cost-effective) for
-- all server-side LLM applications, including tabular review. This changes the
-- column default so NEW user_profiles rows start on Sonnet instead of
-- gemini-3-flash-preview. Opus 4.8 and the other tiers remain selectable per
-- user in Account → Models & API Keys.
--
-- Existing rows keep their stored tabular_model value — this only changes the
-- default for newly created profiles. We deliberately do NOT mass-UPDATE
-- existing users (no backfill); a user's explicit choice is preserved.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook only
-- inspects migrations — it never auto-applies). Idempotent / re-runnable.

alter table public.user_profiles
  alter column tabular_model set default 'claude-sonnet-4-6';
