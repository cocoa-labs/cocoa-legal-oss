-- 016_chat_message_version_context.sql
--
-- Anchor every chat message to the document versions that were open when it
-- was sent. version_context snapshots the open tabs (one entry per tab) with
-- the version each showed and a `displayed` flag for the active one, so:
--   * the active turn can pin the LLM to the bytes the user is looking at
--     (fixes the "memory erased" staleness in buildProjectDocContext), and
--   * a historical turn can be reconstructed honestly for audit / re-open.
-- Shape: { anchored_document_id: uuid|null,
--          docs: [{ document_id, version_id, version_number, displayed }] }
--
-- Also reconciles a schema drift: backend/src/routes/{projectChat,chat}.ts
-- already insert a `workflow` column that no prior migration declared. Declare
-- it here so the tracked schema matches what the routes write. Idempotent.

alter table public.chat_messages
  add column if not exists version_context jsonb,
  add column if not exists workflow jsonb;

revoke all on public.chat_messages from anon, authenticated;
