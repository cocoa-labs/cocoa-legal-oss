# Safe Local Testing

Cocoa Legal is a young legal AI project. Until you have reviewed your
deployment and data flows, test it with disposable infrastructure and synthetic
documents only.

## Use Disposable Test Resources

Create separate test resources for Cocoa Legal:

- a throwaway Supabase project
- a throwaway S3-compatible storage bucket, such as Cloudflare R2
- disposable model-provider API keys with low spending limits
- a test email account

Do not use production Supabase projects, production storage buckets, firm API
keys, or real client documents for initial testing.

## Keep Secrets Out of the Frontend

Only variables prefixed with `NEXT_PUBLIC_` should be assumed safe to expose to
the browser. Service-role keys and model-provider keys should stay server-side.

For frontend testing, `frontend/.env.local` should normally contain only:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-anon-key
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

(`NEXT_PUBLIC_API_BASE_URL` points at the backend — `3001` by default, `3004` if
you run via `restart-dev.sh`. The frontend itself always serves on `3003`.)

Keep the Supabase service-role key in `backend/.env` only:

```env
SUPABASE_SECRET_KEY=your-supabase-service-role-key
```

Model-provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`OPENAI_API_KEY` should also stay in `backend/.env`. Enterprise search keys
such as `TAVILY_API_KEY`, `EXA_API_KEY`, and `FIRECRAWL_API_KEY` are also
backend-only secrets.

## Test With Synthetic Documents

Use fake or public sample documents when testing:

- synthetic NDAs
- sample contracts
- public court documents
- dummy PDF/DOCX files

Do not upload privileged, confidential, client, matter, personnel, or firm
knowledge-management material until you are comfortable with the deployment's
storage, logging, deletion, and model-provider behavior.

## Confirm Environment Files Are Not Tracked

Before running or committing changes, check:

```bash
git status --short
```

Stop if `.env`, `.env.local`, or any file containing secrets appears in the
output.

## Start With Non-LLM Flows

If you do not want to use model-provider keys yet, use dummy provider values and
test only the non-LLM flows first:

- account creation against a test Supabase project
- project creation
- file upload with synthetic documents
- folder organization
- document deletion

Then add one disposable, capped model-provider key and test assistant behavior
with synthetic documents.

## Clean Up After Testing

After testing, delete:

- uploaded objects from the storage bucket
- test Supabase rows or the whole test Supabase project
- disposable model-provider keys
- local `.env` files that contain secrets

For legal-document workflows, deletion semantics matter. Verify that your
storage bucket no longer contains test document objects after delete flows.
