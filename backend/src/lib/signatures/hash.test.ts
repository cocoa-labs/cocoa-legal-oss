// backend/src/lib/signatures/hash.test.ts
import assert from "node:assert/strict";

import { sha256Hex } from "./hash";

// Known NIST vector: SHA-256 of the empty input.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
// SHA-256("abc").
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

async function testEmptyVector() {
    assert.equal(sha256Hex(Buffer.alloc(0)), EMPTY_SHA256);
    assert.equal(sha256Hex(Buffer.from("", "utf8")), EMPTY_SHA256);
}

async function testKnownString() {
    assert.equal(sha256Hex(Buffer.from("abc", "utf8")), ABC_SHA256);
}

async function testAcceptsUint8ArrayAndArrayBuffer() {
    const u8 = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
    assert.equal(sha256Hex(u8), ABC_SHA256);

    const ab = u8.buffer.slice(0); // a clean ArrayBuffer holding "abc"
    assert.equal(sha256Hex(ab), ABC_SHA256);
}

async function testDeterministicAndLowerHex() {
    const a = sha256Hex(Buffer.from("cocoa-legal"));
    const b = sha256Hex(Buffer.from("cocoa-legal"));
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
}

async function main() {
    await testEmptyVector();
    await testKnownString();
    await testAcceptsUint8ArrayAndArrayBuffer();
    await testDeterministicAndLowerHex();
    console.log("hash.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
