// backend/src/lib/storage.test.ts
//
// downloadFile's byte handling, exercised hermetically — no network, no R2.
//
// The R2 client is built lazily inside the module-private getClient(), so there
// is no injection point to reach for. The seam that DOES exist is the AWS SDK
// itself: every command goes through `send()`, inherited from @smithy's Client
// prototype. Stubbing `S3Client.prototype.send` for the duration of a test lets
// the real downloadFile run end-to-end — retry wrapper, Body handling, error
// path — while nothing ever leaves the process. Fake R2 env vars are set BEFORE
// the module is imported (storageEnabled is computed at import time), hence the
// dynamic import inside main().
import assert from "node:assert/strict";

import { S3Client } from "@aws-sdk/client-s3";

type StorageModule = typeof import("./storage");

let storage: StorageModule;

/**
 * Build a Uint8Array that is a window into a larger buffer at a NON-ZERO
 * offset, exactly as Node's 8 KB allocation pool produces for small reads.
 * The surrounding bytes are filled with a recognisable non-payload value so a
 * regression returning the whole underlying buffer is unmistakable.
 */
function pooledView(payload: Buffer): Uint8Array {
    const POOL_BYTES = 8192;
    const OFFSET = 896;
    const pool = new ArrayBuffer(POOL_BYTES);
    new Uint8Array(pool).fill(0x41); // "AAAA…" — never part of a payload here
    const view = new Uint8Array(pool, OFFSET, payload.byteLength);
    view.set(payload);
    return view;
}

/** Run `fn` with S3Client.send replaced by `stub`, restoring it afterwards. */
async function withSendStub<T>(
    stub: (command: unknown) => Promise<unknown>,
    fn: () => Promise<T>,
): Promise<T> {
    const prototype = S3Client.prototype as unknown as Record<string, unknown>;
    const hadOwn = Object.prototype.hasOwnProperty.call(prototype, "send");
    const original = prototype.send;
    prototype.send = stub;
    try {
        return await fn();
    } finally {
        if (hadOwn) prototype.send = original;
        else delete prototype.send;
    }
}

/** A GetObject response whose Body yields `bytes`. */
function bodyOf(bytes: Uint8Array): unknown {
    return { Body: { transformToByteArray: async () => bytes } };
}

// ---------------------------------------------------------------------------
// The regression: a small object must come back as ITS OWN bytes
// ---------------------------------------------------------------------------

async function testSmallPooledPayloadRoundTripsExactly(): Promise<void> {
    const payload = Buffer.from("%PDF-1.7 original-for-hashing\n%%EOF\n", "utf8");
    const view = pooledView(payload);

    // Sanity: the fixture really is a pooled view, or the test proves nothing.
    assert.equal(view.byteOffset, 896);
    assert.equal(view.buffer.byteLength, 8192);

    const result = await withSendStub(
        async () => bodyOf(view),
        () => storage.downloadFile("signatures/u/e/original.pdf"),
    );

    assert.ok(result, "expected bytes, got null");
    // Pre-fix this was 8192 (the whole pool).
    assert.equal(
        result.byteLength,
        payload.byteLength,
        "downloadFile returned the underlying pool, not the object's own bytes",
    );
    // Pre-fix this content was the pool's filler, i.e. entirely wrong.
    assert.deepEqual(
        Buffer.from(result),
        payload,
        "downloadFile returned corrupted content",
    );
}

/**
 * The same defect, reached the way production reaches it: a genuinely
 * pool-allocated Buffer. Several small allocations first, so the pool offset
 * has advanced past zero by the time the payload is allocated.
 */
async function testRealPoolAllocatedBufferRoundTripsExactly(): Promise<void> {
    for (let i = 0; i < 4; i += 1) Buffer.from(`pool-advance-${i}`, "utf8");
    const payload = Buffer.from("executed.pdf bytes — small enough to pool", "utf8");
    const bytes = new Uint8Array(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
    );

    const result = await withSendStub(
        async () => bodyOf(bytes),
        () => storage.downloadFile("documents/u/d/source.docx"),
    );

    assert.ok(result);
    assert.equal(result.byteLength, payload.byteLength);
    assert.deepEqual(Buffer.from(result), payload);
}

/**
 * A hash computed over the download must match one computed over the source.
 * This is the property the e-signature integrity record depends on.
 */
async function testDownloadHashesToTheSourceDigest(): Promise<void> {
    const { createHash } = await import("node:crypto");
    const payload = Buffer.from("signed document bytes", "utf8");
    const expected = createHash("sha256").update(payload).digest("hex");

    const result = await withSendStub(
        async () => bodyOf(pooledView(payload)),
        () => storage.downloadFile("signatures/u/e/original.pdf"),
    );

    assert.ok(result);
    assert.equal(
        createHash("sha256").update(Buffer.from(result)).digest("hex"),
        expected,
        "recorded hash does not describe the document that was downloaded",
    );
}

/** A standalone (non-pooled, offset 0) buffer must be unaffected. */
async function testStandaloneBufferIsUnchanged(): Promise<void> {
    const payload = Buffer.alloc(64 * 1024, 0x7a); // > pool size ⇒ its own buffer
    const bytes = new Uint8Array(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength,
    );
    assert.equal(bytes.byteOffset, 0);

    const result = await withSendStub(
        async () => bodyOf(bytes),
        () => storage.downloadFile("documents/u/d/big.pdf"),
    );

    assert.ok(result);
    assert.equal(result.byteLength, payload.byteLength);
    assert.deepEqual(Buffer.from(result), payload);
}

/** An empty object still round-trips as zero bytes, not as the pool. */
async function testEmptyPayloadRoundTrips(): Promise<void> {
    const view = new Uint8Array(new ArrayBuffer(8192), 512, 0);

    const result = await withSendStub(
        async () => bodyOf(view),
        () => storage.downloadFile("documents/u/d/empty.bin"),
    );

    assert.ok(result);
    assert.equal(result.byteLength, 0);
}

/** The returned buffer is a copy — mutating the source must not affect it. */
async function testResultIsDetachedFromTheSourceBuffer(): Promise<void> {
    const payload = Buffer.from("stable content", "utf8");
    const view = pooledView(payload);

    const result = await withSendStub(
        async () => bodyOf(view),
        () => storage.downloadFile("documents/u/d/source.bin"),
    );

    assert.ok(result);
    new Uint8Array(view.buffer).fill(0x00); // clobber the pool afterwards
    assert.deepEqual(Buffer.from(result), payload);
}

// ---------------------------------------------------------------------------
// Contracts the fix must not have disturbed
// ---------------------------------------------------------------------------

/** No Body on the response ⇒ null, not a throw. */
async function testMissingBodyReturnsNull(): Promise<void> {
    const result = await withSendStub(
        async () => ({}),
        () => storage.downloadFile("documents/u/d/missing.bin"),
    );
    assert.equal(result, null);
}

/** A non-transient failure ⇒ null (absent-object contract), logged, no throw. */
async function testNonTransientErrorReturnsNull(): Promise<void> {
    let calls = 0;
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args);
    };
    try {
        const result = await withSendStub(
            async () => {
                calls += 1;
                const error = new Error("NoSuchKey: the key does not exist");
                (error as { $metadata?: unknown }).$metadata = {
                    httpStatusCode: 404,
                };
                throw error;
            },
            () => storage.downloadFile("documents/u/d/gone.bin"),
        );
        assert.equal(result, null);
        assert.equal(calls, 1, "a 404 must not be retried");
    } finally {
        console.error = originalError;
    }
    assert.equal(errors.length, 1, "the failure must not be swallowed silently");
    assert.equal(errors[0][0], "[storage] downloadFile failed");
}

/**
 * A transient failure is still retried, and the retried read still gets the
 * slice treatment — the body read lives inside the retry wrapper.
 */
async function testTransientErrorRetriesThenReturnsCorrectBytes(): Promise<void> {
    const payload = Buffer.from("recovered after a reset", "utf8");
    let calls = 0;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args);
    };
    let result: ArrayBuffer | null;
    try {
        result = await withSendStub(
            async () => {
                calls += 1;
                if (calls === 1) throw new Error("ECONNRESET while reading body");
                return bodyOf(pooledView(payload));
            },
            () => storage.downloadFile("documents/u/d/flaky.bin"),
        );
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(calls, 2, "a transient error must be retried");
    assert.ok(result);
    assert.equal(result.byteLength, payload.byteLength);
    assert.deepEqual(Buffer.from(result), payload);
    assert.equal(warnings.length, 1);
}

// ---------------------------------------------------------------------------

// Docker Compose runs RustFS at http://rustfs:9000 for the backend, but browsers
// open presigned URLs from the host. R2_PUBLIC_ENDPOINT_URL lets presigned GETs
// carry a host the browser can reach; everything else keeps R2_ENDPOINT_URL.
async function testPresignEndpointPrefersThePublicEndpoint(): Promise<void> {
    assert.equal(
        storage.presignEndpoint({ R2_ENDPOINT_URL: "http://rustfs:9000" }),
        "http://rustfs:9000",
    );
    assert.equal(
        storage.presignEndpoint({
            R2_ENDPOINT_URL: "http://rustfs:9000",
            R2_PUBLIC_ENDPOINT_URL: " http://localhost:9000 ",
        }),
        "http://localhost:9000",
    );
    assert.equal(
        storage.presignEndpoint({ R2_ENDPOINT_URL: "http://rustfs:9000", R2_PUBLIC_ENDPOINT_URL: "  " }),
        "http://rustfs:9000",
        "whitespace-only public endpoint counts as unset",
    );
}

async function testPresignedUrlUsesThePublicHost(): Promise<void> {
    process.env.R2_PUBLIC_ENDPOINT_URL = "http://localhost:9000";
    try {
        const url = await storage.getSignedUrl("documents/example.pdf", 60, "example.pdf");
        assert.ok(url, "presigning works offline with fake credentials");
        assert.equal(new URL(url!).host, "localhost:9000", "browser-facing host, not the internal one");
    } finally {
        delete process.env.R2_PUBLIC_ENDPOINT_URL;
    }
}

async function main(): Promise<void> {
    // Set before importing: storageEnabled and BUCKET are read at module load.
    // The endpoint is never contacted — send() is stubbed in every test.
    process.env.R2_ENDPOINT_URL = "https://storage-test.invalid";
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.R2_BUCKET_NAME = "coco-legal-test";
    storage = await import("./storage");
    assert.equal(
        storage.storageEnabled,
        true,
        "fake R2 env must be in place before storage.ts is imported",
    );

    await testSmallPooledPayloadRoundTripsExactly();
    await testRealPoolAllocatedBufferRoundTripsExactly();
    await testDownloadHashesToTheSourceDigest();
    await testStandaloneBufferIsUnchanged();
    await testEmptyPayloadRoundTrips();
    await testResultIsDetachedFromTheSourceBuffer();
    await testMissingBodyReturnsNull();
    await testNonTransientErrorReturnsNull();
    await testTransientErrorRetriesThenReturnsCorrectBytes();

    await testPresignEndpointPrefersThePublicEndpoint();
    await testPresignedUrlUsesThePublicHost();
    console.log("storage.test.ts: all passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
