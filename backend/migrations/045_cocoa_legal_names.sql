-- 045: store "Cocoa Legal" names instead of the earlier "coco" spellings.
--
-- Migrations 019, 020 and 034 shipped the built-in template marker 'coco_seed',
-- {{coco-sign:N}} signature tokens in the seeded template skeletons, and
-- personal workspaces named 'Coco Legal workspace'. Released migrations stay
-- unchanged (the ledger checks their checksums); this one rewrites the stored
-- values so fresh and upgraded databases match the code. Safe to re-run.

alter table public.document_templates
  drop constraint if exists document_templates_source_kind_check;

update public.document_templates
set source_kind = 'cocoa_seed'
where source_kind = 'coco_seed';

alter table public.document_templates
  add constraint document_templates_source_kind_check
  check (source_kind = any (array['ai_generated'::text, 'cocoa_seed'::text, 'firm_parameterized'::text]));

update public.template_versions
set skeleton_json = replace(skeleton_json::text, '{{coco-sign:', '{{cocoa-sign:')::jsonb
where skeleton_json::text like '%{{coco-sign:%';

update public.organizations
set name = 'Cocoa Legal workspace'
where name = 'Coco Legal workspace';
