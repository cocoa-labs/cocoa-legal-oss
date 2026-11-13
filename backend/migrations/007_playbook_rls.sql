-- Harden the firm-playbook tables against direct browser access.
--
-- 005_firm_playbooks.sql created firm_playbooks, playbook_entries and
-- playbook_versions with no row-level-security and no grant revokes. The
-- backend reaches these tables exclusively through the Supabase service
-- role (SUPABASE_SECRET_KEY, see backend/src/middleware/auth.ts), which
-- bypasses RLS; the browser holds ZERO direct table grants and only uses
-- Supabase for authentication. This mirrors the "Direct client grant
-- hardening" precedent in backend/schema.sql.
--
-- We therefore enable RLS deny-by-default (no permissive auth.uid()
-- policies — that would be inconsistent with every other table here) and
-- revoke all privileges from the anon/authenticated roles. Every statement
-- is idempotent and safe to re-run.
--
-- Apply via the Supabase dashboard SQL editor (per CLAUDE.md; the startup
-- hook only inspects, never auto-applies).

alter table public.firm_playbooks enable row level security;
alter table public.playbook_entries enable row level security;
alter table public.playbook_versions enable row level security;

revoke all on public.firm_playbooks from anon, authenticated;
revoke all on public.playbook_entries from anon, authenticated;
revoke all on public.playbook_versions from anon, authenticated;
