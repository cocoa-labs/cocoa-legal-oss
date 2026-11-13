// backend/src/lib/signatures/tokens.ts
//
// Signer access tokens. Each signer in an envelope gets an unguessable token
// that is emailed to them; only its SHA-256 hash is persisted, so a database
// leak never exposes a usable signing link. All comparisons against the stored
// hash go through `safeEqualHex` to avoid timing side-channels.

import { randomBytes, timingSafeEqual } from "node:crypto";

import { sha256Hex } from "./hash";

/** Number of random bytes behind a signer token (256 bits of entropy). */
const TOKEN_BYTES = 32;

/**
 * Mint a fresh signer token.
 *
 * Returns both the clear-text `token` (put this in the signing URL / email) and
 * its `tokenHash` (persist this, never the raw token). The token is URL-safe
 * base64 (base64url) with no padding so it drops cleanly into a query string or
 * path segment.
 */
export function generateSignerToken(): { token: string; tokenHash: string } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = sha256Hex(Buffer.from(token, "utf8"));
    return { token, tokenHash };
}

/** Hash a clear-text token the same way `generateSignerToken` did, for lookup. */
export function hashSignerToken(token: string): string {
    return sha256Hex(Buffer.from(token, "utf8"));
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Guards against unequal lengths (which `timingSafeEqual` would otherwise throw
 * on) by short-circuiting to `false`. The early length check is not itself a
 * meaningful leak here because both operands are fixed-width SHA-256 hex.
 */
export function safeEqualHex(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}
