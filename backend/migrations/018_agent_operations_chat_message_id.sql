-- 018_agent_operations_chat_message_id.sql
--
-- Supplementary message-precise provenance on the operation ledger. The PRIMARY
-- version -> conversation link is document_edits.chat_message_id (the dominant
-- edit path, runEditDocument, creates no agent_operation), but stamping
-- chat_message_id on the operations that DO run (generate_docx / highlight /
-- replicate / email / signature) makes the chain-of-custody ledger
-- message-precise too. Idempotent.

alter table public.agent_operations
  add column if not exists chat_message_id uuid
    references public.chat_messages(id) on delete set null;

create index if not exists agent_operations_chat_message_idx
  on public.agent_operations(chat_message_id);

revoke all on public.agent_operations from anon, authenticated;
