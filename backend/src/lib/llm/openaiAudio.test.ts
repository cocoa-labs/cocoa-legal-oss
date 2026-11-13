// backend/src/lib/llm/openaiAudio.test.ts
//
// synthesizeSpeech is the recordings voice-briefing's only door to OpenAI TTS.
// These tests pin the exact request it sends (URL / method / Bearer auth / the
// { model, voice, input, response_format:"mp3" } body), that it returns the raw
// mp3 bytes as a Buffer, and every defensive path the brief specifies: an
// empty/whitespace input throws before any request, an over-4096-char input
// throws before any request, a missing key throws before any request, and a
// non-2xx surfaces the HTTP status + a truncated body detail. The key precedence
// (apiKeys.openai user key → OPENAI_API_KEY env) mirrors llm/openai.ts exactly.
// fetch is injected so nothing here touches the network, and the key is never
// echoed into a thrown message.
import assert from "node:assert/strict";
import { synthesizeSpeech } from "./openaiAudio";

interface Captured {
    url: string;
    init: RequestInit | undefined;
}

/** A fake fetch that records its single request and answers with fixed bytes. */
function fakeFetch(
    captured: Captured[],
    body: BodyInit,
    status = 200,
): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(input), init });
        return new Response(body, { status });
    }) as typeof fetch;
}

/** A fetch that fails the test if it is ever called (asserts no request). */
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
    console.log("llm/openaiAudio.test.ts");

    // 1. request shape + bytes returned --------------------------------------
    await test(
        "posts to /audio/speech with Bearer auth and the mp3 body, returns the bytes",
        async () => {
            const captured: Captured[] = [];
            const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x99]);
            const out = await synthesizeSpeech({
                text: "Read this briefing aloud.",
                model: "gpt-4o-mini-tts",
                voice: "alloy",
                apiKeys: { openai: "sk-user-key" },
                fetchImpl: fakeFetch(captured, mp3),
            });

            assert.equal(captured.length, 1, "fetch called exactly once");
            const { url, init } = captured[0];
            assert.equal(url, "https://api.openai.com/v1/audio/speech");
            assert.equal(init?.method, "POST");
            const headers = init?.headers as Record<string, string>;
            assert.equal(headers.Authorization, "Bearer sk-user-key");
            assert.equal(headers["Content-Type"], "application/json");
            const body = JSON.parse(String(init?.body));
            assert.equal(body.model, "gpt-4o-mini-tts");
            assert.equal(body.voice, "alloy");
            assert.equal(body.input, "Read this briefing aloud.");
            assert.equal(body.response_format, "mp3");

            // Returns exactly the response bytes as a Buffer.
            assert.ok(Buffer.isBuffer(out));
            assert.deepEqual(Uint8Array.from(out), mp3);
        },
    );

    // 2. key precedence: env fallback when no user key -----------------------
    await test(
        "falls back to OPENAI_API_KEY when no user key is supplied",
        async () => {
            const saved = process.env.OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = "sk-env-key";
            try {
                const captured: Captured[] = [];
                await synthesizeSpeech({
                    text: "hi",
                    model: "m",
                    voice: "v",
                    apiKeys: {},
                    fetchImpl: fakeFetch(captured, new Uint8Array([1])),
                });
                const headers = captured[0].init?.headers as Record<
                    string,
                    string
                >;
                assert.equal(headers.Authorization, "Bearer sk-env-key");
            } finally {
                if (saved === undefined) delete process.env.OPENAI_API_KEY;
                else process.env.OPENAI_API_KEY = saved;
            }
        },
    );

    // 3. empty / whitespace text throws before any request -------------------
    await test("throws on empty/whitespace text without fetching", async () => {
        await assert.rejects(
            synthesizeSpeech({
                text: "   \n\t ",
                model: "m",
                voice: "v",
                apiKeys: { openai: "sk" },
                fetchImpl: neverFetch(),
            }),
            /empty|no text|text/i,
        );
    });

    // 4. over-4096-char text throws before any request -----------------------
    await test("throws when text exceeds 4096 chars without fetching", async () => {
        await assert.rejects(
            synthesizeSpeech({
                text: "a".repeat(4097),
                model: "m",
                voice: "v",
                apiKeys: { openai: "sk" },
                fetchImpl: neverFetch(),
            }),
            /4096/,
        );
    });

    // 5. missing key throws before any request -------------------------------
    await test("throws on a missing key without fetching", async () => {
        const saved = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            await assert.rejects(
                synthesizeSpeech({
                    text: "hi",
                    model: "m",
                    voice: "v",
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

    // 6. non-2xx surfaces the status + a body detail -------------------------
    await test("throws on a non-2xx with the status and body detail", async () => {
        const captured: Captured[] = [];
        await assert.rejects(
            synthesizeSpeech({
                text: "hi",
                model: "m",
                voice: "v",
                apiKeys: { openai: "sk-secret-key" },
                fetchImpl: fakeFetch(
                    captured,
                    JSON.stringify({
                        error: { message: "voice 'v' not found" },
                    }),
                    400,
                ),
            }),
            (err: Error) => {
                assert.match(err.message, /400/);
                assert.match(err.message, /voice 'v' not found/);
                // The key must never be echoed into an error message.
                assert.doesNotMatch(err.message, /sk-secret-key/);
                return true;
            },
        );
    });

    console.log("llm/openaiAudio.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
