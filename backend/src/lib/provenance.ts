import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * The conversation turn that produced a document version. The backbone is
 * document_edits.chat_message_id — the dominant edit path (runEditDocument)
 * writes edits but creates no agent_operation, so the edit link is the only
 * source that covers ordinary edits. agent_operations.result_version_id and
 * document_highlight_sets are supplementary (cover generate / highlight /
 * replicate / email / signature). A version with no producing turn (e.g. an
 * upload) resolves to no entry — never fabricated.
 */
export type VersionProvenance = {
    version_id: string;
    chat_id: string | null;
    chat_message_id: string | null;
    operation_id: string | null;
    source: "edit" | "operation" | "highlight";
};

/**
 * Resolve, for a set of version ids, which conversation turn produced each.
 * One batched query per source table; left-joins throughout (an unmatched
 * version simply has no entry in the returned map). Resilient to a not-yet-
 * applied migration 018 (agent_operations.chat_message_id): if that column is
 * absent, the operation link degrades to chat-level only.
 */
export async function resolveVersionProvenance(
    db: Db,
    versionIds: string[],
): Promise<Map<string, VersionProvenance>> {
    const out = new Map<string, VersionProvenance>();
    const ids = Array.from(new Set(versionIds.filter(Boolean)));
    if (ids.length === 0) return out;

    // 1. Edits (primary): version_id -> earliest chat_message_id.
    const editByVersion = new Map<string, string>();
    {
        const { data } = await db
            .from("document_edits")
            .select("version_id, chat_message_id, created_at")
            .in("version_id", ids)
            .not("chat_message_id", "is", null)
            .order("created_at", { ascending: true });
        for (const r of (data ?? []) as {
            version_id: string;
            chat_message_id: string | null;
        }[]) {
            if (r.chat_message_id && !editByVersion.has(r.version_id))
                editByVersion.set(r.version_id, r.chat_message_id);
        }
    }

    // 2. Highlight sets (supplementary): version_id -> earliest chat_message_id.
    const highlightByVersion = new Map<string, string>();
    {
        const { data } = await db
            .from("document_highlight_sets")
            .select("version_id, chat_message_id, created_at")
            .in("version_id", ids)
            .not("chat_message_id", "is", null)
            .order("created_at", { ascending: true });
        for (const r of (data ?? []) as {
            version_id: string | null;
            chat_message_id: string | null;
        }[]) {
            if (
                r.version_id &&
                r.chat_message_id &&
                !highlightByVersion.has(r.version_id)
            )
                highlightByVersion.set(r.version_id, r.chat_message_id);
        }
    }

    // 3. Operations (supplementary): result_version_id -> {chat_id, msg, op}.
    const opByVersion = new Map<
        string,
        { chat_id: string | null; chat_message_id: string | null; operation_id: string }
    >();
    {
        type OpRow = {
            result_version_id: string | null;
            chat_id: string | null;
            chat_message_id?: string | null;
            id: string;
        };
        const withMsg =
            "result_version_id, chat_id, chat_message_id, id, created_at";
        const withoutMsg = "result_version_id, chat_id, id, created_at";
        const first = await db
            .from("agent_operations")
            .select(withMsg)
            .in("result_version_id", ids)
            .order("created_at", { ascending: true });
        let rows = (first.data ?? null) as OpRow[] | null;
        if (first.error && /chat_message_id/i.test(first.error.message ?? "")) {
            // Migration 018 not applied yet — fall back to chat-level only.
            const fallback = await db
                .from("agent_operations")
                .select(withoutMsg)
                .in("result_version_id", ids)
                .order("created_at", { ascending: true });
            rows = (fallback.data ?? null) as OpRow[] | null;
        }
        for (const r of rows ?? []) {
            if (r.result_version_id && !opByVersion.has(r.result_version_id))
                opByVersion.set(r.result_version_id, {
                    chat_id: r.chat_id ?? null,
                    chat_message_id: r.chat_message_id ?? null,
                    operation_id: r.id,
                });
        }
    }

    // 4. Resolve chat_id for message-only links via chat_messages.
    const msgIds = new Set<string>();
    for (const m of editByVersion.values()) msgIds.add(m);
    for (const m of highlightByVersion.values()) msgIds.add(m);
    const chatByMessage = new Map<string, string>();
    if (msgIds.size > 0) {
        const { data } = await db
            .from("chat_messages")
            .select("id, chat_id")
            .in("id", Array.from(msgIds));
        for (const r of (data ?? []) as { id: string; chat_id: string }[])
            chatByMessage.set(r.id, r.chat_id);
    }

    for (const versionId of ids) {
        const editMsg = editByVersion.get(versionId);
        const op = opByVersion.get(versionId);
        const hlMsg = highlightByVersion.get(versionId);
        if (editMsg) {
            out.set(versionId, {
                version_id: versionId,
                chat_message_id: editMsg,
                chat_id: chatByMessage.get(editMsg) ?? op?.chat_id ?? null,
                operation_id: op?.operation_id ?? null,
                source: "edit",
            });
        } else if (op && (op.chat_id || op.chat_message_id)) {
            out.set(versionId, {
                version_id: versionId,
                chat_message_id: op.chat_message_id,
                chat_id:
                    op.chat_id ??
                    (op.chat_message_id
                        ? chatByMessage.get(op.chat_message_id) ?? null
                        : null),
                operation_id: op.operation_id,
                source: "operation",
            });
        } else if (hlMsg) {
            out.set(versionId, {
                version_id: versionId,
                chat_message_id: hlMsg,
                chat_id: chatByMessage.get(hlMsg) ?? null,
                operation_id: null,
                source: "highlight",
            });
        }
    }

    return out;
}
