// backend/src/lib/recordings/transcriptPdf.test.ts
//
// Two halves. buildTranscriptMarkdown is a pure renderer — pinned directly on
// its title header, the metadata line (date · duration mm:ss · speaker count),
// the speaker-labeled sections (the `speaker` field already reads "Speaker A",
// so it is NOT re-prefixed), and the raw-text / empty fallbacks. persistTranscriptPdf
// is driven with injected deps (convertToPdf / uploadFile / now) + a scripted
// Supabase stub, so nothing here converts a real document or hits storage/db;
// the test pins the exact documents + document_versions insert shapes it mirrors
// from persistAuthoredDocx (adapted to a PDF), the current_version_id update, the
// returned ids, and error propagation.
import assert from "node:assert/strict";
import {
    buildTranscriptMarkdown,
    formatClock,
    persistTranscriptPdf,
} from "./transcriptPdf";
import type { Recording } from "./types";

// ---- scripted chainable Supabase stub (mirror of store.test.ts) ------------
interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown },
    ) => {
        const c: Record<string, unknown> = {};
        const record =
            (method: string) =>
            (...args: unknown[]) => {
                log.calls.push({ method, args });
                return c;
            };
        for (const m of ["insert", "update", "select", "eq"]) {
            c[m] = record(m);
        }
        const resolved = {
            data: result.data ?? null,
            error: result.error ?? null,
        };
        c.single = () => Promise.resolve(resolved);
        c.maybeSingle = () => Promise.resolve(resolved);
        c.then = (resolve: (v: unknown) => void) => resolve(resolved);
        return c;
    };
    const db = {
        from: (table: string) => {
            const log: ChainLog = { table, calls: [] };
            chains.push(log);
            return makeChain(log, script[next++] ?? {});
        },
    } as never;
    return { db, chains };
}

function insertArg(chain: ChainLog): Record<string, unknown> {
    const call = chain.calls.find((c) => c.method === "insert");
    assert.ok(call, "expected an insert on chain");
    return call.args[0] as Record<string, unknown>;
}

function makeRecording(over: Partial<Recording>): Recording {
    return {
        id: "rec-1",
        user_id: "user-1",
        project_id: null,
        chat_id: null,
        chat_message_id: null,
        title: "Client Intake",
        source: "mic",
        status: "ready",
        audio_storage_key: "r2/rec-1.webm",
        audio_mime: "audio/webm",
        audio_size_bytes: 1024,
        duration_seconds: 125,
        consent_ack_at: "2026-07-16T00:00:00Z",
        assemblyai_transcript_id: "t-1",
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
        next_attempt_at: "2026-07-16T00:00:00Z",
        created_at: "2026-07-17T12:00:00.000Z",
        updated_at: "2026-07-16T00:00:00Z",
        ...over,
    };
}

interface FakeDeps {
    convertCalls: { text: string; ext: string | undefined }[];
    verifyCalls: { fileType: string; size: number }[];
    uploads: { key: string; contentType: string; size: number }[];
    deps: Parameters<typeof persistTranscriptPdf>[0]["deps"];
}

function makeDeps(pdf = Buffer.from("%PDF-1.4 fake body")): FakeDeps {
    const convertCalls: FakeDeps["convertCalls"] = [];
    const verifyCalls: FakeDeps["verifyCalls"] = [];
    const uploads: FakeDeps["uploads"] = [];
    return {
        convertCalls,
        verifyCalls,
        uploads,
        deps: {
            convertToPdf: async (buf: Buffer, ext?: string) => {
                convertCalls.push({ text: buf.toString("utf-8"), ext });
                return pdf;
            },
            verifyDerivedArtifact: async ({ bytes, fileType }) => {
                verifyCalls.push({ fileType, size: bytes.byteLength });
                return {
                    schema_version: 1,
                    artifact_type: "pdf",
                    sha256: "a".repeat(64),
                    checked_at: "2026-07-17T00:00:00.000Z",
                    status: "passed",
                    pdf: {
                        analyzer_version: 2,
                        sha256: "a".repeat(64),
                        page_count: 1,
                        text_item_count: 1,
                        rendered_token_count: 1,
                        expected_token_count: 0,
                        expected_token_coverage: 1,
                        ordered_token_coverage: 1,
                        collision_count: 0,
                        out_of_bounds_count: 0,
                        affected_pages: [],
                        failure_reasons: [],
                        status: "passed",
                    },
                };
            },
            uploadFile: async (
                key: string,
                content: ArrayBuffer,
                contentType: string,
            ) => {
                uploads.push({ key, contentType, size: content.byteLength });
            },
            now: () => "2026-07-17T00:00:00.000Z",
        },
    };
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
    console.log("recordings/transcriptPdf.test.ts");

    // ---- formatClock -------------------------------------------------------
    await test("formatClock renders m:ss, seconds zero-padded, minutes uncapped", async () => {
        assert.equal(formatClock(0), "0:00");
        assert.equal(formatClock(5), "0:05");
        assert.equal(formatClock(125), "2:05");
        assert.equal(formatClock(3725), "62:05");
    });

    // ---- buildTranscriptMarkdown ------------------------------------------
    await test("renders the title header, metadata line, and speaker sections", async () => {
        const md = buildTranscriptMarkdown({
            title: "Client Intake",
            createdAt: "2026-07-17T12:00:00.000Z",
            durationSeconds: 125,
            utterances: [
                { speaker: "Speaker A", text: "Hello.", start_ms: 0, end_ms: 5000 },
                {
                    speaker: "Speaker B",
                    text: "Hi there.",
                    start_ms: 12000,
                    end_ms: 15000,
                },
            ],
            transcriptText: null,
        });
        assert.match(md, /^# Client Intake\n/);
        assert.match(md, /2026-07-17/);
        assert.match(md, /2:05/); // duration
        assert.match(md, /2 speakers/);
        // speaker used verbatim — never doubled to "Speaker Speaker A"
        assert.match(md, /\*\*Speaker A\*\* \[0:00\]:/);
        assert.match(md, /Hello\./);
        assert.match(md, /\*\*Speaker B\*\* \[0:12\]:/);
        assert.doesNotMatch(md, /Speaker Speaker/);
    });

    await test("singular '1 speaker' and omits duration when unknown", async () => {
        const md = buildTranscriptMarkdown({
            title: "Solo dictation",
            createdAt: "2026-07-17T00:00:00Z",
            durationSeconds: null,
            utterances: [
                { speaker: "Speaker A", text: "Note to self.", start_ms: 0, end_ms: 1 },
            ],
            transcriptText: null,
        });
        assert.match(md, /1 speaker\b/);
        assert.doesNotMatch(md, /speakers/);
    });

    await test("falls back to the raw transcript text when there are no utterances", async () => {
        const md = buildTranscriptMarkdown({
            title: "Dictation",
            createdAt: "2026-07-17T00:00:00Z",
            durationSeconds: null,
            utterances: [],
            transcriptText: "Plain transcript body.",
        });
        assert.match(md, /# Dictation/);
        assert.match(md, /Plain transcript body\./);
        assert.doesNotMatch(md, /speaker/i); // no speaker count, no sections
    });

    await test("uses a placeholder when there is neither diarization nor text", async () => {
        const md = buildTranscriptMarkdown({
            title: "Empty",
            createdAt: "2026-07-17T00:00:00Z",
            durationSeconds: null,
            utterances: [],
            transcriptText: "",
        });
        assert.match(md, /_No transcript available\._/);
    });

    // ---- persistTranscriptPdf ---------------------------------------------
    await test("converts the markdown, uploads a PDF, and writes the doc + version rows", async () => {
        const pdf = Buffer.from("%PDF-1.4 fake body");
        const { convertCalls, verifyCalls, uploads, deps } = makeDeps(pdf);
        const { db, chains } = makeDb([
            { data: { id: "doc-1" } }, // documents insert
            { data: { id: "ver-1" } }, // document_versions insert
            {}, // documents update (current_version_id)
        ]);
        const recording = makeRecording({
            id: "rec-9",
            user_id: "user-7",
            project_id: "proj-3",
            title: "Client Call",
            duration_seconds: 60,
            utterances: [
                { speaker: "Speaker A", text: "hi", start_ms: 0, end_ms: 1000 },
            ],
        });

        const result = await persistTranscriptPdf({ db, recording, deps });
        assert.deepEqual(result, { documentId: "doc-1", versionId: "ver-1" });

        // convertToPdf(Buffer.from(md), "md")
        assert.equal(convertCalls.length, 1);
        assert.equal(convertCalls[0].ext, "md");
        assert.match(convertCalls[0].text, /# Client Call/);

        assert.deepEqual(verifyCalls, [
            { fileType: "pdf", size: pdf.byteLength },
        ]);

        // uploadFile with the PDF content type and a generated/<user>/.../*.pdf key
        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].contentType, "application/pdf");
        assert.equal(uploads[0].size, pdf.byteLength);
        assert.match(uploads[0].key, /^generated\/user-7\//);
        assert.match(uploads[0].key, /\.pdf$/);

        // documents row — mirrors persistAuthoredDocx (no `title` column; the
        // title lives in `filename`), adapted to a PDF file_type.
        const doc = insertArg(chains[0]);
        assert.equal(chains[0].table, "documents");
        assert.equal(doc.project_id, "proj-3");
        assert.equal(doc.user_id, "user-7");
        assert.equal(doc.file_type, "pdf");
        assert.equal(doc.status, "ready");
        assert.equal(doc.size_bytes, pdf.byteLength);
        assert.match(String(doc.filename), /transcript/);
        assert.match(String(doc.filename), /\.pdf$/);

        // document_versions row via insertDocumentVersionCompat
        const ver = insertArg(chains[1]);
        assert.equal(chains[1].table, "document_versions");
        assert.equal(ver.document_id, "doc-1");
        assert.equal(ver.storage_path, uploads[0].key);
        assert.equal(ver.source, "generated");
        assert.equal(ver.version_number, 1);
        assert.equal(ver.created_by_user_id, "user-7");
        assert.equal(ver.layout_qa_status, "passed");
        assert.equal(ver.layout_qa_checked_at, "2026-07-17T00:00:00.000Z");
        assert.equal(
            (ver.metadata as Record<string, unknown>).recording_id,
            "rec-9",
        );

        // current_version_id back-reference update
        assert.equal(chains[2].table, "documents");
        const upd = chains[2].calls.find((c) => c.method === "update");
        assert.deepEqual(upd?.args[0], { current_version_id: "ver-1" });
        const eq = chains[2].calls.find((c) => c.method === "eq");
        assert.deepEqual(eq?.args, ["id", "doc-1"]);
    });

    await test("standalone recording persists with project_id null", async () => {
        const { deps } = makeDeps();
        const { db, chains } = makeDb([
            { data: { id: "doc-2" } },
            { data: { id: "ver-2" } },
            {},
        ]);
        await persistTranscriptPdf({
            db,
            recording: makeRecording({ project_id: null }),
            deps,
        });
        assert.equal(insertArg(chains[0]).project_id, null);
    });

    await test("propagates a documents-insert failure (pipeline owns retry)", async () => {
        const { deps } = makeDeps();
        const { db } = makeDb([
            { data: null, error: { message: "boom" } }, // documents insert fails
        ]);
        await assert.rejects(
            persistTranscriptPdf({ db, recording: makeRecording({}), deps }),
            /Failed to record transcript document/,
        );
    });

    console.log("recordings/transcriptPdf.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
