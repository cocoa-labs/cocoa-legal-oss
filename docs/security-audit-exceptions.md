# Production dependency audit

`security/check-production-audit.mjs <backend|frontend>` runs `npm audit --omit=dev`. It fails on any high or critical production advisory, and on any moderate advisory without an unexpired entry in `security/advisory-exceptions.json` (package, directory, reason, `expires_at`). CI runs it as an informational step because this repository is not maintained; run it yourself before every deployment.

## Status at release (2026-11-13)

No high or critical production advisories in either package. These moderate findings remain; none takes request input as far as reviewed:

| Directory | Packages | Advisory | Path | Notes |
| --- | --- | --- | --- | --- |
| backend | `glob`, `minimatch`, `rimraf`, `gaxios` | glob AbortSignal cancellation bypass; minimatch pattern-amplification DoS | `gaxios` (Google API client) → `rimraf` → `glob` → `minimatch` | File-pattern helpers; no user-supplied patterns. |
| frontend | `glob`, `minimatch`, `@sentry/bundler-plugins`, `@sentry/webpack-plugin`, `@sentry/nextjs` | same `glob`/`minimatch` findings | Sentry's Next.js build plugin | Build time only. |
| frontend | `fast-uri`, `ajv`, `schema-utils`, `webpack`, `minimizer-webpack-plugin` | fast-uri scheme spoofing via percent-encoding | webpack option validation | Build time only. |

Before deploying, upgrade the parents once fixes ship, or record each accepted finding in `security/advisory-exceptions.json` with an owner, a bounded rationale and an expiry date. An exception never covers a high or critical finding.
