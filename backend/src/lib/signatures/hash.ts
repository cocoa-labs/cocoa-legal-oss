// backend/src/lib/signatures/hash.ts
//
// Tiny SHA-256 helper used across the signature pipeline. Kept dependency-free
// (node:crypto only) so it can be unit-tested without any DB or network.

import { createHash } from "node:crypto";

/**
 * Compute the lowercase hex SHA-256 digest of the given bytes.
 *
 * Accepts a Node Buffer, a Uint8Array, or a raw ArrayBuffer so callers can pass
 * whatever they already have (file bytes from storage, a freshly generated PDF,
 * a token string buffer, etc.) without converting first.
 */
export function sha256Hex(data: Buffer | Uint8Array | ArrayBuffer): string {
    const bytes: Buffer =
        data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data);
    return createHash("sha256").update(bytes).digest("hex");
}
