import * as Sentry from "@sentry/node";

let initialized = false;

export function scrubTelemetryEvent<T extends Record<string, unknown>>(event: T): T {
  const next: Record<string, unknown> = { ...event };
  delete next.user;
  delete next.extra;
  delete next.contexts;
  delete next.breadcrumbs;
  delete next.message;
  delete next.modules;
  delete next.spans;
  delete next.fingerprint;
  const request = next.request as { method?: unknown; url?: unknown } | undefined;
  if (request) {
    let route: string | undefined;
    try {
      route = new URL(String(request.url ?? ""), "https://redacted.invalid")
        .pathname.replace(/^\/sign\/[^/]+/, "/sign/:token");
    } catch {
      route = undefined;
    }
    next.request = {
      method: typeof request.method === "string" ? request.method : undefined,
      url: route,
    };
  }
  const exception = next.exception as
    | { values?: Array<Record<string, unknown>> }
    | undefined;
  if (Array.isArray(exception?.values)) {
    next.exception = {
      values: exception.values.map((value) => ({
        type: value.type,
        mechanism: value.mechanism,
        stacktrace: value.stacktrace,
      })),
    };
  }
  if (next.tags && typeof next.tags === "object") {
    const allowed = new Set(["requestId", "method", "kind", "operationId", "code"]);
    next.tags = Object.fromEntries(
      Object.entries(next.tags as Record<string, unknown>)
        .filter(([key]) => allowed.has(key))
        .map(([key, value]) => [key, String(value).slice(0, 200)]),
    );
  }
  return next as T;
}

export function initTelemetry(): void {
  if (initialized || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      process.env.DEPLOYMENT_ID ??
      process.env.RAILWAY_GIT_COMMIT_SHA ??
      undefined,
    sendDefaultPii: false,
    attachStacktrace: true,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
    beforeSend(event) {
      return scrubTelemetryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event;
    },
  });
  initialized = true;
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  const allowedTags = new Set(["requestId", "method", "kind", "operationId", "code"]);
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (
        allowedTags.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      )
        scope.setTag(key, String(value).slice(0, 200));
    }
    Sentry.captureException(error);
  });
}

export { Sentry };
