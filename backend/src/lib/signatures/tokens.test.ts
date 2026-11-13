// backend/src/lib/signatures/tokens.test.ts
import assert from "node:assert/strict";

import { generateSignerToken, hashSignerToken, safeEqualHex } from "./tokens";

async function testTokenRoundTrip() {
    const { token, tokenHash } = generateSignerToken();
    // Hashing the clear-text token reproduces the stored hash exactly.
    assert.equal(hashSignerToken(token), tokenHash);
    // Hash is lowercase 64-char hex.
    assert.match(tokenHash, /^[0-9a-f]{64}$/);
    // Token is url-safe base64 (no +, /, or = padding).
    assert.match(token, /^[A-Za-z0-9_-]+$/);
}

async function testTokensAreUnique() {
    const a = generateSignerToken();
    const b = generateSignerToken();
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.tokenHash, b.tokenHash);
}

async function testSafeEqualHexMatches() {
    const { token, tokenHash } = generateSignerToken();
    assert.equal(safeEqualHex(hashSignerToken(token), tokenHash), true);
    assert.equal(safeEqualHex(tokenHash, tokenHash), true);
}

async function testSafeEqualHexRejects() {
    const a = hashSignerToken("alpha");
    const b = hashSignerToken("beta");
    // Different equal-length hashes → false.
    assert.equal(safeEqualHex(a, b), false);
    // Unequal lengths must not throw and must be false.
    assert.equal(safeEqualHex(a, a + "00"), false);
    assert.equal(safeEqualHex("", a), false);
    assert.equal(safeEqualHex(a, ""), false);
}

async function main() {
    await testTokenRoundTrip();
    await testTokensAreUnique();
    await testSafeEqualHexMatches();
    await testSafeEqualHexRejects();
    console.log("tokens.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
