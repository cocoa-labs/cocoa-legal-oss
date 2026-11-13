// backend/src/lib/llm/openaiImage.test.ts
//
// generateImage is the recordings timeline-graphic's only door to OpenAI image
// generation. These tests pin the request it sends (URL / method / Bearer auth /
// the { model, prompt, size, n:1 } body, with the default 1536x1024 size and the
// caller's model passed straight through — proving no hardcoded model), that a
// data[0].b64_json payload is base64-decoded to the exact PNG bytes as a Buffer,
// and every defensive path: an absent b64_json throws with detail, a non-2xx
// surfaces the status + the upstream error message VERBATIM (org-verification
// errors must reach the user readable), an empty prompt throws before any
// request, and a missing key throws before any request. Key precedence
// (apiKeys.openai → OPENAI_API_KEY) mirrors llm/openai.ts. fetch is injected; the
// key is never echoed.
import assert from "node:assert/strict";
import { editImage, generateImage, sizeForOrientation } from "./openaiImage";

interface Captured {
    url: string;
    init: RequestInit | undefined;
}

function fakeFetch(
    captured: Captured[],
    body: unknown,
    status = 200,
): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(input), init });
        const payload = typeof body === "string" ? body : JSON.stringify(body);
        return new Response(payload, {
            status,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
}

function neverFetch(): typeof fetch {
    return (async () => {
        throw new Error("fetch must not be called");
    }) as typeof fetch;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

async function main() {
    console.log("llm/openaiImage.test.ts");

    // 1. request shape (default size, model passthrough) + b64 decode --------
    await test(
        "posts to /images/generations with the model, prompt, default size and decodes b64",
        async () => {
            const captured: Captured[] = [];
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
            const b64 = Buffer.from(png).toString("base64");
            const out = await generateImage({
                prompt: "A clean timeline graphic.",
                model: "gpt-image-2",
                apiKeys: { openai: "sk-user-key" },
                fetchImpl: fakeFetch(captured, { data: [{ b64_json: b64 }] }),
            });

            assert.equal(captured.length, 1, "fetch called exactly once");
            const { url, init } = captured[0];
            assert.equal(url, "https://api.openai.com/v1/images/generations");
            assert.equal(init?.method, "POST");
            const headers = init?.headers as Record<string, string>;
            assert.equal(headers.Authorization, "Bearer sk-user-key");
            assert.equal(headers["Content-Type"], "application/json");
            const body = JSON.parse(String(init?.body));
            // The model is whatever the caller passed — never a hardcoded literal.
            assert.equal(body.model, "gpt-image-2");
            assert.equal(body.prompt, "A clean timeline graphic.");
            assert.equal(body.size, "1536x1024"); // default
            assert.equal(body.n, 1);

            assert.ok(Buffer.isBuffer(out));
            assert.deepEqual(Uint8Array.from(out), png);
        },
    );

    // 2. an explicit size + a different model both pass through --------------
    await test("passes an explicit size and an arbitrary model through", async () => {
        const captured: Captured[] = [];
        const b64 = Buffer.from([1, 2, 3]).toString("base64");
        await generateImage({
            prompt: "p",
            model: "some-future-image-model",
            size: "1024x1024",
            apiKeys: { openai: "sk" },
            fetchImpl: fakeFetch(captured, { data: [{ b64_json: b64 }] }),
        });
        const body = JSON.parse(String(captured[0].init?.body));
        assert.equal(body.model, "some-future-image-model");
        assert.equal(body.size, "1024x1024");
    });

    // 3. key precedence: env fallback ----------------------------------------
    await test("falls back to OPENAI_API_KEY when no user key is supplied", async () => {
        const saved = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = "sk-env-key";
        try {
            const captured: Captured[] = [];
            const b64 = Buffer.from([9]).toString("base64");
            await generateImage({
                prompt: "p",
                model: "m",
                apiKeys: {},
                fetchImpl: fakeFetch(captured, { data: [{ b64_json: b64 }] }),
            });
            const headers = captured[0].init?.headers as Record<string, string>;
            assert.equal(headers.Authorization, "Bearer sk-env-key");
        } finally {
            if (saved === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = saved;
        }
    });

    // 4. absent b64_json throws with detail ----------------------------------
    await test("throws when the response has no b64_json", async () => {
        const captured: Captured[] = [];
        await assert.rejects(
            generateImage({
                prompt: "p",
                model: "m",
                apiKeys: { openai: "sk" },
                fetchImpl: fakeFetch(captured, { data: [{ url: "http://x" }] }),
            }),
            /b64_json|no image|image data/i,
        );
    });

    // 5. non-2xx surfaces the upstream error message verbatim ----------------
    await test("throws on a non-2xx with the status and the verbatim upstream message", async () => {
        const captured: Captured[] = [];
        const orgMsg =
            "Your organization must be verified to use the model `gpt-image-2`.";
        await assert.rejects(
            generateImage({
                prompt: "p",
                model: "gpt-image-2",
                apiKeys: { openai: "sk-secret-key" },
                fetchImpl: fakeFetch(
                    captured,
                    { error: { message: orgMsg } },
                    403,
                ),
            }),
            (err: Error) => {
                assert.match(err.message, /403/);
                // Org-verification detail must reach the user readable, verbatim.
                assert.ok(
                    err.message.includes(orgMsg),
                    `expected verbatim org message, got: ${err.message}`,
                );
                assert.doesNotMatch(err.message, /sk-secret-key/);
                return true;
            },
        );
    });

    // 6. empty prompt throws before any request ------------------------------
    await test("throws on an empty prompt without fetching", async () => {
        await assert.rejects(
            generateImage({
                prompt: "   ",
                model: "m",
                apiKeys: { openai: "sk" },
                fetchImpl: neverFetch(),
            }),
            /empty|prompt/i,
        );
    });

    // 7. missing key throws before any request -------------------------------
    await test("throws on a missing key without fetching", async () => {
        const saved = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            await assert.rejects(
                generateImage({
                    prompt: "p",
                    model: "m",
                    apiKeys: {},
                    fetchImpl: neverFetch(),
                }),
                /OpenAI API key/i,
            );
        } finally {
            if (saved === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = saved;
        }
    });

    // 8. quality is sent only when provided ----------------------------------
    await test("includes quality only when provided", async () => {
        const captured: Captured[] = [];
        const b64 = Buffer.from([1]).toString("base64");
        // omitted → no quality key
        await generateImage({
            prompt: "p",
            model: "m",
            apiKeys: { openai: "sk" },
            fetchImpl: fakeFetch(captured, { data: [{ b64_json: b64 }] }),
        });
        assert.equal(
            Object.hasOwn(JSON.parse(String(captured[0].init?.body)), "quality"),
            false,
        );
        // provided → passed through
        await generateImage({
            prompt: "p",
            model: "m",
            quality: "high",
            apiKeys: { openai: "sk" },
            fetchImpl: fakeFetch(captured, { data: [{ b64_json: b64 }] }),
        });
        assert.equal(JSON.parse(String(captured[1].init?.body)).quality, "high");
    });

    // 9. sizeForOrientation maps the three orientations ----------------------
    await test("sizeForOrientation maps orientations (default landscape)", async () => {
        assert.equal(sizeForOrientation("square"), "1024x1024");
        assert.equal(sizeForOrientation("landscape"), "1536x1024");
        assert.equal(sizeForOrientation("portrait"), "1024x1536");
        assert.equal(sizeForOrientation(undefined), "1536x1024");
        assert.equal(sizeForOrientation("bogus"), "1536x1024");
    });

    // 10. editImage posts multipart to /images/edits and decodes b64 ---------
    await test(
        "editImage posts multipart/form-data to /images/edits with the source image",
        async () => {
            const captured: Captured[] = [];
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
            const out = Buffer.from([5, 6, 7]);
            const b64 = out.toString("base64");
            const result = await editImage({
                prompt: "make the sky blue",
                model: "gpt-image-2",
                image: {
                    bytes: Buffer.from(png),
                    mimeType: "image/png",
                    filename: "src.png",
                },
                quality: "high",
                apiKeys: { openai: "sk-user-key" },
                fetchImpl: fakeFetch(captured, { data: [{ b64_json: b64 }] }),
            });

            assert.equal(captured.length, 1);
            const { url, init } = captured[0];
            assert.equal(url, "https://api.openai.com/v1/images/edits");
            assert.equal(init?.method, "POST");
            const headers = init?.headers as Record<string, string>;
            assert.equal(headers.Authorization, "Bearer sk-user-key");
            // Content-Type must NOT be set by us — fetch adds the multipart boundary.
            assert.equal(headers["Content-Type"], undefined);

            const form = init?.body as FormData;
            assert.ok(form instanceof FormData, "body is FormData");
            assert.equal(form.get("prompt"), "make the sky blue");
            assert.equal(form.get("model"), "gpt-image-2");
            assert.equal(form.get("quality"), "high");
            assert.equal(form.get("n"), "1");
            const image = form.get("image");
            assert.ok(image instanceof Blob, "image part is a Blob");
            assert.equal((image as Blob).type, "image/png");

            assert.ok(Buffer.isBuffer(result));
            assert.deepEqual(Uint8Array.from(result), Uint8Array.from(out));
        },
    );

    // 11. editImage guards: empty instruction / empty image / missing key ----
    await test("editImage throws before fetch on empty instruction", async () => {
        await assert.rejects(
            editImage({
                prompt: "  ",
                model: "m",
                image: { bytes: Buffer.from([1]), mimeType: "image/png" },
                apiKeys: { openai: "sk" },
                fetchImpl: neverFetch(),
            }),
            /empty|instruction/i,
        );
    });
    await test("editImage throws before fetch on empty source bytes", async () => {
        await assert.rejects(
            editImage({
                prompt: "edit",
                model: "m",
                image: { bytes: Buffer.alloc(0), mimeType: "image/png" },
                apiKeys: { openai: "sk" },
                fetchImpl: neverFetch(),
            }),
            /source image|bytes/i,
        );
    });

    console.log("llm/openaiImage.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
