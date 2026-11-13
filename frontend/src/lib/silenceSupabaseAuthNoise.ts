// Supabase's auth client (@supabase/auth-js) runs a background token refresh
// (autoRefreshToken) on a timer and on tab-focus. When that request momentarily
// fails at the network layer — e.g. right after the laptop wakes, or a dev-server
// HMR reconnect — it throws a `TypeError: Failed to fetch`, which auth-js wraps in
// an `AuthRetryableFetchError`, RETRIES, and recovers from (the session survives,
// so the app keeps working). auth-js still `console.error`s the transient, and
// Next.js 16's dev overlay promotes ANY console.error — including from a
// dependency — into a blocking "Console TypeError: Failed to fetch" Issue.
//
// We can't change auth-js (hardcoded console.error, no logger hook for it) or the
// Next overlay, so we drop ONLY that specific benign, auth-originated fetch noise
// at our boundary and pass every other error through untouched. Real app fetch
// failures (e.g. the backend API being down) do NOT match — they carry neither the
// AuthRetryableFetchError name nor an @supabase/auth-js stack — so they still log.

/**
 * True only for the benign, self-healing Supabase auth token-refresh fetch
 * failure. Matches either auth-js's own retryable classification (by error name)
 * or a "Failed to fetch" whose stack originates in @supabase/auth-js. Pure, so it
 * can be unit-tested without a browser.
 */
export function isBenignSupabaseAuthFetchError(args: readonly unknown[]): boolean {
    return args.some((arg) => {
        if (!arg || typeof arg !== "object") return false;
        const err = arg as { name?: unknown; message?: unknown; stack?: unknown };
        const name = typeof err.name === "string" ? err.name : "";
        const message = typeof err.message === "string" ? err.message : "";
        const stack = typeof err.stack === "string" ? err.stack : "";

        const isFetchFailure =
            name === "AuthRetryableFetchError" || /failed to fetch/i.test(message);
        const fromSupabaseAuth =
            name === "AuthRetryableFetchError" ||
            stack.includes("@supabase/auth-js");

        return isFetchFailure && fromSupabaseAuth;
    });
}

let installed = false;

/**
 * Idempotently wrap console.error (browser only) to drop the benign Supabase auth
 * refresh transient. Installed as the outermost wrapper (it runs at app module
 * load, after Next's dev runtime has hooked console.error), so matched lines are
 * dropped before Next records them as an Issue; everything else is forwarded.
 */
export function installSupabaseAuthErrorFilter(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;

    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        if (isBenignSupabaseAuthFetchError(args)) return;
        original(...args);
    };
}
