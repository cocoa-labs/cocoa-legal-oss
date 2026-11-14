// backend/scripts/buildProdEnv.ts
//
// Generates the production environment block for Railway by taking the values
// already working locally, applying the prod overrides, and dropping what
// shouldn't ship. Writes to backend/.env.production.local (gitignored).
//
// Secrets are NEVER printed to stdout — only key names and a summary. Open the
// generated file yourself and paste it into Railway's variables editor (it
// accepts .env-style bulk paste).
//
// Usage:
//   npx tsx scripts/buildProdEnv.ts
//   npx tsx scripts/buildProdEnv.ts --frontend-url=https://your-app.vercel.app
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const BACKEND_DIR = path.resolve(__dirname, "..");
const OUT = path.join(BACKEND_DIR, ".env.production.local");
const PLACEHOLDER = "__SET_AFTER_VERCEL_DEPLOY__";

const frontendArg = process.argv
    .find((a) => a.startsWith("--frontend-url="))
    ?.split("=")[1]
    ?.replace(/\/+$/, "");
const FRONTEND = frontendArg || PLACEHOLDER;

/** Carried over verbatim from local .env — same Supabase project, same R2. */
const CARRY_OVER = [
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "R2_ENDPOINT_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "S3_FORCE_PATH_STYLE",
    "DOWNLOAD_SIGNING_SECRET",
    // MUST be byte-identical: it derives the AES key for every per-user BYOK
    // key already stored in this database. Regenerating bricks them all.
    "USER_API_KEYS_ENCRYPTION_SECRET",
    // E-signature signing identity (scripts/generateSigningCert.ts). Rotating
    // changes the identity on every future envelope — visible on completion
    // certificates and signing_cert_* attribution. See DEPLOY.md.
    "SIGNING_CERT_P12_BASE64",
    "SIGNING_CERT_PASSPHRASE",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "ASSEMBLYAI_API_KEY",
    "GOOGLE_SA_CLIENT_EMAIL",
    "GOOGLE_SA_PRIVATE_KEY",
    "GMAIL_AGENT_ADDRESS",
    "GMAIL_INBOUND_WEBHOOK_SECRET",
    "GMAIL_AGENT_OWNER_USER_ID",
];

/** Never ship these. */
const DROP = new Set([
    "RESEND_API_KEY", // dead: package is never imported anywhere in src/
    "PORT", // Railway injects it
    "FRONTEND_URL",
    "CORS_ORIGINS",
    "SIGN_PUBLIC_BASE_URL",
    "FIRM_ID",
]);

/** Production-only values. */
const PROD_VALUES: [string, string, string][] = [
    ["NODE_ENV", "production", "enables fatal env validation, HSTS, strict CORS"],
    ["FIRM_ID", "pilot-firm", "must match organizations.slug"],
    ["BETA_MODE", "true", "enforces controlled-beta recipient/data policy"],
    ["TENANCY_AUTH_MODE", "strict", "membership tables are authoritative"],
    ["UPLOAD_SCANNING_REQUIRED", "true", "fail closed unless clamd marks clean"],
    ["MATTER_TASK_WORKER_ENABLED", "true", "repairs exact-evidence task state"],
    ["LIFECYCLE_PURGE_ENABLED", "true", "leases the 30-day purge worker"],
    ["FRONTEND_URL", FRONTEND, "exact Vercel origin, no trailing slash"],
    ["CORS_ORIGINS", FRONTEND, "same; add more comma-separated if needed"],
    ["SIGN_PUBLIC_BASE_URL", FRONTEND, "e-signature links are built from this"],
    // clamd sidecar (Railway service "clamav") — UPLOAD_SCANNING_REQUIRED fails
    // closed without it, disabling ALL uploads. The raw-editor paste REPLACES
    // the whole variable set, so these must live here: they were once set only
    // in the dashboard and a regenerated paste silently deleted them (scanner
    // went ok -> disabled in prod).
    ["CLAMAV_HOST", "clamav.railway.internal", "Railway private networking: <service>.railway.internal"],
    ["CLAMAV_PORT", "3310", "clamd default port"],
    ["TRUST_PROXY_HOPS", "1", "Railway fronts you with a single proxy"],
    ["GMAIL_AGENT_NAME", "Quill · Cocoa Legal", "From display name recipients see"],
    ["CALENDAR_FIRM_NAME", "Cocoa Legal", "shared calendar name (also the find-or-create key)"],
    ["CALENDAR_DEFAULT_TIMEZONE", "UTC", "set your firm's IANA timezone"],
    ["CALENDAR_REMINDER_WORKER_ENABLED", "true", "strict lowercase 'true'"],
    ["EMAIL_AUTODRAFT_ENABLED", "true", "drafts replies for human approval"],
    ["EMAIL_AUTOREPLY_ENABLED", "false", "no unattended sending"],
    ["AUTOMATION_ENABLED", "false", "true runs PI automation (shadow mode) and polls the agent inbox"],
    ["RATE_LIMIT_CHAT_MAX", "120", "default 30/15min is tight for many users behind one NAT"],
    // Chat capability-suggestion chips (lib/intentDetection.ts) are
    // deliberately absent: INTENT_LLM_CLASSIFY_ENABLED (default on),
    // INTENT_CLASSIFIER_MODEL (default the product model),
    // INTENT_CLASSIFIER_TIMEOUT_MS (6000), INTENT_POST_STREAM_GRACE_MS (1500),
    // INTENT_LLM_MIN_CONFIDENCE (0.8) and
    // INTENT_LLM_REQUIRE_LEXICAL_AGREEMENT (default on) all default to the
    // intended production posture, so emitting them would only add values to
    // keep in sync. Add one here (and to .env.example) the moment production
    // needs to differ — the raw-editor paste REPLACES the whole variable set,
    // so a var set only in the dashboard is one regenerated paste from being
    // silently deleted.
];

function parseEnvFile(file: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!existsSync(file)) return out;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        out.set(key, value);
    }
    return out;
}

function main() {
    // local.env overrides .env (loadEnv.ts applies it with override: true).
    const base = parseEnvFile(path.join(BACKEND_DIR, ".env"));
    const overrides = parseEnvFile(path.join(BACKEND_DIR, "local.env"));
    const merged = new Map([...base, ...overrides]);

    // Emit ONE `KEY="value"` per line with NO comments and NO blank lines.
    // Railway's raw-variable editor silently dropped 18 of 35 entries from a
    // commented file — values containing spaces (e.g. the PEM private key,
    // "Cocoa Legal") and interleaved `#` lines are the likely cause. Always
    // quoting and emitting nothing else removes every parsing ambiguity.
    const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

    const lines: string[] = [];
    const missing: string[] = [];
    for (const key of CARRY_OVER) {
        const value = merged.get(key);
        if (!value) {
            missing.push(key);
            continue;
        }
        lines.push(`${key}=${quote(value)}`);
    }
    for (const [key, value] of PROD_VALUES) {
        lines.push(`${key}=${quote(value)}`);
    }
    // Build-time vars included inline so a single paste is complete.
    lines.push(`NPM_CONFIG_PRODUCTION="false"`);
    lines.push(`NIXPACKS_NODE_VERSION="20"`);
    lines.push("");

    writeFileSync(OUT, lines.join("\n"), { mode: 0o600 });

    // Report NAMES ONLY — never values.
    console.log(`Wrote ${path.relative(process.cwd(), OUT)} (mode 600)\n`);
    console.log(`  carried over : ${CARRY_OVER.length - missing.length} keys`);
    console.log(`  prod-specific: ${PROD_VALUES.length} keys`);
    console.log(`  dropped      : ${[...DROP].join(", ")}`);
    if (missing.length) {
        console.log(`\n  MISSING locally (fill in manually): ${missing.join(", ")}`);
    }
    if (FRONTEND === PLACEHOLDER) {
        console.log(
            `\n  NOTE: FRONTEND_URL / CORS_ORIGINS / SIGN_PUBLIC_BASE_URL are set to` +
                `\n  ${PLACEHOLDER}. Re-run with --frontend-url=<vercel origin> once the` +
                `\n  frontend is deployed, then update those three in Railway and redeploy.`,
        );
    }
    console.log(
        "\n  Open the file to copy the values. They are deliberately not printed here.",
    );
}

main();
