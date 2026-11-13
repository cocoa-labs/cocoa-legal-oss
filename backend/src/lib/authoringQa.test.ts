import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDefinedTermsAndCrossRefs, runAuthoringQa } from "./authoringQa";

test("a dangling cross-reference is advisory, never blocking", () => {
  // Assembled .docx files use Word AUTO-numbering — the clause numbers live in
  // numbering.xml, not the extracted run text — so the deterministic scanner
  // cannot verify a cross-reference resolves. It must surface a "could not
  // auto-verify" advisory rather than a false blocking that stops valid drafts.
  const text = "1. Term. The lease runs five years.\n2. Rent. As stated in Section 7.";
  const findings = scanDefinedTermsAndCrossRefs(text);
  const dangling = findings.find((f) => f.message.includes("Section 7"));
  assert.ok(dangling, "should flag Section 7");
  assert.equal(dangling!.severity, "advisory");
  // The deterministic scanner must NEVER emit blocking.
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 0);
});

test("runAuthoringQa does NOT block purely from a cross-reference", async () => {
  // A cross-ref alone (the deterministic scanner's only cross-ref output is
  // advisory) must not push status to "blocked" — blocking is reserved for the
  // LLM playbook/deal-breaker guardrail.
  const res = await runAuthoringQa({
    text: "2. Rent. See Section 9.", // cross-ref → advisory only
    docType: "commercial_lease", variables: {}, playbookEntries: {},
    runCheck: async () => [], runResearch: async () => [],
  });
  assert.notEqual(res.status, "blocked");
  assert.equal(res.findings.filter((f) => f.severity === "blocking").length, 0);
});

test("flags an undefined capitalized defined term as advisory (>= 2 uses)", () => {
  // "Property" is used like a defined term (twice) but never defined → advisory.
  const text =
    'The "Premises" are leased. The Property is described in Exhibit A; the Property is in Texas.';
  const findings = scanDefinedTermsAndCrossRefs(text);
  assert.ok(
    findings.some((f) => f.message.includes("Property") && f.severity === "advisory"),
  );
});

test("does NOT flag a multi-word defined term used in prose", () => {
  // "Base Rent" is defined, then used as "the Base Rent". The usage capture is
  // multi-word, so it matches the full term (not just "Base") and finds it in
  // the defined set — no false "used like a defined term but never defined".
  const text =
    '"Base Rent" means the monthly rent. Tenant shall pay the Base Rent on the first; the Base Rent is fixed.';
  const findings = scanDefinedTermsAndCrossRefs(text);
  assert.ok(
    !findings.some((f) => f.message.includes("Base Rent")),
    'defined multi-word term "Base Rent" should not be flagged',
  );
  assert.ok(
    !findings.some((f) => f.message.includes('"Base"')),
    'the partial word "Base" should not be flagged either',
  );
});

test("does NOT flag a single-mention capitalized proper noun", () => {
  // Appears only once → below the >= 2 threshold → dropped as proper-noun noise.
  const text = 'The "Premises" are leased. The Property is described in Exhibit A.';
  const findings = scanDefinedTermsAndCrossRefs(text);
  assert.ok(
    !findings.some((f) => f.message.includes("Property")),
    "single-mention Property should not be flagged",
  );
});

test("scanner emits no blocking findings on a doc with cross-refs", () => {
  const text = '1. Term.\n2. Rent. See Section 1. The "Lease" means this agreement; this Lease is binding.';
  const findings = scanDefinedTermsAndCrossRefs(text);
  assert.equal(findings.filter((f) => f.severity === "blocking").length, 0);
});

test("recognizes the bare (\"X\") parenthetical define form (no false-positive party advisories)", () => {
  const text = 'This Lease is between Acme Holdings LLC ("Landlord") and Beta Retail Inc. ("Tenant").\n1. Use. The Landlord shall deliver the premises; the Tenant shall pay rent.';
  const findings = scanDefinedTermsAndCrossRefs(text);
  assert.ok(!findings.some((f) => f.message.includes("Landlord")), "Landlord defined via (\"Landlord\") should not be flagged");
  assert.ok(!findings.some((f) => f.message.includes("Tenant")), "Tenant defined via (\"Tenant\") should not be flagged");
});

test("runAuthoringQa aggregates to blocked only from an LLM blocking finding", async () => {
  // Blocking now comes ONLY from the LLM playbook/deal-breaker guardrail, not
  // from the deterministic cross-ref scanner.
  const res = await runAuthoringQa({
    text: "1. Term.\n2. Rent.",
    docType: "commercial_lease", variables: {}, playbookEntries: {},
    runCheck: async () => [
      { guardrail: "playbook", severity: "blocking", message: "violates a deal-breaker" },
    ],
    runResearch: async () => [],
  });
  assert.equal(res.status, "blocked");
  assert.ok(res.findings.some((f) => f.severity === "blocking"));
});

test("runAuthoringQa is advisory when only advisories exist", async () => {
  const res = await runAuthoringQa({
    text: "1. Term.\n2. Rent. See Section 1.",
    docType: "commercial_lease", variables: {}, playbookEntries: {},
    runCheck: async () => [{ guardrail: "playbook", severity: "advisory", message: "off-market rent escalator" }],
    runResearch: async () => [],
  });
  assert.equal(res.status, "advisory");
});

test("runAuthoringQa passes clean docs with no cross-refs", async () => {
  // No cross-reference and no recurring undefined term → deterministic scanner
  // yields nothing → status "passed".
  const res = await runAuthoringQa({
    text: '1. Term.\n2. Rent. The "Lease" means this agreement; this Lease is binding.',
    docType: "commercial_lease", variables: {}, playbookEntries: {},
    runCheck: async () => [], runResearch: async () => [],
  });
  assert.equal(res.status, "passed");
});
