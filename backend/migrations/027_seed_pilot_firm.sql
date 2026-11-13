-- Single-firm foundation: seed ONE shared firm and auto-enroll every user.
--
-- The multi-user model is "one firm, shared intelligence": all users of this
-- deployment are colleagues of a single firm. resolveFirmId (backend/src/lib/
-- playbooks.ts) returns the firm slug from the FIRM_ID env var for EVERY user,
-- so they share one firm playbook + firm memory. This migration seeds that
-- firm's rows and makes each new auth user a member of it.
--
-- IMPORTANT: the org slug and firm_playbooks.firm_id below ('pilot-firm') MUST
-- match the backend FIRM_ID env var. Change all three together to rename the
-- firm, and edit the firm display name before applying.
--
-- Idempotent; apply through the transactional migration ledger command.

-- 1. Seed the single organization (the "firm").
insert into public.organizations (name, slug, created_by_user_id)
values ('My Firm', 'pilot-firm', 'migration')
on conflict (slug) do update set name = excluded.name;

-- 2. Ensure the firm's playbook container exists so the first shared
--    read/write never races in ensurePlaybook (backend/src/lib/playbooks.ts).
insert into public.firm_playbooks (firm_id, updated_by)
values ('pilot-firm', 'migration')
on conflict (firm_id) do nothing;

-- 3. Auto-enroll every new auth user into the firm. Extends handle_new_user
--    (schema.sql) so, in addition to the user_profiles row, each signup gets
--    an active 'lawyer' membership in the single firm. The catch-all is
--    preserved so a membership hiccup NEVER blocks account creation. We look
--    the org up by slug (not a hardcoded UUID) so this stays valid across
--    environments.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  insert into public.user_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  select id into v_org from public.organizations where slug = 'pilot-firm';
  if v_org is not null then
    insert into public.organization_memberships
      (organization_id, user_id, email, role, status)
    values (v_org, new.id::text, new.email, 'lawyer', 'active')
    on conflict (organization_id, user_id) do nothing;
  end if;

  return new;
exception when others then
  -- Never block signup if profile/membership provisioning fails.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 4. AFTER the 1-2 firm admins have signed in once (so their membership row
--    exists), promote them to 'owner' so they can approve firm-memory
--    candidates (weight >= 3 is required; owner = 5). Edit the email(s) and
--    run this statement manually (npm run seed:firm -- --admin ... --apply does it for you):
--
--   update public.organization_memberships
--      set role = 'owner', updated_at = now()
--    where organization_id = (select id from public.organizations where slug = 'pilot-firm')
--      and lower(email) in ('you@example.com');
