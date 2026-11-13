import assert from "node:assert/strict";
import { redactTelemetryValue } from "./logger";
import { scrubTelemetryEvent } from "./telemetry";

const canary = "CLIENT-SECRET-CANARY";
const redacted = redactTelemetryValue({
  authorization: "Bearer secret-token",
  cookie: "session=secret",
  prompt: canary,
  body: { document_text: canary },
  email: "client@example.com",
  safe: "contact client@example.com",
});
const serialized = JSON.stringify(redacted);
assert.doesNotMatch(serialized, /secret-token|CLIENT-SECRET-CANARY|client@example\.com/);
assert.match(serialized, /\[redacted\]/);
const sentry = JSON.stringify(scrubTelemetryEvent({
  message: canary,
  user: { email: "client@example.com" },
  request: {
    method: "POST",
    url: "https://beta.test/sign/secret-signer-token?document=private",
    headers: { authorization: "Bearer secret-token" },
    data: { prompt: canary },
  },
  breadcrumbs: [{ message: canary, data: { body: canary } }],
  exception: { values: [{ type: "Error", value: canary }] },
}));
assert.doesNotMatch(sentry, /CLIENT-SECRET-CANARY|secret-signer-token|private|client@example\.com|secret-token/);
assert.match(sentry, /\/sign\/:token/);
console.log("privacy.test.ts: all passed");
