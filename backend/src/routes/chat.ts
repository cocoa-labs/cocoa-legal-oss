import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildDocContext,
    buildMessages,
    collectConversationImageAttachmentIds,
    buildToolset,
    enrichWithPriorEvents,
    buildWorkflowStore,
    extractAnnotations,
    runLLMStream,
    resolveSystemPromptCtx,
    type ChatMessage,
} from "../lib/chatTools";
import {
    completeText,
    DEFAULT_MAIN_MODEL,
    resolveAvailableMainModel,
    resolveModel,
} from "../lib/llm";
import {
    parseCapabilityRun,
    parseCurrentChatMessage,
    parseEditImageSource,
} from "../lib/chatMessages";
import { getCapability } from "../lib/legalCapabilities";
import type { PlaybookEntry } from "../lib/playbooks";
import {
    buildCapabilityRunPrompt,
    capabilityResultToDocxSections,
    failedCapabilityResult,
    resolveEscalationTemplate,
    type CapabilityResultEvent,
    type CapabilityRunContext,
} from "../lib/legalCapabilities/run";
import {
    persistAuthoredDocx,
    renderSectionsToDocxBuffer,
} from "../lib/docxAssembly";
import { buildDownloadUrl } from "../lib/downloadTokens";
import { temporalGroundingLine } from "../lib/systemPrompt/temporalContext";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    listAccessibleProjectIds,
    type ProjectPermission,
} from "../lib/access";
import { loadRecentImageAttachments } from "../lib/chatAttachments";
import {
    buildIntentAttachments,
    intentClassifierModel,
    intentPostStreamGraceMs,
    runIntentDetection,
    withDeadline,
    type IntentDetectionResult,
} from "../lib/intentDetection";
import {
    alreadyRunCapabilityIds,
    chatAuditScope,
    mergeSuggestionSettings,
    parseSuggestionAction,
    readSuggestionSettings,
} from "../lib/chatSuggestions";
import { recordAuditEvent } from "../lib/audit";
import {
    conversationContextSize,
    loadConversationContext,
} from "../lib/conversationContext";
import { queueConversationSummary } from "../lib/conversationSummary/worker";
import { assistantResponseIntegrity } from "../lib/assistantResponseIntegrity";

export const chatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

type AccessibleChat = {
    id: string;
    title: string | null;
    user_id: string;
    project_id: string | null;
} & Record<string, unknown>;

function parseOptionalProjectId(
    value: unknown,
):
    | { ok: true; provided: boolean; projectId: string | null }
    | { ok: false; detail: string } {
    if (value === undefined)
        return { ok: true, provided: false, projectId: null };
    if (value === null) return { ok: true, provided: true, projectId: null };
    if (typeof value !== "string" || !value.trim()) {
        return {
            ok: false,
            detail: "project_id must be a non-empty string or null",
        };
    }
    return { ok: true, provided: true, projectId: value.trim() };
}

function parseOptionalChatId(
    value: unknown,
): { ok: true; chatId: string | null } | { ok: false; detail: string } {
    if (value === undefined || value === null)
        return { ok: true, chatId: null };
    if (typeof value !== "string" || !value.trim()) {
        return { ok: false, detail: "chat_id must be a non-empty string" };
    }
    return { ok: true, chatId: value.trim() };
}

function parseOptionalModel(
    value: unknown,
): { ok: true; model: string | undefined } | { ok: false; detail: string } {
    if (value === undefined) return { ok: true, model: undefined };
    if (typeof value !== "string" || !value.trim()) {
        return { ok: false, detail: "model must be a non-empty string" };
    }
    const trimmed = value.trim();
    if (resolveModel(trimmed, "") === "") {
        return { ok: false, detail: "model is not a recognized model id" };
    }
    return { ok: true, model: trimmed };
}

async function validateAccessibleProjectId(
    projectId: string | null,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    if (!projectId) return { ok: true };
    const access = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!access.ok)
        return { ok: false, status: 404, detail: "Project not found" };
    return { ok: true };
}

async function getAccessibleChat(
    chatId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
    permission: ProjectPermission = "read",
): Promise<AccessibleChat | null> {
    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();
    if (error || !chat) return null;

    const row = chat as AccessibleChat;
    if (row.project_id) {
        const access = await checkProjectAccess(
            row.project_id,
            userId,
            userEmail,
            db,
            permission,
        );
        if (access.ok) return row;
        return null;
    }

    return row.user_id === userId ? row : null;
}

/** Longest chat-title search term we'll accept; anything more is noise. */
export const MAX_CHAT_SEARCH_LENGTH = 100;

/**
 * Normalize the optional `search` query param for GET /chat.
 *
 * Returns null when there is no usable term, so callers can skip the filter
 * entirely rather than running a `%%` match. No PostgREST escaping happens
 * here on purpose: the term goes into a standalone `.ilike("title", …)` call
 * (not into the `.or(...)` filter string), so there is no delimiter to break
 * out of. A user-typed `%` or `_` just widens the match across their OWN
 * chats, which is harmless.
 */
export function normalizeChatSearch(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().slice(0, MAX_CHAT_SEARCH_LENGTH);
    return trimmed.length > 0 ? trimmed : null;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
//
// Optional `?search=` filters by chat TITLE only (case-insensitive,
// substring). Message bodies are deliberately not searched.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : null;
    const search = normalizeChatSearch(req.query.search);

    const projectIds = await listAccessibleProjectIds(userId, userEmail, db);
    let standaloneQuery = db
        .from("chats")
        .select("*")
        .eq("user_id", userId)
        .is("project_id", null)
        .order("created_at", { ascending: false });
    let projectQuery = db
        .from("chats")
        .select("*")
        .in(
            "project_id",
            projectIds.length
                ? projectIds
                : ["00000000-0000-0000-0000-000000000000"],
        )
        .order("created_at", { ascending: false });
    if (search) {
        standaloneQuery = standaloneQuery.ilike("title", `%${search}%`);
        projectQuery = projectQuery.ilike("title", `%${search}%`);
    }
    if (limit) {
        standaloneQuery = standaloneQuery.limit(limit);
        projectQuery = projectQuery.limit(limit);
    }
    const [standaloneResult, projectResult] = await Promise.all([
        standaloneQuery,
        projectQuery,
    ]);
    const error = standaloneResult.error ?? projectResult.error;
    if (error) return void res.status(500).json({ detail: error.message });
    const chats = [
        ...(standaloneResult.data ?? []),
        ...(projectResult.data ?? []),
    ]
        .sort((left, right) =>
            String(right.created_at ?? "").localeCompare(
                String(left.created_at ?? ""),
            ),
        )
        .slice(0, limit ?? undefined);
    res.json(chats);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const projectId = parsedProjectId.projectId;
    const db = createServerSupabase();
    const projectAccess = await validateAccessibleProjectId(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res
            .status(projectAccess.status)
            .json({ detail: projectAccess.detail });

    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? null })
        .select("id")
        .single();

    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const chat = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });

    const { data: ownMessages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    // Fork (REFERENCE model): prepend the parent's turns up to and including
    // the fork point, tagged so the UI renders them as inherited "from the main
    // thread." Single parent hop — chat_messages are append-only, so the parent
    // slice is a stable, audit-clean record without copying rows.
    let inherited: Record<string, unknown>[] = [];
    const chatRow = chat as Record<string, unknown>;
    const parentChatId = chatRow.parent_chat_id as string | null | undefined;
    const forkedFromMessageId = chatRow.forked_from_message_id as
        | string
        | null
        | undefined;
    if (parentChatId && forkedFromMessageId) {
        const { data: forkPoint } = await db
            .from("chat_messages")
            .select("created_at")
            .eq("id", forkedFromMessageId)
            .maybeSingle();
        if (forkPoint?.created_at) {
            const { data: parentMsgs } = await db
                .from("chat_messages")
                .select("*")
                .eq("chat_id", parentChatId)
                .lte("created_at", forkPoint.created_at as string)
                .order("created_at", { ascending: true });
            inherited = (parentMsgs ?? []).map((m) => ({
                ...m,
                inherited_from_chat_id: parentChatId,
            }));
        }
    }

    const combined = [...inherited, ...(ownMessages ?? [])];
    const hydrated = await hydrateDocumentGenerationJobs(
        await hydrateEditStatuses(combined, db),
        db,
    );
    res.json({ chat, messages: hydrated });
});

async function hydrateDocumentGenerationJobs(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
) {
    const assistantIds = messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id)
        .filter((id): id is string => typeof id === "string");
    if (!assistantIds.length) return messages;
    const { data, error } = await db
        .from("document_generation_jobs")
        .select("id, assistant_message_id, total_items")
        .in("assistant_message_id", assistantIds);
    // Backward-compatible before migration 031 is applied.
    if (error || !data?.length) return messages;

    const jobsByMessage = new Map<
        string,
        { id: string; total_items: number }[]
    >();
    for (const row of data as {
        id: string;
        assistant_message_id: string;
        total_items: number;
    }[]) {
        const list = jobsByMessage.get(row.assistant_message_id) ?? [];
        list.push({ id: row.id, total_items: row.total_items });
        jobsByMessage.set(row.assistant_message_id, list);
    }
    return messages.map((message) => {
        const id = typeof message.id === "string" ? message.id : "";
        const jobs = jobsByMessage.get(id);
        if (!jobs?.length) return message;
        const content = Array.isArray(message.content)
            ? ([...message.content] as Record<string, unknown>[])
            : [];
        for (const job of jobs) {
            if (
                content.some(
                    (event) =>
                        event.type === "document_job_started" &&
                        event.job_id === job.id,
                )
            )
                continue;
            content.push({
                type: "document_job_started",
                job_id: job.id,
                total_documents: job.total_items,
            });
        }
        return { ...message, content };
    });
}

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const emailIds = new Set<string>();
    const envelopeIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string") versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        collectFromAnnList(m.annotations);
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                } else if (
                    ev?.type === "email_pending" &&
                    typeof ev.email_id === "string"
                ) {
                    emailIds.add(ev.email_id);
                } else if (
                    ev?.type === "signature_pending" &&
                    typeof ev.envelope_id === "string"
                ) {
                    envelopeIds.add(ev.envelope_id);
                }
            }
        }
    }
    if (
        editIds.size === 0 &&
        versionIds.size === 0 &&
        emailIds.size === 0 &&
        envelopeIds.size === 0
    )
        return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    // Email / signature draft status patch — a persisted email_pending /
    // signature_pending event captured the status at draft time
    // ("pending_approval"); the real email/envelope may since have been sent or
    // cancelled. Merge the current status so a reloaded card renders the true
    // state (Sent / Cancelled / live signature progress) instead of a stale
    // approve affordance. Tolerant: a missing table/row leaves the event as-is.
    const emailStatusById = new Map<string, string>();
    if (emailIds.size > 0) {
        const { data: erows } = await db
            .from("email_messages")
            .select("id, status")
            .in("id", Array.from(emailIds));
        for (const r of (erows ?? []) as { id: string; status: string }[]) {
            emailStatusById.set(r.id, r.status);
        }
    }
    const envelopeStatusById = new Map<string, string>();
    // Whether the document has moved past the version the request was pinned
    // to. The approve button on a reloaded card would otherwise look ordinary
    // right up until approval refuses with SIGNATURE_STALE_VERSION.
    const envelopeChangedById = new Map<string, boolean>();
    if (envelopeIds.size > 0) {
        const { data: srows } = await db
            .from("signature_envelopes")
            .select("id, status, document_id, source_version_id")
            .in("id", Array.from(envelopeIds));
        const rows = (srows ?? []) as {
            id: string;
            status: string;
            document_id: string | null;
            source_version_id: string | null;
        }[];
        for (const r of rows) {
            envelopeStatusById.set(r.id, r.status);
        }
        // Only still-approvable, still-pinned envelopes can be stale; legacy
        // unpinned ones are never blocked, so they get no flag. ONE batched
        // documents query for all of them — a per-event lookup would be N+1
        // over a chat's whole history — and zero queries when there are none.
        const pending = rows.filter(
            (r) =>
                r.status === "pending_approval" &&
                r.source_version_id &&
                r.document_id,
        );
        if (pending.length > 0) {
            const { data: drows } = await db
                .from("documents")
                .select("id, current_version_id")
                .in(
                    "id",
                    Array.from(new Set(pending.map((r) => r.document_id))),
                );
            const currentByDoc = new Map<string, string | null>();
            for (const d of (drows ?? []) as {
                id: string;
                current_version_id: string | null;
            }[]) {
                currentByDoc.set(d.id, d.current_version_id ?? null);
            }
            for (const r of pending) {
                const current = currentByDoc.get(r.document_id as string);
                // An unknown / version-less document proves nothing; only an
                // actual disagreement counts as changed.
                if (!current) continue;
                envelopeChangedById.set(r.id, current !== r.source_version_id);
            }
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        next.annotations = patchAnnList(m.annotations);
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type === "doc_edited") {
                        let patched: Record<string, unknown> = {
                            ...ev,
                            annotations: patchAnnList(ev.annotations),
                        };
                        if (
                            typeof ev.version_id === "string" &&
                            versionNumberById.has(ev.version_id)
                        ) {
                            patched = {
                                ...patched,
                                version_number:
                                    versionNumberById.get(ev.version_id) ??
                                    null,
                            };
                        }
                        return patched;
                    }
                    if (
                        ev?.type === "email_pending" &&
                        typeof ev.email_id === "string" &&
                        emailStatusById.has(ev.email_id)
                    ) {
                        return {
                            ...ev,
                            status: emailStatusById.get(ev.email_id),
                        };
                    }
                    if (
                        ev?.type === "signature_pending" &&
                        typeof ev.envelope_id === "string" &&
                        envelopeStatusById.has(ev.envelope_id)
                    ) {
                        return {
                            ...ev,
                            status: envelopeStatusById.get(ev.envelope_id),
                            ...(envelopeChangedById.has(ev.envelope_id)
                                ? {
                                      document_changed: envelopeChangedById.get(
                                          ev.envelope_id,
                                      ),
                                  }
                                : {}),
                        };
                    }
                    return ev;
                },
            );
        }
        return next;
    });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const title = (req.body.title ?? "").trim();
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const db = createServerSupabase();
    const chat = await getAccessibleChat(
        chatId,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });
    const { data, error } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .select("id, title")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const chat = await getAccessibleChat(
        chatId,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });
    const { error } = await db.from("chats").delete().eq("id", chatId);

    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message =
        typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message)
        return void res.status(400).json({ detail: "message is required" });

    const db = createServerSupabase();
    const chat = await getAccessibleChat(
        chatId,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });

    try {
        const { title_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
            apiKeys: api_keys,
        });
        const title = titleText.trim() || message.slice(0, 60);

        await db.from("chats").update({ title }).eq("id", chatId);

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessage = parseCurrentChatMessage(body.message, body.messages);
    if (!parsedMessage.ok) {
        return void res.status(400).json({ detail: parsedMessage.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedProjectId = parseOptionalProjectId(body.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }

    // A confirmed in-chat capability run. Resolved here, with every other
    // request-level guard, so an unrunnable capability is refused BEFORE a
    // chat or a message row exists — a run that cannot produce a card should
    // leave no trace of having been attempted.
    const capabilityRun = parseCapabilityRun(body.capability_run);
    const runCapability = capabilityRun
        ? getCapability(capabilityRun.capabilityId)
        : null;
    if (capabilityRun) {
        if (
            !runCapability ||
            runCapability.workflow.type !== "assistant" ||
            !runCapability.outputSpec
        ) {
            return void res.status(400).json({
                code: "capability_not_runnable_in_chat",
                detail: `Capability "${capabilityRun.capabilityId}" cannot be run in chat.`,
            });
        }
    }

    const currentMessage = parsedMessage.message;
    const chat_id = parsedChatId.chatId;
    const project_id = parsedProjectId.projectId;
    const model = parsedModel.model;

    devLog("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        payloadMode: parsedMessage.usedLegacyPayload
            ? "legacy"
            : "current-turn",
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;
    let resolvedProjectId: string | null = parsedProjectId.projectId;
    // Kept for the suggestion-settings read and the audit scope below. Null
    // for a chat created on this very turn — which has no settings yet, and
    // readSuggestionSettings treats that as "firm defaults apply".
    let chatRow: AccessibleChat | null = null;

    if (chatId) {
        const existing = await getAccessibleChat(
            chatId,
            userId,
            userEmail,
            db,
            "mutate",
        );
        if (!existing)
            return void res.status(404).json({ detail: "Chat not found" });

        const existingProjectId = existing.project_id ?? null;
        if (
            parsedProjectId.provided &&
            parsedProjectId.projectId !== existingProjectId
        ) {
            return void res
                .status(400)
                .json({ detail: "project_id does not match chat" });
        }
        resolvedProjectId = existingProjectId;
        chatTitle = existing.title;
        chatRow = existing;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        const projectAccess = await validateAccessibleProjectId(
            resolvedProjectId,
            userId,
            userEmail,
            db,
        );
        if (!projectAccess.ok)
            return void res
                .status(projectAccess.status)
                .json({ detail: projectAccess.detail });

        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: resolvedProjectId })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    devLog("[chat/stream] resolved chatId", chatId);

    const conversationContext = await loadConversationContext({
        db,
        surface: "chat",
        chatId,
    }).catch((error) => {
        console.error("[conversation-context] load failed", {
            surface: "chat",
            chatId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    });
    if (!conversationContext) {
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to load the saved conversation",
        });
    }
    if (conversationContext.unsummarizedOverflowEpisodeCount > 0) {
        await queueConversationSummary({
            db,
            surface: "chat",
            chatId,
            completedEpisodeCount: conversationContext.episodes.filter(
                (episode) => episode.completed,
            ).length,
        }).catch((error) => {
            console.error("[conversation-summary] lazy backfill queue failed", {
                chatId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    // Only the current browser turn is accepted. Every historical turn comes
    // from saved rows (including inherited fork history).
    const messages: ChatMessage[] = [
        ...conversationContext.messages,
        currentMessage,
    ];
    const lastUser = currentMessage;

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
        userEmail,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const imageAttachments = await loadRecentImageAttachments(
        enrichedMessages,
        userId,
        db,
        { projectId: resolvedProjectId, limit: 4 },
    );

    // Steering chain: resolve the firm's playbook for the capability(ies)
    // this turn looks like. selectRelevantPlaybookKeys returns [] until a
    // capability is registered, so today this resolves to no keys and the
    // empty-ctx path keeps the prompt byte-identical. Once a capability
    // registers and the message matches it, the firm-aware prompt path
    // activates with only the relevant playbook entries substituted in.
    // On a run turn the capability is FORCED rather than matched: the user
    // already confirmed it, so its fragment and playbook keys are in scope
    // whatever the message text happens to look like.
    const systemPromptCtx = await resolveSystemPromptCtx(
        db,
        userId,
        lastUser,
        runCapability ? { forceCapabilityIds: [runCapability.id] } : undefined,
    );
    if (userEmail) systemPromptCtx.userEmail = userEmail;
    // Temporal grounding: authoritative server clock, displayed in the user's
    // browser timezone (validated + defaulted inside temporalGroundingLine).
    const clientTz =
        typeof body.client_time_zone === "string"
            ? body.client_time_zone
            : undefined;
    systemPromptCtx.currentDateLine = temporalGroundingLine({
        timeZone: clientTz,
    });
    systemPromptCtx.conversationSummary =
        conversationContext.summaryText ?? undefined;
    // SystemPromptContext widens the entry type to `unknown`; what
    // resolveSystemPromptCtx actually stores is getEffectivePlaybookEntries'
    // Record<string, PlaybookEntry>.
    const resolvedPlaybook = (systemPromptCtx.resolvedPlaybook ??
        {}) as Record<string, PlaybookEntry>;
    const capabilityRunContext: CapabilityRunContext | null =
        capabilityRun && runCapability
            ? {
                  cap: runCapability,
                  capabilityRun,
                  escalationTemplate: resolveEscalationTemplate(
                      runCapability,
                      resolvedPlaybook,
                  ),
              }
            : null;
    const runPrompt =
        capabilityRun && runCapability
            ? buildCapabilityRunPrompt({
                  cap: runCapability,
                  resolvedPlaybook,
                  docIndex,
                  documentIds: capabilityRun.documentIds,
                  representedParty: capabilityRun.inputs.representedParty,
              })
            : undefined;
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        runPrompt,
        docIndex,
        imageAttachments,
        systemPromptCtx,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    const apiKeys = await getUserApiKeys(userId, db);
    const selectedModel = resolveAvailableMainModel(model, apiKeys);
    const contextCapacity = conversationContextSize({
        model: selectedModel,
        apiMessages,
        tools: buildToolset(),
    });
    console.info("[conversation-context] capacity", {
        surface: "chat",
        chatId,
        model: selectedModel,
        estimatedInputTokens: contextCapacity.estimatedInputTokens,
        maximumInputTokens: contextCapacity.maximumInputTokens,
        fits: contextCapacity.ok,
    });
    if (!contextCapacity.ok) {
        return void res.status(422).json({
            code: "conversation_context_too_large",
            detail: "This saved conversation's guaranteed 50-episode context does not fit the selected model. Choose a model with a larger context window; no conversation history was truncated.",
            estimated_input_tokens: contextCapacity.estimatedInputTokens,
            maximum_input_tokens: contextCapacity.maximumInputTokens,
        });
    }

    const userRow: Record<string, unknown> = {
        chat_id: chatId,
        role: "user",
        content: lastUser.content,
        files: lastUser.files ?? null,
        workflow: lastUser.workflow ?? null,
    };
    if (capabilityRun) {
        userRow.capability_run = {
            capability_id: capabilityRun.capabilityId,
            proposal_id: capabilityRun.proposalId,
            document_ids: capabilityRun.documentIds,
            inputs: {
                represented_party: capabilityRun.inputs.representedParty,
            },
        };
    }
    let { data: insertedUser, error: userInsertErr } = await db
        .from("chat_messages")
        .insert(userRow)
        .select("id")
        .single();
    if (
        userInsertErr &&
        capabilityRun &&
        (userInsertErr.message ?? "").includes("capability_run")
    ) {
        // Migration 042 has not been applied yet. Losing the audit-grade
        // record of WHICH run this turn was is worth a warning, but it is not
        // worth failing the run the user just confirmed.
        console.warn(
            "[chat/stream] chat_messages.capability_run is unavailable (migration 042 not applied); persisting the turn without it",
        );
        delete userRow.capability_run;
        ({ data: insertedUser, error: userInsertErr } = await db
            .from("chat_messages")
            .insert(userRow)
            .select("id")
            .single());
    }
    if (userInsertErr || !insertedUser) {
        console.error(
            "[chat/stream] failed to persist user message:",
            userInsertErr,
        );
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to record message",
        });
    }
    const userMessageId = insertedUser.id as string;

    const { data: assistantRow, error: assistantInsertError } = await db
        .from("chat_messages")
        .insert({
            chat_id: chatId,
            role: "assistant",
            content: null,
            model_id: selectedModel,
            generation_status: "streaming",
            generation_updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();
    if (assistantInsertError || !assistantRow) {
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to create the durable assistant response",
        });
    }
    const assistantMessageId = String(assistantRow.id);

    devLog("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const abortController = new AbortController();
    let streamFinished = false;
    // Set immediately before the first terminal frame. A late classification
    // must never write a `legal_proposal` after citations/generation_finish.
    let terminalWritten = false;
    req.once("aborted", () => abortController.abort());
    res.once("close", () => {
        if (!streamFinished) abortController.abort();
    });

    try {
        write(
            `data: ${JSON.stringify({
                type: "chat_id",
                chatId,
                assistant_message_id: assistantMessageId,
                requested_model_id: selectedModel,
            })}\n\n`,
        );

        // Conversational discovery: decide whether this turn wants a
        // registered legal capability and, if so, emit ONE non-blocking
        // `legal_proposal` frame the UI surfaces as a suggestion chip. The
        // answer never waits on it — detection runs concurrently with the
        // stream and its result is emitted whenever it lands (or dropped if
        // the stream is already over). We still produce the full answer, so
        // dismissing the chip costs the user nothing.
        const suggestionSettings = readSuggestionSettings(chatRow, userId);
        const excludedCapabilityIds = new Set<string>([
            ...suggestionSettings.dismissedCapabilityIds,
            ...alreadyRunCapabilityIds(conversationContext.episodes),
        ]);
        // `chatRow` is only set when the request named an EXISTING chat, so on
        // a chat created during this turn chatAuditScope() is empty and the
        // first turn's capability audit rows carry no project scope — they
        // then drop out of per-matter audit queries. Fall back to the id
        // already resolved above. (projectChat always has a row.)
        const auditScope: { orgId?: string; matterId?: string; projectId?: string } =
            chatRow
                ? chatAuditScope(chatRow)
                : resolvedProjectId
                  ? { projectId: resolvedProjectId }
                  : {};
        // The one awaited step: a single cheap documents query that also
        // authorizes every attachment id. Everything after it is off the
        // critical path.
        const intentAttachments = await buildIntentAttachments({
            files: lastUser?.files,
            userId,
            userEmail,
            db,
        }).catch((err) => {
            devLog("[chat/stream] intent attachments unavailable", err);
            return [];
        });
        const recentUserTurns = conversationContext.messages
            .filter(
                (m): m is typeof m & { content: string } =>
                    m.role === "user" && typeof m.content === "string",
            )
            .map((m) => m.content)
            .slice(-2);

        const intentStarted = Date.now();
        // A classifier that THREW is a different fact from one that simply
        // lost the grace race; persisting both as {ran:true, "abandoned"}
        // hides a broken classifier behind a tuning knob.
        let intentCrashed = false;
        const intent: Promise<IntentDetectionResult | null> = runIntentDetection({
            message: lastUser?.content ?? null,
            attachments: intentAttachments,
            conversationSummary: conversationContext.summaryText,
            recentUserTurns,
            excludedCapabilityIds,
            suppressed: suggestionSettings.suppressed,
            // A run turn already IS the capability the user picked; proposing
            // another one on top of it is noise.
            capabilityRunTurn: Boolean(capabilityRun),
            seededWorkflowTurn:
                Boolean(lastUser?.workflow) ||
                /^implement workflow/i.test(lastUser?.content ?? ""),
            model: resolveAvailableMainModel(
                intentClassifierModel() ?? DEFAULT_MAIN_MODEL,
                apiKeys,
            ),
            apiKeys,
        }).catch((err) => {
            devLog("[chat/stream] intent detection failed", err);
            intentCrashed = true;
            return null;
        });

        let proposalEmitted = false;
        const emitProposal = (result: IntentDetectionResult | null) => {
            if (!result?.proposal) return;
            if (proposalEmitted || terminalWritten || streamFinished) return;
            proposalEmitted = true;
            write(
                `data: ${JSON.stringify({
                    type: "legal_proposal",
                    proposal: result.proposal,
                })}\n\n`,
            );
            void recordAuditEvent(db, {
                ...auditScope,
                actorUserId: userId,
                eventType: "capability_proposal.shown",
                targetType: "chat",
                targetId: chatId,
                outcome: "succeeded",
                metadata: {
                    capability_id: result.proposal.capabilityId,
                    proposal_id: result.proposal.proposalId,
                    confidence: result.proposal.confidence,
                    source: result.proposal.source,
                },
            });
        };
        void intent
            .then(emitProposal)
            .catch((err) => devLog("[chat/stream] proposal emit failed", err));

        if (capabilityRun) {
            void recordAuditEvent(db, {
                ...auditScope,
                actorUserId: userId,
                eventType: "capability_proposal.confirmed",
                targetType: "chat",
                targetId: chatId,
                outcome: "succeeded",
                metadata: {
                    capability_id: capabilityRun.capabilityId,
                    proposal_id: capabilityRun.proposalId,
                },
            });
        }

        // Optional per-turn image edit source bound by the frontend "Edit"
        // button — used when the model calls edit_image without its own source.
        const editImageSource = parseEditImageSource(body.edit_image_source);

        const {
            fullText,
            events,
            finishReason,
            usage,
            iterations,
            modelId,
            citations,
            durationMs,
        } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            userEmail,
            db,
            write,
            workflowStore,
            model,
            apiKeys,
            projectId: resolvedProjectId,
            chatId,
            chatMessageId: userMessageId,
            assistantMessageId,
            editImageSource,
            capabilityRun: capabilityRunContext,
            allowedChatAttachmentIds:
                collectConversationImageAttachmentIds(enrichedMessages),
            signal: abortController.signal,
            deferTerminalEvents: true,
            onCheckpoint: async (checkpointEvents) => {
                const { error } = await db
                    .from("chat_messages")
                    .update({
                        content: checkpointEvents.length
                            ? checkpointEvents
                            : null,
                        generation_updated_at: new Date().toISOString(),
                    })
                    .eq("id", assistantMessageId);
                if (error) throw error;
            },
            // General chat has no fork/branch model, so there's no branch tip
            // to anchor edits to — provenance threading is otherwise identical
            // to the project-chat path.
            branchContext: null,
        });

        devLog("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        // Give a still-running classification a short grace period now that
        // the answer is complete, then stop waiting: the chip is worth a
        // moment, never a delayed persist.
        const settledIntent = await withDeadline(
            intent,
            intentPostStreamGraceMs(),
        );
        if (settledIntent) emitProposal(settledIntent);

        // A run turn that ends without a recorded result FAILED, however
        // fluent the prose was. Persisting an explicit failed event is what
        // lets the card say so and offer a re-run, instead of the confirmed
        // run silently evaporating into an ordinary answer.
        if (capabilityRunContext) {
            const recorded = events.find(
                (event) =>
                    event.type === "capability_result" &&
                    event.status === "complete",
            );
            if (!recorded) {
                const failed = failedCapabilityResult({
                    ctx: capabilityRunContext,
                    errorCode: "no_result_recorded",
                });
                events.push(failed);
                if (!streamFinished) {
                    write(`data: ${JSON.stringify(failed)}\n\n`);
                }
            }
            const resultEvent = recorded ?? null;
            void recordAuditEvent(db, {
                ...auditScope,
                actorUserId: userId,
                eventType: resultEvent
                    ? "capability_result.recorded"
                    : "capability_result.failed",
                targetType: "chat",
                targetId: chatId,
                outcome: resultEvent ? "succeeded" : "failed",
                metadata: {
                    capability_id: capabilityRunContext.cap.id,
                    result_id:
                        resultEvent && resultEvent.type === "capability_result"
                            ? resultEvent.result_id
                            : null,
                    proposal_id: capabilityRunContext.capabilityRun.proposalId,
                },
            });
        }

        const annotations = extractAnnotations(fullText, docIndex, events);
        const hasBackgroundJob = events.some(
            (event) => event.type === "document_job_started",
        );
        const generationStatus = hasBackgroundJob
            ? "background"
            : finishReason === "completed"
              ? "completed"
              : finishReason === "cancelled"
                ? "cancelled"
                : finishReason === "refused"
                  ? "refused"
                  : finishReason === "error"
                    ? "failed"
                    : "incomplete";
        const { error: assistantUpdateError } = await db
            .from("chat_messages")
            .update({
                content: events.length ? events : null,
                annotations: annotations.length ? annotations : null,
                model_id: modelId,
                generation_status: generationStatus,
                finish_reason: finishReason,
                generation_usage_json: {
                    ...usage,
                    iterations,
                    intent_classifier: settledIntent
                        ? {
                              ran: settledIntent.ran,
                              source: settledIntent.source,
                              outcome: settledIntent.outcome,
                              elapsed_ms: settledIntent.elapsedMs,
                              model: settledIntent.model,
                          }
                        : {
                              ran: !intentCrashed,
                              source: "none",
                              outcome: intentCrashed ? "error" : "abandoned",
                              elapsed_ms: Date.now() - intentStarted,
                              model: null,
                          },
                },
                generation_updated_at: new Date().toISOString(),
            })
            .eq("id", assistantMessageId);
        if (assistantUpdateError) {
            throw new Error(
                `PERSISTENCE_ERROR: ${assistantUpdateError.message}`,
            );
        }

        if (!chatTitle && lastUser?.content) {
            await db
                .from("chats")
                .update({ title: lastUser.content.slice(0, 120) })
                .eq("id", chatId);
        }

        await queueConversationSummary({
            db,
            surface: "chat",
            chatId,
            completedEpisodeCount:
                conversationContext.episodes.filter(
                    (episode) => episode.completed,
                ).length + 1,
        }).catch((error) => {
            console.error("[conversation-summary] queue failed", {
                chatId,
                error: error instanceof Error ? error.message : String(error),
            });
        });

        const integrity = assistantResponseIntegrity(events);
        terminalWritten = true;
        write(`data: ${JSON.stringify({ type: "citations", citations })}\n\n`);
        write(
            `data: ${JSON.stringify({
                type: "generation_finish",
                finish_reason: finishReason,
                usage,
                iterations,
                duration_ms: durationMs,
                assistant_message_id: assistantMessageId,
                requested_model_id: selectedModel,
                final_model_id: modelId,
                visible_text_utf8_bytes: integrity.visibleTextUtf8Bytes,
                visible_text_sha256: integrity.visibleTextSha256,
            })}\n\n`,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        // The error path never awaits the classifier: a still-running
        // classification is simply abandoned.
        terminalWritten = true;
        console.error("[chat/stream] error:", err);
        const cancelled = abortController.signal.aborted;
        const { error: terminalStatusError } = await db
            .from("chat_messages")
            .update({
                generation_status: cancelled ? "cancelled" : "failed",
                finish_reason: cancelled ? "cancelled" : "error",
                generation_updated_at: new Date().toISOString(),
            })
            .eq("id", assistantMessageId);
        const message = terminalStatusError
            ? `PERSISTENCE_ERROR: ${terminalStatusError.message}`
            : err instanceof Error && err.message
              ? err.message
              : "Stream error";
        try {
            if (message.startsWith("PERSISTENCE_ERROR:")) {
                write(
                    `data: ${JSON.stringify({
                        type: "persistence_error",
                        code: "persistence_error",
                        message:
                            "The response could not be saved, so it was not marked complete.",
                    })}\n\n`,
                );
            } else {
                write(
                    `data: ${JSON.stringify({ type: "error", message })}\n\n`,
                );
            }
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});

// POST /chat/:chatId/suggestions
//
// Per-user, per-chat control over capability suggestion chips: dismiss one
// capability, mute the whole chat, or un-mute it. The column is shared by
// everyone with access to the chat, so the value is MERGED (never replaced)
// and other users' entries are preserved.
chatRouter.post("/:chatId/suggestions", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;

    const parsed = parseSuggestionAction(req.body);
    if (!parsed.ok) {
        return void res
            .status(400)
            .json({ code: "invalid_request", detail: parsed.detail });
    }

    const db = createServerSupabase();
    const chat = await getAccessibleChat(chatId, userId, userEmail, db, "read");
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });

    const value = mergeSuggestionSettings(
        chat.suggestion_settings,
        userId,
        parsed.action,
        parsed.capabilityId,
    );
    const { error } = await db
        .from("chats")
        .update({ suggestion_settings: value })
        .eq("id", chatId);
    if (error) {
        // Most likely cause: migration 042 has not been applied, so the
        // column does not exist. Log it — a silent 200 would let the user
        // keep dismissing a chip that comes straight back.
        console.error("[chat/suggestions] failed to persist", {
            chatId,
            code: error.code,
        });
        return void res.status(500).json({
            code: "suggestion_settings_unavailable",
            detail: "Suggestion settings could not be saved.",
        });
    }

    void recordAuditEvent(db, {
        ...chatAuditScope(chat),
        actorUserId: userId,
        eventType:
            parsed.action === "dismiss"
                ? "capability_proposal.dismissed"
                : parsed.action === "suppress"
                  ? "capability_proposal.suppressed"
                  : "capability_proposal.unsuppressed",
        targetType: "chat",
        targetId: chatId,
        outcome: "succeeded",
        metadata: {
            ...(parsed.capabilityId
                ? { capability_id: parsed.capabilityId }
                : {}),
            ...(parsed.proposalId ? { proposal_id: parsed.proposalId } : {}),
        },
    });

    res.json({
        ok: true,
        settings: readSuggestionSettings({ suggestion_settings: value }, userId),
    });
});

/**
 * Locate one recorded `capability_result` event inside a persisted assistant
 * message's content array. The column is `jsonb`, so everything in it is
 * untrusted-shaped as far as the type system is concerned: match on the two
 * discriminators and let the mapper read the rest.
 */
function findCapabilityResultBlock(
    content: unknown,
    resultId: string,
): CapabilityResultEvent | null {
    if (!Array.isArray(content)) return null;
    for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as Partial<CapabilityResultEvent>;
        if (
            block.type === "capability_result" &&
            block.result_id === resultId
        ) {
            return block as CapabilityResultEvent;
        }
    }
    return null;
}

/** The response body of a capability-result DOCX export. */
type CapabilityResultExport = {
    document_id: string;
    filename: string;
    download_url: string;
    version_id: string;
    version_number: number;
};

/**
 * A previous export of this same result, or null when there is none.
 *
 * `persistAuthoredDocx({ idempotencyKey: resultId })` writes `documents.id =
 * resultId`, so the row is addressable by the result id alone. Returning it
 * verbatim is what keeps a second exporter from taking ownership of the first
 * exporter's document. The row is only reused when it is `ready` and its
 * current version still names a storage path — anything else falls through to
 * a fresh render.
 */
async function existingCapabilityResultExport(
    db: Db,
    resultId: string,
): Promise<CapabilityResultExport | null> {
    const { data: documentRow } = await db
        .from("documents")
        .select("id, filename, status, current_version_id")
        .eq("id", resultId)
        .maybeSingle();
    const doc = documentRow as {
        filename?: unknown;
        status?: unknown;
        current_version_id?: unknown;
    } | null;
    if (
        !doc ||
        doc.status !== "ready" ||
        typeof doc.filename !== "string" ||
        typeof doc.current_version_id !== "string"
    ) {
        return null;
    }

    const { data: versionRow } = await db
        .from("document_versions")
        .select("id, version_number, storage_path")
        .eq("id", doc.current_version_id)
        .maybeSingle();
    const version = versionRow as {
        id?: unknown;
        version_number?: unknown;
        storage_path?: unknown;
    } | null;
    if (
        !version ||
        typeof version.id !== "string" ||
        typeof version.storage_path !== "string" ||
        !version.storage_path
    ) {
        return null;
    }

    return {
        document_id: resultId,
        filename: doc.filename,
        download_url: buildDownloadUrl(version.storage_path, doc.filename),
        version_id: version.id,
        version_number:
            typeof version.version_number === "number"
                ? version.version_number
                : 1,
    };
}

// POST /chat/:chatId/messages/:messageId/capability-results/:resultId/docx
//
// Export a recorded capability result as a first-class document row. The
// export is DETERMINISTIC — the payload already on the message is mapped
// straight to DOCX sections, with no model call — so the exported memo can
// never disagree with the card the lawyer read. `idempotencyKey: resultId`
// means repeated clicks reuse the same document instead of littering the
// matter with copies.
chatRouter.post(
    "/:chatId/messages/:messageId/capability-results/:resultId/docx",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { chatId, messageId, resultId } = req.params;

        const db = createServerSupabase();
        // "export", not "read": this route WRITES a documents row into the
        // matter (persistAuthoredDocx({ projectId: chat.project_id })), so a
        // project viewer must not be able to create shared matter content.
        // Matches routes/documents.ts, routes/tabular.ts and email/attachments.
        const chat = await getAccessibleChat(
            chatId,
            userId,
            userEmail,
            db,
            "export",
        );
        if (!chat) {
            return void res
                .status(404)
                .json({ code: "not_found", detail: "Chat not found" });
        }

        const { data: message } = await db
            .from("chat_messages")
            .select("id, chat_id, role, content")
            .eq("id", messageId)
            .eq("chat_id", chatId)
            .maybeSingle();
        const row = message as {
            role?: unknown;
            content?: unknown;
        } | null;
        if (!row || row.role !== "assistant") {
            return void res
                .status(404)
                .json({ code: "not_found", detail: "Message not found" });
        }

        const block = findCapabilityResultBlock(row.content, resultId);
        if (!block) {
            return void res.status(404).json({
                code: "result_not_found",
                detail: "Capability result not found on this message",
            });
        }
        if (block.status !== "complete") {
            return void res.status(409).json({
                code: "result_not_complete",
                detail: "This capability run recorded no result to export.",
            });
        }

        // The idempotency key is the result id, which everyone who can see
        // this chat shares. Re-persisting under it would upsert
        // documents.user_id to the SECOND exporter while the version's
        // storage_path still points at the first exporter's blob — the
        // document changes hands and the stored path stops matching the URL.
        // So a result that has already been exported is returned as it
        // stands, and nothing is re-uploaded or re-upserted.
        let exported = await existingCapabilityResultExport(db, resultId);

        if (!exported) {
            const rendered = await renderSectionsToDocxBuffer(
                block.title,
                capabilityResultToDocxSections(block),
            );
            if ("error" in rendered) {
                return void res
                    .status(502)
                    .json({ code: "render_failed", detail: rendered.error });
            }

            const persisted = await persistAuthoredDocx({
                db,
                userId,
                buffer: rendered.buffer,
                title: block.title,
                projectId: chat.project_id ?? null,
                source: "generated",
                idempotencyKey: resultId,
                lineage: {
                    derivationKind: "capability_result",
                    operationId: resultId,
                },
            });
            if ("error" in persisted) {
                return void res
                    .status(500)
                    .json({ code: "persist_failed", detail: persisted.error });
            }
            exported = {
                document_id: persisted.document_id,
                filename: persisted.filename,
                download_url: persisted.download_url,
                version_id: persisted.version_id,
                version_number: persisted.version_number,
            };
        }

        void recordAuditEvent(db, {
            ...chatAuditScope(chat),
            actorUserId: userId,
            eventType: "capability_result.exported",
            targetType: "document",
            targetId: exported.document_id,
            outcome: "succeeded",
            metadata: {
                result_id: resultId,
                capability_id: block.capability_id,
                document_id: exported.document_id,
            },
        });

        res.json(exported);
    },
);
