-- 022_signature_fields_rls.sql
--
-- Harden signature_fields against direct browser access.
--
-- 015_signature_fields.sql created public.signature_fields with neither
-- `enable row level security` nor a grant revoke — the only table in the
-- schema missing both. In a Supabase project the anon/authenticated roles
-- keep their default public-schema privileges unless revoked, so the table
-- was reachable through PostgREST with the publicly-shipped anon key: field
-- placements (and envelope/signer UUIDs) were readable cross-tenant, and the
-- boxes where runCompletion stamps signature/initials/date marks onto
-- executed PDFs (backend/src/routes/signatures.ts) were writable.
--
-- The backend reaches this table exclusively through the Supabase service
-- role (SUPABASE_SECRET_KEY), which bypasses RLS; the browser holds zero
-- direct table grants and only uses Supabase for authentication. So, as with
-- its sibling tables from 012 and the playbook retrofit in 007: enable RLS
-- deny-by-default (no permissive auth.uid() policies — that would be
-- inconsistent with every other table here) and revoke all privileges from
-- anon/authenticated. Every statement is idempotent and safe to re-run.
--
-- Fresh databases are covered by this file too: schema.sql does not create
-- the email/e-sign tables, so any database with signature_fields got it from
-- 015 and takes this hardening from 022 in the same migration pass.
--
-- Apply via the Supabase dashboard SQL editor (per CLAUDE.md; the startup
-- hook only inspects, never auto-applies) — in BOTH local and production.

alter table public.signature_fields enable row level security;

revoke all on public.signature_fields from anon, authenticated;
