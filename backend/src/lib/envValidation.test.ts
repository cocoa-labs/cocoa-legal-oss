import assert from "node:assert";
import {
  AUTOMATION_ENV_VARS,
  CRITICAL_ENV_VARS,
  INTENT_ENV_VARS,
  RECORDINGS_ENV_VARS,
  validateCriticalEnv,
} from "./envValidation";

// ---------------------------------------------------------------------------
// The critical-var list must track the actual consumers (supabase.ts,
// storage.ts, downloadTokens.ts). If a name is renamed in one of those
// modules this test won't catch it — but it does pin the contract so a
// rename is a deliberate two-file change.
// ---------------------------------------------------------------------------

assert.deepStrictEqual(
  [...CRITICAL_ENV_VARS].sort(),
  [
    "DOWNLOAD_SIGNING_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_ENDPOINT_URL",
    "R2_SECRET_ACCESS_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_URL",
  ],
  "critical env var list changed — update consumers check",
);

function fullEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    SIGN_PUBLIC_BASE_URL: "https://app.example.com",
    // A production env is only warning-free with a persistent signing cert.
    SIGNING_CERT_P12_BASE64: "aGVsbG8=",
  };
  for (const name of CRITICAL_ENV_VARS) env[name] = `value-of-${name}`;
  return env;
}

// --- all present -----------------------------------------------------------

{
  const result = validateCriticalEnv(fullEnv(), true);
  assert.deepStrictEqual(result.missing, [], "nothing missing when all set (prod)");
  assert.strictEqual(result.fatal, false, "not fatal when all set (prod)");
  assert.deepStrictEqual(result.warnings, [], "no warnings when all set (prod)");
}

{
  const result = validateCriticalEnv(fullEnv(), false);
  assert.deepStrictEqual(result.missing, [], "nothing missing when all set (dev)");
  assert.strictEqual(result.fatal, false, "not fatal when all set (dev)");
}

// --- some missing: production is fatal, dev is not --------------------------

{
  const env = fullEnv();
  delete env.SUPABASE_URL;
  delete env.DOWNLOAD_SIGNING_SECRET;

  const prod = validateCriticalEnv(env, true);
  assert.deepStrictEqual(
    prod.missing,
    ["SUPABASE_URL", "DOWNLOAD_SIGNING_SECRET"],
    "missing names reported in declaration order (prod)",
  );
  assert.strictEqual(prod.fatal, true, "missing critical vars are fatal in prod");

  const dev = validateCriticalEnv(env, false);
  assert.deepStrictEqual(
    dev.missing,
    ["SUPABASE_URL", "DOWNLOAD_SIGNING_SECRET"],
    "missing names reported in declaration order (dev)",
  );
  assert.strictEqual(dev.fatal, false, "missing critical vars only warn in dev");
}

// --- completely empty env (fresh dev checkout) ------------------------------

{
  const dev = validateCriticalEnv({}, false);
  assert.strictEqual(dev.fatal, false, "bare dev boot must not be fatal");
  assert.deepStrictEqual(
    dev.missing,
    [...CRITICAL_ENV_VARS],
    "all critical vars reported missing on empty env",
  );

  const prod = validateCriticalEnv({}, true);
  assert.strictEqual(prod.fatal, true, "empty env is fatal in prod");
}

// --- empty string counts as missing -----------------------------------------
// loadEnv.ts deletes empty-string vars before .env is read, but the consumers
// (e.g. createServerSupabase's `|| ""`) also treat "" as unset, so the
// validator must agree.

{
  const env = fullEnv();
  env.R2_ENDPOINT_URL = "";
  const result = validateCriticalEnv(env, true);
  assert.deepStrictEqual(result.missing, ["R2_ENDPOINT_URL"]);
  assert.strictEqual(result.fatal, true, "empty-string critical var is fatal in prod");
}

// --- SIGN_PUBLIC_BASE_URL: warning only, never fatal -------------------------

{
  const env = fullEnv();
  delete env.SIGN_PUBLIC_BASE_URL;

  for (const isProduction of [true, false]) {
    const result = validateCriticalEnv(env, isProduction);
    assert.strictEqual(
      result.fatal,
      false,
      "missing SIGN_PUBLIC_BASE_URL alone is never fatal",
    );
    assert.deepStrictEqual(result.missing, [], "not in the critical-missing list");
    assert.strictEqual(result.warnings.length, 1, "exactly one warning");
    assert.ok(
      result.warnings[0].includes("SIGN_PUBLIC_BASE_URL"),
      "warning names the variable",
    );
    assert.ok(
      /relative|unreachable/i.test(result.warnings[0]),
      "warning preserves the dead-link intent of the original message",
    );
  }
}

// --- automation vars: optional, warn-only ------------------------------------
// The scheduler is a hard no-op unless AUTOMATION_ENABLED=true, so tuning
// vars set without the master switch are silently ignored — the same class
// of silent misconfiguration as a missing SIGN_PUBLIC_BASE_URL. Warn, never
// refuse to boot.

assert.deepStrictEqual(
  [...AUTOMATION_ENV_VARS].sort(),
  [
    "AUTOMATION_DRAFTS_ONLY",
    "AUTOMATION_ENABLED",
    "AUTOMATION_LLM_CLASSIFY_ENABLED",
    "AUTOMATION_MAX_RETRIES",
    "AUTOMATION_MODEL",
    "AUTOMATION_POLL_INTERVAL_MS",
    "AUTOMATION_RECONCILE_EVERY_N_TICKS",
  ],
  "automation env var list changed — update lib/automation/env.ts readers",
);

{
  // Tuning vars without the master switch → exactly one warning, never fatal.
  const env = fullEnv();
  env.AUTOMATION_MODEL = "claude-opus-4-8";
  env.AUTOMATION_POLL_INTERVAL_MS = "60000";

  for (const isProduction of [true, false]) {
    const result = validateCriticalEnv(env, isProduction);
    assert.strictEqual(result.fatal, false, "automation vars are never fatal");
    assert.deepStrictEqual(result.missing, [], "not in the critical-missing list");
    assert.strictEqual(result.warnings.length, 1, "exactly one warning");
    assert.ok(
      result.warnings[0].includes("AUTOMATION_MODEL") &&
        result.warnings[0].includes("AUTOMATION_POLL_INTERVAL_MS"),
      "warning names the ignored variables",
    );
    assert.ok(
      result.warnings[0].includes("AUTOMATION_ENABLED"),
      "warning points at the master switch",
    );
  }
}

{
  // With the master switch on, the same tuning vars are consumed — no warning.
  const env = fullEnv();
  env.AUTOMATION_ENABLED = "true";
  env.AUTOMATION_MODEL = "claude-opus-4-8";
  const result = validateCriticalEnv(env, true);
  assert.deepStrictEqual(result.warnings, [], "enabled automation warns nothing");
  assert.strictEqual(result.fatal, false);
}

{
  // The master switch alone (either state) warns nothing.
  for (const enabled of ["true", "false"]) {
    const env = fullEnv();
    env.AUTOMATION_ENABLED = enabled;
    const result = validateCriticalEnv(env, true);
    assert.deepStrictEqual(
      result.warnings,
      [],
      `AUTOMATION_ENABLED=${enabled} alone warns nothing`,
    );
  }
}

// --- recordings vars: optional, warn-only ------------------------------------
// The transcription worker is a hard no-op unless ASSEMBLYAI_API_KEY is set, so
// tuning/TTS/image vars set without the key are silently ignored — the same
// class of silent misconfiguration as the automation tuning vars. Warn, never
// refuse to boot.

assert.deepStrictEqual(
  [...RECORDINGS_ENV_VARS].sort(),
  [
    "ASSEMBLYAI_API_KEY",
    "OPENAI_IMAGE_MODEL",
    "OPENAI_TTS_MODEL",
    "OPENAI_TTS_VOICE",
    "RECORDINGS_MAX_RETRIES",
    "RECORDINGS_MODEL",
    "RECORDINGS_POLL_INTERVAL_MS",
    "RECORDINGS_WORKER_ENABLED",
  ],
  "recordings env var list changed — update lib/recordings/env.ts readers",
);

{
  // Tuning vars without the key → exactly one warning, never fatal.
  const env = fullEnv();
  env.RECORDINGS_MODEL = "claude-opus-4-8";
  env.OPENAI_IMAGE_MODEL = "gpt-image-2";

  for (const isProduction of [true, false]) {
    const result = validateCriticalEnv(env, isProduction);
    assert.strictEqual(result.fatal, false, "recordings vars are never fatal");
    assert.deepStrictEqual(result.missing, [], "not in the critical-missing list");
    assert.strictEqual(result.warnings.length, 1, "exactly one warning");
    assert.ok(
      result.warnings[0].includes("RECORDINGS_MODEL") &&
        result.warnings[0].includes("OPENAI_IMAGE_MODEL"),
      "warning names the ignored variables",
    );
    assert.ok(
      result.warnings[0].includes("ASSEMBLYAI_API_KEY"),
      "warning points at the enabling key",
    );
  }
}

{
  // With the key set, the same tuning vars are consumed — no warning.
  const env = fullEnv();
  env.ASSEMBLYAI_API_KEY = "sk-assembly";
  env.RECORDINGS_MODEL = "claude-opus-4-8";
  const result = validateCriticalEnv(env, true);
  assert.deepStrictEqual(result.warnings, [], "keyed recordings warns nothing");
  assert.strictEqual(result.fatal, false);
}

{
  // The enabling key alone warns nothing.
  const env = fullEnv();
  env.ASSEMBLYAI_API_KEY = "sk-assembly";
  const result = validateCriticalEnv(env, true);
  assert.deepStrictEqual(
    result.warnings,
    [],
    "ASSEMBLYAI_API_KEY alone warns nothing",
  );
}

// --- signing certificate: warn-only, never fatal ------------------------------
// Without SIGNING_CERT_P12_BASE64, e-signatures fall back to an ephemeral
// self-signed dev cert whose identity changes on every restart — fine in dev,
// a silent legal-quality regression in production. Warn loudly there; a
// set-but-broken cert is handled separately (and fatally) by
// checkSigningIdentityAtBoot, not here.

{
  // Production without the cert → exactly one warning naming the fix.
  const env = fullEnv();
  delete env.SIGNING_CERT_P12_BASE64;
  const prod = validateCriticalEnv(env, true);
  assert.strictEqual(prod.fatal, false, "missing signing cert is never fatal");
  assert.deepStrictEqual(prod.missing, [], "not in the critical-missing list");
  assert.strictEqual(prod.warnings.length, 1, "exactly one warning (prod)");
  assert.ok(
    prod.warnings[0].includes("SIGNING_CERT_P12_BASE64"),
    "warning names the variable",
  );
  assert.ok(
    /generateSigningCert/.test(prod.warnings[0]),
    "warning points at the generator script",
  );
  assert.ok(
    /ephemeral|restart/i.test(prod.warnings[0]),
    "warning explains the per-restart identity problem",
  );

  // Dev without the cert → no warning (self-signed fallback is the dev norm).
  const dev = validateCriticalEnv(env, false);
  assert.deepStrictEqual(dev.warnings, [], "dev without the cert warns nothing");
}

{
  // Passphrase set without the bundle → orphan-config warning in BOTH modes
  // (same class as automation tuning without the master switch).
  const env = fullEnv();
  delete env.SIGNING_CERT_P12_BASE64;
  env.SIGNING_CERT_PASSPHRASE = "some-pass";

  const dev = validateCriticalEnv(env, false);
  assert.strictEqual(dev.warnings.length, 1, "dev: exactly the orphan warning");
  assert.ok(
    dev.warnings[0].includes("SIGNING_CERT_PASSPHRASE"),
    "orphan warning names the passphrase var",
  );

  const prod = validateCriticalEnv(env, true);
  assert.strictEqual(
    prod.warnings.length,
    2,
    "prod: orphan warning + missing-cert warning",
  );
}

{
  // With the cert set, the passphrase is consumed — no warnings either mode.
  const env = fullEnv();
  env.SIGNING_CERT_PASSPHRASE = "some-pass";
  for (const isProduction of [true, false]) {
    const result = validateCriticalEnv(env, isProduction);
    assert.deepStrictEqual(
      result.warnings,
      [],
      "cert + passphrase together warn nothing",
    );
  }
}

// --- intent-detection vars: optional, warn-only ------------------------------
// The hybrid intent classifier is ON by default and every reader has a safe
// default, so nothing here is ever fatal. The one silent misconfiguration is
// tuning vars set while the classifier itself has been switched off — the
// same class as automation tuning without the master switch.

assert.deepStrictEqual(
  [...INTENT_ENV_VARS].sort(),
  [
    "INTENT_CLASSIFIER_MODEL",
    "INTENT_CLASSIFIER_TIMEOUT_MS",
    "INTENT_LLM_CLASSIFY_ENABLED",
    "INTENT_LLM_MIN_CONFIDENCE",
    "INTENT_LLM_REQUIRE_LEXICAL_AGREEMENT",
    "INTENT_POST_STREAM_GRACE_MS",
  ],
  "intent env var list changed — update lib/intentDetection.ts readers",
);

{
  // Tuning vars with the classifier switched off → exactly one warning.
  const env = fullEnv();
  env.INTENT_LLM_CLASSIFY_ENABLED = "false";
  env.INTENT_CLASSIFIER_MODEL = "claude-opus-5";
  env.INTENT_CLASSIFIER_TIMEOUT_MS = "9000";

  for (const isProduction of [true, false]) {
    const result = validateCriticalEnv(env, isProduction);
    assert.strictEqual(result.fatal, false, "intent vars are never fatal");
    assert.deepStrictEqual(result.missing, [], "not in the critical-missing list");
    assert.strictEqual(result.warnings.length, 1, "exactly one warning");
    assert.ok(
      result.warnings[0].includes("INTENT_CLASSIFIER_MODEL") &&
        result.warnings[0].includes("INTENT_CLASSIFIER_TIMEOUT_MS"),
      "warning names the ignored variables",
    );
    assert.ok(
      result.warnings[0].includes("INTENT_LLM_CLASSIFY_ENABLED"),
      "warning points at the switch that disabled them",
    );
  }
}

{
  // The classifier is on by default, so tuning vars alone warn nothing.
  const env = fullEnv();
  env.INTENT_CLASSIFIER_MODEL = "claude-opus-5";
  const result = validateCriticalEnv(env, true);
  assert.deepStrictEqual(
    result.warnings,
    [],
    "tuning vars with the default-on classifier warn nothing",
  );
  assert.strictEqual(result.fatal, false);
}

{
  // The switch alone (either state) warns nothing.
  for (const enabled of ["true", "false"]) {
    const env = fullEnv();
    env.INTENT_LLM_CLASSIFY_ENABLED = enabled;
    const result = validateCriticalEnv(env, true);
    assert.deepStrictEqual(
      result.warnings,
      [],
      `INTENT_LLM_CLASSIFY_ENABLED=${enabled} alone warns nothing`,
    );
  }
}

console.log("envValidation tests passed");
