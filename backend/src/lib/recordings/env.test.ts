// backend/src/lib/recordings/env.test.ts
//
// The recordings env readers gate the transcription worker: it runs only when
// ASSEMBLYAI_API_KEY is present and RECORDINGS_WORKER_ENABLED isn't an explicit
// "false", and the poll/retry/model knobs are the safety rails the scheduler
// and pipeline build on. Pure functions over an injected env object, so the
// defaults/overrides/clamps matrix is pinned here without mutating process.env.
import assert from "node:assert/strict";
import {
    assemblyAiApiKey,
    recordingsWorkerEnabled,
    recordingsPollIntervalMs,
    recordingsMaxRetries,
    recordingsModel,
    openaiTtsModel,
    openaiTtsVoice,
    openaiImageModel,
} from "./env";
import { DEFAULT_MAIN_MODEL } from "../llm/models";

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

console.log("recordings/env.test.ts");

test("defaults on an empty env", () => {
    assert.equal(assemblyAiApiKey({}), null, "no key by default");
    assert.equal(recordingsWorkerEnabled({}), false, "worker off without a key");
    assert.equal(recordingsPollIntervalMs({}), 15_000);
    assert.equal(recordingsMaxRetries({}), 3);
    assert.equal(recordingsModel({}), DEFAULT_MAIN_MODEL);
    assert.equal(openaiTtsModel({}), "gpt-4o-mini-tts");
    assert.equal(openaiTtsVoice({}), "alloy");
    assert.equal(openaiImageModel({}), "gpt-image-2");
});

test("assemblyAiApiKey: trims, empty/whitespace → null", () => {
    assert.equal(assemblyAiApiKey({ ASSEMBLYAI_API_KEY: "sk-abc" }), "sk-abc");
    assert.equal(
        assemblyAiApiKey({ ASSEMBLYAI_API_KEY: "  sk-abc  " }),
        "sk-abc",
    );
    assert.equal(assemblyAiApiKey({ ASSEMBLYAI_API_KEY: "" }), null);
    assert.equal(assemblyAiApiKey({ ASSEMBLYAI_API_KEY: "   " }), null);
});

test("recordingsWorkerEnabled: needs a key, default ON, only 'false' disables", () => {
    // No key → always off, even if explicitly enabled.
    assert.equal(
        recordingsWorkerEnabled({ RECORDINGS_WORKER_ENABLED: "true" }),
        false,
        "no key → worker off regardless of the flag",
    );
    // Key present → default ON.
    assert.equal(recordingsWorkerEnabled({ ASSEMBLYAI_API_KEY: "k" }), true);
    // Only a literal "false" disarms it (case-insensitive).
    assert.equal(
        recordingsWorkerEnabled({
            ASSEMBLYAI_API_KEY: "k",
            RECORDINGS_WORKER_ENABLED: "false",
        }),
        false,
    );
    assert.equal(
        recordingsWorkerEnabled({
            ASSEMBLYAI_API_KEY: "k",
            RECORDINGS_WORKER_ENABLED: "FALSE",
        }),
        false,
    );
    // Junk must NOT disable a key-enabled worker.
    assert.equal(
        recordingsWorkerEnabled({
            ASSEMBLYAI_API_KEY: "k",
            RECORDINGS_WORKER_ENABLED: "0",
        }),
        true,
        "junk must not disarm the worker",
    );
    assert.equal(
        recordingsWorkerEnabled({
            ASSEMBLYAI_API_KEY: "k",
            RECORDINGS_WORKER_ENABLED: "off",
        }),
        true,
    );
});

test("recordingsPollIntervalMs: default 15000, override wins, floor 2000, junk → default", () => {
    assert.equal(
        recordingsPollIntervalMs({ RECORDINGS_POLL_INTERVAL_MS: "30000" }),
        30_000,
    );
    assert.equal(
        recordingsPollIntervalMs({ RECORDINGS_POLL_INTERVAL_MS: "abc" }),
        15_000,
        "non-numeric falls back to the default",
    );
    assert.equal(
        recordingsPollIntervalMs({ RECORDINGS_POLL_INTERVAL_MS: "500" }),
        2_000,
        "a too-small interval clamps up to the 2000ms floor, not the default",
    );
    assert.equal(
        recordingsPollIntervalMs({ RECORDINGS_POLL_INTERVAL_MS: "0" }),
        2_000,
    );
    assert.equal(
        recordingsPollIntervalMs({ RECORDINGS_POLL_INTERVAL_MS: "-100" }),
        2_000,
    );
    assert.equal(
        recordingsPollIntervalMs({ RECORDINGS_POLL_INTERVAL_MS: "2000" }),
        2_000,
    );
});

test("recordingsMaxRetries: default 3, zero allowed, negative clamps to 0, junk → default", () => {
    assert.equal(recordingsMaxRetries({ RECORDINGS_MAX_RETRIES: "5" }), 5);
    assert.equal(
        recordingsMaxRetries({ RECORDINGS_MAX_RETRIES: "0" }),
        0,
        "0 = never retry is meaningful",
    );
    assert.equal(
        recordingsMaxRetries({ RECORDINGS_MAX_RETRIES: "-2" }),
        0,
        "negative clamps to 0, never a silent 3",
    );
    assert.equal(recordingsMaxRetries({ RECORDINGS_MAX_RETRIES: "many" }), 3);
});

test("recordingsModel: RECORDINGS_MODEL wins, blank/whitespace → DEFAULT_MAIN_MODEL", () => {
    assert.equal(
        recordingsModel({ RECORDINGS_MODEL: "claude-opus-4-8" }),
        "claude-opus-4-8",
    );
    assert.equal(recordingsModel({ RECORDINGS_MODEL: "" }), DEFAULT_MAIN_MODEL);
    assert.equal(
        recordingsModel({ RECORDINGS_MODEL: "   " }),
        DEFAULT_MAIN_MODEL,
        "whitespace-only is not a model id",
    );
});

test("openai media models: defaults + overrides; image pinned to gpt-image-2", () => {
    assert.equal(openaiTtsModel({ OPENAI_TTS_MODEL: "tts-1-hd" }), "tts-1-hd");
    assert.equal(openaiTtsVoice({ OPENAI_TTS_VOICE: "nova" }), "nova");
    assert.equal(
        openaiImageModel({ OPENAI_IMAGE_MODEL: "dall-e-3" }),
        "dall-e-3",
    );
    // The image default MUST be exactly the user-pinned model.
    assert.equal(openaiImageModel({}), "gpt-image-2");
    assert.equal(openaiTtsModel({}), "gpt-4o-mini-tts");
    assert.equal(openaiTtsVoice({}), "alloy");
});

console.log("recordings/env.test.ts: all passed");
