# Coco Legal

Coco Legal is an agentic legal document review platform: matter-centered document analysis, guided drafting and review, legal research, tracked-change editing, e-signature and an auditable chain of custody for every AI-driven change. Lawyers chat with their documents through **Quill**, the built-in assistant, which reads, highlights, drafts, edits and proposes changes. Every change that touches a document goes through an approval-and-undo ledger.

> **Community release.** Cocoa Labs built Coco Legal and gives it away as-is for anyone to run, study and change. Cocoa Labs **no longer maintains or supports it**: issues are closed, pull requests won't be reviewed, and security reports may go unanswered. Fork it and make it yours.

## What it does

- **Quill, the assistant.** Free-form legal chat, matter-scoped chat with every document in context, and attachments (PDF, Word, images).
- **Document review workspace.** Side-by-side document, chat and analysis panels; persistent highlights; tracked-change redlines; version history with forks and a clean-DOCX export that accepts pending changes.
- **Tabular review.** Extract the same fields across many documents into a grid with citations.
- **Workflows and capabilities.** Built-in and custom workflows plus structured legal capabilities: NDA triage, contract review against a firm playbook, compliance check, legal risk assessment, commercial real estate lease abstraction and a personal-injury email automation pipeline.
- **Firm playbooks and memory.** Firm-wide positions and fallbacks that steer reviews, with suggest-then-approve shared memory.
- **Document authoring.** Template-driven drafting with section assembly and layout checks, rendered to DOCX and PDF with LibreOffice.
- **Legal research.** Hybrid web and authority search (Tavily, Exa, Firecrawl) with citations.
- **E-signature.** A native signing engine: signer links, field placement, a certificate of completion and a cryptographic PDF signature. It has **not** been legally reviewed (see [Responsible use](#responsible-use)).
- **Optional integrations.** Agent mailbox and calendar (Google Workspace), meeting recordings and transcription (AssemblyAI), image generation (OpenAI) and a model catalog via OpenRouter.
- **Models.** Anthropic Claude, Google Gemini, OpenAI and OpenRouter, configured per instance or per user, with runtime failover.

## Responsible use

- AI output can be wrong. A qualified lawyer must review anything Quill produces before it is relied on. Nothing here is legal advice.
- The e-signature engine has not been reviewed for ESIGN, UETA or eIDAS compliance. In the default controlled-beta mode, signatures are labelled **nonbinding test signatures**.
- Fresh installs start in **controlled-beta mode**: uploads must pass a ClamAV virus scan, users accept a data-handling policy before uploading or emailing, and signature and calendar invitations go only to approved addresses. Use synthetic or redacted documents until you have done your own security and compliance review. See [Controlled-beta mode](#controlled-beta-mode).
- Sign-up is **invite-only**: a database trigger rejects any email not on the allowlist.

## Architecture

```
Browser ──► Frontend (Next.js 16, React 19)          frontend/
              │  HTTPS + Supabase session token
              ▼
            Backend (Express, TypeScript)              backend/
              ├── Supabase: Postgres + Auth            backend/migrations/
              ├── S3-compatible storage (R2, S3, RustFS)
              ├── LibreOffice (DOCX/XLSX/PPTX → PDF)
              ├── ClamAV (upload scanning)
              └── Model providers, search, Google, AssemblyAI (each optional)
```

## Quickstart (local, Docker)

You need Docker (with about 6 GB of memory available), Node.js 20 or newer, and Git.

> **One machine, test data only.** The quickstart is for trying Coco Legal on your own computer. Compose publishes its ports on 127.0.0.1 only, but the local Supabase stack listens on every network interface with well-known demo keys and the default database password. Run it on a network you trust, keep real client documents out of it, and follow [DEPLOY.md](DEPLOY.md) for a server.

1. **Start Supabase locally.** From the repository root:

   ```bash
   npx supabase@3.1.0 start
   ```

   Note the API URL (`http://127.0.0.1:54321`), the **anon** key, the **service_role** key and the database URL from the output (or from `npx supabase@3.1.0 status`).

2. **Configure the backend.** Copy `backend/.env.example` to `backend/.env` and set at least:

   | Setting | Value |
   |---|---|
   | `SUPABASE_URL` | `http://127.0.0.1:54321` |
   | `SUPABASE_SECRET_KEY` | the **service_role** key |
   | `DOWNLOAD_SIGNING_SECRET` | output of `openssl rand -hex 32` |
   | `USER_API_KEYS_ENCRYPTION_SECRET` | another `openssl rand -hex 32` |
   | `FRONTEND_URL`, `SIGN_PUBLIC_BASE_URL` | `http://localhost:3003` |

   Storage and the virus scanner are wired up by Docker Compose, so the `R2_*` and `CLAMAV_*` values in that file are ignored there.

3. **Configure Compose.** Copy `compose.env.example` to `.env`, paste the **anon** key into `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and set `S3_SECRET_KEY` to the output of `openssl rand -hex 24`. Compose refuses to start without it.

4. **Create the database schema** with the migration runner, which applies every file in `backend/migrations/` in order and records each one in a checksum ledger that the backend's readiness check verifies:

   ```bash
   docker compose run --rm --no-deps -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres backend npm run migrate
   ```

5. **Allow your email to sign up** and create the firm. This writes nothing without `--apply`, so run it once without to preview. On a fresh install `--admin` only allowlists you (see [Known limitations](#known-limitations)):

   ```bash
   docker compose run --rm --no-deps backend npm run seed:firm -- --name "Example Law LLP" --admin you@example.com --apply
   ```

6. **Start everything.**

   ```bash
   docker compose up -d --build
   ```

   The first start takes a few minutes while ClamAV downloads its signature database; the backend waits for it. Then open <http://localhost:3003>.

7. **First run in the app.**
   1. Sign up with the allowlisted email. Locally, confirmation emails are off; the Supabase mail viewer is at <http://127.0.0.1:54324>.
   2. Go to **Account → Data & outbound safeguards**, accept the data-handling policy and add the addresses or domains allowed to receive signature and calendar invitations.
   3. Add a model provider key under **Account → Models & API Keys**, or set `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `OPENAI_API_KEY` in `backend/.env` for the whole instance.
   4. Create a matter, upload a document and start working with Quill. `fixtures/legal/` has fictional sample documents.

To stop: `docker compose down` and `npx supabase@3.1.0 stop`.

### Running without Docker

After quickstart step 3 (Compose reads `.env`), start the services you still need from Compose, then run both apps with hot reload:

```bash
docker compose up -d rustfs storage-init clamav
npm install --prefix backend && npm install --prefix frontend
npm run dev --prefix backend    # http://localhost:3001
npm run dev --prefix frontend   # http://localhost:3003
```

For this mode, point the backend at RustFS and ClamAV on localhost in `backend/.env` (`R2_ENDPOINT_URL=http://localhost:9000`, the `S3_ACCESS_KEY`/`S3_SECRET_KEY` from `.env`, `R2_BUCKET_NAME=coco-legal`, `CLAMAV_HOST=localhost`) and create `frontend/.env.local` from `frontend/.env.local.example`. You need LibreOffice installed locally for document conversion. Uploads return 503 until ClamAV has loaded its signature database, which takes a few minutes after its first start.

## Controlled-beta mode

`BETA_MODE=true` (the default in `backend/.env.example`) turns on safeguards for running with real people before you have reviewed the deployment yourself:

| Safeguard | Effect |
|---|---|
| Upload scanning | Uploads are refused unless ClamAV marks them clean (`UPLOAD_SCANNING_REQUIRED=true`). |
| Data policy | Uploads and outbound email wait until the organization accepts the data-handling policy. |
| Approved recipients | Signature and calendar invitations go only to listed addresses or domains. |
| Signature label | Signatures are labelled nonbinding test signatures. |

Set `BETA_MODE=false` to turn these off. Signature wording then becomes neutral; the app makes no claim either way about whether a signature is legally binding. Upload scanning stays on while `UPLOAD_SCANNING_REQUIRED=true`.

## Configuration

`backend/.env.example` documents every backend setting; `frontend/.env.local.example` and `compose.env.example` cover the frontend and Compose. Only six settings are required to boot: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `DOWNLOAD_SIGNING_SECRET`. Everything below is optional.

| Feature | Turn it on with |
|---|---|
| Models | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` (or per-user keys in the app) |
| Legal research | `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY` |
| Agent mailbox (Gmail) | `GMAIL_AGENT_ADDRESS`, `GMAIL_AGENT_OWNER_USER_ID`, `GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` |
| Calendar (Google) | the Gmail service account plus `CALENDAR_*` settings |
| Persistent signing identity | `SIGNING_CERT_P12_BASE64`, `SIGNING_CERT_PASSPHRASE` (generate with `backend/scripts/generateSigningCert.ts`); `SIGNING_CONTACT_EMAIL`, `SIGNING_LOCATION` |
| Recordings and transcription | `ASSEMBLYAI_API_KEY` |
| Personal-injury automation | `AUTOMATION_ENABLED=true`; see [docs/pi-automation.md](docs/pi-automation.md) |
| Error reporting | `SENTRY_DSN` |
| Your legal pages and fork URL | `NEXT_PUBLIC_TERMS_URL`, `NEXT_PUBLIC_PRIVACY_URL`, `NEXT_PUBLIC_SOURCE_CODE_URL` |

The firm is identified by `FIRM_ID`, which defaults to `pilot-firm`, the slug the migrations create. To rename it, run `npm run seed:firm -- --slug your-firm …` and set `FIRM_ID` to match.

`backend/schema.sql` is a reference snapshot of an older schema. Create databases with `npm run migrate`, not with that file.

## Known limitations

Nobody will fix these upstream. They are listed so you can decide what to change in your fork.

- **`seed:firm --admin` on a fresh install.** Since migration 034, sign-up only claims explicit invitations, so the seed script can grant firm membership only to accounts that already exist. On a fresh install it allowlists you, and your account gets a personal workspace when you create your first matter. Re-run it after people sign up to make `--admin` accounts firm owners; `--allow` accounts then become firm lawyers, a role that can't create matters in the firm organization.
- **Firm memory has no approval screen.** Suggested firm-wide memory can only be reviewed through the `/firm-memory` API.
- **Any signed-in user can edit firm playbooks.**
- **Containers run as root.** Both Dockerfiles keep the base image's root user, so LibreOffice converts uploads as root. Add a non-root user before you expose a deployment.
- **Fixed product wording.** The login and sign-up pages always call Coco Legal "a demo service" (`frontend/src/app/login/page.tsx`, `frontend/src/app/signup/page.tsx`), and signed PDFs name the signature "Coco Legal Signing" (`backend/src/lib/signatures/pdf.ts`).
- **The Source code link is only in the account menu.** If you run a modified version for other people, the AGPL asks you to offer its source to every remote user, including signers on the public signing page.
- **Old migration headers.** Some files in `backend/migrations/` say to apply them by hand in the Supabase SQL editor. Use `npm run migrate` instead: it records each migration in the checksum ledger that the readiness check verifies. Never edit a migration after a deployment has applied it.
- **The strict dependency check fails today.** `node security/check-production-audit.mjs` reports the moderate advisories listed in [docs/security-audit-exceptions.md](docs/security-audit-exceptions.md) until you upgrade those packages or record exceptions.

## Deploying

See [DEPLOY.md](DEPLOY.md) for Supabase Cloud, storage, the backend on Docker or Railway, and the frontend on Docker or Vercel.

## Development

```bash
(cd backend && npm test && npm run test:reliability && npm run test:document-reliability)
(cd frontend && npx tsc --noEmit && npx eslint src && npm run test:public-settings)
```

Backend tests are hermetic: no database or network. Some document tests use LibreOffice when it is installed and skip otherwise. CI runs the same checks on every pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately through GitHub security advisories, not in public issues.

## License

Coco Legal is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). If you run a modified version as a network service, the AGPL requires you to offer its source code to your users; the in-app **Source code** link points wherever `NEXT_PUBLIC_SOURCE_CODE_URL` says.

Coco Legal began as a fork of Mike; see [NOTICE](NOTICE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
