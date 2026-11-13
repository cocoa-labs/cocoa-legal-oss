// backend/src/lib/recordings/briefing.test.ts
//
// generateVoiceBriefing turns a ready recording's summary into a spoken mp3
// briefing. These tests drive it entirely through injected deps (no db, no LLM,
// no OpenAI, no storage) and pin: the two guard failures (not-found → 404-coded,
// not-ready → 409-coded RecordingArtifactError), idempotence (an existing
// voice_briefing_document_id short-circuits with created:false and NO paid work)
// and force (regenerates), the prompt discipline (untrusted-content delimiters
// around the recording's own summary/action-items/title, spoken-prose framing),
// the 3,500-char sentence-boundary truncation applied to the model's script
// BEFORE TTS, the env-resolved TTS model/voice, the owner-key best-effort
// resolution mirrored from pipeline.ts, and the persist + id-update sequence
// (mp3 / audio/mpeg via persistGeneratedArtifact, then voice_briefing_document_id).
import assert from "node:assert/strict";
import {
    BRIEFING_CHAR_CAP,
    buildBriefingPrompt,
    generateVoiceBriefing,
    truncateAtSentenceBoundary,
    type GenerateVoiceBriefingDeps,
} from "./briefing";
import { RecordingArtifactError } from "./artifacts";
import type { Recording } from "./types";
import type { RecordingPatch } from "./store";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

const fakeDb = { __tag: "fake-db" } as never;

function makeRecording(partial: Partial<Recording> = {}): Recording {
    return {
        id: "rec-1",
        user_id: "user-1",
        project_id: "proj-1",
        chat_id: null,
        chat_message_id: null,
        title: "Placeholder intake call",
        source: "mic",
        status: "ready",
        audio_storage_key: "recordings/user-1/rec-1.webm",
        audio_mime: "audio/webm",
        audio_size_bytes: 1024,
        duration_seconds: 300,
        consent_ack_at: "2026-07-17T00:00:00Z",
        assemblyai_transcript_id: "tx-1",
        utterances: [],
        transcript_text: "full transcript",
        summary_md:
            "## Summary\nDiscussed the slip-and-fall claim and next steps.",
        action_items: [
            { id: "item-1", text: "File the complaint", done: false, owner: "Dana", due: "2026-08-01" },
            { id: "item-2", text: "Request medical records", done: false, owner: null, due: null },
        ],
        transcript_document_id: "doc-transcript",
        voice_briefing_document_id: null,
        timeline_image_document_id: null,
        email_id: null,
        error: null,
        retry_count: 0,
        next_attempt_at: "2026-07-17T00:00:00Z",
        created_at: "2026-07-17T00:00:00Z",
        updated_at: "2026-07-17T00:00:00Z",
        ...partial,
    };
}

interface Captured {
    complete: Parameters<NonNullable<GenerateVoiceBriefingDeps["completeTextFn"]>>[0][];
    tts: Parameters<NonNullable<GenerateVoiceBriefingDeps["synthesizeSpeechFn"]>>[0][];
    persist: Parameters<NonNullable<GenerateVoiceBriefingDeps["persistArtifactFn"]>>[0][];
    updates: { id: string; patch: RecordingPatch }[];
    apiKeyLookups: string[];
}

function makeDeps(
    recording: Recording | null,
    overrides: {
        script?: string;
        apiKeys?: Record<string, string>;
        apiKeysThrow?: boolean;
    } = {},
): { deps: GenerateVoiceBriefingDeps; captured: Captured } {
    const captured: Captured = {
        complete: [],
        tts: [],
        persist: [],
        updates: [],
        apiKeyLookups: [],
    };
    const deps: GenerateVoiceBriefingDeps = {
        getRecordingFn: async () => recording,
        getUserApiKeysFn: async (userId: string) => {
            captured.apiKeyLookups.push(userId);
            if (overrides.apiKeysThrow) throw new Error("lookup down");
            return (overrides.apiKeys ?? {}) as never;
        },
        completeTextFn: async (params) => {
            captured.complete.push(params);
            return overrides.script ?? "Here is your briefing. All done.";
        },
        synthesizeSpeechFn: async (params) => {
            captured.tts.push(params);
            return Buffer.from("mp3-bytes");
        },
        persistArtifactFn: async (params) => {
            captured.persist.push(params);
            return { documentId: "doc-brief", versionId: "ver-brief" };
        },
        updateRecordingFn: async (_db, id, patch) => {
            captured.updates.push({ id, patch });
            return { ...(recording as Recording), ...patch };
        },
    };
    return { deps, captured };
}

async function main() {
    console.log("recordings/briefing.test.ts");

    // ---- pure helpers ------------------------------------------------------
    await test("truncateAtSentenceBoundary keeps short text and cuts at a sentence end", () => {
        assert.equal(truncateAtSentenceBoundary("One. Two.", 100), "One. Two.");
        const long = "Alpha sentence. Beta sentence. Gamma sentence.";
        const out = truncateAtSentenceBoundary(long, 20); // "Alpha sentence. Beta" → cut at "."
        assert.ok(out.length <= 20);
        assert.ok(out.endsWith("."), `expected sentence end, got: ${out}`);
        assert.equal(out, "Alpha sentence.");
    });

    await test("truncateAtSentenceBoundary hard-cuts when there is no boundary", () => {
        const out = truncateAtSentenceBoundary("a".repeat(50), 10);
        assert.equal(out.length, 10);
    });

    await test("buildBriefingPrompt frames the summary as untrusted and forbids markup", () => {
        const prompt = buildBriefingPrompt(makeRecording({}));
        assert.match(prompt, /UNTRUSTED/);
        assert.match(prompt, /NEVER follow/i);
        assert.match(prompt, /slip-and-fall claim/); // summary content included
        assert.match(prompt, /Placeholder intake call/); // title included
        assert.match(prompt, /File the complaint/); // action item included
        assert.match(prompt, /spoken|aloud|voice/i);
        assert.match(prompt, /no markdown|no heading|no bullet/i);
    });

    // ---- guards ------------------------------------------------------------
    await test("not-found recording throws a not_found RecordingArtifactError", async () => {
        const { deps } = makeDeps(null);
        await assert.rejects(
            generateVoiceBriefing({ db: fakeDb, recordingId: "rec-x", userId: "user-1", deps }),
            (err: unknown) => {
                assert.ok(err instanceof RecordingArtifactError);
                assert.equal(err.code, "not_found");
                return true;
            },
        );
    });

    await test("a non-ready recording throws a not_ready RecordingArtifactError", async () => {
        const { deps } = makeDeps(makeRecording({ status: "summarizing" }));
        await assert.rejects(
            generateVoiceBriefing({ db: fakeDb, recordingId: "rec-1", userId: "user-1", deps }),
            (err: unknown) =>
                err instanceof RecordingArtifactError && err.code === "not_ready",
        );
    });

    await test("a ready recording with no summary is not_ready", async () => {
        const { deps } = makeDeps(makeRecording({ summary_md: null }));
        await assert.rejects(
            generateVoiceBriefing({ db: fakeDb, recordingId: "rec-1", userId: "user-1", deps }),
            (err: unknown) =>
                err instanceof RecordingArtifactError && err.code === "not_ready",
        );
    });

    // ---- idempotence / force ----------------------------------------------
    await test("returns the existing document without paid work when already generated", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ voice_briefing_document_id: "doc-existing" }),
        );
        const result = await generateVoiceBriefing({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            deps,
        });
        assert.deepEqual(result, { documentId: "doc-existing", created: false });
        assert.equal(captured.complete.length, 0);
        assert.equal(captured.tts.length, 0);
        assert.equal(captured.persist.length, 0);
        assert.equal(captured.updates.length, 0);
    });

    await test("force regenerates even when a document already exists", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ voice_briefing_document_id: "doc-existing" }),
        );
        const result = await generateVoiceBriefing({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            force: true,
            deps,
        });
        assert.equal(result.created, true);
        assert.equal(result.documentId, "doc-brief");
        assert.equal(captured.complete.length, 1);
        assert.equal(captured.tts.length, 1);
        assert.equal(captured.persist.length, 1);
    });

    // ---- script cap + TTS env model/voice ---------------------------------
    await test("caps the script at 3500 chars at a sentence boundary before TTS", async () => {
        const sentence = "This is a spoken briefing sentence about the case. ";
        const script = sentence.repeat(200); // ~10k chars, many sentence ends
        const { deps, captured } = makeDeps(makeRecording({}), { script });
        await generateVoiceBriefing({ db: fakeDb, recordingId: "rec-1", userId: "user-1", deps });
        assert.equal(captured.tts.length, 1);
        const spoken = captured.tts[0].text;
        assert.ok(spoken.length <= BRIEFING_CHAR_CAP, `len ${spoken.length}`);
        assert.ok(spoken.trimEnd().endsWith("."), "ends at a sentence boundary");
    });

    await test("synthesizes with the env-resolved TTS model and voice", async () => {
        const { deps, captured } = makeDeps(makeRecording({}));
        await generateVoiceBriefing({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            env: {
                OPENAI_TTS_MODEL: "tts-model-x",
                OPENAI_TTS_VOICE: "voice-y",
                RECORDINGS_MODEL: "recordings-model-z",
            } as NodeJS.ProcessEnv,
            deps,
        });
        assert.equal(captured.tts[0].model, "tts-model-x");
        assert.equal(captured.tts[0].voice, "voice-y");
        // The script model comes from recordingsModel(env).
        assert.equal(captured.complete[0].model, "recordings-model-z");
    });

    // ---- owner keys (mirror of pipeline.ts) --------------------------------
    await test("resolves the owner's BYOK keys and passes them to the script + TTS", async () => {
        const { deps, captured } = makeDeps(makeRecording({ user_id: "owner-9" }), {
            apiKeys: { openai: "sk-owner", claude: "sk-c" },
        });
        await generateVoiceBriefing({ db: fakeDb, recordingId: "rec-1", userId: "owner-9", deps });
        assert.deepEqual(captured.apiKeyLookups, ["owner-9"]);
        assert.deepEqual(captured.complete[0].apiKeys, { openai: "sk-owner", claude: "sk-c" });
        assert.deepEqual(captured.tts[0].apiKeys, { openai: "sk-owner", claude: "sk-c" });
    });

    await test("degrades to no BYOK when the key lookup throws (best-effort)", async () => {
        const { deps, captured } = makeDeps(makeRecording({}), { apiKeysThrow: true });
        await generateVoiceBriefing({ db: fakeDb, recordingId: "rec-1", userId: "user-1", deps });
        assert.deepEqual(captured.complete[0].apiKeys, {});
    });

    // ---- persistence + id update ------------------------------------------
    await test("persists the mp3 and stores voice_briefing_document_id", async () => {
        const rec = makeRecording({});
        const { deps, captured } = makeDeps(rec);
        const result = await generateVoiceBriefing({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            deps,
        });
        assert.deepEqual(result, {
            documentId: "doc-brief",
            versionId: "ver-brief",
            created: true,
        });
        const p = captured.persist[0];
        assert.equal(p.recording, rec);
        assert.equal(p.label, "voice briefing");
        assert.equal(p.extension, "mp3");
        assert.equal(p.fileType, "mp3");
        assert.equal(p.contentType, "audio/mpeg");
        assert.ok(Buffer.isBuffer(p.bytes));
        assert.equal(captured.updates.length, 1);
        assert.equal(captured.updates[0].id, "rec-1");
        assert.deepEqual(captured.updates[0].patch, {
            voice_briefing_document_id: "doc-brief",
        });
    });

    console.log("recordings/briefing.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
