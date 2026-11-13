# Security policy

Coco Legal is a community release published as-is. Cocoa Labs does not maintain it, so security reports may not get a response or a fix. If you run Coco Legal, you are responsible for reviewing, patching and operating your deployment.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private vulnerability reporting (the **Security** tab of this repository → **Report a vulnerability**). Do not open a public issue, and never include credentials, client data, document content, prompts or provider payloads in a report.

## Running it safely

- **Keep controlled-beta mode on** (`BETA_MODE=true`) until you have done your own security and compliance review: it requires virus scanning of uploads, a data-handling acknowledgement, and an allowlist of signature and calendar recipients.
- **Use synthetic or redacted documents** until you trust your deployment. Coco Legal sends document text to the model providers you configure; review their data-handling terms.
- **The e-signature engine has not been legally reviewed.** Treat its signatures as nonbinding unless your own counsel concludes otherwise for your jurisdiction and use.
- **Keep sign-up invite-only.** The `allowed_emails` trigger rejects any sign-up not on the list; add people with `npm run seed:firm`.
- **Protect secrets.** `SUPABASE_SECRET_KEY` (service role), `DOWNLOAD_SIGNING_SECRET`, `USER_API_KEYS_ENCRYPTION_SECRET` and the signing certificate grant full access. Keep them out of the repository and rotate them if exposed.
- **Watch dependencies.** CI reports production npm advisories without failing the build. Run `node security/check-production-audit.mjs backend` (and `frontend`) before deploying and upgrade affected packages. Exceptions you accept go in `security/advisory-exceptions.json` with an owner, rationale, advisory ID and expiry date.
