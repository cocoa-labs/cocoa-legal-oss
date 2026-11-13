-- Migration 021: add 'authored' to the document_versions.source enum.
--
-- Template-assembled documents are persisted with source = 'authored'
-- (see persistAuthoredDocx / insertDocumentVersionCompat in
-- backend/src/lib/documentVersions.ts). 'authored' is a first-class,
-- numbered source — it is added to NUMBERED_VERSION_SOURCES in
-- operations.ts and to the attachLatestVersionNumbers filter in
-- documentVersions.ts so authored drafts get a visible sequential
-- version number, exactly like 'generated'.
--
-- Mirrors the existing drop/add idiom for document_versions_source_check
-- (see backend/schema.sql). Idempotent / re-runnable: the constraint is
-- dropped if present, then re-added with the full member list. 'authored'
-- is inserted right after 'generated'. Applied via the Supabase SQL
-- editor (per CLAUDE.md, the startup hook only inspects migrations, it
-- never auto-applies).

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'assistant_highlight'::text,
      'assistant_undo'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'authored'::text,
      'clean_final'::text
    ]));
