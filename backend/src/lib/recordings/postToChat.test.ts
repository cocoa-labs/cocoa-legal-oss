// backend/src/lib/recordings/postToChat.test.ts
//
// postToChat posts the two durable assistant messages the pipeline surfaces into
// a chat: a `recording_card` (posted at capture) and a `recording_summary`
// (posted when the summary is ready). Both mirror the REAL assistant-message
// insert shape used across the codebase (routes/chat.ts line 801, email/autoReply.ts
// line 506): a `chat_messages` row with role "assistant" whose `content` is a
// jsonb array of typed blocks — and, critically, NO `user_id` (that column does
// not exist on chat_messages; see schema.sql). These tests pin the block shapes,
// the plain-text fallback block, the null-chatId no-op, and the missing-chat
// tolerance (chat deleted between create and ready → null, never a throw). A
// scripted Supabase stub stands in for the database.
import assert from "node:assert/strict";
import {
    insertRecordingCardMessage,
    insertRecordingSummaryMessage,
} from "./postToChat";
import type { Recording } from "./types";

function makeDb(result: { data?: unknown; error?: unknown }) {
    const inserts: { table: string; values: Record<string, unknown> }[] = [];
    const db = {
        from: (table: string) => ({
            insert: (values: Record<string, unknown>) => {
                inserts.push({ table, values });
                return {
                    select: () => ({
                        single: () =>
                            Promise.resolve({
                                data: result.data ?? null,
                                error: result.error ?? null,
                            }),
                    }),
                };
            },
        }),
    } as never;
    return { db, inserts };
}

function makeRecording(over: Partial<Recording>): Recording {
    return {
        id: "rec-1",
        user_id: "user-1",
        project_id: null,
        chat_id: "chat-1",
        chat_message_id: null,
        title: "Deposition",
        source: "mic",
        status: "ready",
        audio_storage_key: "r2/rec-1.webm",
        audio_mime: "audio/webm",
        audio_size_bytes: 1024,
        duration_seconds: 42,
        consent_ack_at: "2026-07-16T00:00:00Z",
        assemblyai_transcript_id: "t-1",
        utterances: [],
        transcript_text: null,
        summary_md: "## Summary\nBody text.",
        action_items: [
            { id: "item-1", text: "call the client", done: false, owner: null, due: null },
        ],
        transcript_document_id: "doc-9",
        voice_briefing_document_id: null,
        timeline_image_document_id: null,
        email_id: null,
        error: null,
        retry_count: 0,
        next_attempt_at: "2026-07-16T00:00:00Z",
        created_at: "2026-07-16T00:00:00Z",
        updated_at: "2026-07-16T00:00:00Z",
        ...over,
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
    console.log("recordings/postToChat.test.ts");

    await test("card message: assistant row, recording_card block, no user_id, returns id", async () => {
        const { db, inserts } = makeDb({ data: { id: "msg-1" } });
        const id = await insertRecordingCardMessage(db, {
            chatId: "chat-1",
            userId: "user-1",
            recordingId: "rec-1",
            title: "Client call",
            source: "mic",
        });
        assert.equal(id, "msg-1");
        assert.equal(inserts.length, 1);
        assert.equal(inserts[0].table, "chat_messages");
        assert.equal(inserts[0].values.chat_id, "chat-1");
        assert.equal(inserts[0].values.role, "assistant");
        // chat_messages has no user_id column — it must NOT be in the insert.
        assert.ok(!("user_id" in inserts[0].values));
        assert.deepEqual(inserts[0].values.content, [
            {
                type: "recording_card",
                recording_id: "rec-1",
                title: "Client call",
                source: "mic",
            },
        ]);
    });

    await test("summary message: plain-text fallback block + recording_summary block", async () => {
        const { db, inserts } = makeDb({ data: { id: "msg-2" } });
        const recording = makeRecording({
            id: "rec-2",
            title: "Deposition",
            summary_md: "## Summary\nBody text.",
            transcript_document_id: "doc-9",
        });
        const id = await insertRecordingSummaryMessage(db, {
            chatId: "chat-2",
            userId: "user-1",
            recording,
        });
        assert.equal(id, "msg-2");
        assert.equal(inserts[0].values.chat_id, "chat-2");
        assert.equal(inserts[0].values.role, "assistant");
        assert.ok(!("user_id" in inserts[0].values));
        const content = inserts[0].values.content as Record<string, unknown>[];
        // Block 0 — the plain-text fallback so history renders before the FE
        // recording_summary renderer lands (mirrors autoReply's {type:"content"}).
        assert.equal(content[0].type, "content");
        assert.equal(content[0].text, "## Summary\nBody text.");
        // Block 1 — the structured card the FE renders.
        assert.equal(content[1].type, "recording_summary");
        assert.equal(content[1].recording_id, "rec-2");
        assert.equal(content[1].title, "Deposition");
        assert.equal(content[1].summary_md, "## Summary\nBody text.");
        assert.deepEqual(content[1].action_items, recording.action_items);
        assert.equal(content[1].transcript_document_id, "doc-9");
    });

    await test("null chatId is a no-op returning null (db untouched)", async () => {
        const { db, inserts } = makeDb({ data: { id: "unused" } });
        const cardId = await insertRecordingCardMessage(db, {
            chatId: null,
            userId: "user-1",
            recordingId: "rec-1",
            title: "t",
            source: "upload",
        });
        assert.equal(cardId, null);
        const summaryId = await insertRecordingSummaryMessage(db, {
            chatId: null,
            userId: "user-1",
            recording: makeRecording({}),
        });
        assert.equal(summaryId, null);
        assert.equal(inserts.length, 0);
    });

    await test("tolerates a missing chat (insert error → null, never throws)", async () => {
        const { db, inserts } = makeDb({
            data: null,
            error: {
                message:
                    'insert on table "chat_messages" violates foreign key constraint',
            },
        });
        const id = await insertRecordingCardMessage(db, {
            chatId: "deleted-chat",
            userId: "user-1",
            recordingId: "rec-1",
            title: "t",
            source: "mic",
        });
        assert.equal(id, null);
        assert.equal(inserts.length, 1); // it did attempt the insert
    });

    console.log("recordings/postToChat.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
