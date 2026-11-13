-- Migration 041: per-envelope signing-identity attribution.
--
-- Records WHICH certificate produced the cryptographic signature on each
-- executed PDF. Before this, the identity was disclosed only inside the
-- completion-certificate PDF bytes — after a certificate swap (dev → org cert,
-- org → purchased CA cert) there was no way to query which envelopes were
-- signed under which identity, or to tell users which documents predate the
-- persistent certificate.
--
-- All columns nullable: historical envelopes predate attribution. Written
-- best-effort at completion time (routes/signatures.ts) in a separate update
-- so a not-yet-applied migration can never sink executed-artifact metadata.

alter table public.signature_envelopes
  add column if not exists signing_cert_mode text,
  add column if not exists signing_cert_subject text,
  add column if not exists signing_cert_issuer text,
  add column if not exists signing_cert_serial text,
  add column if not exists signing_cert_fingerprint_sha256 text,
  add column if not exists signing_cert_not_after timestamptz;

alter table public.signature_envelopes
  drop constraint if exists signature_envelopes_signing_cert_mode_check;
alter table public.signature_envelopes
  add constraint signature_envelopes_signing_cert_mode_check
  check (signing_cert_mode is null or signing_cert_mode = any (array[
    'dev-ephemeral'::text,
    'org-self-signed'::text,
    'ca-issued'::text
  ]));
