-- 015_signature_fields.sql
--
-- Phase 2 of signature placement: explicit, sender-placed field positions
-- (visual drag-drop placement, Documenso-style). When an envelope has fields,
-- completion stamps each signer's mark exactly inside its box and skips the
-- text-anchor heuristic entirely.
--
-- Coordinate convention (canonical, end-to-end): TOP-LEFT origin, normalized to
-- the page. x_pct/y_pct are the box's top-left corner as a fraction of page
-- width/height (y measured DOWN from the top); w_pct/h_pct are size fractions.
-- The backend converts to pdf-lib's bottom-left space exactly once, at stamp
-- time. Idempotent.

create table if not exists public.signature_fields (
  id uuid primary key default gen_random_uuid(),
  envelope_id uuid not null
    references public.signature_envelopes(id) on delete cascade,
  signer_id uuid not null
    references public.signature_signers(id) on delete cascade,
  -- 'signature' | 'initials' | 'date' | 'name'
  type text not null default 'signature',
  page int not null default 0,            -- 0-based page index
  x_pct double precision not null,        -- top-left corner X, fraction of width
  y_pct double precision not null,        -- top-left corner Y, fraction of height (from top)
  w_pct double precision not null,        -- box width, fraction of page width
  h_pct double precision not null,        -- box height, fraction of page height
  created_at timestamptz not null default now()
);

create index if not exists signature_fields_envelope_idx
  on public.signature_fields(envelope_id);
create index if not exists signature_fields_signer_idx
  on public.signature_fields(signer_id);
