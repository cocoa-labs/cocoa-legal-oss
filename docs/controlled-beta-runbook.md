# Controlled beta operations runbook

Controlled-beta mode is meant for an invite-only rollout. It permits only synthetic or redacted documents and nonbinding signature exercises. Ordinary outbound email may be sent to any valid address the authenticated user specifies; the approved-participant allowlist applies only to calendar and signature beta actions. It is not approved for unredacted client data or legal execution.

## Staging and deployment

Use distinct Supabase, object storage, backup storage, email inboxes, signing keys, Sentry environment, scanner, and secrets for staging. Set `BETA_MODE=true`, `TENANCY_AUTH_MODE=shadow` for the comparison window, and `UPLOAD_SCANNING_REQUIRED=true`. Run `npm run migrate -- --baseline-through=33` once for an existing database, then `npm run migrate:verify` on every deployment. After resolving every logged tenancy mismatch, set `TENANCY_AUTH_MODE=strict` (the application default).

For a schema bootstrap that predates migration 033, apply the missing incremental files through 033 first. Do not mark a baseline until `migrate` verifies the foundation and edit-commit RPC. Apply 034 and later migrations only through `npm run migrate`; the command holds a database advisory lock, wraps each migration and ledger write in one transaction, and rejects changed checksums.

Readiness must report the expected schema, Supabase, object storage, and LibreOffice as healthy. A failed scanner makes upload capability degraded and fail-closed. Run authenticated synthetic canaries after every deployment and roll back the application release on failure; do not weaken tenant checks or reverse additive migrations.

## Backups and recovery

Run `npm run backup:database` daily with a separately credentialed backup bucket and an `age` recipient. Run `npm run backup:objects` incrementally to the separate destination. Configure destination lifecycle so retired backups age out no later than 30 days after the primary retention window. Never print database URLs, encryption identities, or object names in job logs.

Before beta and monthly thereafter, download one encrypted backup into a disposable environment and run `RESTORE_DRILL_CONFIRM=disposable npm run restore:drill`. Record start/end time, schema version, row-count checks, object sampling, responder, and cleanup evidence. Targets are 24-hour RPO and four-hour RTO.

## Staging rehearsals

Run the document/workflow rehearsal only against disposable staging resources:

```sh
ALLOW_DOCUMENT_RELIABILITY_REHEARSAL=true \
REHEARSAL_SYNTHETIC_USER_ID=synthetic-beta-rehearsal \
npm run rehearse:document-reliability
```

The rehearsal creates its own organization, matter, duplicate-named Parenting Plan fixtures, versions, recipient/reply evidence, signer timestamps, and exact-evidence task. It tests displayed-copy targeting, stale-version refusal, idempotent replay, concurrent commit conflict, task reopen semantics, and deletes only IDs/object keys created by that run.

For the 50-account load gate, supply JSON arrays of staging tokens and corresponding project IDs plus a synthetic DOCX fixture, then run `npm run load:beta`. The harness refuses hosts that do not look local/staging and requires `BETA_LOAD_TEST_CONFIRM=synthetic-staging`. It exercises 15 active readers, 10 chat streams, and three concurrent uploads and fails the ordinary-read gate at 1% errors or 750 ms p95.

## Launch gates

- CI, CodeQL, production dependency audit, migration verification, and staging rehearsal are green.
- Strict-tenancy mismatch audit is empty; guessed UUID and role-matrix tests pass.
- EICAR, malformed archive, scanner outage, duplicate callback, and two-replica rate-limit tests pass.
- Restore drill, synthetic canary, and 15-concurrent-user load rehearsal pass.
- GitHub secret scanning/push protection and required review checks are enabled.
- Sentry alert ownership and the incident responder are named.

On suspected tenant leakage, disable traffic and outbound connectors, preserve content-free audit identifiers, rotate affected credentials, and notify the named responder. Do not copy document text, email bodies, prompts, filenames, tokens, cookies, or provider payloads into tickets or logs.
