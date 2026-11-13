-- Migration 014: represented-party column on tabular_reviews.
--
-- Adds a nullable `represented_party` to public.tabular_reviews so a CRE
-- review can persist WHICH side the user represents (e.g. 'Tenant',
-- 'Landlord', 'Buyer', 'Seller'). The value steers the analysis: the
-- tabular generate/regenerate path substitutes it into the CRE column
-- prompts' {{representedParty}} placeholder before extraction (see
-- backend/src/lib/systemPrompt/substitute.ts + backend/src/routes/tabular.ts).
--
-- Nullable by design: legacy rows and every non-CRE review simply leave
-- this NULL, so this migration does not touch existing data and non-CRE
-- behavior is unchanged. The substitution falls back to a neutral default
-- ("the party you represent") whenever the value is absent, so the literal
-- placeholder never leaks to the model.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook only
-- inspects migrations, it never auto-applies). Idempotent / re-runnable:
-- the column add is guarded with `if not exists`.

alter table public.tabular_reviews
  add column if not exists represented_party text;
