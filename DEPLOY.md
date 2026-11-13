# Deploying Coco Legal

This guide covers a production deployment. For a local install, use the [README quickstart](README.md#quickstart-local-docker).

A deployment has five parts:

| Part | Options |
|---|---|
| Database and auth | Supabase (Cloud, or self-hosted) |
| File storage | Cloudflare R2, Amazon S3 or another S3-compatible store |
| Backend | `backend/Dockerfile` on any container host, or Railway with Nixpacks |
| Frontend | Vercel, or `frontend/Dockerfile` on any container host |
| Upload scanning | ClamAV (`clamav/clamav` container), required in controlled-beta mode |

## 1. Supabase

1. Create a project. From **Project Settings → API** collect the project URL, the **anon** (publishable) key and the **service_role** (secret) key. From **Connect** collect a direct Postgres connection string for migrations.
2. Under **Authentication → URL Configuration**, set the site URL to your frontend origin and add `https://app.your-domain.example/**` to the redirect URLs.
3. Under **Authentication → Emails**, configure custom SMTP. The built-in mailer is heavily rate-limited and not meant for production.

## 2. Database schema

Apply every migration with the ledger runner, from any machine with Node.js 20+ (or with the backend image: `docker run --rm -e DATABASE_URL=... coco-legal-backend npm run migrate`):

```bash
cd backend
npm ci
DATABASE_URL='postgresql://...' npm run migrate
```

The runner takes an advisory lock, applies each pending file in its own transaction and records a checksum. Run `npm run migrate:verify` on every deploy: the backend's readiness check fails when a migration is missing or a recorded checksum differs. Never edit an applied migration; add a new one.

Then create the firm and allow the first users to sign up (it writes nothing without `--apply`):

```bash
npm run seed:firm -- --name "Example Law LLP" --admin you@example.com --allow colleague@example.com --apply
```

The firm slug defaults to `pilot-firm` and must equal the backend's `FIRM_ID`.

## 3. File storage

Create a private bucket and an access key limited to it. Set `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME` on the backend. Browsers download files through short-lived presigned URLs, so:

- if the browser reaches storage on a different host than the backend does (as with the bundled RustFS inside Docker Compose), set `R2_PUBLIC_ENDPOINT_URL` to the browser-facing endpoint;
- if the document viewer can't load files, add a bucket CORS rule allowing `GET` from your frontend origin.

## 4. Upload scanning

Run ClamAV (`clamav/clamav`) where the backend can reach it and set `CLAMAV_HOST` and `CLAMAV_PORT` (3310). With `UPLOAD_SCANNING_REQUIRED=true` (the controlled-beta default), uploads are refused while the scanner is unavailable. It needs a few minutes and about 1–2 GB of memory to load its signature database.

## 5. Backend

### Docker (any container host)

```bash
docker build -t coco-legal-backend ./backend
```

The image includes LibreOffice and the fonts document conversion needs. It listens on `PORT` (3001) and runs `NODE_ENV=production`, which makes missing critical settings fatal at boot.

### Railway

- Set the service's root directory to `backend/`.
- Keep the **Nixpacks** builder (`backend/railway.json` pins it). Railway's newer Railpack builder ignores `backend/nixpacks.toml`, which is what installs LibreOffice; without it every DOCX→PDF conversion and signature fails at runtime.
- Set the build variables `NPM_CONFIG_PRODUCTION=false` (the build needs TypeScript and tsx) and `NIXPACKS_NODE_VERSION=20`.
- Point the health check at `/health`, which stays 200 while the process is up. `/health/ready` probes Supabase and storage live and will cause restart loops if used as the restart probe; use it for manual checks.

### Required and recommended settings

Copy `backend/.env.example` as the reference. At minimum:

| Setting | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | service_role key; never expose it to browsers |
| `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | storage |
| `DOWNLOAD_SIGNING_SECRET`, `USER_API_KEYS_ENCRYPTION_SECRET` | long random values (`openssl rand -hex 32`) |
| `FRONTEND_URL`, `SIGN_PUBLIC_BASE_URL` | your frontend origin; used for CORS and signer links |
| `FIRM_ID` | the firm slug from step 2 |
| `BETA_MODE`, `UPLOAD_SCANNING_REQUIRED`, `CLAMAV_HOST`, `CLAMAV_PORT` | keep controlled-beta mode on until you have reviewed your deployment |

At least one model provider key (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`) is needed for Quill unless users bring their own. `backend/scripts/buildProdEnv.ts` prints a production environment from your local `backend/.env` for pasting into a host's variable editor; check the count of variables after pasting, because some raw editors drop lines silently.

### Signing identity

Each executed PDF carries a cryptographic signature from one certificate, supplied as `SIGNING_CERT_P12_BASE64` and `SIGNING_CERT_PASSPHRASE` and validated at boot. Without them the backend uses an ephemeral development certificate that changes on every restart and logs a warning.

1. Run `npx tsx scripts/generateSigningCert.ts` in `backend/`. It creates a five-year RSA-4096 certificate and writes both values into `backend/.env`; it won't overwrite an existing identity without `--force`.
2. Back up both values in a password manager. Your host must not be the only holder of the signing identity.
3. Deploy, restart once, and confirm the boot log shows the same certificate serial both times.

A self-signed certificate protects document integrity but shows as "validity unknown" in PDF readers. To remove that, buy an RSA document-signing certificate on the Adobe Approved Trust List, export it as a passphrase-protected P12 with its full chain, and swap the two values.

## 6. Frontend

### Vercel

Set the project's root directory to `frontend/` and add:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | anon key |
| `NEXT_PUBLIC_API_BASE_URL` | backend origin |
| `NEXT_PUBLIC_SITE_URL` | frontend origin |
| `NEXT_PUBLIC_TERMS_URL`, `NEXT_PUBLIC_PRIVACY_URL` | optional; links are hidden when unset |
| `NEXT_PUBLIC_SOURCE_CODE_URL` | your fork's public URL if you modified Coco Legal (AGPL-3.0 §13) |

### Docker

```bash
docker build -t coco-legal-frontend \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.your-domain.example \
  --build-arg NEXT_PUBLIC_SITE_URL=https://app.your-domain.example \
  ./frontend
```

`NEXT_PUBLIC_*` values are compiled into the bundle, so rebuild after changing them. The container serves on port 3003.

The `frontend/package.json` scripts for Cloudflare (OpenNext) are inherited and have not been verified with this codebase.

## 7. Optional integrations

Each is off until configured; `backend/.env.example` documents the settings:

- **Agent mailbox and calendar:** a Google Workspace service account with domain-wide delegation (`GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`), `GMAIL_AGENT_ADDRESS`, `GMAIL_AGENT_OWNER_USER_ID`, and the `CALENDAR_*` settings. See [docs/email-attachments.md](docs/email-attachments.md).
- **Recordings and transcription:** `ASSEMBLYAI_API_KEY`. See [docs/recordings-onboarding.md](docs/recordings-onboarding.md).
- **Personal-injury automation:** `AUTOMATION_ENABLED=true`. See [docs/pi-automation.md](docs/pi-automation.md).
- **Legal research:** `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`.
- **Error reporting:** `SENTRY_DSN`.

## 8. Verify the deployment

An HTTP 200 from the frontend proves little. Run the checks script, which tests backend health and readiness (Supabase, storage, LibreOffice), CORS for the frontend origin, and that the home, sign-up, login and signer pages render:

```bash
cd backend
npx tsx scripts/verifyDeployment.ts --backend=https://api.your-domain.example --frontend=https://app.your-domain.example
```

Then sign in, upload a document and confirm it converts and previews, which proves LibreOffice, storage and scanning together.

## 9. Operations

[docs/controlled-beta-runbook.md](docs/controlled-beta-runbook.md) covers staging, backups (`npm run backup:database`, `npm run backup:objects`), restore drills and rehearsals. [docs/production-readiness.md](docs/production-readiness.md) lists the controls the codebase implements.
