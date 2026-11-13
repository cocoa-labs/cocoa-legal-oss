// backend/src/lib/recordings/pipeline.test.ts
//
// The recordings pipeline is a resumable state machine over `recordings`:
// submit → poll → summarize → ready, with a failed exit and retry backoff. These
// tests pin the pieces that make it safe to re-enter and impossible to
// crash-loop, mirroring automation/pipeline.test.ts's injected-deps harness (no
// database, no network, no LLM):
//   - the nextStep decision table (derived from PERSISTED fields, so a
//     stall-recovered row resumes at the right step) including the two documented
//     traps: a recovered queued-row-with-transcript resolves to summarize, and an
//     EMPTY-string assemblyai id resolves to submit (never poll);
//   - submit claims from the row's ACTUAL current status, signs the right key,
//     stores the returned id + a +10s next_attempt_at — and a malformed empty id
//     schedules a retry WITHOUT ever storing an empty id;
//   - poll's three branches (processing → reschedule; error → scheduleRetry with
//     AssemblyAI's own message; completed → store transcript, claim to
//     summarizing, and run summarize IN THE SAME invocation);
//   - summarize's containment: a custom title survives, the default title is
//     overwritten, a chat-post throw still lands the recording at `ready`, and a
//     summary throw schedules a retry carrying maxRetries from env;
//   - idempotent resume (fix wave): a crash-window row (summary persisted, ready
//     CAS missed) re-enters summarize WITHOUT re-billing the LLM, and skips the
//     PDF render too when transcript_document_id is already set — never an
//     AssemblyAI resubmit;
//   - lost CAS claims return quietly (no writes), and processDueRecordings works
//     rows STRICTLY SEQUENTIALLY with per-row containment.
import assert from "node:assert/strict";
import {
    nextStep,
    processDueRecordings,
    processRecording,
    withHeartbeat,
    POLL_DELAY_MS,
    type ProcessRecordingDeps,
} from "./pipeline";
import type { Recording, RecordingStatus } from "./types";
import type { AssemblyAiTranscriptResult } from "./assemblyai";
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
const FIXED_NOW = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRecording(partial: Partial<Recording> = {}): Recording {
    return {
        id: "rec-1",
        user_id: "user-1",
        project_id: null,
        chat_id: null,
        chat_message_id: null,
        title: "Untitled recording",
        source: "mic",
        status: "queued",
        audio_storage_key: "audio/user-1/rec-1.webm",
        audio_mime: "audio/webm",
        audio_size_bytes: 1024,
        duration_seconds: null,
        consent_ack_at: "2026-07-17T00:00:00Z",
        assemblyai_transcript_id: null,
        utterances: [],
        transcript_text: null,
        summary_md: null,
        action_items: [],
        transcript_document_id: null,
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

function completedTranscript(
    overrides: Partial<AssemblyAiTranscriptResult> = {},
): AssemblyAiTranscriptResult {
    return {
        id: "tx-1",
        status: "completed",
        text: "Full transcript text.",
        error: null,
        audio_duration_seconds: 42,
        utterances: [
            { speaker: "Speaker A", text: "Hello", start_ms: 0, end_ms: 1500 },
        ],
        ...overrides,
    };
}

/**
 * In-memory `recordings` store faithful to the real store semantics:
 * claimRecordingStep is a CAS on status, updateRecording merges the patch,
 * scheduleRetry increments retry_count and fails the row at the cap. Every call
 * is recorded so tests can assert claims/updates/retries.
 */
interface FakeStore {
    record: Recording;
    claims: string[];
    updates: RecordingPatch[];
    retries: { error: string; delayMs: number; maxRetries: number }[];
    getRecordingAnyFn: NonNullable<ProcessRecordingDeps["getRecordingAnyFn"]>;
    claimRecordingStepFn: NonNullable<ProcessRecordingDeps["claimRecordingStepFn"]>;
    updateRecordingFn: NonNullable<ProcessRecordingDeps["updateRecordingFn"]>;
    scheduleRetryFn: NonNullable<ProcessRecordingDeps["scheduleRetryFn"]>;
}

function makeStore(record: Recording): FakeStore {
    const s: FakeStore = {
        record,
        claims: [],
        updates: [],
        retries: [],
        getRecordingAnyFn: (async () => ({ ...s.record })) as never,
        claimRecordingStepFn: (async (
            _db: never,
            _id: string,
            from: RecordingStatus,
            to: RecordingStatus,
        ) => {
            s.claims.push(`${from}->${to}`);
            if (s.record.status !== from) return null;
            s.record = { ...s.record, status: to };
            return { ...s.record };
        }) as never,
        updateRecordingFn: (async (
            _db: never,
            _id: string,
            patch: RecordingPatch,
        ) => {
            s.updates.push(patch);
            s.record = { ...s.record, ...patch } as Recording;
            return { ...s.record };
        }) as never,
        scheduleRetryFn: (async (
            _db: never,
            _id: string,
            input: { error: string; delayMs: number; maxRetries: number },
        ) => {
            s.retries.push(input);
            const retryCount = s.record.retry_count + 1;
            if (retryCount > input.maxRetries) {
                s.record = {
                    ...s.record,
                    status: "failed",
                    error: input.error,
                    retry_count: retryCount,
                };
            } else {
                s.record = {
                    ...s.record,
                    error: input.error,
                    retry_count: retryCount,
                };
            }
            return { ...s.record };
        }) as never,
    };
    return s;
}

function deps(
    store: FakeStore,
    overrides: Partial<ProcessRecordingDeps> = {},
): ProcessRecordingDeps {
    return {
        getRecordingAnyFn: store.getRecordingAnyFn,
        claimRecordingStepFn: store.claimRecordingStepFn,
        updateRecordingFn: store.updateRecordingFn,
        scheduleRetryFn: store.scheduleRetryFn,
        signAudioUrlFn: async () => "https://signed.example/audio.webm",
        submitTranscriptionFn: (async () => ({
            id: "tx-default",
            status: "queued",
        })) as never,
        getTranscriptionFn: (async () => completedTranscript()) as never,
        generateRecordingSummaryFn: (async () => ({
            title: "Generated Title",
            summary_md: "## Summary\n\nBody.",
            action_items: [
                { id: "item-1", text: "Follow up", done: false, owner: null, due: null },
            ],
        })) as never,
        persistTranscriptPdfFn: (async () => ({
            documentId: "doc-1",
            versionId: "ver-1",
        })) as never,
        insertRecordingSummaryMessageFn: (async () => "msg-1") as never,
        getUserApiKeysFn: async () => ({}),
        assemblyAiApiKeyFn: () => "aai-test-key",
        modelFn: () => "test-model",
        maxRetriesFn: () => 3,
        now: () => FIXED_NOW,
        // Large so the heartbeat interval never fires during a fast test.
        heartbeatIntervalMs: 100_000,
        ...overrides,
    };
}

async function main() {
    console.log("recordings/pipeline.test.ts");

    // 1 — nextStep matrix -----------------------------------------------------
    await test("nextStep: all four outcomes, recovered→summarize, empty-id→submit", () => {
        assert.equal(nextStep(makeRecording({ status: "ready" })), "done");
        assert.equal(nextStep(makeRecording({ status: "failed" })), "done");
        // Fresh queued row, nothing done yet.
        assert.equal(nextStep(makeRecording({ status: "queued" })), "submit");
        // Empty-string assemblyai id counts as ABSENT → submit, never poll.
        assert.equal(
            nextStep(
                makeRecording({
                    status: "transcribing",
                    assemblyai_transcript_id: "",
                }),
            ),
            "submit",
        );
        // Non-empty id, no transcript yet → poll.
        assert.equal(
            nextStep(
                makeRecording({
                    status: "transcribing",
                    assemblyai_transcript_id: "tx-1",
                }),
            ),
            "poll",
        );
        // Stall-recovered (status reset to queued) but transcript present and no
        // summary → summarize, regardless of the reset status.
        assert.equal(
            nextStep(
                makeRecording({
                    status: "queued",
                    assemblyai_transcript_id: "tx-1",
                    transcript_text: "hello world",
                }),
            ),
            "summarize",
        );
        assert.equal(
            nextStep(
                makeRecording({
                    status: "summarizing",
                    transcript_text: "hello world",
                }),
            ),
            "summarize",
        );
        // Fix-wave amendment: transcript AND summary both present on a
        // non-terminal row (crashed after the summary write, before the ready
        // CAS) → STILL summarize — the step itself skips what is already
        // persisted. This must never route back to submit (a full
        // re-transcription of audio we already have a transcript for).
        assert.equal(
            nextStep(
                makeRecording({
                    status: "queued",
                    assemblyai_transcript_id: "tx-1",
                    transcript_text: "hello world",
                    summary_md: "## done already",
                }),
            ),
            "summarize",
        );
    });

    // 2 — submit happy path ---------------------------------------------------
    await test("submit: claims current→transcribing, signs the key, stores id + 10s", async () => {
        const store = makeStore(
            makeRecording({
                status: "queued",
                audio_storage_key: "audio/user-1/clip.webm",
            }),
        );
        const signed: string[] = [];
        const submitCalls: { audioUrl: string; apiKey: string | null }[] = [];
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                signAudioUrlFn: async (key) => {
                    signed.push(key);
                    return "https://signed.example/clip";
                },
                submitTranscriptionFn: (async (p: {
                    audioUrl: string;
                    apiKey: string | null;
                }) => {
                    submitCalls.push(p);
                    return { id: "tx-42", status: "queued" };
                }) as never,
            }),
        );
        assert.equal(result.outcome, "submitted");
        assert.deepEqual(store.claims, ["queued->transcribing"]);
        assert.deepEqual(signed, ["audio/user-1/clip.webm"]);
        assert.equal(submitCalls[0].audioUrl, "https://signed.example/clip");
        assert.equal(submitCalls[0].apiKey, "aai-test-key");
        assert.equal(store.record.assemblyai_transcript_id, "tx-42");
        assert.equal(store.record.status, "transcribing");
        const idUpdate = store.updates.find(
            (u) => "assemblyai_transcript_id" in u,
        );
        assert.ok(idUpdate);
        assert.equal(
            idUpdate?.next_attempt_at,
            new Date(FIXED_NOW + POLL_DELAY_MS).toISOString(),
        );
    });

    // 3 — submit with empty id ------------------------------------------------
    await test("submit: empty returned id → scheduleRetry, id NEVER stored", async () => {
        const store = makeStore(makeRecording({ status: "queued" }));
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                submitTranscriptionFn: (async () => ({
                    id: "",
                    status: "error",
                })) as never,
            }),
        );
        assert.equal(result.outcome, "retry-scheduled");
        assert.equal(store.retries.length, 1);
        assert.equal(store.retries[0].error, "AssemblyAI returned no transcript id");
        assert.equal(store.retries[0].maxRetries, 3);
        assert.equal(store.record.assemblyai_transcript_id, null);
        assert.ok(
            !store.updates.some((u) => "assemblyai_transcript_id" in u),
            "an empty id is never written to the row",
        );
    });

    // 4 — poll still processing -----------------------------------------------
    await test("poll: processing → next_attempt_at pushed +10s, no status change, no claim", async () => {
        const store = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
            }),
        );
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                getTranscriptionFn: (async () =>
                    completedTranscript({
                        status: "processing",
                        text: null,
                        audio_duration_seconds: null,
                        utterances: [],
                    })) as never,
            }),
        );
        assert.equal(result.outcome, "polling");
        assert.equal(store.record.status, "transcribing");
        assert.deepEqual(store.claims, []);
        assert.equal(
            store.record.next_attempt_at,
            new Date(FIXED_NOW + POLL_DELAY_MS).toISOString(),
        );
    });

    // 5 — poll completed → summarize in the same invocation → ready -----------
    await test("poll: completed stores transcript, claims to summarizing, summarizes, ends ready", async () => {
        const store = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
                duration_seconds: null,
                title: "Untitled recording",
            }),
        );
        const utterances = [
            { speaker: "Speaker A", text: "Hi", start_ms: 0, end_ms: 1000 },
            { speaker: "Speaker B", text: "Hello", start_ms: 1000, end_ms: 2000 },
        ];
        let persistArg: { recording: Recording } | null = null;
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                getTranscriptionFn: (async () =>
                    completedTranscript({
                        text: "Hi there",
                        audio_duration_seconds: 12.5,
                        utterances,
                    })) as never,
                persistTranscriptPdfFn: (async (args: {
                    recording: Recording;
                }) => {
                    persistArg = args;
                    return { documentId: "doc-77", versionId: "ver-1" };
                }) as never,
            }),
        );
        assert.equal(result.outcome, "ready");
        assert.equal(store.record.status, "ready");
        assert.deepEqual(store.record.utterances, utterances);
        assert.equal(store.record.transcript_text, "Hi there");
        assert.equal(store.record.duration_seconds, 12.5);
        assert.equal(store.record.summary_md, "## Summary\n\nBody.");
        assert.equal(store.record.transcript_document_id, "doc-77");
        assert.deepEqual(store.claims, [
            "transcribing->summarizing",
            "summarizing->ready",
        ]);
        assert.ok(persistArg, "persistTranscriptPdf was called");
        assert.equal(
            (persistArg as unknown as { recording: Recording }).recording
                .transcript_text,
            "Hi there",
            "the PDF is built from the stored transcript",
        );
    });

    // 6 — poll error ----------------------------------------------------------
    await test("poll: error status → scheduleRetry with AssemblyAI's own message", async () => {
        const store = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
            }),
        );
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                getTranscriptionFn: (async () =>
                    completedTranscript({
                        status: "error",
                        text: null,
                        error: "audio download failed",
                        utterances: [],
                    })) as never,
            }),
        );
        assert.equal(result.outcome, "retry-scheduled");
        assert.equal(store.retries.length, 1);
        assert.equal(store.retries[0].error, "audio download failed");
        assert.equal(store.retries[0].maxRetries, 3);
        assert.equal(store.record.summary_md, null, "no summary on a failed poll");
    });

    // 7 — title preservation vs overwrite -------------------------------------
    await test("summarize: custom title preserved; default 'Untitled recording' overwritten", async () => {
        // Custom title survives.
        const custom = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
                title: "Deposition of Jane Doe",
            }),
        );
        await processRecording(fakeDb, "rec-1", deps(custom));
        assert.equal(custom.record.status, "ready");
        assert.equal(custom.record.title, "Deposition of Jane Doe");

        // Default title is replaced by the generated one.
        const def = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
                title: "Untitled recording",
            }),
        );
        await processRecording(fakeDb, "rec-1", deps(def));
        assert.equal(def.record.status, "ready");
        assert.equal(def.record.title, "Generated Title");
    });

    // 8 — chat-post failure is tolerated --------------------------------------
    await test("summarize: a chat-post throw is swallowed, recording still ends ready", async () => {
        const store = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
                chat_id: "chat-1",
            }),
        );
        const realWarn = console.warn;
        console.warn = () => {};
        let result: Awaited<ReturnType<typeof processRecording>>;
        try {
            result = await processRecording(
                fakeDb,
                "rec-1",
                deps(store, {
                    insertRecordingSummaryMessageFn: (async () => {
                        throw new Error("chat was deleted");
                    }) as never,
                }),
            );
        } finally {
            console.warn = realWarn;
        }
        assert.equal(result.outcome, "ready");
        assert.equal(store.record.status, "ready");
        assert.equal(store.retries.length, 0, "chat failure does not schedule a retry");
    });

    // 9 — summarize throw → scheduleRetry carrying maxRetries from env ---------
    await test("summarize: a summary throw → scheduleRetry with maxRetries resolved from env", async () => {
        const store = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
            }),
        );
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                generateRecordingSummaryFn: (async () => {
                    throw new Error("model is down");
                }) as never,
                maxRetriesFn: () => 7,
            }),
        );
        assert.equal(result.outcome, "retry-scheduled");
        assert.equal(store.retries.length, 1);
        assert.match(store.retries[0].error, /model is down/);
        assert.equal(
            store.retries[0].maxRetries,
            7,
            "the store receives maxRetries straight from env; the cap→failed is the store's job",
        );
    });

    // 10 — lost CAS claim -----------------------------------------------------
    await test("lost CAS claim → returns quietly with no side effects", async () => {
        const store = makeStore(makeRecording({ status: "queued" }));
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                // Claim always fails (another worker owns the row).
                claimRecordingStepFn: (async (
                    _db: never,
                    _id: string,
                    from: RecordingStatus,
                    to: RecordingStatus,
                ) => {
                    store.claims.push(`${from}->${to}`);
                    return null;
                }) as never,
                signAudioUrlFn: async () => {
                    throw new Error("must not sign after a lost claim");
                },
                submitTranscriptionFn: (async () => {
                    throw new Error("must not submit after a lost claim");
                }) as never,
            }),
        );
        assert.equal(result.outcome, "lost-claim");
        assert.deepEqual(store.updates, [], "no writes on a lost claim");
        assert.equal(store.retries.length, 0, "no retry on a lost claim");
    });

    // 11 — processDueRecordings serial + containment --------------------------
    await test("processDueRecordings: strictly sequential, contains one bad row, returns counts", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const processed: string[] = [];
        const realConsoleError = console.error;
        const errorLogs: string[] = [];
        console.error = (...args: unknown[]) => {
            errorLogs.push(args.map(String).join(" "));
        };
        let result: Awaited<ReturnType<typeof processDueRecordings>>;
        try {
            result = await processDueRecordings(
                fakeDb,
                { limit: 5 },
                {
                    listDueRecordingsFn: (async () => [
                        makeRecording({ id: "rec-a" }),
                        makeRecording({ id: "rec-b" }),
                        makeRecording({ id: "rec-c" }),
                    ]) as never,
                    processRecordingFn: (async (_db: never, id: string) => {
                        inFlight += 1;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        await sleep(5);
                        processed.push(id);
                        inFlight -= 1;
                        if (id === "rec-b") throw new Error("one bad recording");
                        return { outcome: "ready" as const };
                    }) as never,
                },
            );
        } finally {
            console.error = realConsoleError;
        }
        assert.equal(maxInFlight, 1, "recordings are processed one at a time");
        assert.deepEqual(processed, ["rec-a", "rec-b", "rec-c"]);
        assert.deepEqual(
            result,
            { processed: 2, due: 3 },
            "a thrown row is contained and not counted as processed",
        );
        assert.ok(
            errorLogs.some((line) => line.includes("rec-b")),
            "the contained crash is logged, not silent",
        );
    });

    // 12 — duration_seconds not clobbered -------------------------------------
    await test("poll completed: duration_seconds is NOT overwritten when already set", async () => {
        const store = makeStore(
            makeRecording({
                status: "transcribing",
                assemblyai_transcript_id: "tx-1",
                duration_seconds: 99,
            }),
        );
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                getTranscriptionFn: (async () =>
                    completedTranscript({
                        text: "hi",
                        audio_duration_seconds: 55,
                        utterances: [],
                    })) as never,
            }),
        );
        assert.equal(result.outcome, "ready");
        assert.equal(store.record.duration_seconds, 99, "existing duration wins");
        const transcriptUpdate = store.updates.find(
            (u) => "transcript_text" in u,
        );
        assert.ok(transcriptUpdate);
        assert.ok(
            !("duration_seconds" in (transcriptUpdate as RecordingPatch)),
            "the completed patch omits duration_seconds when the row already has one",
        );
    });

    // 13 — fix wave: crash-window resume skips the LLM, persists the PDF ------
    await test("resume: summary already persisted → LLM skipped, PDF persisted, ends ready", async () => {
        const store = makeStore(
            makeRecording({
                status: "summarizing",
                assemblyai_transcript_id: "tx-1",
                transcript_text: "already transcribed",
                summary_md: "## Persisted summary",
                transcript_document_id: null,
                title: "Untitled recording",
            }),
        );
        let generateCalled = false;
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                generateRecordingSummaryFn: (async () => {
                    generateCalled = true;
                    throw new Error("must not re-bill the LLM on resume");
                }) as never,
                persistTranscriptPdfFn: (async () => ({
                    documentId: "doc-resume",
                    versionId: "ver-resume",
                })) as never,
            }),
        );
        assert.equal(result.outcome, "ready");
        assert.equal(generateCalled, false, "generateRecordingSummary skipped");
        assert.equal(store.record.summary_md, "## Persisted summary");
        assert.equal(
            store.record.title,
            "Untitled recording",
            "the title update is skipped along with the LLM",
        );
        assert.equal(store.record.transcript_document_id, "doc-resume");
        assert.equal(store.record.status, "ready");
        assert.deepEqual(store.claims, [
            "summarizing->summarizing",
            "summarizing->ready",
        ]);
    });

    // 14 — fix wave: resume with the PDF also already persisted ---------------
    await test("resume: summary AND pdf already persisted → neither re-run, ends ready", async () => {
        const store = makeStore(
            makeRecording({
                status: "summarizing",
                assemblyai_transcript_id: "tx-1",
                transcript_text: "already transcribed",
                summary_md: "## Persisted summary",
                transcript_document_id: "doc-existing",
            }),
        );
        let generateCalled = false;
        let pdfCalled = false;
        const result = await processRecording(
            fakeDb,
            "rec-1",
            deps(store, {
                generateRecordingSummaryFn: (async () => {
                    generateCalled = true;
                    throw new Error("must not re-bill the LLM on resume");
                }) as never,
                persistTranscriptPdfFn: (async () => {
                    pdfCalled = true;
                    return { documentId: "doc-dup", versionId: "ver-dup" };
                }) as never,
            }),
        );
        assert.equal(result.outcome, "ready");
        assert.equal(generateCalled, false, "LLM still skipped");
        assert.equal(pdfCalled, false, "persistTranscriptPdf skipped");
        assert.equal(store.record.transcript_document_id, "doc-existing");
        assert.equal(store.record.status, "ready");
    });

    // 15 — fix wave: recovered queued row polls completed, claims from ACTUAL --
    await test("poll completed on a recovered queued row: claims queued→summarizing, same invocation", async () => {
        const store = makeStore(
            makeRecording({
                status: "queued",
                assemblyai_transcript_id: "tx-1",
                transcript_text: null,
            }),
        );
        const result = await processRecording(fakeDb, "rec-1", deps(store));
        assert.equal(result.outcome, "ready");
        assert.deepEqual(
            store.claims,
            ["queued->summarizing", "summarizing->ready"],
            "the completed-poll claim starts from the row's ACTUAL status",
        );
        assert.equal(store.record.status, "ready");
        assert.equal(store.record.summary_md, "## Summary\n\nBody.");
    });

    // withHeartbeat lifecycle (mirrors the blueprint) -------------------------
    await test("withHeartbeat: beats while running, cleared after the step", async () => {
        let beats = 0;
        const result = await withHeartbeat(
            {
                db: fakeDb,
                recordingId: "rec-1",
                intervalMs: 5,
                updateRecordingFn: (async () => {
                    beats += 1;
                    return null;
                }) as never,
            },
            async () => {
                await sleep(40);
                return "done";
            },
        );
        assert.equal(result, "done");
        assert.ok(beats >= 2, `heartbeat fired during the step (${beats})`);
        const after = beats;
        await sleep(30);
        assert.equal(beats, after, "the interval is cleared once the step ends");
    });

    console.log("recordings/pipeline.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
