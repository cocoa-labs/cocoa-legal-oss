-- 020_authoring_seed.sql — default-shared CRE templates + starter clauses. Idempotent.

-- Commercial lease (complete exemplar) -----------------------------------
insert into public.document_templates (id, firm_id, slug, title, doc_type, practice, jurisdiction, description, source_kind, status)
values ('00000000-0000-4000-a000-000000000101', 'default-shared', 'commercial-lease',
        'Commercial Lease Agreement', 'commercial_lease', 'Real Estate', null,
        'Standard U.S. commercial lease skeleton.', 'coco_seed', 'active')
on conflict (firm_id, slug) do nothing;

insert into public.template_versions (id, template_id, version_number, skeleton_json, variable_schema_json, clause_slots_json, generation_notes_md)
values ('00000000-0000-4000-a000-000000000201', '00000000-0000-4000-a000-000000000101', 1,
  $json$[
    {"id":"parties","heading":"Parties","body_md":"This Commercial Lease Agreement (the \"Lease\") is entered into as of {{var.effective_date}} by and between {{var.landlord}} (\"Landlord\") and {{var.tenant}} (\"Tenant\")."},
    {"id":"premises","heading":"Premises","body_md":"Landlord leases to Tenant the premises located at {{var.premises_address}} (the \"Premises\")."},
    {"id":"term","heading":"Term","body_md":"The term of this Lease is {{var.term}}, commencing on {{var.commencement_date}}."},
    {"id":"rent","heading":"Base Rent","body_md":"Tenant shall pay base rent of {{var.base_rent}} per month, payable in advance on the first day of each month."},
    {"id":"use","heading":"Permitted Use","body_md":""},
    {"id":"maintenance","heading":"Maintenance and Repairs","body_md":""},
    {"id":"default","heading":"Default and Remedies","body_md":""},
    {"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{coco-sign:0}}\nLANDLORD:\nBy: ____________________\nName: ____________________\nTitle: ____________________\n\n{{coco-sign:1}}\nTENANT:\nBy: ____________________\nName: ____________________\nTitle: ____________________"}
  ]$json$::jsonb,
  $json$[
    {"name":"landlord","label":"Landlord","type":"party","required":true,"group":"Parties"},
    {"name":"tenant","label":"Tenant","type":"party","required":true,"group":"Parties"},
    {"name":"effective_date","label":"Effective Date","type":"date","required":true,"group":"Dates"},
    {"name":"commencement_date","label":"Commencement Date","type":"date","required":true,"group":"Dates"},
    {"name":"premises_address","label":"Premises Address","type":"text","required":true,"group":"Premises"},
    {"name":"term","label":"Lease Term","type":"duration","required":true,"group":"Economics"},
    {"name":"base_rent","label":"Base Monthly Rent","type":"money","required":true,"group":"Economics"},
    {"name":"jurisdiction","label":"Governing-Law State","type":"jurisdiction","required":true,"group":"Legal"}
  ]$json$::jsonb,
  '[]'::jsonb,
  'Expand empty-body sections (Permitted Use, Maintenance, Default) using the firm playbook standard positions. Keep numbering automatic.')
on conflict (template_id, version_number) do nothing;

update public.document_templates set current_version_id = '00000000-0000-4000-a000-000000000201'
  where id = '00000000-0000-4000-a000-000000000101' and current_version_id is null;

-- Five minimal templates (psa, loi, estoppel, snda, amendment) ------------
insert into public.document_templates (id, firm_id, slug, title, doc_type, practice, source_kind, status) values
  ('00000000-0000-4000-a000-000000000102','default-shared','purchase-and-sale-agreement','Purchase and Sale Agreement','psa','Real Estate','coco_seed','active'),
  ('00000000-0000-4000-a000-000000000103','default-shared','letter-of-intent','Letter of Intent','loi','Real Estate','coco_seed','active'),
  ('00000000-0000-4000-a000-000000000104','default-shared','estoppel-certificate','Estoppel Certificate','estoppel','Real Estate','coco_seed','active'),
  ('00000000-0000-4000-a000-000000000105','default-shared','snda','Subordination, Non-Disturbance and Attornment Agreement','snda','Real Estate','coco_seed','active'),
  ('00000000-0000-4000-a000-000000000106','default-shared','lease-amendment','Lease Amendment','amendment','Real Estate','coco_seed','active')
on conflict (firm_id, slug) do nothing;

insert into public.template_versions (id, template_id, version_number, skeleton_json, variable_schema_json, clause_slots_json, generation_notes_md) values
  ('00000000-0000-4000-a000-000000000202','00000000-0000-4000-a000-000000000102',1,
   $json$[{"id":"parties","heading":"Parties","body_md":"This Purchase and Sale Agreement is entered into as of {{var.effective_date}} between {{var.seller}} (\"Seller\") and {{var.buyer}} (\"Buyer\")."},{"id":"property","heading":"Property","body_md":"The property is {{var.property_address}}."},{"id":"price","heading":"Purchase Price","body_md":"The purchase price is {{var.purchase_price}}."},{"id":"terms","heading":"Terms and Conditions","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{coco-sign:0}}\nSELLER:\nBy: ____________________\n\n{{coco-sign:1}}\nBUYER:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"seller","label":"Seller","type":"party","required":true},{"name":"buyer","label":"Buyer","type":"party","required":true},{"name":"effective_date","label":"Effective Date","type":"date","required":true},{"name":"property_address","label":"Property Address","type":"text","required":true},{"name":"purchase_price","label":"Purchase Price","type":"money","required":true},{"name":"jurisdiction","label":"Governing-Law State","type":"jurisdiction","required":true}]$json$::jsonb,
   '[]'::jsonb,'Expand Terms and Conditions from the PSA standard positions.'),
  ('00000000-0000-4000-a000-000000000203','00000000-0000-4000-a000-000000000103',1,
   $json$[{"id":"parties","heading":"Letter of Intent","body_md":"This non-binding Letter of Intent dated {{var.effective_date}} sets out the principal terms between {{var.party_a}} and {{var.party_b}}."},{"id":"terms","heading":"Principal Terms","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{coco-sign:0}}\nBy: ____________________\n\n{{coco-sign:1}}\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"party_a","label":"Party A","type":"party","required":true},{"name":"party_b","label":"Party B","type":"party","required":true},{"name":"effective_date","label":"Date","type":"date","required":true},{"name":"jurisdiction","label":"Governing-Law State","type":"jurisdiction","required":false}]$json$::jsonb,
   '[]'::jsonb,'LOI is non-binding except confidentiality/exclusivity; state that explicitly.'),
  ('00000000-0000-4000-a000-000000000204','00000000-0000-4000-a000-000000000104',1,
   $json$[{"id":"intro","heading":"Estoppel Certificate","body_md":"The undersigned tenant {{var.tenant}} certifies to {{var.beneficiary}} as follows regarding the lease for {{var.premises_address}}."},{"id":"certs","heading":"Certifications","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{coco-sign:0}}\nTENANT:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"tenant","label":"Tenant","type":"party","required":true},{"name":"beneficiary","label":"Beneficiary","type":"party","required":true},{"name":"premises_address","label":"Premises Address","type":"text","required":true}]$json$::jsonb,
   '[]'::jsonb,'Expand Certifications from the estoppel requirements playbook key.'),
  ('00000000-0000-4000-a000-000000000205','00000000-0000-4000-a000-000000000105',1,
   $json$[{"id":"intro","heading":"SNDA","body_md":"This Subordination, Non-Disturbance and Attornment Agreement dated {{var.effective_date}} is among {{var.lender}}, {{var.landlord}}, and {{var.tenant}}."},{"id":"terms","heading":"Terms","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{coco-sign:0}}\nLENDER:\nBy: ____________________\n\n{{coco-sign:1}}\nTENANT:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"lender","label":"Lender","type":"party","required":true},{"name":"landlord","label":"Landlord","type":"party","required":true},{"name":"tenant","label":"Tenant","type":"party","required":true},{"name":"effective_date","label":"Date","type":"date","required":true}]$json$::jsonb,
   '[]'::jsonb,'Expand Terms from the SNDA requirements playbook key.'),
  ('00000000-0000-4000-a000-000000000206','00000000-0000-4000-a000-000000000106',1,
   $json$[{"id":"intro","heading":"Lease Amendment","body_md":"This Amendment dated {{var.effective_date}} amends the lease between {{var.landlord}} and {{var.tenant}} dated {{var.original_lease_date}}."},{"id":"changes","heading":"Amendments","body_md":""},{"id":"signatures","heading":"Signatures","pageBreak":true,"body_md":"{{coco-sign:0}}\nLANDLORD:\nBy: ____________________\n\n{{coco-sign:1}}\nTENANT:\nBy: ____________________"}]$json$::jsonb,
   $json$[{"name":"landlord","label":"Landlord","type":"party","required":true},{"name":"tenant","label":"Tenant","type":"party","required":true},{"name":"effective_date","label":"Amendment Date","type":"date","required":true},{"name":"original_lease_date","label":"Original Lease Date","type":"date","required":true}]$json$::jsonb,
   '[]'::jsonb,'State that all other lease terms remain in effect.')
on conflict (template_id, version_number) do nothing;

update public.document_templates t set current_version_id = v.id
  from public.template_versions v
  where v.template_id = t.id and v.version_number = 1
    and t.firm_id = 'default-shared' and t.current_version_id is null;
