-- Controlled-beta tenancy cutover.
--
-- This migration is intentionally additive. It turns the organization and
-- matter membership tables introduced in 001 into the authoritative identity
-- graph, backfills every legacy project/shared_with entry, and propagates the
-- resulting scope to child records. The legacy shared_with column remains for
-- response compatibility, but application code must never authorize from it.

create extension if not exists "pgcrypto";

-- Invitations exist before an auth.users row exists, so user_id must be
-- nullable. Identity is unique independently by user id and normalized email.
alter table public.organization_memberships
  drop constraint if exists organization_memberships_organization_id_user_id_key;
alter table public.organization_memberships
  alter column user_id drop not null,
  add column if not exists invitation_expires_at timestamptz,
  add column if not exists invited_by_user_id text,
  add column if not exists accepted_at timestamptz;

alter table public.matter_memberships
  drop constraint if exists matter_memberships_matter_id_user_id_key;
alter table public.matter_memberships
  alter column user_id drop not null,
  add column if not exists invitation_expires_at timestamptz,
  add column if not exists invited_by_user_id text,
  add column if not exists accepted_at timestamptz;

create unique index if not exists organization_memberships_user_unique
  on public.organization_memberships(organization_id, user_id)
  where user_id is not null;
create unique index if not exists organization_memberships_email_unique
  on public.organization_memberships(organization_id, lower(email))
  where email is not null;
create unique index if not exists matter_memberships_user_unique
  on public.matter_memberships(matter_id, user_id)
  where user_id is not null;
create unique index if not exists matter_memberships_email_unique
  on public.matter_memberships(matter_id, lower(email))
  where email is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'organization_memberships_identity_check'
      and conrelid = 'public.organization_memberships'::regclass
  ) then
    alter table public.organization_memberships
      add constraint organization_memberships_identity_check
      check (user_id is not null or nullif(trim(email), '') is not null);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'matter_memberships_identity_check'
      and conrelid = 'public.matter_memberships'::regclass
  ) then
    alter table public.matter_memberships
      add constraint matter_memberships_identity_check
      check (user_id is not null or nullif(trim(email), '') is not null);
  end if;
end;
$$;

alter table public.allowed_emails
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade,
  add column if not exists invited_by_user_id text,
  add column if not exists expires_at timestamptz;

-- Expired invitation allowlist entries must not permit a late signup. The
-- membership-claim trigger below independently checks the same deadline.
create or replace function public.enforce_email_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(new.email)
      and (expires_at is null or expires_at > now())
  ) then
    raise exception 'Sign-ups are limited to approved addresses. Please contact your administrator.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- An existing project maps one-to-one to a matter. This prevents two matters
-- from racing to claim the same legacy project during an idempotent backfill.
create unique index if not exists matters_project_unique
  on public.matters(project_id)
  where project_id is not null;

-- Give any project owner without an organization a private workspace.
do $$
declare
  owner_row record;
  new_org_id uuid;
  owner_email text;
begin
  for owner_row in
    select distinct p.user_id
    from public.projects p
    where not exists (
      select 1 from public.organization_memberships om
      where om.user_id = p.user_id and om.status = 'active'
    )
  loop
    select lower(email) into owner_email
    from auth.users where id::text = owner_row.user_id;

    insert into public.organizations(name, slug, created_by_user_id)
    values (
      'Coco Legal workspace',
      'workspace-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
      owner_row.user_id
    ) returning id into new_org_id;

    insert into public.organization_memberships(
      organization_id, user_id, email, role, status, accepted_at
    ) values (
      new_org_id, owner_row.user_id, owner_email, 'owner', 'active', now()
    );
  end loop;
end;
$$;

-- Prefer an owner/admin membership when a user belongs to multiple orgs.
update public.projects p
set org_id = (
  select om.organization_id
  from public.organization_memberships om
  where om.user_id = p.user_id and om.status = 'active'
  order by
    case om.role when 'owner' then 0 when 'admin' then 1 else 2 end,
    om.created_at
  limit 1
)
where p.org_id is null
  and exists (
    select 1 from public.organization_memberships om
    where om.user_id = p.user_id and om.status = 'active'
  );

insert into public.matters(
  organization_id, project_id, name, cm_number, lifecycle_status,
  retention_until, created_by_user_id, created_at, updated_at
)
select
  p.org_id, p.id, p.name, p.cm_number, p.lifecycle_status,
  p.retention_until, p.user_id, p.created_at, p.updated_at
from public.projects p
where p.org_id is not null
  and not exists (select 1 from public.matters m where m.project_id = p.id)
on conflict do nothing;

update public.projects p
set matter_id = m.id
from public.matters m
where m.project_id = p.id and p.matter_id is distinct from m.id;

insert into public.matter_memberships(
  matter_id, user_id, email, role, status, accepted_at
)
select
  p.matter_id,
  p.user_id,
  lower(u.email),
  'owner',
  'active',
  now()
from public.projects p
left join auth.users u on u.id::text = p.user_id
where p.matter_id is not null
on conflict do nothing;

-- Preserve legacy collaborators. Registered users become active editors;
-- unknown emails remain time-bounded invitations.
insert into public.organization_memberships(
  organization_id, user_id, email, role, status,
  invitation_expires_at, accepted_at
)
select distinct
  p.org_id,
  u.id::text,
  lower(member.email),
  'editor',
  case when u.id is null then 'invited' else 'active' end,
  case when u.id is null then now() + interval '7 days' else null end,
  case when u.id is null then null else now() end
from public.projects p
cross join lateral jsonb_array_elements_text(coalesce(p.shared_with, '[]'::jsonb)) member(email)
left join auth.users u on lower(u.email) = lower(member.email)
where p.org_id is not null and nullif(trim(member.email), '') is not null
on conflict do nothing;

insert into public.matter_memberships(
  matter_id, user_id, email, role, status,
  invitation_expires_at, accepted_at
)
select distinct
  p.matter_id,
  u.id::text,
  lower(member.email),
  'editor',
  case when u.id is null then 'invited' else 'active' end,
  case when u.id is null then now() + interval '7 days' else null end,
  case when u.id is null then null else now() end
from public.projects p
cross join lateral jsonb_array_elements_text(coalesce(p.shared_with, '[]'::jsonb)) member(email)
left join auth.users u on lower(u.email) = lower(member.email)
where p.matter_id is not null and nullif(trim(member.email), '') is not null
on conflict do nothing;

-- Propagate authoritative scope to all project-owned records.
update public.documents child set org_id = p.org_id, matter_id = p.matter_id
from public.projects p where child.project_id = p.id
  and (child.org_id is distinct from p.org_id or child.matter_id is distinct from p.matter_id);
update public.chats child set org_id = p.org_id, matter_id = p.matter_id
from public.projects p where child.project_id = p.id
  and (child.org_id is distinct from p.org_id or child.matter_id is distinct from p.matter_id);
update public.tabular_reviews child set org_id = p.org_id, matter_id = p.matter_id
from public.projects p where child.project_id = p.id
  and (child.org_id is distinct from p.org_id or child.matter_id is distinct from p.matter_id);
update public.workflows child
set org_id = (
  select membership.organization_id
  from public.organization_memberships membership
  where membership.user_id = child.user_id and membership.status = 'active'
  order by membership.created_at
  limit 1
)
where child.org_id is null and child.user_id is not null;

alter table public.email_messages
  add column if not exists matter_id uuid references public.matters(id) on delete set null;
alter table public.signature_envelopes
  add column if not exists matter_id uuid references public.matters(id) on delete set null;

update public.email_messages child set org_id = p.org_id, matter_id = p.matter_id
from public.projects p where child.project_id = p.id
  and (child.org_id is distinct from p.org_id or child.matter_id is distinct from p.matter_id);
update public.signature_envelopes child set org_id = p.org_id, matter_id = p.matter_id
from public.projects p where child.project_id = p.id
  and (child.org_id is distinct from p.org_id or child.matter_id is distinct from p.matter_id);
update public.agent_operations child set org_id = p.org_id, matter_id = p.matter_id
from public.projects p where child.project_id = p.id
  and (child.org_id is distinct from p.org_id or child.matter_id is distinct from p.matter_id);

create index if not exists email_messages_matter_idx
  on public.email_messages(matter_id, created_at desc);
create index if not exists signature_envelopes_matter_idx
  on public.signature_envelopes(matter_id, created_at desc);

-- New accounts claim only explicit, unexpired invitations. This replaces the
-- single-firm auto-enrollment trigger from migration 027.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles(user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  update public.organization_memberships
  set user_id = new.id::text,
      status = 'active',
      accepted_at = now(),
      updated_at = now()
  where lower(email) = lower(new.email)
    and status = 'invited'
    and (invitation_expires_at is null or invitation_expires_at > now());

  update public.matter_memberships
  set user_id = new.id::text,
      status = 'active',
      accepted_at = now(),
      updated_at = now()
  where lower(email) = lower(new.email)
    and status = 'invited'
    and (invitation_expires_at is null or invitation_expires_at > now());

  return new;
end;
$$;

-- Service-role-only invitation transaction. External email delivery happens
-- after this commit; if Supabase Auth delivery fails, the invitation remains
-- visible/retryable instead of granting hidden access.
create or replace function public.invite_project_member(
  p_project_id uuid,
  p_email text,
  p_role text,
  p_invited_by_user_id text
)
returns table(membership_id uuid, membership_status text, member_user_id text)
language plpgsql security definer set search_path = public as $$
declare
  target_project public.projects%rowtype;
  normalized_email text := lower(trim(p_email));
  auth_user_id text;
  org_membership_id uuid;
  matter_membership_id uuid;
  next_status text;
begin
  if normalized_email = '' then raise exception 'INVALID_MEMBER_EMAIL'; end if;
  if p_role <> all(array['admin','lawyer','editor','reviewer','viewer']) then
    raise exception 'INVALID_MEMBER_ROLE';
  end if;

  select * into target_project from public.projects where id = p_project_id for update;
  if target_project.id is null or target_project.org_id is null or target_project.matter_id is null then
    raise exception 'PROJECT_TENANCY_UNAVAILABLE';
  end if;

  select id::text into auth_user_id from auth.users
  where lower(email) = normalized_email limit 1;
  next_status := case when auth_user_id is null then 'invited' else 'active' end;

  insert into public.allowed_emails(email, note, organization_id, invited_by_user_id, expires_at)
  values (
    normalized_email, 'Controlled beta project invitation', target_project.org_id,
    p_invited_by_user_id,
    case when auth_user_id is null then now() + interval '7 days' else null end
  )
  on conflict (email) do update set
    organization_id = excluded.organization_id,
    invited_by_user_id = excluded.invited_by_user_id,
    expires_at = excluded.expires_at;

  select id into org_membership_id from public.organization_memberships
  where organization_id = target_project.org_id
    and (user_id = auth_user_id or lower(email) = normalized_email)
  order by created_at limit 1 for update;
  if org_membership_id is null then
    insert into public.organization_memberships(
      organization_id, user_id, email, role, status,
      invitation_expires_at, invited_by_user_id, accepted_at
    ) values (
      target_project.org_id, auth_user_id, normalized_email, p_role, next_status,
      case when auth_user_id is null then now() + interval '7 days' else null end,
      p_invited_by_user_id,
      case when auth_user_id is null then null else now() end
    ) returning id into org_membership_id;
  else
    update public.organization_memberships set
      user_id = coalesce(auth_user_id, user_id), email = normalized_email,
      status = next_status,
      invitation_expires_at = case when auth_user_id is null then now() + interval '7 days' else null end,
      invited_by_user_id = p_invited_by_user_id,
      accepted_at = case when auth_user_id is null then accepted_at else coalesce(accepted_at, now()) end,
      updated_at = now()
    where id = org_membership_id;
  end if;

  select id into matter_membership_id from public.matter_memberships
  where matter_id = target_project.matter_id
    and (user_id = auth_user_id or lower(email) = normalized_email)
  order by created_at limit 1 for update;
  if matter_membership_id is null then
    insert into public.matter_memberships(
      matter_id, user_id, email, role, status,
      invitation_expires_at, invited_by_user_id, accepted_at
    ) values (
      target_project.matter_id, auth_user_id, normalized_email, p_role, next_status,
      case when auth_user_id is null then now() + interval '7 days' else null end,
      p_invited_by_user_id,
      case when auth_user_id is null then null else now() end
    ) returning id into matter_membership_id;
  else
    update public.matter_memberships set
      user_id = coalesce(auth_user_id, user_id), email = normalized_email,
      role = p_role, status = next_status,
      invitation_expires_at = case when auth_user_id is null then now() + interval '7 days' else null end,
      invited_by_user_id = p_invited_by_user_id,
      accepted_at = case when auth_user_id is null then accepted_at else coalesce(accepted_at, now()) end,
      updated_at = now()
    where id = matter_membership_id;
  end if;

  return query select matter_membership_id, next_status, auth_user_id;
end;
$$;

revoke all on function public.invite_project_member(uuid, text, text, text)
  from public, anon, authenticated;

revoke all on public.organization_memberships from anon, authenticated;
revoke all on public.matter_memberships from anon, authenticated;
