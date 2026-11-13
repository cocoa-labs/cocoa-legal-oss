type Level = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY =
  /(authorization|cookie|token|secret|password|body|content|prompt|document_text|email_html|email_body|signature_png|provider_payload|arguments|filename|url|path|query)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /bearer\s+[a-z0-9._~+/=-]+/gi;
const BASIC_AUTH = /basic\s+[a-z0-9+/=]+/gi;
const JWT = /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi;
const PROVIDER_KEY = /\b(?:sk|rk|key)-[a-z0-9_-]{12,}\b/gi;
const URL = /https?:\/\/[^\s"'<>]+/gi;
const LOG_FIELD_ALLOWLIST = new Set([
  "action",
  "actorRole",
  "attachmentId",
  "attempt",
  "capability",
  "code",
  "count",
  "documentId",
  "durationMs",
  "emailId",
  "envelopeId",
  "error",
  "event",
  "eventType",
  "expectedVersionId",
  "jobId",
  "matterId",
  "membershipAllowed",
  "method",
  "operationId",
  "outcome",
  "permission",
  "projectId",
  "provider",
  "requestId",
  "retryable",
  "role",
  "route",
  "scannerAvailable",
  "status",
  "taskId",
  "toolName",
  "userId",
  "versionId",
  "worker",
]);

function cleanString(value: string): string {
  return value
    .replace(BEARER, "Bearer [redacted]")
    .replace(BASIC_AUTH, "Basic [redacted]")
    .replace(JWT, "[redacted-token]")
    .replace(PROVIDER_KEY, "[redacted-key]")
    .replace(URL, "[redacted-url]")
    .replace(EMAIL, "[redacted-email]")
    .slice(0, 2_000);
}

function cleanValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "string") return cleanString(value);
  if (value instanceof Error) {
    return {
      name: cleanString(value.name),
      message: cleanString(value.message),
      ...(process.env.NODE_ENV === "production"
        ? {}
        : { stack: cleanString(value.stack ?? "") }),
    };
  }
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => cleanValue(item, key, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      result[childKey] = cleanValue(child, childKey, depth + 1);
    }
    return result;
  }
  return cleanString(String(value));
}

function cleanLogValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) return cleanValue(value, "error", depth);
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => cleanLogValue(item, key, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(childKey)) {
        result[childKey] = "[redacted]";
      } else if (LOG_FIELD_ALLOWLIST.has(childKey)) {
        result[childKey] = cleanLogValue(child, childKey, depth + 1);
      }
    }
    return result;
  }
  return cleanValue(value, key, depth);
}

const originals = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function emit(level: Level, args: unknown[]): void {
  const first = args[0];
  const message = typeof first === "string" ? cleanString(first) : "application event";
  const context = args.length > 1 ? cleanLogValue(args.slice(1)) : typeof first === "object" ? cleanLogValue(first) : undefined;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: "coco-legal-backend",
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.DEPLOYMENT_ID ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "local",
    message,
    ...(context === undefined ? {} : { context }),
  };
  originals[level === "debug" ? "info" : level](JSON.stringify(record));
}

export const logger = {
  debug: (message: string, context?: unknown) => emit("debug", [message, context]),
  info: (message: string, context?: unknown) => emit("info", [message, context]),
  warn: (message: string, context?: unknown) => emit("warn", [message, context]),
  error: (message: string, context?: unknown) => emit("error", [message, context]),
};

export function installStructuredConsole(): void {
  console.log = (...args: unknown[]) => emit("info", args);
  console.info = (...args: unknown[]) => emit("info", args);
  console.warn = (...args: unknown[]) => emit("warn", args);
  console.error = (...args: unknown[]) => emit("error", args);
}

export function redactTelemetryValue(value: unknown): unknown {
  return cleanValue(value);
}
