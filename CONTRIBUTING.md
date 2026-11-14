# Contributing

Cocoa Legal is a community release, and Cocoa Labs no longer maintains it. Issues are closed and pull requests won't be reviewed or merged. The way to build on it is to **fork it** and run your own version.

If you maintain a fork:

- Keep it focused on one bug, feature or cleanup.
- Update docs and `.env.example` files when you change setup, configuration or user-facing behavior.
- Never commit secrets, API keys, real documents, client data or `.env` files.
- Run the checks below before you ship a change.

## Checks

```bash
cd backend
npm ci
npx tsc --noEmit
npm test
npm run test:reliability
npm run test:document-reliability

cd ../frontend
npm ci
npx tsc --noEmit
npx eslint src
npm run test:document-reliability
npm run test:public-settings
npm run build
```

Backend tests are hermetic (no database or network). Some document tests need LibreOffice and skip when it is missing.

## Database changes

Add a new numbered file to `backend/migrations/` (the next free `NNN_name.sql`). Make it idempotent (`if not exists`, `on conflict`). Never edit a migration that a deployment may already have applied: the migration ledger stores checksums and readiness fails when one changes.

See [AGENTS.md](AGENTS.md) for codebase conventions.
