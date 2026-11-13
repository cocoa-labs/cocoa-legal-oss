-- Migration 040: fail-closed layout verification for generated/modified
-- DOCX and PDF artifacts. User-uploaded originals are explicitly marked as
-- source artifacts and remain exportable byte-for-byte.

alter table public.document_versions
  add column if not exists layout_qa_status text not null default 'unverified',
  add column if not exists layout_qa_report jsonb,
  add column if not exists layout_qa_checked_at timestamptz;

alter table public.document_versions
  drop constraint if exists document_versions_layout_qa_status_check;

alter table public.document_versions
  add constraint document_versions_layout_qa_status_check
  check (layout_qa_status = any (array[
    'source'::text,
    'unverified'::text,
    'passed'::text,
    'failed'::text
  ]));

update public.document_versions
set layout_qa_status = 'source',
    layout_qa_report = null,
    layout_qa_checked_at = null
where source in ('upload', 'user_upload')
  and layout_qa_status = 'unverified';

create index if not exists document_versions_layout_qa_pending_idx
  on public.document_versions(layout_qa_status, created_at)
  where layout_qa_status in ('unverified', 'failed');
