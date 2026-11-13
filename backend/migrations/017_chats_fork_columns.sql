-- 017_chats_fork_columns.sql
--
-- Forked conversations alongside forked document versions. A fork is ONE new
-- chats row (no messages copied — chat_messages are append-only/immutable, so
-- the branch inherits parent turns by reference at read time). Columns:
--   parent_chat_id         — the chat this branched from (null for main thread)
--   root_chat_id           — the session root; main thread points at itself, so
--                            every branch of a session shares one root_chat_id
--   forked_from_message_id — the message the branch diverged at
--   anchor_document_id /   — the document + version the branch was forked at
--   anchor_version_id        (derived from the fork-point message's version_context)
--   branch_tip_version_id  — the branch's PRIVATE version tip; branch edits
--                            advance this while documents.current_version_id
--                            stays the mainline tip
--   fork_label             — optional human label for the branch
-- Idempotent.

alter table public.chats
  add column if not exists parent_chat_id uuid
    references public.chats(id) on delete set null,
  add column if not exists root_chat_id uuid
    references public.chats(id) on delete set null,
  add column if not exists forked_from_message_id uuid
    references public.chat_messages(id) on delete set null,
  add column if not exists anchor_document_id uuid
    references public.documents(id) on delete set null,
  add column if not exists anchor_version_id uuid
    references public.document_versions(id) on delete set null,
  add column if not exists branch_tip_version_id uuid
    references public.document_versions(id) on delete set null,
  add column if not exists fork_label text;

create index if not exists chats_parent_idx on public.chats(parent_chat_id);
create index if not exists chats_root_idx on public.chats(root_chat_id);

revoke all on public.chats from anon, authenticated;
