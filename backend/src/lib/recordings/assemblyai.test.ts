// backend/src/lib/recordings/assemblyai.test.ts
//
// The AssemblyAI client is the recordings pipeline's only door to AssemblyAI,
// so these tests pin the exact request it sends (URL, method, the RAW
// `authorization` key with no Bearer prefix, and the locked speaker_labels:true
// body) and the mapping it applies on the way back — AssemblyAI's "A"/"B"
// speakers → "Speaker A"/"Speaker B", start/end ms → start_ms/end_ms,
// audio_duration seconds → audio_duration_seconds — plus every defensive path:
// a non-2xx surfaces the HTTP status + the body's error field, a missing key
// throws before any request, an unexpected status collapses to "error" (never a
// poll-forever "processing"), and malformed utterances are dropped/coerced
// rather than thrown. fetch is injected, so nothing here touches the network.
import assert from "node:assert/strict";
import { submitTranscription, getTranscription } from "./assemblyai";

interface Captured {
    url: string;
    init: RequestInit | undefined;
}

/**
 * A fake fetch that records the single request it receives and answers with a
 * fixed JSON (or raw-string) body + status, so each test can both assert on the
 * captured request and drive the mapping off a canned response.
 */
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
    console.log("recordings/assemblyai.test.ts");

    // 1. submit: request shape (URL / method / raw auth / body) + parsed result.
    await test(
        "submitTranscription posts to /transcript with the raw key and speaker_labels:true",
        async () => {
            const captured: Captured[] = [];
            const result = await submitTranscription({
                audioUrl: "https://cdn.example.com/audio/a1.webm",
                apiKey: "sk-live-key",
                fetchImpl: fakeFetch(captured, {
                    id: "transcript_123",
                    status: "queued",
                }),
            });

            assert.equal(captured.length, 1, "fetch called exactly once");
            const { url, init } = captured[0];
            assert.equal(url, "https://api.assemblyai.com/v2/transcript");
            assert.equal(init?.method, "POST");
            const headers = init?.headers as Record<string, string>;
            assert.equal(
                headers.authorization,
                "sk-live-key",
                "raw key in the authorization header, no Bearer prefix",
            );
            const sent = JSON.parse(String(init?.body));
            assert.equal(sent.audio_url, "https://cdn.example.com/audio/a1.webm");
            assert.equal(
                sent.speaker_labels,
                true,
                "speaker_labels is always true (locked product decision)",
            );

            assert.deepEqual(result, { id: "transcript_123", status: "queued" });
        },
    );

    // 2. submit non-2xx → throws carrying the HTTP status and the body's error.
    await test(
        "submitTranscription surfaces a non-2xx status + the body's error field",
        async () => {
            const captured: Captured[] = [];
            await assert.rejects(
                submitTranscription({
                    audioUrl: "https://cdn.example.com/audio/a1.webm",
                    apiKey: "sk-bad",
                    fetchImpl: fakeFetch(captured, { error: "bad key" }, 401),
                }),
                (err: Error) => {
                    assert.match(err.message, /401/, "carries the HTTP status");
                    assert.match(
                        err.message,
                        /bad key/,
                        "carries the response body's error",
                    );
                    return true;
                },
            );
        },
    );

    // 3. submit with an empty key throws BEFORE any request is sent.
    await test(
        "submitTranscription throws on an empty apiKey without calling fetch",
        async () => {
            const captured: Captured[] = [];
            await assert.rejects(
                submitTranscription({
                    audioUrl: "https://cdn.example.com/audio/a1.webm",
                    apiKey: "",
                    fetchImpl: fakeFetch(captured, {
                        id: "x",
                        status: "queued",
                    }),
                }),
                /API key is missing/,
            );
            assert.equal(captured.length, 0, "no request went out");
        },
    );

    // 4. get: a completed payload → mapped speakers, ms fields, duration seconds.
    await test(
        "getTranscription maps a completed transcript (speakers, ms, duration)",
        async () => {
            const captured: Captured[] = [];
            const result = await getTranscription({
                transcriptId: "transcript_123",
                apiKey: "sk-live-key",
                fetchImpl: fakeFetch(captured, {
                    id: "transcript_123",
                    status: "completed",
                    text: "Hello there. Hi.",
                    audio_duration: 90,
                    utterances: [
                        {
                            speaker: "A",
                            text: "Hello there.",
                            start: 100,
                            end: 1500,
                        },
                        { speaker: "B", text: "Hi.", start: 1600, end: 2000 },
                    ],
                }),
            });

            assert.equal(captured.length, 1);
            assert.match(
                captured[0].url,
                /\/v2\/transcript\/transcript_123$/,
                "GET url contains the transcript id",
            );
            assert.equal(captured[0].init?.method, "GET");

            assert.equal(result.status, "completed");
            assert.equal(result.text, "Hello there. Hi.");
            assert.equal(result.error, null);
            assert.equal(
                result.audio_duration_seconds,
                90,
                "audio_duration (seconds) maps straight through, no unit change",
            );
            assert.equal(result.utterances.length, 2);
            assert.deepEqual(result.utterances[0], {
                speaker: "Speaker A",
                text: "Hello there.",
                start_ms: 100,
                end_ms: 1500,
            });
            assert.equal(result.utterances[1].speaker, "Speaker B");
            assert.equal(result.utterances[1].start_ms, 1600);
            assert.equal(result.utterances[1].end_ms, 2000);
            assert.equal(
                typeof result.utterances[1].start_ms,
                "number",
                "times are numbers, not strings",
            );
        },
    );

    // 5. get: still processing → status through, text null, utterances [].
    await test(
        "getTranscription maps a processing transcript to null text / empty utterances",
        async () => {
            const captured: Captured[] = [];
            const result = await getTranscription({
                transcriptId: "transcript_123",
                apiKey: "sk-live-key",
                fetchImpl: fakeFetch(captured, {
                    id: "transcript_123",
                    status: "processing",
                }),
            });
            assert.equal(result.status, "processing");
            assert.equal(result.text, null);
            assert.equal(result.error, null);
            assert.equal(result.audio_duration_seconds, null);
            assert.deepEqual(result.utterances, []);
        },
    );

    // 6. get: an errored transcript is mapped through, NOT thrown.
    await test(
        "getTranscription maps an error transcript without throwing",
        async () => {
            const captured: Captured[] = [];
            const result = await getTranscription({
                transcriptId: "transcript_123",
                apiKey: "sk-live-key",
                fetchImpl: fakeFetch(captured, {
                    id: "transcript_123",
                    status: "error",
                    error: "Download of the audio file failed",
                }),
            });
            assert.equal(result.status, "error");
            assert.equal(result.error, "Download of the audio file failed");
            assert.equal(result.text, null);
            assert.deepEqual(result.utterances, []);
        },
    );

    // 7. get: an unknown status collapses to "error" with an explanation.
    await test(
        "getTranscription treats an unknown status as error with an explanatory message",
        async () => {
            const captured: Captured[] = [];
            const result = await getTranscription({
                transcriptId: "transcript_123",
                apiKey: "sk-live-key",
                fetchImpl: fakeFetch(captured, {
                    id: "transcript_123",
                    status: "banana",
                }),
            });
            assert.equal(result.status, "error");
            assert.ok(result.error, "an explanatory error is set");
            assert.match(
                result.error ?? "",
                /banana/,
                "the error names the offending status",
            );
        },
    );

    // 8. get: malformed utterances are dropped (no text) / coerced (bad speaker).
    await test(
        "getTranscription drops and coerces malformed utterances without throwing",
        async () => {
            const captured: Captured[] = [];
            const result = await getTranscription({
                transcriptId: "transcript_123",
                apiKey: "sk-live-key",
                fetchImpl: fakeFetch(captured, {
                    id: "transcript_123",
                    status: "completed",
                    utterances: [
                        // speaker field absent → coerced to "Speaker ?"
                        { text: "no speaker field", start: 0, end: 10 },
                        // non-string speaker → coerced to "Speaker ?"
                        {
                            speaker: 5,
                            text: "numeric speaker",
                            start: 10,
                            end: 20,
                        },
                        // missing text → dropped (carries no content)
                        { speaker: "C", start: 20, end: 30 },
                        "not an object", // dropped
                        null, // dropped
                        { speaker: "D", text: "kept", start: 30, end: 40 },
                    ],
                }),
            });

            assert.equal(
                result.utterances.length,
                3,
                "the three malformed entries are dropped, three survive",
            );
            assert.deepEqual(result.utterances[0], {
                speaker: "Speaker ?",
                text: "no speaker field",
                start_ms: 0,
                end_ms: 10,
            });
            assert.equal(result.utterances[1].speaker, "Speaker ?");
            assert.equal(result.utterances[1].text, "numeric speaker");
            assert.deepEqual(result.utterances[2], {
                speaker: "Speaker D",
                text: "kept",
                start_ms: 30,
                end_ms: 40,
            });
        },
    );

    console.log("recordings/assemblyai.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
