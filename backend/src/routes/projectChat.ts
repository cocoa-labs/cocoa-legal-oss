import { restoreChatEmailAttachments } from "../lib/email/attachmentContext";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildProjectDocContext,
    buildVersionContext,
    buildMessages,
    collectConversationImageAttachmentIds,
    buildToolset,
    buildWorkflowStore,
    enrichWithPriorEvents,
    extractAnnotations,
    runLLMStream,
    resolveSystemPromptCtx,
    PROJECT_EXTRA_TOOLS,
    type ChatMessage,
} from "../lib/chatTools";
import { getUserApiKeys } from "../lib/userSettings";
import { DEFAULT_MAIN_MODEL, resolveAvailableMainModel } from "../lib/llm";
import { checkProjectAccess } from "../lib/access";
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
    readSuggestionSettings,
} from "../lib/chatSuggestions";
import { recordAuditEvent } from "../lib/audit";
import { loadRecentImageAttachments } from "../lib/chatAttachments";
import {
    parseCapabilityRun,
    parseCurrentChatMessage,
    parseEditImageSource,
} from "../lib/chatMessages";
import { getCapability } from "../lib/legalCapabilities";
import {
    buildCapabilityRunPrompt,
    failedCapabilityResult,
    resolveEscalationTemplate,
    type CapabilityRunContext,
} from "../lib/legalCapabilities/run";
import type { PlaybookEntry } from "../lib/playbooks";
import { temporalGroundingLine } from "../lib/systemPrompt/temporalContext";
import {
    DisplayedDocumentResolutionError,
    resolveDisplayedDocument,
    resolveOpenDocuments,
    type DisplayedDocumentInput,
    type OpenDocumentInput,
    type ResolvedDisplayedDocument,
    type ResolvedOpenDocument,
} from "../lib/displayedDocument";
import { getProjectActionState } from "../lib/documentActionState";
import { formatMatterTasksForPrompt } from "../lib/matterTasks";
import {
    conversationContextSize,
    loadConversationContext,
} from "../lib/conversationContext";
import { queueConversationSummary } from "../lib/conversationSummary/worker";
import { assistantResponseIntegrity } from "../lib/assistantResponseIntegrity";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.`;

export const projectChatRouter = Router({ mergeParams: true });

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    // Same body guard as POST /chat. This route used to blind-cast req.body
    // and iterate `messages` — a malformed payload threw before the stream
    // opened and (pre error-middleware) killed the whole process.
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessage = parseCurrentChatMessage(body.message, body.messages);
    if (!parsedMessage.ok) {
        return void res.status(400).json({ detail: parsedMessage.detail });
    }
    // A confirmed in-chat capability run. Resolved here, with the other
    // request-level guards, so an unrunnable capability is refused BEFORE a
    // chat or a message row exists.
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
    const {
        chat_id,
        model,
        displayed_doc,
        attached_documents,
        open_docs,
        client_time_zone,
    } = body as {
        chat_id?: string;
        model?: string;
        displayed_doc?: DisplayedDocumentInput;
        attached_documents?: { filename: string; document_id: string }[];
        open_docs?: OpenDocumentInput[];
        client_time_zone?: string;
    };

    const db = createServerSupabase();

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    // The browser only supplies identity hints. Resolve them against the
    // accessible project before they can be persisted or reach an LLM/tool.
    // A spoofed filename/version number is ignored; a mismatched UUID pair is
    // rejected with a stable code while normal JSON responses are still valid.
    let resolvedDisplayed: ResolvedDisplayedDocument | null;
    let resolvedOpenDocs: ResolvedOpenDocument[];
    try {
        resolvedDisplayed = await resolveDisplayedDocument({
            db,
            projectId,
            input: displayed_doc ?? null,
        });
        resolvedOpenDocs = await resolveOpenDocuments({
            db,
            projectId,
            inputs: open_docs,
            displayed: resolvedDisplayed,
        });
    } catch (error) {
        if (error instanceof DisplayedDocumentResolutionError) {
            return void res.status(error.status).json({
                code: error.code,
                detail: error.message,
            });
        }
        throw error;
    }

    const versionContext = buildVersionContext(
        resolvedDisplayed
            ? {
                  document_id: resolvedDisplayed.document_id,
                  version_id: resolvedDisplayed.version_id,
                  version_number: resolvedDisplayed.version_number,
              }
            : null,
        resolvedOpenDocs,
    );

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;
    // When the active chat is a fork, edits this turn must branch off the
    // fork's own tip (not the mainline current_version_id), and a displayed doc
    // with no explicit version resolves to that tip. Captured from the chat row
    // and threaded into the stream.
    let branchContext: {
        chatId: string;
        branchTipVersionId: string | null;
        anchorDocumentId: string | null;
    } | null = null;
    let branchAnchorDocumentId: string | null = null;
    // Kept for the suggestion-settings read and the audit scope below (null
    // for a chat created on this turn, which has no settings yet).
    let chatRow: Record<string, unknown> | null = null;

    if (chatId) {
        // `*` so a column added by a later migration (suggestion_settings,
        // migration 042) is picked up without coupling this select to it;
        // the base-column retry below still covers a genuine query failure.
        const first = await db
            .from("chats")
            .select("*")
            .eq("id", chatId)
            .single();
        let existing = first.data as Record<string, unknown> | null;
        if (first.error) {
            const base = await db
                .from("chats")
                .select("id, title, project_id")
                .eq("id", chatId)
                .single();
            existing = (base.data as Record<string, unknown> | null) ?? null;
        }
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) {
            return void res.status(404).json({ detail: "Chat not found" });
        } else {
            chatTitle = (existing!.title as string | null) ?? null;
            chatRow = existing;
            if (existing!.parent_chat_id) {
                branchContext = {
                    chatId: existing!.id as string,
                    branchTipVersionId:
                        (existing!.branch_tip_version_id as string | null) ??
                        (existing!.anchor_version_id as string | null) ??
                        null,
                    anchorDocumentId:
                        (existing!.anchor_document_id as string | null) ?? null,
                };
                branchAnchorDocumentId =
                    (existing!.anchor_document_id as string | null) ?? null;
            }
        }
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: projectId })
            .select("id, title")
            .single();
        if (error || !newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

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
    const messages: ChatMessage[] = [
        ...conversationContext.messages,
        currentMessage,
    ];
    const lastUser = currentMessage;

    // Pin the displayed doc to the version the user is viewing (the anchor),
    // so the model reads/cites those bytes instead of the live current version.
    const anchor = resolvedDisplayed
        ? {
              documentId: resolvedDisplayed.document_id,
              versionId:
                  resolvedDisplayed.version_id ??
                  (branchContext &&
                  branchAnchorDocumentId === resolvedDisplayed.document_id
                      ? branchContext.branchTipVersionId
                      : null),
              versionNumber: resolvedDisplayed.version_number ?? null,
          }
        : null;
    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
        db,
        anchor,
    );
    if (chatId) await restoreChatEmailAttachments({ db, chatId, table: "project_chat_messages", userId, userEmail, docIndex, docStore });
    const projectState = await getProjectActionState(db, projectId).catch(
        () => ({
            documents: [],
            communications: [],
            tasks: [],
            cursor: "",
        }),
    );
    const projectActionState = projectState.documents;
    const actionByDocument = new Map(
        projectActionState.map((state) => [state.document_id, state]),
    );
    for (const info of Object.values(docIndex)) {
        const state = actionByDocument.get(info.document_id);
        if (!state) continue;
        info.delivery = {
            current_version_sent: state.delivery.current_version_sent,
            newer_version_available: state.delivery.newer_version_available,
            sent_versions: state.delivery.sent_versions.map((version) => ({
                version_id: version.version_id,
                version_number: version.version_number,
            })),
        };
        info.signature = {
            current_version_status: state.signature.current_version_status,
            newer_version_available: state.signature.newer_version_available,
            latest_envelope_id: state.signature.latest_envelope_id,
        };
    }
    if (resolvedDisplayed) {
        resolvedDisplayed.doc_handle =
            Object.entries(docIndex).find(
                ([, info]) =>
                    info.document_id === resolvedDisplayed.document_id,
            )?.[0] ?? null;
        if (!resolvedDisplayed.doc_handle) {
            return void res.status(409).json({
                code: "DISPLAYED_DOCUMENT_UNAVAILABLE",
                detail: "The displayed document is not available to the editor.",
            });
        }
    }
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        projectId,
        projectActionState,
    );
    const messagesForLLM: ChatMessage[] = resolvedDisplayed
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${resolvedDisplayed.filename}, displayed_doc_id: ${resolvedDisplayed.document_id}, editable_doc_handle: ${resolvedDisplayed.doc_handle}${resolvedDisplayed.version_number ? `, displayed_version: V${resolvedDisplayed.version_number}` : ""}, is_current: ${resolvedDisplayed.is_current}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    const taskLines = formatMatterTasksForPrompt(projectState.tasks);
    if (taskLines.length) {
        systemPromptExtra += `\n\nAUTHORITATIVE OPEN MATTER TASKS:\n${taskLines.join("\n")}\nA task is complete only when its stored status says completed. You may suggest semantic follow-up, but never claim or apply inferred completion.`;
    }
    if (attached_documents?.length) {
        const slugByDocumentId = new Map<string, string>();
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id) slugByDocumentId.set(info.document_id, slug);
        }
        const lines = attached_documents.map((d) => {
            const slug = slugByDocumentId.get(d.document_id);
            return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
        });
        systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const imageAttachments = await loadRecentImageAttachments(
        messagesForLLM,
        userId,
        db,
        { projectId, limit: 4 },
    );

    // Steering chain (see resolveSystemPromptCtx): resolve the firm's
    // playbook for the capability(ies) this turn matches. Yields {} until a
    // capability is registered and the message matches it, keeping the
    // empty-ctx prompt byte-identical today.
    // On a run turn the capability is FORCED rather than matched: the user
    // already confirmed it, so its fragment and playbook keys are in scope
    // whatever the message text happens to look like.
    const lastUserMessage = currentMessage;
    const systemPromptCtx = await resolveSystemPromptCtx(
        db,
        userId,
        lastUserMessage,
        runCapability ? { forceCapabilityIds: [runCapability.id] } : undefined,
    );
    if (userEmail) systemPromptCtx.userEmail = userEmail;
    // Temporal grounding: authoritative server clock in the user's browser
    // timezone (validated + defaulted inside temporalGroundingLine).
    systemPromptCtx.currentDateLine = temporalGroundingLine({
        timeZone:
            typeof client_time_zone === "string" ? client_time_zone : undefined,
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
    if (capabilityRun && runCapability) {
        systemPromptExtra +=
            "\n\n" +
            buildCapabilityRunPrompt({
                cap: runCapability,
                resolvedPlaybook,
                docIndex,
                documentIds: capabilityRun.documentIds,
                representedParty: capabilityRun.inputs.representedParty,
            });
    }

    const apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        systemPromptExtra,
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
        tools: buildToolset(PROJECT_EXTRA_TOOLS),
    });
    console.info("[conversation-context] capacity", {
        surface: "project",
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
        version_context: versionContext,
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
        // Migration 042 has not been applied yet. Losing the record of WHICH
        // run this turn was is worth a warning, not a failed run.
        console.warn(
            "[project-chat/stream] chat_messages.capability_run is unavailable (migration 042 not applied); persisting the turn without it",
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
            "[project-chat/stream] failed to persist user message:",
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

        // Conversational discovery (mirrors POST /chat): decide whether this
        // turn wants a registered legal capability and emit ONE non-blocking
        // `legal_proposal` frame. The answer never waits on it.
        const suggestionSettings = readSuggestionSettings(chatRow, userId);
        const excludedCapabilityIds = new Set<string>([
            ...suggestionSettings.dismissedCapabilityIds,
            ...alreadyRunCapabilityIds(conversationContext.episodes),
        ]);
        // Project documents were already authorized by checkProjectAccess /
        // buildProjectDocContext, so the allow-list is built from docIndex
        // (plus the displayed doc) and no second access query runs. Ids the
        // browser supplied in `attached_documents` are NOT trusted on their
        // own: they only survive if docIndex — i.e. this project — has them.
        const allowedDocumentIds = new Set<string>(
            [
                ...Object.values(docIndex).map((info) => info.document_id),
                resolvedDisplayed?.document_id,
            ].filter((id): id is string => typeof id === "string" && !!id),
        );
        const intentFiles: {
            filename?: string | null;
            document_id?: string | null;
            origin?: "attached" | "displayed";
        }[] = [
            ...(lastUser.files ?? []),
            ...(Array.isArray(attached_documents) ? attached_documents : []).map(
                (d) => ({
                    filename: d?.filename,
                    document_id: d?.document_id,
                }),
            ),
        ];
        // The displayed document IS the subject of "review this" on the matter
        // surface. Its id is already authorized (allowedDocumentIds carries
        // it) but it was never in `files`, so the headline flow — an MSA open
        // in the panel plus "review this" — could not produce a chip at all.
        // buildIntentAttachments emits one attachment per entry, so an id the
        // browser also sent must not be listed twice — and when it did send
        // it, the user attached it, so it keeps the default "attached"
        // origin. `origin: "displayed"` marks this as CONTEXT for the
        // classifier only: it must not make a "thanks" turn worth a model
        // call, and it must not let the structural rule re-propose a chip on
        // every unrelated turn just because the panel has a document open.
        if (
            resolvedDisplayed?.document_id &&
            !intentFiles.some(
                (f) => f?.document_id === resolvedDisplayed?.document_id,
            )
        ) {
            intentFiles.push({
                filename: resolvedDisplayed.filename,
                document_id: resolvedDisplayed.document_id,
                origin: "displayed",
            });
        }
        const intentAttachments = await buildIntentAttachments({
            files: intentFiles,
            userId,
            userEmail,
            db,
            allowedDocumentIds,
        }).catch((err) => {
            console.error("[project-chat/stream] intent attachments failed", err);
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
            // The matter surface renders no gallery modal, so its chip gate
            // drops a "modal" proposal. Emitting one anyway costs the turn its
            // chance at a runnable suggestion and files a `shown` audit row for
            // a chip nobody saw.
            allowedRunTargets: ["chat"],
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
            console.error("[project-chat/stream] intent detection failed", err);
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
                ...chatAuditScope(chatRow),
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
            .catch((err) =>
                console.error("[project-chat/stream] proposal emit failed", err),
            );

        if (capabilityRun) {
            void recordAuditEvent(db, {
                ...chatAuditScope(chatRow),
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
            extraTools: PROJECT_EXTRA_TOOLS,
            workflowStore,
            model,
            apiKeys,
            projectId,
            chatId,
            chatMessageId: userMessageId,
            assistantMessageId,
            branchContext,
            displayedDocument: resolvedDisplayed,
            editImageSource: parseEditImageSource(body.edit_image_source),
            capabilityRun: capabilityRunContext,
            allowedChatAttachmentIds:
                collectConversationImageAttachmentIds(messagesForLLM),
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
        });

        // Short grace period for a still-running classification now that the
        // answer is complete; the persist below never waits longer.
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
                ...chatAuditScope(chatRow),
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
        console.error("[project-chat/stream] error", {
            name: err instanceof Error ? err.name : "Error",
            message:
                err instanceof Error
                    ? err.message
                    : "Project chat stream failed.",
        });
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

// POST /projects/:projectId/chat/:chatId/fork
// Branch a conversation from a specific message. REFERENCE model: writes ONE
// chats row; the branch inherits the parent's turns up to the fork point by
// reference at read time (see GET /chat/:chatId). Anchors are derived from the
// fork-point message's immutable version_context — never trusted from client.
projectChatRouter.post("/:chatId/fork", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, chatId } = req.params as {
        projectId: string;
        chatId: string;
    };
    const { forked_from_message_id, fork_label } = req.body as {
        forked_from_message_id?: string;
        fork_label?: string;
    };
    const db = createServerSupabase();

    const access = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Project not found" });
    if (!forked_from_message_id)
        return void res
            .status(400)
            .json({ detail: "forked_from_message_id is required" });

    const { data: parent } = await db
        .from("chats")
        .select("id, title, project_id, root_chat_id")
        .eq("id", chatId)
        .maybeSingle();
    if (!parent || parent.project_id !== projectId)
        return void res.status(404).json({ detail: "Chat not found" });

    // The fork-point message must belong to this chat; its version_context
    // gives the anchor doc + version the branch starts from.
    const { data: msg } = await db
        .from("chat_messages")
        .select("id, chat_id, version_context")
        .eq("id", forked_from_message_id)
        .maybeSingle();
    if (!msg || msg.chat_id !== chatId)
        return void res
            .status(400)
            .json({ detail: "fork point is not part of this chat" });

    const vc = (msg.version_context ?? null) as {
        anchored_document_id?: string | null;
        docs?: { document_id: string; version_id: string | null }[];
    } | null;
    const anchorDocId = vc?.anchored_document_id ?? null;
    const anchorVersionId =
        (anchorDocId &&
            (vc?.docs?.find((d) => d.document_id === anchorDocId)?.version_id ??
                null)) ||
        null;

    // root_chat_id groups a whole fork family; the main thread roots itself.
    const rootChatId =
        (parent.root_chat_id as string | null) ?? (parent.id as string);

    const { data: created, error } = await db
        .from("chats")
        .insert({
            user_id: userId,
            project_id: projectId,
            parent_chat_id: chatId,
            root_chat_id: rootChatId,
            forked_from_message_id,
            anchor_document_id: anchorDocId,
            anchor_version_id: anchorVersionId,
            branch_tip_version_id: anchorVersionId,
            fork_label: fork_label?.trim() || null,
            title: fork_label?.trim() || `Branch of ${parent.title ?? "chat"}`,
        })
        .select("id, title")
        .single();
    if (error || !created)
        return void res
            .status(500)
            .json({ detail: "Failed to create fork", error: error?.message });

    res.json({
        chat_id: created.id,
        title: created.title,
        parent_chat_id: chatId,
        root_chat_id: rootChatId,
        forked_from_message_id,
        anchor_document_id: anchorDocId,
        anchor_version_id: anchorVersionId,
    });
});
