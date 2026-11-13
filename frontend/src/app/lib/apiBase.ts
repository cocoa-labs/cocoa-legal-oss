/**
 * Single source of truth for the backend API base URL.
 *
 * Every fetch to the Node backend — main app client, hooks, components, and the
 * public signing page — must import `API_BASE` from here instead of re-deriving
 * `process.env.NEXT_PUBLIC_API_BASE_URL ?? "..."` inline. Centralizing it keeps
 * the dev port in exactly one place and turns a missing env var into a loud
 * console warning instead of a silent fallback to a port nothing is serving.
 *
 * Dev setup: the backend listens on :3004 (`backend/.env` → `PORT=3004`) and the
 * frontend reads `NEXT_PUBLIC_API_BASE_URL=http://localhost:3004` from
 * `frontend/.env.local`. If that env var ever fails to load while the backend's
 * does, every request would otherwise die with an opaque
 * `TypeError: Failed to fetch`. To make that failure mode obvious we (a) warn
 * loudly, naming the missing var and its expected value, and (b) fall back to
 * the real dev port rather than a dead one.
 *
 * `process.env.NEXT_PUBLIC_*` and `process.env.NODE_ENV` are statically inlined
 * by Next.js at build time, so this module is safe in both server and client
 * bundles (including the standalone signing-page bundle) without any runtime
 * `process` dependency.
 */

const ENV_VAR = "NEXT_PUBLIC_API_BASE_URL";

/** The port the dev backend actually serves on — see `backend/.env` PORT. */
const DEV_FALLBACK = "http://localhost:3004";

function resolveApiBase(): string {
    const fromEnv = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (fromEnv && fromEnv.trim()) {
        // Strip trailing slash(es) so callers can join with an absolute backend
        // path (`/single-documents/...`) without doubling the separator.
        return fromEnv.trim().replace(/\/+$/, "");
    }

    // Unset or blank: do NOT fail silently. Surface the misconfiguration in the
    // console (browser devtools client-side, terminal server-side) so the cause
    // of any "Failed to fetch" is named outright, not guessed at.
    const message =
        `${ENV_VAR} is not set — falling back to ${DEV_FALLBACK}. ` +
        `If backend requests fail with "TypeError: Failed to fetch", set ` +
        `${ENV_VAR} in frontend/.env.local (the dev backend runs on ` +
        `${DEV_FALLBACK}; see backend/.env PORT).`;

    if (process.env.NODE_ENV === "production") {
        // A missing base URL in a production build is a real deployment bug.
        console.error(`[apiBase] ${message}`);
    } else {
        console.warn(`[apiBase] ${message}`);
    }

    return DEV_FALLBACK;
}

/**
 * Resolved backend base URL, trailing slash stripped. Import this constant for
 * any request to the Node backend, e.g. ``fetch(`${API_BASE}/single-documents`)``.
 */
export const API_BASE = resolveApiBase();
