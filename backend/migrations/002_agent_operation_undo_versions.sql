-- Adds an explicit source for undo-created document versions.
-- Undo operations never rewrite history; they create a new visible version that
-- points back to the restored bytes and records the inverse operation metadata.

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
      'clean_final'::text
    ]));
