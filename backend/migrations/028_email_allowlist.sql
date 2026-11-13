-- Invite-only gating: hard email allowlist enforced at the database layer.
--
-- Layer A (primary gate) is the Supabase Auth dashboard toggle
-- "Allow new users to sign up" = OFF. This migration is Layer B: a
-- defense-in-depth backstop that rejects any auth.users insert whose email is
-- not on the allowlist -- even if public signup is accidentally re-enabled or
-- an admin invites the wrong address.
--
-- CRITICAL: enforcement lives in a SEPARATE *BEFORE INSERT* trigger -- NOT
-- inside handle_new_user(), whose 'exception when others' catch-all would
-- swallow the raise and let signup through. A BEFORE-INSERT raise aborts the
-- auth.users insert outright, before the AFTER-INSERT provisioning runs.
--
-- Idempotent; apply via the Supabase SQL editor.
--
-- >>> EDIT THE SEEDED EMAILS BELOW BEFORE APPLYING <<<
--     With this trigger live and only the placeholder seeded, NO real user
--     can sign up until their email is added to allowed_emails.

create table if not exists public.allowed_emails (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);

-- Match the 43-table lockdown: the browser (anon/authenticated) can never read
-- this list; only the service-role backend and SECURITY DEFINER triggers can.
-- Both locks, same as 007_playbook_rls.sql: RLS deny-by-default (no permissive
-- policies) AND the grant revoke. Neither affects the backend (service role
-- bypasses RLS) nor enforce_email_allowlist() (SECURITY DEFINER also bypasses).
alter table public.allowed_emails enable row level security;
revoke all on public.allowed_emails from anon, authenticated;

-- No addresses are seeded: a pre-allowlisted address on a domain someone else
-- controls would let them sign up on any fresh deployment. Add the first admin
-- with `npm run seed:firm -- --admin you@example.com --apply`, or:
--   insert into public.allowed_emails (email) values ('you@example.com');

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
  ) then
    -- Deliberately does NOT echo the submitted address: the message reaches the
    -- browser, and repeating it back would let anyone probe who is on the list.
    raise exception 'Sign-ups are limited to approved addresses. Please contact your administrator.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_allowlist_before_insert on auth.users;
create trigger enforce_allowlist_before_insert
  before insert on auth.users
  for each row execute procedure public.enforce_email_allowlist();
