-- Atomic, immutable document edit commits.
--
-- The storage object is uploaded before this RPC. The RPC then owns every
-- database mutation for the commit: pointer verification, version allocation,
-- edit rows, operation completion, and pointer advancement. A caller that sees
-- DOCUMENT_VERSION_CONFLICT deletes its unreferenced object best-effort.

-- Alpha data predating immutable commits can contain duplicate version numbers.
-- Repair only affected documents, assigning their existing non-null versions a
-- deterministic chronological sequence before enforcing uniqueness. Version
-- UUIDs, storage objects, parent links, current pointers, and audit references
-- are unchanged.
with duplicate_documents as (
  select document_id
    from public.document_versions
   where version_number is not null
   group by document_id
  having count(*) <> count(distinct version_number)
), ranked_versions as (
  select v.id,
         row_number() over (
           partition by v.document_id
           order by v.created_at, v.id
         )::integer as repaired_version_number
    from public.document_versions v
    join duplicate_documents d on d.document_id = v.document_id
   where v.version_number is not null
)
update public.document_versions v
   set version_number = ranked.repaired_version_number
  from ranked_versions ranked
 where v.id = ranked.id
   and v.version_number is distinct from ranked.repaired_version_number;

create unique index if not exists document_versions_document_number_unique
  on public.document_versions(document_id, version_number)
  where version_number is not null;

create or replace function public.commit_document_edit(
  p_operation_id uuid,
  p_document_id uuid,
  p_expected_version_id uuid,
  p_result_version_id uuid,
  p_storage_path text,
  p_display_name text,
  p_created_by_user_id text,
  p_chat_message_id uuid,
  p_branch_chat_id uuid,
  p_edits jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version_id uuid;
  v_branch_tip_version_id uuid;
  v_next_version_number integer;
  v_inserted_edits jsonb;
begin
  -- Serialize allocation and pointer movement for this document even when the
  -- mainline and one or more private chat branches are active concurrently.
  perform pg_advisory_xact_lock(hashtextextended(p_document_id::text, 0));

  select current_version_id
    into v_current_version_id
    from public.documents
   where id = p_document_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'DOCUMENT_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.document_versions
     where id = p_expected_version_id and document_id = p_document_id
  ) then
    raise exception using errcode = 'P0002', message = 'DOCUMENT_VERSION_UNAVAILABLE';
  end if;

  if p_branch_chat_id is null then
    if v_current_version_id is distinct from p_expected_version_id then
      raise exception using errcode = '40001', message = 'DOCUMENT_VERSION_CONFLICT';
    end if;
  else
    select branch_tip_version_id
      into v_branch_tip_version_id
      from public.chats
     where id = p_branch_chat_id
     for update;
    if not found or v_branch_tip_version_id is distinct from p_expected_version_id then
      raise exception using errcode = '40001', message = 'DOCUMENT_VERSION_CONFLICT';
    end if;
  end if;

  select coalesce(max(version_number), 0) + 1
    into v_next_version_number
    from public.document_versions
   where document_id = p_document_id
     and version_number is not null;

  insert into public.document_versions (
    id, document_id, storage_path, source, version_number, display_name,
    created_by_user_id, parent_version_id, created_by_operation_id
  ) values (
    p_result_version_id, p_document_id, p_storage_path, 'assistant_edit',
    v_next_version_number, p_display_name, p_created_by_user_id,
    p_expected_version_id, p_operation_id
  );

  with inserted as (
    insert into public.document_edits (
      document_id, chat_message_id, version_id, change_id, del_w_id, ins_w_id,
      deleted_text, inserted_text, context_before, context_after, status
    )
    select
      p_document_id,
      p_chat_message_id,
      p_result_version_id,
      edit->>'change_id',
      nullif(edit->>'del_w_id', ''),
      nullif(edit->>'ins_w_id', ''),
      coalesce(edit->>'deleted_text', ''),
      coalesce(edit->>'inserted_text', ''),
      coalesce(edit->>'context_before', ''),
      coalesce(edit->>'context_after', ''),
      'pending'
    from jsonb_array_elements(coalesce(p_edits, '[]'::jsonb)) edit
    returning id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text,
              context_before, context_after
  )
  select coalesce(jsonb_agg(to_jsonb(inserted)), '[]'::jsonb)
    into v_inserted_edits
    from inserted;

  if p_branch_chat_id is null then
    update public.documents
       set current_version_id = p_result_version_id,
           updated_at = now()
     where id = p_document_id;
  else
    update public.chats
       set branch_tip_version_id = p_result_version_id,
           updated_at = now()
     where id = p_branch_chat_id;
  end if;

  update public.agent_operations
     set status = 'succeeded',
         result_document_id = p_document_id,
         result_version_id = p_result_version_id,
         affected_ranges = coalesce(p_edits, '[]'::jsonb),
         errors = '[]'::jsonb,
         completed_at = now(),
         updated_at = now()
   where id = p_operation_id
     and status = 'running';

  if not found then
    raise exception using errcode = 'P0002', message = 'AGENT_OPERATION_UNAVAILABLE';
  end if;

  return jsonb_build_object(
    'version_id', p_result_version_id,
    'version_number', v_next_version_number,
    'storage_path', p_storage_path,
    'edits', v_inserted_edits
  );
end;
$$;

revoke all on function public.commit_document_edit(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.commit_document_edit(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb
) to service_role;
