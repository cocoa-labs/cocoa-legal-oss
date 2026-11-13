export function scrubSentryEvent<T extends object>(event: T): T {
    const next = { ...event } as Record<string, unknown>;
    delete next.user;
    delete next.extra;
    delete next.modules;
    delete next.message;
    const request = next.request as
        | { url?: string; method?: string; headers?: unknown; data?: unknown; cookies?: unknown }
        | undefined;
    if (request) {
        let safeUrl: string | undefined;
        try {
            const parsed = new URL(request.url ?? "", "https://redacted.invalid");
            safeUrl = parsed.pathname.replace(/^\/sign\/[^/]+/, "/sign/:token");
        } catch {
            safeUrl = undefined;
        }
        next.request = { method: request.method, url: safeUrl };
    }
    if (Array.isArray(next.breadcrumbs)) {
        next.breadcrumbs = next.breadcrumbs.slice(-30).map((breadcrumb) => {
            if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
            const row = breadcrumb as Record<string, unknown>;
            return {
                type: row.type,
                category: row.category,
                level: row.level,
                timestamp: row.timestamp,
            };
        });
    }
    const exception = next.exception as
        | { values?: Record<string, unknown>[] }
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
    return next as T;
}
