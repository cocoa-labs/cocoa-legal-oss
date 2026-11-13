# AGENTS.md — working on Coco Legal

Guidance for people and coding agents changing this codebase. User-facing setup lives in [README.md](README.md); deployment in [DEPLOY.md](DEPLOY.md).

## Layout

- `backend/` — Express + TypeScript API. `src/routes/` (HTTP), `src/lib/` (domain logic, agent tools, LLM providers, documents, e-signature, email, calendar, automation), `migrations/` (numbered SQL), `scripts/` (operational scripts run with tsx).
- `frontend/` — Next.js app. `src/app/(pages)/` routes, `src/app/components/` UI, `src/app/lib/cocoLegalApi.ts` the API client.
- `fixtures/legal/` — fictional sample documents and their generator.
- `docs/` — runbooks and test scripts for specific features.
- `supabase/config.toml` — local Supabase CLI stack (Postgres + Auth only).

## Commands

```bash
(cd backend && npm test)                    # hermetic unit tests (tsx), no DB or network
(cd backend && npm run test:reliability)    # reliability suites
(cd backend && npm run test:document-reliability)
(cd frontend && npx tsc --noEmit && npx eslint src)
(cd frontend && npm run test:public-settings) # deployment-link and consent-copy tests
```

New backend test files must be added to the `test` script in `backend/package.json`; they are not discovered automatically.

## Conventions

- **Migrations** are numbered, append-only and idempotent. Apply them with `npm run migrate` (needs `DATABASE_URL`), which records checksums in a ledger the readiness check enforces. Never edit an applied migration; add a new one. `backend/schema.sql` is a historical reference, not an install path.
- **The model registry is append-only.** Superseded model ids stay registered in `backend/src/lib/llm/models.ts`: queued document-generation jobs store a free-form model id and resolve it at execution time, so removing an id breaks those jobs.
- **Thinking configuration is centralized.** `claudeThinkingConfig()` in `backend/src/lib/llm/claude.ts` owns the per-model `thinking` fragment. Never inline a `thinking` object at a request site.
- **OpenRouter is an optional fourth provider.** Any `vendor/model` id (the slash is the discriminator) routes to `backend/src/lib/llm/openrouter.ts`. Its catalog is fetched live and cached; when it's unavailable, native providers are unaffected.
- **Playbook keys need seeds.** A capability that references a playbook key must ship a default value for that key in the same change.
- **Document-changing agent actions** go through the operation ledger (`backend/src/lib/operations.ts`) with approval and undo, never direct writes.
- **Deployment-specific values** (domains, legal links, contact addresses) come from environment variables with neutral defaults. Never hardcode an organization's details.
- **Tests and fixtures** use fictional names and reserved domains (`example.com`, `*.test`).
