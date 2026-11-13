import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.cwd(), process.argv[2] ?? ".");
const targetName = path.relative(repositoryRoot, target) || ".";
const exceptionPath = path.join(repositoryRoot, "security", "advisory-exceptions.json");
const exceptionFile = JSON.parse(fs.readFileSync(exceptionPath, "utf8"));
const exceptions = Array.isArray(exceptionFile.moderate) ? exceptionFile.moderate : [];
const now = Date.now();

for (const exception of exceptions) {
  if (
    !exception ||
    typeof exception.package !== "string" ||
    typeof exception.reason !== "string" ||
    !exception.reason.trim() ||
    typeof exception.expires_at !== "string" ||
    !Number.isFinite(Date.parse(exception.expires_at))
  ) {
    throw new Error("Every moderate advisory exception needs package, reason, and a valid expires_at timestamp.");
  }
  if (Date.parse(exception.expires_at) <= now) {
    throw new Error(`Moderate advisory exception for ${exception.package} expired at ${exception.expires_at}.`);
  }
}

const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], {
  cwd: target,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});
if (!audit.stdout.trim()) {
  throw new Error(`npm audit did not return JSON for ${targetName}: ${audit.stderr.trim() || "unknown error"}`);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  throw new Error(`npm audit returned malformed JSON for ${targetName}.`);
}
if (report.error) {
  throw new Error(`npm audit failed for ${targetName}: ${report.error.summary ?? report.error.code ?? "unknown error"}`);
}

const vulnerabilities = Object.entries(report.vulnerabilities ?? {}).map(
  ([packageName, details]) => ({ packageName, severity: details.severity }),
);
const blocking = vulnerabilities.filter(({ severity }) =>
  severity === "high" || severity === "critical",
);
if (blocking.length) {
  throw new Error(
    `High/critical production advisories in ${targetName}: ${blocking.map((item) => `${item.packageName} (${item.severity})`).join(", ")}`,
  );
}

const unexceptedModerate = vulnerabilities.filter(({ packageName, severity }) => {
  if (severity !== "moderate") return false;
  return !exceptions.some(
    (exception) =>
      exception.package === packageName &&
      (!exception.directory || exception.directory === targetName),
  );
});
if (unexceptedModerate.length) {
  throw new Error(
    `Moderate production advisories need an unexpired documented exception in ${targetName}: ${unexceptedModerate.map((item) => item.packageName).join(", ")}`,
  );
}

console.log(
  `${targetName}: production audit passed (${blocking.length} high/critical, ${unexceptedModerate.length} unexcepted moderate).`,
);
