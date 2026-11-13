// backend/src/lib/recordings/postToChat.ts
//
// Durable assistant messages the recordings pipeline surfaces into a chat: a
// `recording_card` (posted when capture starts) and a `recording_summary`
// (posted when the summary is ready). Both mirror the REAL structured-assistant
// insert shape the codebase already uses — routes/chat.ts (line 801) and
// email/autoReply.ts (line 506) insert a `chat_messages` row with role
// "assistant" whose `content` is a jsonb ARRAY of typed blocks. So the recording
// blocks ride in `content` directly, exactly like autoReply's email cards.
//
// NOTE (divergence from the Task-4 brief, following the codebase — see report):
// the brief lists a `user_id` column on chat_messages, but schema.sql has none
// (id, chat_id, role, content, files, annotations, workflow, version_context,
// created_at) and NO insert in the codebase sets it. `userId` stays in the
// signature for call-site parity (the pipeline passes it) but is NOT persisted.
//
// Posting to chat is best-effort: the `recordings` row is the source of truth,
// so a chat that was deleted between create and ready (chat_id is an FK) degrades
// to null — never a throw — and a null chatId is a no-op.

import type { createServerSupabase } from "../supabase";
import { describeSupabaseError } from "../documentVersions";
import type { Recording, RecordingSource } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Insert one assistant `chat_messages` row carrying `content` (a jsonb array of
 * blocks) and return its id. No-op (null) when chatId is null; tolerates a
 * missing chat (FK violation on a deleted chat) by logging and returning null
 * rather than throwing — mirrors storage.ts's "degrade to null, but never
 * silently" discipline.
 */
async function insertAssistantMessage(
    db: Db,
    chatId: string | null,
    content: Record<string, unknown>[],
    label: string,
): Promise<string | null> {
    if (!chatId) return null;
    const { data, error } = await db
        .from("chat_messages")
        .insert({ chat_id: chatId, role: "assistant", content })
        .select("id")
        .single();
    if (error || !data) {
        console.warn(`[recordings] ${label} skipped`, {
            chatId,
            error: describeSupabaseError(error),
        });
        return null;
    }
    return String((data as { id: unknown }).id);
}

/**
 * Post the capture-time `recording_card` block. Returns the inserted message id
 * (the pipeline stores it on `recordings.chat_message_id`), or null.
 */
export async function insertRecordingCardMessage(
    db: Db,
    args: {
        chatId: string | null;
        /** Accepted for call-site parity; NOT persisted (chat_messages has no
         * user_id column). */
        userId: string;
        recordingId: string;
        title: string;
        source: RecordingSource;
    },
): Promise<string | null> {
    return insertAssistantMessage(
        db,
        args.chatId,
        [
            {
                type: "recording_card",
                recording_id: args.recordingId,
                title: args.title,
                source: args.source,
            },
        ],
        "insertRecordingCardMessage",
    );
}

/**
 * Post the ready-time `recording_summary` block, preceded by a plain-text
 * `{ type: "content" }` block carrying the summary Markdown so chat history
 * renders the summary even before the frontend recording_summary renderer ships
 * (mirrors autoReply.ts's lead-in text block). Returns the inserted id, or null.
 */
export async function insertRecordingSummaryMessage(
    db: Db,
    args: {
        chatId: string | null;
        /** Accepted for call-site parity; NOT persisted (see above). */
        userId: string;
        recording: Recording;
    },
): Promise<string | null> {
    const r = args.recording;
    const summaryMd = r.summary_md ?? "";
    const content: Record<string, unknown>[] = [
        { type: "content", text: summaryMd },
        {
            type: "recording_summary",
            recording_id: r.id,
            title: r.title,
            summary_md: summaryMd,
            action_items: r.action_items,
            transcript_document_id: r.transcript_document_id,
        },
    ];
    return insertAssistantMessage(
        db,
        args.chatId,
        content,
        "insertRecordingSummaryMessage",
    );
}
