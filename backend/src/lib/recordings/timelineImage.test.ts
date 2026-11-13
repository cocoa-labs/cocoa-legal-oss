// backend/src/lib/recordings/timelineImage.test.ts
//
// generateTimelineImage renders a ready recording's summary into a timeline PNG.
// Same guard/idempotence/persist skeleton as briefing.ts, so these tests focus
// on the differences: buildTimelinePrompt (pure) must frame a professional
// horizontal timeline graphic, embed the recording's OWN summary/action-items/
// title as exact source facts inside untrusted delimiters (gpt-image-2 renders
// the label strings verbatim, so they must be given exactly), and stay under the
// ~4,000-char cap; the image model must come from openaiImageModel(env) — proven
// by (a) the env.ts default flowing through as "gpt-image-2" and (b) an injected
// OPENAI_IMAGE_MODEL overriding it — so no model literal lives in this file; and
// the persist writes a PNG (image/png) and stores timeline_image_document_id.
// Everything is injected — no db, no OpenAI, no storage.
import assert from "node:assert/strict";
import {
    TIMELINE_PROMPT_CAP,
    buildTimelinePrompt,
    generateTimelineImage,
    type GenerateTimelineImageDeps,
} from "./timelineImage";
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
        title: "Acme merger timeline sync",
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
            "## Summary\nSigning targeted for 2026-09-01; regulatory filing due 2026-08-15.",
        action_items: [
            { id: "item-1", text: "File HSR notification", done: false, owner: "Dana", due: "2026-08-15" },
            { id: "item-2", text: "Board approval meeting", done: false, owner: null, due: "2026-08-20" },
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
    image: Parameters<NonNullable<GenerateTimelineImageDeps["generateImageFn"]>>[0][];
    persist: Parameters<NonNullable<GenerateTimelineImageDeps["persistArtifactFn"]>>[0][];
    updates: { id: string; patch: RecordingPatch }[];
}

function makeDeps(
    recording: Recording | null,
): { deps: GenerateTimelineImageDeps; captured: Captured } {
    const captured: Captured = { image: [], persist: [], updates: [] };
    const deps: GenerateTimelineImageDeps = {
        getRecordingFn: async () => recording,
        getUserApiKeysFn: async () => ({}) as never,
        generateImageFn: async (params) => {
            captured.image.push(params);
            return Buffer.from("png-bytes");
        },
        persistArtifactFn: async (params) => {
            captured.persist.push(params);
            return { documentId: "doc-timeline", versionId: "ver-timeline" };
        },
        updateRecordingFn: async (_db, id, patch) => {
            captured.updates.push({ id, patch });
            return { ...(recording as Recording), ...patch };
        },
    };
    return { deps, captured };
}

async function main() {
    console.log("recordings/timelineImage.test.ts");

    // ---- buildTimelinePrompt (pure) ---------------------------------------
    await test("frames a professional horizontal timeline with exact source labels", () => {
        const prompt = buildTimelinePrompt(makeRecording({}));
        assert.match(prompt, /timeline/i);
        assert.match(prompt, /horizontal|chronological/i);
        assert.match(prompt, /legible|spelled exactly|verbatim|exactly as/i);
        // Untrusted framing around the recording's own facts.
        assert.match(prompt, /UNTRUSTED/);
        assert.match(prompt, /NEVER follow/i);
        // Exact label strings the model must render.
        assert.match(prompt, /Acme merger timeline sync/); // title
        assert.match(prompt, /2026-08-15/); // date from summary + action item
        assert.match(prompt, /File HSR notification/); // action item label
    });

    await test("adopts the brand palette (cream/ink/amber, serif) for cohesion with branded emails", () => {
        const prompt = buildTimelinePrompt(makeRecording({}));
        assert.match(prompt, /#f6f1ea/i, "cream background token present");
        assert.match(prompt, /#b45309/i, "amber accent token present");
        assert.match(prompt, /serif/i, "serif headings called out");
        // The palette instruction must live OUTSIDE the untrusted source facts.
        const beforeFacts = prompt.split("--- SOURCE FACTS")[0];
        assert.match(
            beforeFacts,
            /#f6f1ea/i,
            "palette is part of the trusted instruction block, not the facts",
        );
    });

    await test("caps the prompt near 4000 chars for a huge summary", () => {
        const prompt = buildTimelinePrompt(
            makeRecording({ summary_md: "x".repeat(12000) }),
        );
        assert.ok(
            prompt.length <= TIMELINE_PROMPT_CAP,
            `prompt length ${prompt.length} exceeds cap ${TIMELINE_PROMPT_CAP}`,
        );
    });

    // ---- guards ------------------------------------------------------------
    await test("not-found recording throws a not_found RecordingArtifactError", async () => {
        const { deps } = makeDeps(null);
        await assert.rejects(
            generateTimelineImage({ db: fakeDb, recordingId: "rec-x", userId: "user-1", deps }),
            (err: unknown) =>
                err instanceof RecordingArtifactError && err.code === "not_found",
        );
    });

    await test("a non-ready recording throws a not_ready RecordingArtifactError", async () => {
        const { deps } = makeDeps(makeRecording({ status: "queued" }));
        await assert.rejects(
            generateTimelineImage({ db: fakeDb, recordingId: "rec-1", userId: "user-1", deps }),
            (err: unknown) =>
                err instanceof RecordingArtifactError && err.code === "not_ready",
        );
    });

    // ---- model resolution proves no hardcoded literal ----------------------
    await test("uses the env.ts default gpt-image-2 when OPENAI_IMAGE_MODEL is unset", async () => {
        const { deps, captured } = makeDeps(makeRecording({}));
        await generateTimelineImage({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            env: {} as NodeJS.ProcessEnv, // no OPENAI_IMAGE_MODEL
            deps,
        });
        assert.equal(captured.image[0].model, "gpt-image-2");
        assert.equal(captured.image[0].size, "1536x1024");
    });

    await test("an injected OPENAI_IMAGE_MODEL overrides the model (env reader, not a literal)", async () => {
        const { deps, captured } = makeDeps(makeRecording({}));
        await generateTimelineImage({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            env: { OPENAI_IMAGE_MODEL: "gpt-image-next" } as NodeJS.ProcessEnv,
            deps,
        });
        assert.equal(captured.image[0].model, "gpt-image-next");
    });

    // ---- idempotence / force ----------------------------------------------
    await test("returns the existing document without generating when already present", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ timeline_image_document_id: "doc-existing" }),
        );
        const result = await generateTimelineImage({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            deps,
        });
        assert.deepEqual(result, { documentId: "doc-existing", created: false });
        assert.equal(captured.image.length, 0);
        assert.equal(captured.persist.length, 0);
        assert.equal(captured.updates.length, 0);
    });

    await test("force regenerates even when a document already exists", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ timeline_image_document_id: "doc-existing" }),
        );
        const result = await generateTimelineImage({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            force: true,
            deps,
        });
        assert.equal(result.created, true);
        assert.equal(result.documentId, "doc-timeline");
        assert.equal(captured.image.length, 1);
    });

    // ---- persistence + id update ------------------------------------------
    await test("persists the png and stores timeline_image_document_id", async () => {
        const rec = makeRecording({});
        const { deps, captured } = makeDeps(rec);
        const result = await generateTimelineImage({
            db: fakeDb,
            recordingId: "rec-1",
            userId: "user-1",
            deps,
        });
        assert.deepEqual(result, {
            documentId: "doc-timeline",
            versionId: "ver-timeline",
            created: true,
        });
        const p = captured.persist[0];
        assert.equal(p.recording, rec);
        assert.equal(p.label, "timeline");
        assert.equal(p.extension, "png");
        assert.equal(p.fileType, "png");
        assert.equal(p.contentType, "image/png");
        assert.ok(Buffer.isBuffer(p.bytes));
        assert.equal(captured.updates.length, 1);
        assert.deepEqual(captured.updates[0].patch, {
            timeline_image_document_id: "doc-timeline",
        });
    });

    console.log("recordings/timelineImage.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
