import assert from "node:assert/strict";
import {
  assertBetaDataPolicy,
  assertBetaRecipientsAllowed,
  BetaPolicyError,
  projectBetaPolicyView,
  signaturesNonbindingFor,
} from "./betaPolicy";

function dbFor(policy: Record<string, unknown> | null) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) chain[method] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: policy, error: null });
  return { from: () => chain } as never;
}

async function main() {
 const before = process.env.BETA_MODE;
 process.env.BETA_MODE = "true";
 try {
  const policy = { data_policy_accepted_at: "2026-08-06T00:00:00Z", allowed_recipient_emails: ["exact@example.com"], allowed_recipient_domains: ["pilot.test"] };
  await assertBetaDataPolicy(dbFor(policy), { userId: "u1", orgId: "org-1" });
  await assertBetaRecipientsAllowed(dbFor(policy), { userId: "u1", orgId: "org-1", recipients: ["exact@example.com", "person@pilot.test"] });
  await assert.rejects(
    () => assertBetaRecipientsAllowed(dbFor(policy), { userId: "u1", orgId: "org-1", recipients: ["client@outside.test"] }),
    (error: unknown) => error instanceof BetaPolicyError && error.code === "BETA_RECIPIENT_NOT_ALLOWED",
  );
  await assert.rejects(
    () => assertBetaDataPolicy(dbFor(null), { userId: "u1", orgId: "org-1" }),
    (error: unknown) => error instanceof BetaPolicyError && error.code === "BETA_DATA_POLICY_REQUIRED",
  );
 } finally {
   if (before === undefined) delete process.env.BETA_MODE;
   else process.env.BETA_MODE = before;
 }
 // Signature wording follows beta mode: neutral when off, the org row's flag when on,
 // and nonbinding when the policy can't be read.
 const savedMode = process.env.BETA_MODE;
 try {
   delete process.env.BETA_MODE;
   assert.equal(await signaturesNonbindingFor(dbFor(null), { userId: "u1", orgId: "org-1" }), false);
   process.env.BETA_MODE = "true";
   assert.equal(await signaturesNonbindingFor(dbFor({ signatures_nonbinding: true }), { userId: "u1", orgId: "org-1" }), true);
   assert.equal(await signaturesNonbindingFor(dbFor({ signatures_nonbinding: false }), { userId: "u1", orgId: "org-1" }), false);
   const failing = { from: () => { throw new Error("db down"); } } as never;
   assert.equal(await signaturesNonbindingFor(failing, { userId: "u1", orgId: "org-1" }), true);
 } finally {
   if (savedMode === undefined) delete process.env.BETA_MODE;
   else process.env.BETA_MODE = savedMode;
 }
 // The matter page's view follows beta mode: disabled outside it (no panel, no
 // upload gate, neutral signature wording), the organization's row inside it.
 const row = {
   data_policy_accepted_at: null,
   allowed_recipient_emails: ["exact@example.com"],
   allowed_recipient_domains: ["pilot.test"],
   signatures_nonbinding: true,
 };
 assert.deepEqual(projectBetaPolicyView(row, false), {
   enabled: false,
   accepted: true,
   data_policy_accepted_at: null,
   allowed_recipient_emails: [],
   allowed_recipient_domains: [],
   signatures_nonbinding: false,
 });
 assert.deepEqual(projectBetaPolicyView(row, true), {
   enabled: true,
   accepted: false,
   data_policy_accepted_at: null,
   allowed_recipient_emails: ["exact@example.com"],
   allowed_recipient_domains: ["pilot.test"],
   signatures_nonbinding: true,
 });
 assert.equal(projectBetaPolicyView(null, true).signatures_nonbinding, true);
 assert.equal(projectBetaPolicyView(null, true).accepted, false);
 assert.equal(
   projectBetaPolicyView({ ...row, data_policy_accepted_at: "2026-08-06T00:00:00Z", signatures_nonbinding: false }, true).accepted,
   true,
 );
 console.log("betaPolicy.test.ts: all passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
