# Production Readiness Notes

This file records the production controls Cocoa Legal implements and the
ones a deployer still has to add. It tracks the controls that must stay visible
while the implementation is staged.

## Current Production Foundation

- `backend/migrations/001_production_foundation.sql` adds organization/matter
  tenancy tables, operation logging, version lineage, and lifecycle fields.
- `backend/migrations/002_agent_operation_undo_versions.sql` adds explicit
  `assistant_undo` document versions so undo creates auditable history instead
  of rewinding the current-version pointer.
- `agent_operations` is the durable chain-of-custody ledger for agent and user
  actions.
- `/operations` exposes recent activity for matter, project, document, and chat
  views.
- Highlight apply/remove operations are routed through the approval executor and
  record source/result versions, approval actor, affected anchors, and inverse
  metadata.
- Agent-initiated DOCX highlight removal now creates a pending operation first;
  the user must approve it from the assistant card or chain-of-custody panel
  before the document version changes.
- `backend/src/lib/authorization.ts` is the first typed policy layer. It uses
  org/matter membership roles when available and falls back to existing
  project/document sharing while legacy scopes are migrated.
- Legal search events now record provider blend and source provenance in the
  operation ledger.

## Risk Register

| Risk | Current control | Next required control |
| --- | --- | --- |
| Cross-tenant access | Typed authorization layer for operations plus legacy fallback | Replace route-level checks across documents/chats/workflows/reviews |
| Incomplete audit history | `agent_operations` for new agent/search/highlight paths | Backfill all edit/generate/tabular/delete/share paths |
| Unauthorized document mutation | Highlight apply/remove approval execution path; chat highlight removal is proposal-first | Move edit/generate/delete/share/export tools into pending approval proposals |
| Stale rendered document | Version lineage fields and active-version resolution | Queue PDF rendition for every generated DOCX version |
| Missing database migrations | First migration directory added | Add migration runner/status table and CI migration check |
| Prompt injection | Tool descriptions limit legal/search/document actions | Add hostile-document prompt-injection test suite |
| Provider/search failures | Search warnings and partial failure handling | Persist provider health metrics and alerting |
| Client data deletion | Physical delete flows exist | Add retention, legal hold, purge queue, and delete evidence |
| File-borne malware | File type and size checks | Add malware scanning before extraction/rendering |
| Raw client data in logs | Request logging omits bodies | Add structured redaction tests and log review policy |
| Signing identity continuity | Env-pinned org P12 (scripts/generateSigningCert.ts), boot validation fails fast on a broken cert, per-envelope signing_cert_* attribution (migration 041), tri-state disclosure on completion certificates | Purchase an AATL-issued RSA certificate (clears the "validity unknown" banner in PDF viewers) |

## Rollout Gates

1. Internal pilot may use legacy sharing, but every document mutation must create
   an operation row.
2. Internal legal review beta requires org/matter membership rows, operation
   search by matter/document/chat, and undo for all document version mutations.
3. Client beta requires server-enforced approval gates, migration checks in CI,
   cross-tenant authorization tests, retention controls, and documented vendor
   settings for model/search providers.
4. Business-ready launch requires SOC 2 evidence collection, incident response
   runbooks, backup restore drills, and security review sign-off.

## Operator Runbooks To Complete

- Failed document conversion recovery.
- Bad or unsupported agent output incident.
- Provider outage fallback.
- Client data deletion and retention proof.
- API key rotation.
- Cross-tenant access incident response.
