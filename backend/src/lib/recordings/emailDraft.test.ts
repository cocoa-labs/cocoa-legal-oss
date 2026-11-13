// backend/src/lib/recordings/emailDraft.test.ts
//
// draftRecordingEmail wires a ready recording's summary into the EXISTING
// draft-then-approve email rails (createAgentOperation + createPendingEmail) —
// it never sends. These tests drive it entirely through injected deps + a
// scripted db stub (no real db, no email store, no PDF render) and pin:
//   * the shared guard (loadReadyRecording): not-found → 404-coded, not-ready →
//     409-coded RecordingArtifactError (non-ready status AND ready-without-summary);
//   * default recipient [userEmail] when `to` is absent, and custom to/cc/subject;
//   * the plain-text body layout (optional note paragraph, the summary_md, then an
//     "Action items:" block with owner/due suffixes);
//   * the attachment ref built EXACTLY per EmailAttachmentRef — every field pinned
//     (document_id, version_id from the document's current_version_id, filename
//     from the document row, content_type "application/pdf");
//   * the operation mirrors send_email verbatim-in-shape (toolName/actionType
//     "send_email", mutating, requiresApproval true, arguments {to,subject,
//     attachment_count}) + a human-readable metadata.summary and recording linkage;
//   * email_id is stored on the recording and the reloaded row is returned;
//   * idempotence: a still-pending linked email is reused with NO new op/email/
//     update; force and a prior sent/cancelled email both cut a fresh draft;
//   * a null transcript_document_id is regenerated via the injected
//     persistTranscriptPdf; a document row missing current_version_id → domain error.
import assert from "node:assert/strict";
import {
    buildRecordingEmailBody,
    draftRecordingEmail,
    type DraftRecordingEmailDeps,
} from "./emailDraft";
import { RecordingArtifactError } from "./artifacts";
import type { Recording } from "./types";
import type { RecordingPatch } from "./store";
import type { EmailMessage } from "../email/store";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

function makeRecording(partial: Partial<Recording> = {}): Recording {
    return {
        id: "rec-1",
        user_id: "user-1",
        project_id: "proj-1",
        chat_id: "chat-9",
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
            {
                id: "item-1",
                text: "File the complaint",
                done: false,
                owner: "Dana",
                due: "2026-08-01",
            },
            {
                id: "item-2",
                text: "Request medical records",
                done: true,
                owner: null,
                due: null,
            },
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

// A minimal chainable Supabase stub for the single documents-row read
// (db.from("documents").select(...).eq(...).maybeSingle()). Records the table
// and eq filters so tests can pin the lookup, and resolves the terminal read to
// the scripted row.
interface DbLog {
    table: string;
    eq: unknown[][];
    select: unknown[];
}
function makeDb(docRow: Record<string, unknown> | null): {
    db: never;
    log: DbLog[];
} {
    const log: DbLog[] = [];
    const db = {
        from: (table: string) => {
            const entry: DbLog = { table, eq: [], select: [] };
            log.push(entry);
            const chain: Record<string, unknown> = {};
            chain.select = (...args: unknown[]) => {
                entry.select.push(...args);
                return chain;
            };
            chain.eq = (...args: unknown[]) => {
                entry.eq.push(args);
                return chain;
            };
            chain.maybeSingle = () =>
                Promise.resolve({ data: docRow, error: null });
            return chain;
        },
    } as never;
    return { db, log };
}

interface Captured {
    getEmailIds: string[];
    persist: Parameters<
        NonNullable<DraftRecordingEmailDeps["persistTranscriptPdfFn"]>
    >[0][];
    operations: Parameters<
        NonNullable<DraftRecordingEmailDeps["createAgentOperationFn"]>
    >[0][];
    emails: Parameters<
        NonNullable<DraftRecordingEmailDeps["createPendingEmailFn"]>
    >[1][];
    updates: { id: string; patch: RecordingPatch }[];
    timeline: { recordingId: string; userId: string }[];
}

function makeDeps(
    recording: Recording | null,
    overrides: {
        linkedEmail?: Partial<EmailMessage> | null;
        newDocumentId?: string;
        newVersionId?: string;
        emailStoreDown?: boolean;
        timelineThrows?: boolean;
        timelineDocumentId?: string;
        timelineVersionId?: string;
    } = {},
): { deps: DraftRecordingEmailDeps; captured: Captured; current: () => Recording | null } {
    const captured: Captured = {
        getEmailIds: [],
        persist: [],
        operations: [],
        emails: [],
        updates: [],
        timeline: [],
    };
    // Mutable holder so the closing reload reflects the stored email_id /
    // transcript_document_id (mirror of briefing.test's update-then-return).
    let holder = recording;
    const deps: DraftRecordingEmailDeps = {
        getRecordingFn: async () => holder,
        getEmailFn: async (_db, id) => {
            captured.getEmailIds.push(id);
            return overrides.linkedEmail === undefined
                ? null
                : overrides.linkedEmail === null
                  ? null
                  : ({
                        id,
                        status: "pending_approval",
                        ...overrides.linkedEmail,
                    } as EmailMessage);
        },
        persistTranscriptPdfFn: async (params) => {
            captured.persist.push(params);
            return {
                documentId: overrides.newDocumentId ?? "doc-tx-new",
                versionId: overrides.newVersionId ?? "ver-tx-new",
            };
        },
        createAgentOperationFn: async (input) => {
            captured.operations.push(input);
            return { id: "op-1" } as never;
        },
        createPendingEmailFn: async (_db, input) => {
            captured.emails.push(input);
            if (overrides.emailStoreDown) return null;
            return {
                id: "email-new",
                status: "pending_approval",
            } as EmailMessage;
        },
        updateRecordingFn: async (_db, id, patch) => {
            captured.updates.push({ id, patch });
            holder = holder ? { ...holder, ...patch } : holder;
            return holder;
        },
        generateTimelineImageFn: async (params) => {
            captured.timeline.push({
                recordingId: params.recordingId,
                userId: params.userId,
            });
            if (overrides.timelineThrows) {
                throw new Error("gpt-image-2 org verification required (403)");
            }
            return {
                documentId: overrides.timelineDocumentId ?? "doc-timeline",
                versionId: overrides.timelineVersionId ?? "ver-timeline",
                created: true,
            };
        },
    };
    return { deps, captured, current: () => holder };
}

async function main() {
    console.log("recordings/emailDraft.test.ts");

    // ---- pure body builder -------------------------------------------------
    await test("buildRecordingEmailBody: note + summary + action-item lines with owner/due", () => {
        const body = buildRecordingEmailBody(makeRecording({}), "Please review.");
        // Note paragraph first.
        assert.ok(body.startsWith("Please review."));
        // Summary content is present.
        assert.match(body, /slip-and-fall claim/);
        // Action items block with owner/due suffix + done reflected.
        assert.match(body, /Action items:/);
        assert.match(body, /- \[ \] File the complaint \(Dana, 2026-08-01\)/);
        assert.match(body, /- \[x\] Request medical records\b/);
        // The unowned/undated item carries no parenthetical suffix.
        assert.ok(!/Request medical records \(/.test(body));
    });

    await test("buildRecordingEmailBody: no note and no action items → just the summary", () => {
        const body = buildRecordingEmailBody(
            makeRecording({ action_items: [] }),
            undefined,
        );
        assert.match(body, /slip-and-fall claim/);
        assert.ok(!/Action items:/.test(body));
    });

    // ---- guards ------------------------------------------------------------
    await test("not-found recording → not_found RecordingArtifactError", async () => {
        const { deps } = makeDeps(null);
        const { db } = makeDb(null);
        await assert.rejects(
            draftRecordingEmail({
                db,
                recordingId: "rec-x",
                userId: "user-1",
                userEmail: "me@firm.test",
                input: {},
                deps,
            }),
            (err: unknown) =>
                err instanceof RecordingArtifactError &&
                err.code === "not_found",
        );
    });

    await test("non-ready recording → not_ready RecordingArtifactError", async () => {
        const { deps } = makeDeps(makeRecording({ status: "summarizing" }));
        const { db } = makeDb(null);
        await assert.rejects(
            draftRecordingEmail({
                db,
                recordingId: "rec-1",
                userId: "user-1",
                userEmail: "me@firm.test",
                input: {},
                deps,
            }),
            (err: unknown) =>
                err instanceof RecordingArtifactError &&
                err.code === "not_ready",
        );
    });

    await test("ready but no summary → not_ready RecordingArtifactError", async () => {
        const { deps } = makeDeps(makeRecording({ summary_md: null }));
        const { db } = makeDb(null);
        await assert.rejects(
            draftRecordingEmail({
                db,
                recordingId: "rec-1",
                userId: "user-1",
                userEmail: "me@firm.test",
                input: {},
                deps,
            }),
            (err: unknown) =>
                err instanceof RecordingArtifactError &&
                err.code === "not_ready",
        );
    });

    // ---- happy path: default recipient + attachment + operation + link -----
    await test("timeline excluded: default recipient [userEmail]; single transcript attachment, operation, email_id all correct", async () => {
        const rec = makeRecording({});
        const { deps, captured } = makeDeps(rec);
        const { db, log } = makeDb({
            current_version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
        });
        const result = await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: { includeTimelineImage: false },
            deps,
        });

        // No regeneration — the transcript doc already existed.
        assert.equal(captured.persist.length, 0);
        // Timeline excluded → no generation attempted.
        assert.equal(captured.timeline.length, 0);

        // The documents row was read by id.
        assert.equal(log[0].table, "documents");
        assert.deepEqual(log[0].eq, [["id", "doc-transcript"]]);

        // Exactly one operation, mirroring send_email verbatim-in-shape.
        assert.equal(captured.operations.length, 1);
        const op = captured.operations[0];
        assert.equal(op.toolName, "send_email");
        assert.equal(op.actionType, "send_email");
        assert.equal(op.mutating, true);
        assert.equal(op.requiresApproval, true);
        assert.equal(op.projectId, "proj-1");
        assert.equal(op.chatId, "chat-9");
        assert.deepEqual(op.arguments, {
            to: ["me@firm.test"],
            subject: "Recording summary: Placeholder intake call",
            attachment_count: 1,
        });
        assert.equal(
            (op.metadata as { summary?: string }).summary,
            'Email recording summary "Placeholder intake call" to me@firm.test',
        );
        assert.equal(
            (op.metadata as { recording_id?: string }).recording_id,
            "rec-1",
        );

        // Exactly one email draft with the resolved fields + exact attachment.
        assert.equal(captured.emails.length, 1);
        const email = captured.emails[0];
        assert.equal(email.userId, "user-1");
        assert.equal(email.projectId, "proj-1");
        assert.equal(email.chatId, "chat-9");
        assert.equal(email.agentOperationId, "op-1");
        assert.deepEqual(email.to, ["me@firm.test"]);
        assert.deepEqual(email.cc, []);
        assert.equal(email.subject, "Recording summary: Placeholder intake call");
        assert.match(email.bodyText, /slip-and-fall claim/);
        // The attachment ref matches EmailAttachmentRef EXACTLY (every field).
        assert.equal(email.attachments.length, 1);
        assert.deepEqual(email.attachments[0], {
            document_id: "doc-transcript",
            version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
            content_type: "application/pdf",
        });

        // email_id stored, then the reloaded recording is returned.
        const emailIdUpdate = captured.updates.find(
            (u) => "email_id" in u.patch,
        );
        assert.ok(emailIdUpdate, "email_id was stored");
        assert.equal(emailIdUpdate!.patch.email_id, "email-new");
        assert.equal(result.emailId, "email-new");
        assert.equal(result.created, true);
        assert.equal(result.recording.email_id, "email-new");
    });

    // ---- timeline image inclusion (default ON) -----------------------------
    await test("default ON: timeline image auto-generated, added inline + attached (attachment_count 2)", async () => {
        const { deps, captured } = makeDeps(makeRecording({}));
        const { db } = makeDb({
            current_version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
        });
        await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: {}, // includeTimelineImage undefined → defaults ON
            deps,
        });

        // The timeline image was auto-generated for THIS recording + owner.
        assert.equal(captured.timeline.length, 1);
        assert.equal(captured.timeline[0].recordingId, "rec-1");
        assert.equal(captured.timeline[0].userId, "user-1");

        const email = captured.emails[0];
        assert.equal(email.attachments.length, 2);
        // The transcript PDF stays first.
        assert.equal(email.attachments[0].content_type, "application/pdf");
        assert.equal(email.attachments[0].document_id, "doc-transcript");
        // The timeline image is the inline+downloadable second ref.
        const tl = email.attachments[1];
        assert.equal(tl.document_id, "doc-timeline");
        assert.equal(tl.version_id, "ver-timeline");
        assert.equal(tl.content_type, "image/png");
        assert.equal(tl.inline, true);
        assert.equal(typeof tl.content_id, "string");
        assert.ok((tl.content_id as string).length > 0, "cid is set");
        assert.match(tl.filename, /timeline\.png$/);
        // The operation's attachment_count reflects BOTH attachments.
        assert.equal(
            (captured.operations[0].arguments as { attachment_count?: number })
                .attachment_count,
            2,
        );
    });

    await test("timeline generation failure degrades to a transcript-only draft", async () => {
        const { deps, captured } = makeDeps(makeRecording({}), {
            timelineThrows: true,
        });
        const { db } = makeDb({
            current_version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
        });
        // Silence the expected degrade warning to keep test output pristine.
        const origWarn = console.warn;
        console.warn = () => {};
        let result;
        try {
            result = await draftRecordingEmail({
                db,
                recordingId: "rec-1",
                userId: "user-1",
                userEmail: "me@firm.test",
                input: { includeTimelineImage: true },
                deps,
            });
        } finally {
            console.warn = origWarn;
        }
        // Generation was attempted but failed…
        assert.equal(captured.timeline.length, 1);
        // …and the draft still went out, transcript-only.
        assert.equal(result.created, true);
        assert.equal(captured.emails[0].attachments.length, 1);
        assert.equal(
            captured.emails[0].attachments[0].content_type,
            "application/pdf",
        );
        assert.equal(
            (captured.operations[0].arguments as { attachment_count?: number })
                .attachment_count,
            1,
        );
    });

    // ---- custom to / cc / subject / note -----------------------------------
    await test("custom to/cc/subject/note are respected", async () => {
        const { deps, captured } = makeDeps(makeRecording({}));
        const { db } = makeDb({
            current_version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
        });
        await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: {
                to: ["client@acme.test"],
                cc: ["paralegal@firm.test"],
                subject: "  Intake recap  ",
                note: "As discussed, here is the recap.",
            },
            deps,
        });
        const email = captured.emails[0];
        assert.deepEqual(email.to, ["client@acme.test"]);
        assert.deepEqual(email.cc, ["paralegal@firm.test"]);
        assert.equal(email.subject, "Intake recap"); // trimmed
        assert.ok(email.bodyText.startsWith("As discussed, here is the recap."));
        // The operation summary lists the custom recipients.
        assert.equal(
            (captured.operations[0].metadata as { summary?: string }).summary,
            'Email recording summary "Placeholder intake call" to client@acme.test',
        );
    });

    // ---- idempotence -------------------------------------------------------
    await test("a still-pending linked email is reused with NO new op/email/update", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ email_id: "email-existing" }),
            { linkedEmail: { status: "pending_approval" } },
        );
        const { db } = makeDb(null);
        const result = await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: {},
            deps,
        });
        assert.equal(result.created, false);
        assert.equal(result.emailId, "email-existing");
        assert.deepEqual(captured.getEmailIds, ["email-existing"]);
        assert.equal(captured.operations.length, 0);
        assert.equal(captured.emails.length, 0);
        assert.equal(captured.updates.length, 0);
        assert.equal(captured.persist.length, 0);
    });

    await test("force cuts a fresh draft without even consulting the linked email", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ email_id: "email-existing" }),
            { linkedEmail: { status: "pending_approval" } },
        );
        const { db } = makeDb({
            current_version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
        });
        const result = await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: { force: true },
            deps,
        });
        assert.equal(result.created, true);
        assert.equal(result.emailId, "email-new");
        assert.equal(captured.getEmailIds.length, 0); // idempotence skipped
        assert.equal(captured.operations.length, 1);
        assert.equal(captured.emails.length, 1);
    });

    await test("a prior sent email is not reused — a fresh draft is cut", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ email_id: "email-old" }),
            { linkedEmail: { status: "sent" } },
        );
        const { db } = makeDb({
            current_version_id: "ver-1",
            filename: "Placeholder intake call - transcript.pdf",
        });
        const result = await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: {},
            deps,
        });
        assert.equal(result.created, true);
        assert.deepEqual(captured.getEmailIds, ["email-old"]);
        assert.equal(captured.operations.length, 1);
        assert.equal(captured.emails.length, 1);
        const emailIdUpdate = captured.updates.find(
            (u) => "email_id" in u.patch,
        );
        assert.equal(emailIdUpdate!.patch.email_id, "email-new");
    });

    // ---- transcript regeneration + version guard ---------------------------
    await test("a null transcript_document_id is regenerated via persistTranscriptPdf and stored", async () => {
        const { deps, captured } = makeDeps(
            makeRecording({ transcript_document_id: null }),
            { newDocumentId: "doc-tx-new", newVersionId: "ver-tx-new" },
        );
        const { db } = makeDb({
            current_version_id: "ver-tx-new",
            filename: "Placeholder intake call - transcript.pdf",
        });
        const result = await draftRecordingEmail({
            db,
            recordingId: "rec-1",
            userId: "user-1",
            userEmail: "me@firm.test",
            input: {},
            deps,
        });
        assert.equal(captured.persist.length, 1);
        // The regenerated id is stored on the recording.
        const txUpdate = captured.updates.find(
            (u) => "transcript_document_id" in u.patch,
        );
        assert.ok(txUpdate, "transcript_document_id was stored");
        assert.equal(txUpdate!.patch.transcript_document_id, "doc-tx-new");
        // The attachment points at the freshly-generated doc + its version.
        assert.deepEqual(captured.emails[0].attachments[0], {
            document_id: "doc-tx-new",
            version_id: "ver-tx-new",
            filename: "Placeholder intake call - transcript.pdf",
            content_type: "application/pdf",
        });
        assert.equal(result.created, true);
    });

    await test("a document row missing current_version_id → not_ready domain error", async () => {
        const { deps, captured } = makeDeps(makeRecording({}));
        const { db } = makeDb({
            current_version_id: null,
            filename: "whatever.pdf",
        });
        await assert.rejects(
            draftRecordingEmail({
                db,
                recordingId: "rec-1",
                userId: "user-1",
                userEmail: "me@firm.test",
                input: {},
                deps,
            }),
            (err: unknown) => {
                assert.ok(err instanceof RecordingArtifactError);
                assert.equal(err.code, "not_ready");
                assert.match(err.message, /not available/i);
                return true;
            },
        );
        // No draft was cut once the guard failed.
        assert.equal(captured.emails.length, 0);
    });

    console.log("recordings/emailDraft.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
