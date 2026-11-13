/**
 * Guarded controlled-beta load rehearsal.
 *
 * Requires 50 staging auth tokens and matching accessible project IDs. It
 * keeps 15 users reading concurrently, opens 10 chat streams, and performs
 * three concurrent synthetic uploads. It refuses production-looking hosts and
 * never invents credentials or documents.
 */
import fs from "node:fs";
import { performance } from "node:perf_hooks";

if (process.env.BETA_LOAD_TEST_CONFIRM !== "synthetic-staging")
  throw new Error("Set BETA_LOAD_TEST_CONFIRM=synthetic-staging to run this guarded rehearsal.");

const baseUrl = (process.env.BETA_LOAD_BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl || !/(staging|localhost|127\.0\.0\.1)/i.test(baseUrl))
  throw new Error("BETA_LOAD_BASE_URL must identify an isolated staging or local stack.");

function jsonArray(name: string): string[] {
  const value = JSON.parse(process.env[name] ?? "[]") as unknown;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))
    throw new Error(`${name} must be a JSON string array.`);
  return value;
}

const tokens = jsonArray("BETA_LOAD_AUTH_TOKENS");
const projects = jsonArray("BETA_LOAD_PROJECT_IDS");
if (tokens.length < 50 || projects.length < 50)
  throw new Error("Provide at least 50 staging tokens and 50 matching project IDs.");
const fixturePath = process.env.BETA_LOAD_SYNTHETIC_FIXTURE;
if (!fixturePath || !fs.existsSync(fixturePath))
  throw new Error("BETA_LOAD_SYNTHETIC_FIXTURE must point to a synthetic/redacted document.");

const durationMs = Math.max(10_000, Number(process.env.BETA_LOAD_DURATION_MS ?? 60_000));
const latencies: number[] = [];
let requests = 0;
let failures = 0;
let ordinaryRequests = 0;
let ordinaryFailures = 0;

async function timedFetch(
  index: number,
  path: string,
  init?: RequestInit,
  includeInOrdinarySlo = false,
) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tokens[index]}`,
        ...(init?.headers ?? {}),
      },
    });
    requests += 1;
    if (!response.ok) failures += 1;
    if (includeInOrdinarySlo) {
      ordinaryRequests += 1;
      if (!response.ok) ordinaryFailures += 1;
    }
    return response;
  } catch (error) {
    requests += 1;
    failures += 1;
    if (includeInOrdinarySlo) {
      ordinaryRequests += 1;
      ordinaryFailures += 1;
    }
    throw error;
  } finally {
    if (includeInOrdinarySlo) latencies.push(performance.now() - started);
  }
}

async function readUser(index: number) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await timedFetch(index, `/projects/${projects[index]}`, undefined, true);
    await timedFetch(index, `/projects/${projects[index]}/action-state`, undefined, true);
  }
}

async function chatUser(index: number) {
  const response = await timedFetch(index, `/projects/${projects[index]}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Controlled beta load canary: reply with OK only." }],
      client_time_zone: "America/Chicago",
    }),
  });
  await response.body?.pipeTo(new WritableStream({ write() {} }));
}

async function uploadUser(index: number) {
  const form = new FormData();
  form.set("file", new Blob([fs.readFileSync(fixturePath!)]), "synthetic-beta-fixture.docx");
  const response = await timedFetch(index, `/projects/${projects[index]}/documents`, {
    method: "POST",
    body: form,
  });
  await response.arrayBuffer();
}

async function main() {
  await Promise.all([
    ...Array.from({ length: 15 }, (_, index) => readUser(index)),
    ...Array.from({ length: 10 }, (_, index) => chatUser(index)),
    ...Array.from({ length: 3 }, (_, index) => uploadUser(index)),
  ]);
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const failureRate = ordinaryRequests ? ordinaryFailures / ordinaryRequests : 1;
  console.info("Controlled beta load rehearsal completed", {
    requests,
    failures,
    ordinaryRequests,
    ordinaryFailures,
    failureRate,
    p95Ms: Math.round(p95),
  });
  if (failureRate >= 0.01)
    throw new Error(`Non-provider failure rate ${(failureRate * 100).toFixed(2)}% exceeded 1%.`);
  if (p95 >= 750)
    throw new Error(`Ordinary read p95 ${Math.round(p95)}ms exceeded 750ms.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
