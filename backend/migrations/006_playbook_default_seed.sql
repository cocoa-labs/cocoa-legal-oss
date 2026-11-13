-- Firm-customizable legal playbooks. Each capability reads keyed entries
-- (e.g. nda.standard_positions, risk.escalation_thresholds) from the
-- firm's playbook at runtime. v1 resolves firm_id to the user's
-- auth.users id; a future migration will introduce a true firms table
-- and join key.

-- A single placeholder seed row to verify the playbook plumbing
-- works end-to-end. The real per-capability seeds live in their
-- own migrations once each capability is added.

-- This migration is intentionally idempotent so it can be re-run
-- safely after dev DB resets.

do $$
declare
  default_firm text := 'default-shared';
  pb_id uuid;
begin
  insert into public.firm_playbooks (firm_id, updated_by)
  values (default_firm, 'migration')
  on conflict (firm_id) do update set updated_at = now()
  returning id into pb_id;

  insert into public.playbook_entries
    (playbook_id, key, value_json, notes_md, is_default, updated_by)
  values
    (
      pb_id,
      'meta.playbook_seeded',
      jsonb_build_object('seeded_at', now()::text),
      'Placeholder confirming the playbook layer is wired. Replace with real per-capability seeds.',
      true,
      'migration'
    )
  on conflict (playbook_id, key) do update set
    value_json = excluded.value_json,
    notes_md = excluded.notes_md;
end $$;
