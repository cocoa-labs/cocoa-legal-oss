-- Migration 008: document_type classification column.
--
-- Adds a nullable `document_type` to public.documents so the upload
-- pipeline can stamp a deterministically classified CRE document type
-- (e.g. 'commercial-lease', 'estoppel-certificate', 'snda',
-- 'purchase-and-sale-agreement', 'title-commitment', 'rent-roll',
-- 'loan-agreement'). See backend/src/lib/creClassifier.ts for the
-- classifier and documentUpload.ts for where the value is written.
--
-- Nullable by design: legacy rows and every non-CRE upload simply leave
-- this NULL, so this migration does not touch existing data.
--
-- Applied via the Supabase SQL editor (per CLAUDE.md, the startup hook
-- only inspects migrations, it never auto-applies). Idempotent /
-- re-runnable: the column add and the index create are both guarded.

alter table public.documents
  add column if not exists document_type text;

create index if not exists idx_documents_document_type
  on public.documents(document_type);
