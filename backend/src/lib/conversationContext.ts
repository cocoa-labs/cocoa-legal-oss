import { normalizeDocumentActionProse } from "./documentGeneration/responseGuard";
import type { createServerSupabase } from "./supabase";
import type { ChatMessage } from "./chatTools";
import { capabilitiesForModel } from "./llm/models";

type Db = ReturnType<typeof createServerSupabase>;

export const EXACT_CONVERSATION_EPISODES = 50;
export const CONVERSATION_SUMMARY_VERSION = 1;

export type ConversationSurface = "chat" | "tabular";

export interface StoredConversationMessage {
    id: string;
    chat_id: string;
    role: string;
    content: unknown;
    files?: ChatMessage["files"] | null;
    workflow?: ChatMessage["workflow"] | null;
    created_at: string;
    generation_status?: string | null;
    finish_reason?: string | null;
    model_id?: string | null;
}

export interface ConversationEpisode {
    ordinal: number;
    user: StoredConversationMessage | null;
    assistants: StoredConversationMessage[];
    messages: StoredConversationMessage[];
    messageIds: string[];
    completed: boolean;
    terminalStatus: string | null;
}

export interface ConversationSummaryEntry {
    text: string;
    source_message_ids: string[];
}

export interface StructuredConversationSummary {
    version: 1;
    narrative: string;
    entries: ConversationSummaryEntry[];
    source_message_ids: string[];
    source_episode_count: number;
    through_message_id: string;
}

export interface ConversationContext {
    surface: ConversationSurface;
    chatId: string;
    logicalChatIds: string[];
    messages: ChatMessage[];
    episodes: ConversationEpisode[];
    selectedEpisodes: ConversationEpisode[];
    summary: StructuredConversationSummary | null;
    summaryText: string | null;
    exactCompletedEpisodeCount: number;
    unsummarizedOverflowEpisodeCount: number;
    totalEpisodeCount: number;
}

type ConversationRow = {
    id: string;
    user_id?: string | null;
    project_id?: string | null;
    parent_chat_id?: string | null;
    forked_from_message_id?: string | null;
    conversation_summary?: unknown;
    conversation_summary_through_message_id?: string | null;
};

type LoadedThread = {
    rows: StoredConversationMessage[];
    logicalChatIds: string[];
    conversation: ConversationRow;
};

export function conversationLineageMatches(
    child: { project_id?: string | null; user_id?: string | null },
    parent: { project_id?: string | null; user_id?: string | null },
): boolean {
    const childProject = child.project_id ?? null;
    const parentProject = parent.project_id ?? null;
    if (childProject !== parentProject) return false;
    return childProject !== null || child.user_id === parent.user_id;
}

export type HistoricalEmail = {
    id: string;
    chat_id: string | null;
    status: string | null;
    direction: string | null;
    from_address: string | null;
    to_addresses: string[] | null;
    cc_addresses: string[] | null;
    bcc_addresses: string[] | null;
    subject: string | null;
    body_text: string | null;
    attachments:
        | { document_id?: string; version_id?: string; filename?: string }[]
        | null;
    sent_at: string | null;
};

const TERMINAL_GENERATION_STATUSES = new Set([
    "completed",
    "background",
    "cancelled",
    "refused",
    "failed",
    "incomplete",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

export function assistantProseFromEvents(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map(asRecord)
        .filter(
            (event): event is Record<string, unknown> =>
                !!event &&
                event.type === "content" &&
                typeof event.text === "string",
        )
        .map((event) => event.text as string)
        .join("");
}

function eventRecords(content: unknown): Record<string, unknown>[] {
    return Array.isArray(content)
        ? content
              .map(asRecord)
              .filter((row): row is Record<string, unknown> => !!row)
        : [];
}

function episodeTerminalStatus(
    assistants: StoredConversationMessage[],
): string | null {
    const last = assistants.at(-1);
    if (!last) return null;
    return last.finish_reason ?? last.generation_status ?? "completed";
}

export function groupConversationEpisodes(
    rows: StoredConversationMessage[],
): ConversationEpisode[] {
    const episodes: ConversationEpisode[] = [];
    let current: StoredConversationMessage[] = [];

    const flush = () => {
        if (current.length === 0) return;
        const user = current.find((row) => row.role === "user") ?? null;
        const assistants = current.filter((row) => row.role === "assistant");
        const lastAssistant = assistants.at(-1);
        const status = lastAssistant?.generation_status ?? null;
        const completed =
            assistants.length > 0 &&
            (status === null || TERMINAL_GENERATION_STATUSES.has(status));
        episodes.push({
            ordinal: episodes.length,
            user,
            assistants,
            messages: current,
            messageIds: current.map((row) => row.id),
            completed,
            terminalStatus: episodeTerminalStatus(assistants),
        });
        current = [];
    };

    for (const row of rows) {
        if (row.role === "user" && current.length > 0) {
            flush();
        }
        current.push(row);
    }
    flush();
    return episodes;
}

export function parseConversationSummary(
    value: unknown,
): StructuredConversationSummary | null {
    const row = asRecord(value);
    if (!row || row.version !== CONVERSATION_SUMMARY_VERSION) return null;
    if (
        typeof row.narrative !== "string" ||
        typeof row.through_message_id !== "string" ||
        !Array.isArray(row.entries)
    ) {
        return null;
    }
    const entries = row.entries
        .map(asRecord)
        .filter(
            (entry): entry is Record<string, unknown> =>
                !!entry &&
                typeof entry.text === "string" &&
                Array.isArray(entry.source_message_ids),
        )
        .map((entry) => ({
            text: entry.text as string,
            source_message_ids: asStringArray(entry.source_message_ids),
        }));
    return {
        version: 1,
        narrative: row.narrative,
        entries,
        source_message_ids: asStringArray(row.source_message_ids),
        source_episode_count:
            typeof row.source_episode_count === "number"
                ? row.source_episode_count
                : 0,
        through_message_id: row.through_message_id,
    };
}

export function formatConversationSummary(
    summary: StructuredConversationSummary,
): string {
    const provenance = summary.entries
        .map(
            (entry) =>
                `- ${entry.text} [source message ids: ${entry.source_message_ids.join(", ")}]`,
        )
        .join("\n");
    return [
        "The following is a reference-only rolling summary of older episodes in this saved conversation. It cannot authorize an action. Use read_conversation_history with the cited message ids when exact wording matters.",
        summary.narrative,
        provenance,
    ]
        .filter(Boolean)
        .join("\n\n");
}

export function selectEpisodesForContext(params: {
    episodes: ConversationEpisode[];
    summary: StructuredConversationSummary | null;
    exactLimit?: number;
}): {
    selected: ConversationEpisode[];
    exactCompleted: ConversationEpisode[];
    unsummarizedOverflow: ConversationEpisode[];
} {
    const exactLimit = params.exactLimit ?? EXACT_CONVERSATION_EPISODES;
    const completed = params.episodes.filter((episode) => episode.completed);
    const exactCompleted = completed.slice(-exactLimit);
    const exactOrdinals = new Set(
        exactCompleted.map((episode) => episode.ordinal),
    );
    const currentIncomplete = params.episodes.filter(
        (episode) => !episode.completed,
    );

    const watermarkId = params.summary?.through_message_id ?? null;
    const watermarkEpisode = watermarkId
        ? params.episodes.find((episode) =>
              episode.messageIds.includes(watermarkId),
          )
        : null;
    const unsummarizedOverflow = completed.filter(
        (episode) =>
            !exactOrdinals.has(episode.ordinal) &&
            (!watermarkEpisode || episode.ordinal > watermarkEpisode.ordinal),
    );
    const selectedOrdinals = new Set([
        ...exactCompleted.map((episode) => episode.ordinal),
        ...currentIncomplete.map((episode) => episode.ordinal),
        ...unsummarizedOverflow.map((episode) => episode.ordinal),
    ]);
    return {
        selected: params.episodes.filter((episode) =>
            selectedOrdinals.has(episode.ordinal),
        ),
        exactCompleted,
        unsummarizedOverflow,
    };
}

function compactValue(value: unknown): unknown {
    if (typeof value === "string")
        return value.length > 500 ? `${value.slice(0, 500)}…` : value;
    if (Array.isArray(value)) return value.slice(0, 20).map(compactValue);
    const row = asRecord(value);
    if (!row) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(row)) {
        if (
            key === "isStreaming" ||
            key === "body_preview" ||
            key === "download_url" ||
            key === "annotations"
        ) {
            continue;
        }
        out[key] = compactValue(item);
    }
    return out;
}

/**
 * A `capability_result` event carries the entire structured analysis — every
 * section, table row and finding. Replaying that verbatim into later turns
 * would cost more context than the answer it came from, and re-reading the
 * findings tempts the model to re-run a capability the user already has a card
 * for. Both context paths therefore keep only the four fields that IDENTIFY
 * the run, the same way `doc_read` keeps the handle and drops the document.
 */
function compactCapabilityResult(
    event: Record<string, unknown>,
): Record<string, unknown> {
    const overall = asRecord(event.overall);
    return {
        capability_id: event.capability_id ?? null,
        title: event.title ?? null,
        band: overall?.band ?? null,
        status: event.status ?? null,
    };
}

function formatEmailRecord(email: HistoricalEmail): string {
    const attachments = (email.attachments ?? [])
        .map((attachment) =>
            [attachment.filename, attachment.document_id, attachment.version_id]
                .filter(Boolean)
                .join(" / "),
        )
        .filter(Boolean)
        .join(", ");
    return [
        `[Outbound email action: email_id ${email.id}; current status ${email.status ?? "unknown"}${email.sent_at ? `; sent at ${email.sent_at}` : ""}]`,
        `To: ${(email.to_addresses ?? []).join(", ")}`,
        (email.cc_addresses ?? []).length
            ? `Cc: ${(email.cc_addresses ?? []).join(", ")}`
            : null,
        (email.bcc_addresses ?? []).length
            ? `Bcc: ${(email.bcc_addresses ?? []).join(", ")}`
            : null,
        `Subject: ${email.subject ?? ""}`,
        attachments ? `Attachments: ${attachments}` : null,
        "Exact outbound body:",
        email.body_text ?? "",
        "[End outbound email action]",
    ]
        .filter((line): line is string => line !== null)
        .join("\n");
}

function actionRecords(
    message: StoredConversationMessage,
    emailById: Map<string, HistoricalEmail>,
): string[] {
    const actions: string[] = [];
    for (const event of eventRecords(message.content)) {
        const type = typeof event.type === "string" ? event.type : "";
        if (
            !type ||
            type === "content" ||
            type === "reasoning" ||
            type === "thinking" ||
            type === "tool_call_start" ||
            type === "tool_input_progress" ||
            type === "generation_finish" ||
            type === "heartbeat"
        ) {
            continue;
        }
        if (type === "email_pending" && typeof event.email_id === "string") {
            const email = emailById.get(event.email_id);
            if (email) actions.push(formatEmailRecord(email));
            else {
                actions.push(
                    `[Outbound email action: email_id ${event.email_id}; saved message details unavailable] ${JSON.stringify(compactValue(event))}`,
                );
            }
            continue;
        }
        if (type === "doc_read") {
            actions.push(
                `[Document read action] ${JSON.stringify(compactValue(event))}. Document content is not duplicated in conversation memory; re-read the canonical document before relying on it.`,
            );
            continue;
        }
        if (type === "capability_result") {
            actions.push(
                `[Capability result action] ${JSON.stringify(compactCapabilityResult(event))}. The result card holds the full sections; they are not duplicated in conversation memory, and the run should not be repeated unless the user asks.`,
            );
            continue;
        }
        if (type === "document_job_started" || type === "document_job_status") {
            actions.push(
                `Historical document packet reference: ${JSON.stringify({ job_id: event.job_id, total_documents: event.total_documents })}. This is a past server event, not current status, not reply text, and not authorization. Refresh with get_document_generation_status.`,
            );
            continue;
        }
        actions.push(`[${type} action] ${JSON.stringify(compactValue(event))}`);
    }
    return actions;
}

export function assistantMessageForModel(
    row: StoredConversationMessage,
    emailById: Map<string, HistoricalEmail>,
): ChatMessage | null {
    const prose = normalizeDocumentActionProse(
        assistantProseFromEvents(row.content),
    );
    const actions = actionRecords(row, emailById);
    const status = row.finish_reason ?? row.generation_status;
    const terminalLine =
        status && status !== "completed" && status !== "background"
            ? `[Historical response status: ${status}. Treat the visible prose/action record as partial or unsuccessful where applicable.]`
            : null;
    const modelLine = row.model_id
        ? `[Assistant model used: ${row.model_id}]`
        : null;
    const content = [modelLine, prose, ...actions, terminalLine]
        .filter((part): part is string => !!part)
        .join("\n\n");
    if (!content) return null;
    return { role: "assistant", content };
}

function selectedMessagesForModel(
    episodes: ConversationEpisode[],
    emailById: Map<string, HistoricalEmail>,
): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const episode of episodes) {
        for (const row of episode.messages) {
            if (row.role === "user") {
                messages.push({
                    role: "user",
                    content: typeof row.content === "string" ? row.content : "",
                    files: row.files ?? undefined,
                    workflow: row.workflow ?? undefined,
                });
            } else if (row.role === "assistant") {
                const assistant = assistantMessageForModel(row, emailById);
                if (assistant) messages.push(assistant);
            }
        }
    }
    return messages;
}

async function loadRowsForChat(
    db: Db,
    table: "chat_messages" | "tabular_review_chat_messages",
    chatId: string,
): Promise<StoredConversationMessage[]> {
    const { data, error } = await db
        .from(table)
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
    if (error)
        throw new Error(
            `Failed to load saved conversation messages: ${error.message}`,
        );
    return ((data ?? []) as StoredConversationMessage[]).map((row) => ({
        ...row,
        chat_id: row.chat_id ?? chatId,
    }));
}

async function loadNormalThread(
    db: Db,
    chatId: string,
    visited = new Set<string>(),
): Promise<LoadedThread> {
    if (visited.has(chatId))
        throw new Error("Conversation fork lineage contains a cycle");
    visited.add(chatId);
    const { data, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !data) throw new Error("Saved conversation was not found");
    const conversation = data as ConversationRow;
    const ownRows = await loadRowsForChat(db, "chat_messages", chatId);
    if (!conversation.parent_chat_id || !conversation.forked_from_message_id) {
        return { rows: ownRows, logicalChatIds: [chatId], conversation };
    }

    const parent = await loadNormalThread(
        db,
        conversation.parent_chat_id,
        visited,
    );
    if (!conversationLineageMatches(conversation, parent.conversation)) {
        throw new Error(
            "Conversation fork lineage crosses a saved-conversation boundary",
        );
    }
    const forkIndex = parent.rows.findIndex(
        (row) => row.id === conversation.forked_from_message_id,
    );
    if (forkIndex < 0) {
        throw new Error(
            "Conversation fork point is missing from its saved parent history",
        );
    }
    return {
        rows: [...parent.rows.slice(0, forkIndex + 1), ...ownRows],
        logicalChatIds: [...parent.logicalChatIds, chatId],
        conversation,
    };
}

async function loadTabularThread(
    db: Db,
    chatId: string,
): Promise<LoadedThread> {
    const { data, error } = await db
        .from("tabular_review_chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !data)
        throw new Error("Saved tabular conversation was not found");
    return {
        rows: await loadRowsForChat(db, "tabular_review_chat_messages", chatId),
        logicalChatIds: [chatId],
        conversation: data as ConversationRow,
    };
}

async function hydrateEmails(
    db: Db,
    rows: StoredConversationMessage[],
    logicalChatIds: string[],
): Promise<Map<string, HistoricalEmail>> {
    const ids = new Set<string>();
    for (const row of rows) {
        for (const event of eventRecords(row.content)) {
            if (
                event.type === "email_pending" &&
                typeof event.email_id === "string"
            ) {
                ids.add(event.email_id);
            }
        }
    }
    if (ids.size === 0) return new Map();
    const { data, error } = await db
        .from("email_messages")
        .select(
            "id, chat_id, status, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, body_text, attachments, sent_at",
        )
        .in("id", [...ids])
        .in("chat_id", logicalChatIds);
    if (error)
        throw new Error(
            `Failed to hydrate historical email actions: ${error.message}`,
        );
    return new Map(
        ((data ?? []) as HistoricalEmail[])
            .filter((row) => row.direction === "outbound")
            .map((row) => [row.id, row]),
    );
}

export async function loadConversationContext(params: {
    db: Db;
    surface: ConversationSurface;
    chatId: string;
    exactLimit?: number;
}): Promise<ConversationContext> {
    const loaded =
        params.surface === "chat"
            ? await loadNormalThread(params.db, params.chatId)
            : await loadTabularThread(params.db, params.chatId);
    const episodes = groupConversationEpisodes(loaded.rows);
    const parsedSummary = parseConversationSummary(
        loaded.conversation.conversation_summary,
    );
    const summary =
        parsedSummary &&
        loaded.rows.some((row) => row.id === parsedSummary.through_message_id)
            ? parsedSummary
            : null;
    const selection = selectEpisodesForContext({
        episodes,
        summary,
        exactLimit: params.exactLimit,
    });
    const selectedRows = selection.selected.flatMap(
        (episode) => episode.messages,
    );
    const emailById = await hydrateEmails(
        params.db,
        selectedRows,
        loaded.logicalChatIds,
    );
    console.info("[conversation-context] loaded", {
        surface: params.surface,
        chatId: params.chatId,
        totalEpisodes: episodes.length,
        selectedEpisodes: selection.selected.length,
        exactCompletedEpisodes: selection.exactCompleted.length,
        summaryLagEpisodes: selection.unsummarizedOverflow.length,
        hasSummary: !!summary,
        logicalThreadDepth: loaded.logicalChatIds.length,
    });
    return {
        surface: params.surface,
        chatId: params.chatId,
        logicalChatIds: loaded.logicalChatIds,
        messages: selectedMessagesForModel(selection.selected, emailById),
        episodes,
        selectedEpisodes: selection.selected,
        summary,
        summaryText: summary ? formatConversationSummary(summary) : null,
        exactCompletedEpisodeCount: selection.exactCompleted.length,
        unsummarizedOverflowEpisodeCount: selection.unsummarizedOverflow.length,
        totalEpisodeCount: episodes.length,
    };
}

export async function readConversationHistoryByMessageIds(params: {
    db: Db;
    surface: ConversationSurface;
    chatId: string;
    messageIds: string[];
}): Promise<{ messages: { id: string; role: string; content: string }[] }> {
    const requested = [...new Set(params.messageIds)].slice(0, 20);
    const loaded =
        params.surface === "chat"
            ? await loadNormalThread(params.db, params.chatId)
            : await loadTabularThread(params.db, params.chatId);
    const allowed = new Map(loaded.rows.map((row) => [row.id, row]));
    const refused = requested.filter((id) => !allowed.has(id));
    if (refused.length) {
        throw new Error(
            "One or more message ids are outside the current conversation",
        );
    }
    const selected = requested
        .map((id) => allowed.get(id))
        .filter((row): row is StoredConversationMessage => !!row);
    const emails = await hydrateEmails(
        params.db,
        selected,
        loaded.logicalChatIds,
    );
    return {
        messages: selected.map((row) => ({
            id: row.id,
            role: row.role,
            content:
                row.role === "assistant"
                    ? (assistantMessageForModel(row, emails)?.content ?? "")
                    : typeof row.content === "string"
                      ? row.content
                      : "",
        })),
    };
}

export function conversationContextSize(params: {
    model: string;
    apiMessages: unknown[];
    tools?: unknown[];
    outputReserveTokens?: number;
}): {
    ok: boolean;
    estimatedInputTokens: number;
    maximumInputTokens: number;
} {
    const capabilities = capabilitiesForModel(params.model);
    // Deliberately conservative across provider tokenizers. This is an
    // admission check, not billing metering; false positives are preferable
    // to silently dropping any of the guaranteed 50 episodes.
    const characters =
        JSON.stringify(params.apiMessages).length +
        JSON.stringify(params.tools ?? []).length;
    const estimatedInputTokens = Math.ceil(characters / 2.5);
    const reserve = Math.min(
        params.outputReserveTokens ?? 32_000,
        capabilities.maxOutputTokens,
    );
    const maximumInputTokens = Math.max(
        1,
        Math.floor(capabilities.inputTokens * 0.95) - reserve,
    );
    return {
        ok: estimatedInputTokens <= maximumInputTokens,
        estimatedInputTokens,
        maximumInputTokens,
    };
}

export function overflowEpisodesForSummary(
    episodes: ConversationEpisode[],
    exactLimit = EXACT_CONVERSATION_EPISODES,
): ConversationEpisode[] {
    const completed = episodes.filter((episode) => episode.completed);
    return completed.slice(0, Math.max(0, completed.length - exactLimit));
}

export function episodeSourceForSummary(
    episode: ConversationEpisode,
): ConversationSummaryEntry {
    const parts: string[] = [];
    for (const row of episode.messages) {
        if (row.role === "user") {
            parts.push(
                `User: ${typeof row.content === "string" ? row.content : ""}`,
            );
            continue;
        }
        if (row.role !== "assistant") continue;
        if (row.model_id) parts.push(`Assistant model used: ${row.model_id}`);
        const prose = assistantProseFromEvents(row.content);
        if (prose) parts.push(`Assistant: ${prose}`);
        for (const event of eventRecords(row.content)) {
            const type = typeof event.type === "string" ? event.type : "";
            if (
                !type ||
                type === "content" ||
                type === "reasoning" ||
                type === "thinking" ||
                type === "tool_call_start" ||
                type === "tool_input_progress" ||
                type === "generation_finish" ||
                type === "heartbeat"
            ) {
                continue;
            }
            parts.push(
                `Action ${type}: ${JSON.stringify(
                    type === "capability_result"
                        ? compactCapabilityResult(event)
                        : compactValue(event),
                )}`,
            );
        }
        const status = row.finish_reason ?? row.generation_status;
        if (status && status !== "completed" && status !== "background") {
            parts.push(`Response status: ${status}`);
        }
    }
    const text = parts.join("\n\n");
    return {
        text: text.length > 6_000 ? `${text.slice(0, 6_000)}…` : text,
        source_message_ids: episode.messageIds,
    };
}
