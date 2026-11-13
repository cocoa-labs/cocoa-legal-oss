import {
    draftedWordCount,
    enforceDraftBudget,
    DocumentDraftSizingError,
} from "./draftBudget";
import {
    createDocumentJobLease,
    DocumentGenerationLeaseLost,
    type DocumentJobLease,
} from "./lease";
import os from "node:os";
import crypto from "node:crypto";
import { createServerSupabase } from "../supabase";
import { getUserApiKeys } from "../userSettings";
import {
    capabilitiesForModel,
    completeStructured,
    streamChatWithTools,
} from "../llm";
import { downloadFile } from "../storage";
import { extractDocumentText } from "../documentExtraction";
import { ensureVersionExportable } from "../documentLayoutGate";
import { persistAuthoredDocxOrThrow, type DocxSection } from "../docxAssembly";
import {
    DOCUMENT_QA_UNAVAILABLE,
    DocumentLayoutQaError,
} from "../documentLayoutQa";
import { runAuthoringQa, type QaFinding } from "../authoringQa";
import { makeQaCheck, makeQaResearch } from "../authoringExecute";
import { getEffectivePlaybookEntries, resolveFirmId } from "../playbooks";
import { CRE_PLAYBOOK_KEYS } from "../legalCapabilities/creProfiles";
import {
    DOCUMENT_RENDER_FAILED,
    DocumentRenderError,
    renderDocumentWithRecovery,
    type DocumentRenderAttempt,
} from "./renderRecovery";
import { documentGenerationCanaryPassed } from "./canary";
import {
    DocumentSourceLoadError,
    loadDocumentGenerationContext,
} from "./sourceContext";
import {
    resolveDraftOutline,
    validateSavedOutline,
    type DraftOutline,
} from "./outlinePlanning";
import {
    countWords,
    continueSectionInChunks,
    DocumentSectionChunkLimitError,
    normalizeGeneratedSections,
    readDraftCheckpoint,
    requestedDocumentWordTarget,
    serializeDraftCheckpoint,
    targetWordsForSection,
    type DraftCheckpoint,
} from "./chunkedDrafting";
import type {
    DocumentGenerationItemRow,
    DocumentGenerationJobRow,
} from "./types";

export { validateSavedOutline } from "./outlinePlanning";
export { savedBriefContext } from "./sourceContext";

export const MAX_DRAFT_CALL_OUTPUT_TOKENS = 32_000;

export function calculatedDraftOutputTokens(
    targetWords: number | null | undefined,
    modelMaxOutputTokens: number,
) {
    const calculated = targetWords
        ? Math.max(1_000, Math.ceil(targetWords * 2.5 + 2_000))
        : MAX_DRAFT_CALL_OUTPUT_TOKENS;
    return Math.min(
        calculated,
        MAX_DRAFT_CALL_OUTPUT_TOKENS,
        modelMaxOutputTokens,
    );
}

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let draining = false;
let timer: NodeJS.Timeout | null = null;

class DocumentGenerationCancelled extends Error {
    constructor() {
        super("Document generation was cancelled.");
        this.name = "DocumentGenerationCancelled";
    }
}

const TABLE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        headers: {
            type: "array",
            minItems: 2,
            maxItems: 12,
            items: { type: "string" },
        },
        rows: {
            type: "array",
            maxItems: 250,
            items: {
                type: "array",
                minItems: 2,
                maxItems: 12,
                items: { type: "string" },
            },
        },
    },
    required: ["headers", "rows"],
} as const;

const SECTION_BODY_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        content: { type: "string" },
        table: TABLE_SCHEMA,
    },
    required: ["content"],
} as const;

const OUTLINE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        sections: {
            type: "array",
            minItems: 1,
            maxItems: 80,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    heading: {
                        type: "string",
                        description: "A concise heading of 12 words or fewer.",
                    },
                    level: { type: "integer", minimum: 1, maximum: 3 },
                    instructions: {
                        type: "string",
                        description:
                            "A bounded drafting instruction of 80 words or fewer; do not draft the section body.",
                    },
                },
                required: ["heading", "level", "instructions"],
            },
        },
    },
    required: ["sections"],
} as const;

export function isTransientGenerationError(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return /\b(408|429|500|502|503|504)\b|timeout|temporar|rate.?limit|overload/i.test(
        text,
    );
}

export function isGenerationRefusal(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return /refus|safety|policy|content.?filter/i.test(text);
}

export function isGenerationMaxOutputError(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return /\bmax[_ -]?(?:output|tokens?)\b|truncated (?:the )?structured completion|output length limit/i.test(
        text,
    );
}

export function isGenerationContextLimitError(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    return /\bcontext[_ -]?(?:length|limit|window)\b|too many input tokens|maximum context/i.test(
        text,
    );
}

async function withRetry<T>(
    fn: () => Promise<T>,
    onRetry: (n: number) => Promise<void>,
) {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await fn();
        } catch (error) {
            last = error;
            if (
                isGenerationRefusal(error) ||
                !isTransientGenerationError(error) ||
                attempt === 2
            )
                throw error;
            await onRetry(attempt + 1);
            await new Promise((resolve) =>
                setTimeout(resolve, 350 * 2 ** attempt + Math.random() * 250),
            );
        }
    }
    throw last;
}

export function validateGeneratedSections(
    value: unknown,
): DocxSection[] | null {
    return normalizeGeneratedSections(value);
}

type FailureStage =
    | "planning"
    | "drafting"
    | "rendering"
    | "layout_qa"
    | "persistence";

function markFailureStage(error: unknown, stage: FailureStage): never {
    if (error instanceof Error) {
        Object.defineProperty(error, "failureStage", {
            configurable: true,
            value: stage,
        });
        throw error;
    }
    const wrapped = new Error(String(error));
    Object.defineProperty(wrapped, "failureStage", { value: stage });
    throw wrapped;
}

async function runStage<T>(stage: FailureStage, work: () => Promise<T>) {
    try {
        return await work();
    } catch (error) {
        return markFailureStage(error, stage);
    }
}

function failureStage(error: unknown): FailureStage | null {
    if (!(error instanceof Error)) return null;
    const stage = (error as Error & { failureStage?: unknown }).failureStage;
    return typeof stage === "string" ? (stage as FailureStage) : null;
}

function classifyItemFailure(error: unknown): {
    stage: FailureStage | null;
    code: string | null;
    retryable: boolean;
    message: string;
} {
    if (error instanceof DocumentSourceLoadError)
        return {
            stage: failureStage(error) ?? "planning",
            code: error.code,
            retryable: false,
            message: error.message,
        };
    if (error instanceof DocumentDraftSizingError)
        return {
            stage: failureStage(error) ?? "drafting",
            code: error.code,
            retryable: false,
            message: error.message,
        };
    if (error instanceof DocumentGenerationCancelled) {
        return {
            stage: null,
            code: null,
            retryable: false,
            message: error.message,
        };
    }
    if (error instanceof DocumentLayoutQaError) {
        return {
            stage: failureStage(error) ?? "layout_qa",
            code: error.code,
            retryable: error.retryable,
            message:
                error.code === DOCUMENT_QA_UNAVAILABLE
                    ? "Document layout verification is temporarily unavailable after three attempts. The saved draft can be retried."
                    : "The document did not pass layout verification after both standard and compatibility rendering. The saved draft can be retried.",
        };
    }
    if (error instanceof DocumentRenderError) {
        return {
            stage: failureStage(error) ?? "rendering",
            code: DOCUMENT_RENDER_FAILED,
            retryable: false,
            message:
                "The DOCX renderer could not create a valid document. The saved draft can be retried.",
        };
    }
    if (error instanceof DocumentSectionChunkLimitError) {
        return {
            stage: failureStage(error) ?? "drafting",
            code: error.code,
            retryable: error.retryable,
            message:
                "A very large section reached the configured chunk guard. All completed content was saved and can resume after the limit is increased.",
        };
    }
    if (isGenerationRefusal(error)) {
        return {
            stage: failureStage(error) ?? "drafting",
            code: "DOCUMENT_DRAFT_REFUSED",
            retryable: false,
            message:
                "The selected model could not draft this document. Retry it or choose another model.",
        };
    }
    if (isGenerationMaxOutputError(error)) {
        return {
            stage: failureStage(error) ?? "drafting",
            code: "DOCUMENT_GENERATION_MAX_OUTPUT",
            retryable: true,
            message:
                "The model reached its output limit before finishing. Saved planning or draft content can be retried.",
        };
    }
    if (isGenerationContextLimitError(error)) {
        return {
            stage: failureStage(error) ?? "drafting",
            code: "DOCUMENT_GENERATION_CONTEXT_LIMIT",
            retryable: true,
            message:
                "The selected model reached its context limit. Saved planning and draft checkpoints can resume with a smaller source set or a model with a larger context window.",
        };
    }
    if (isTransientGenerationError(error)) {
        return {
            stage: failureStage(error),
            code: "DOCUMENT_GENERATION_TRANSIENT",
            retryable: true,
            message:
                "Document generation was temporarily unavailable after three attempts. It can be retried.",
        };
    }
    return {
        stage: failureStage(error),
        code: "DOCUMENT_GENERATION_FAILED",
        retryable: false,
        message:
            "Document generation failed. Any completed draft content was saved and can be retried.",
    };
}

async function cancelled(
    db: ReturnType<typeof createServerSupabase>,
    jobId: string,
) {
    const { data, error } = await db
        .from("document_generation_jobs")
        .select("cancel_requested_at")
        .eq("id", jobId)
        .maybeSingle();
    if (error)
        throw new Error(`Could not read packet cancellation: ${error.message}`);
    if (!data) throw new DocumentGenerationLeaseLost();
    return !!data.cancel_requested_at;
}

export async function checkpointDocumentGenerationItem(
    db: ReturnType<typeof createServerSupabase>,
    itemId: string,
    patch: Record<string, unknown>,
    lease: DocumentJobLease,
) {
    await lease.assertOwned();
    const { data, error } = await db
        .from("document_generation_items")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", itemId)
        .select("id")
        .maybeSingle();
    if (error) {
        throw new Error(`Failed to update drafting item: ${error.message}`, {
            cause: error,
        });
    }
    if (!data)
        throw new Error(
            "Draft checkpoint was not saved because the item is unavailable.",
        );
}

async function recoverPersistedItem(
    db: ReturnType<typeof createServerSupabase>,
    job: DocumentGenerationJobRow,
    item: DocumentGenerationItemRow,
    apiKeys: Awaited<ReturnType<typeof getUserApiKeys>>,
    lease: DocumentJobLease,
) {
    await lease.assertOwned();
    const { data: document, error: documentError } = await db
        .from("documents")
        .select("id, current_version_id")
        .eq("id", item.id)
        .maybeSingle();
    if (documentError)
        throw new Error(
            `Could not recover saved draft: ${documentError.message}`,
        );
    if (!document?.current_version_id) return false;
    const { data: version, error: versionError } = await db
        .from("document_versions")
        .select("id, storage_path")
        .eq("id", document.current_version_id)
        .maybeSingle();
    if (versionError)
        throw new Error(
            `Could not recover saved version: ${versionError.message}`,
        );
    if (!version?.storage_path) return false;
    await ensureVersionExportable({
        db,
        documentId: String(document.id),
        versionId: String(version.id),
        fileType: "docx",
    });
    const raw = await downloadFile(version.storage_path);
    const text = raw
        ? await extractDocumentText({
              fileType: "docx",
              rawBuf: raw,
              pdfRenditionBuf: null,
          })
        : "";
    const qa = await performQa({ db, job, item, text, apiKeys });
    await checkpointDocumentGenerationItem(
        db,
        item.id,
        {
            status: "ready",
            progress: 100,
            qa_status: qa.status,
            qa_findings_json: qa.findings,
            result_document_id: String(document.id),
            result_version_id: String(version.id),
            completed_at: new Date().toISOString(),
        },
        lease,
    );
    return true;
}

async function performQa(params: {
    db: ReturnType<typeof createServerSupabase>;
    job: DocumentGenerationJobRow;
    item: DocumentGenerationItemRow;
    text: string;
    apiKeys: Awaited<ReturnType<typeof getUserApiKeys>>;
}): Promise<{
    findings: QaFinding[];
    status: "passed" | "advisory" | "blocked";
}> {
    if (!params.text.trim()) {
        return {
            status: "advisory",
            findings: [
                {
                    guardrail: "defined_terms",
                    severity: "advisory",
                    message:
                        "Automated QA could not read the generated document; review it manually.",
                },
            ],
        };
    }
    try {
        const usesCreGuardrails =
            /lease|real[ -]?estate|cam\b|estoppel|snda|purchase and sale/i.test(
                params.item.document_type,
            );
        const playbookEntries = usesCreGuardrails
            ? await getEffectivePlaybookEntries(
                  params.db,
                  await resolveFirmId(params.job.user_id),
                  [...CRE_PLAYBOOK_KEYS],
              )
            : {};
        return await runAuthoringQa({
            text: params.text,
            docType: params.item.document_type,
            variables: {
                drafting_instructions: params.item.drafting_instructions,
            },
            playbookEntries,
            jurisdiction: params.item.jurisdiction,
            runCheck: usesCreGuardrails
                ? makeQaCheck({
                      model: params.job.model_id,
                      apiKeys: params.apiKeys,
                  })
                : async () => [],
            runResearch: usesCreGuardrails
                ? makeQaResearch({
                      model: params.job.model_id,
                      apiKeys: params.apiKeys,
                  })
                : async () => [],
        });
    } catch (error) {
        console.error("[document-generation] QA degraded", {
            jobId: params.job.id,
            itemId: params.item.id,
            error: error instanceof Error ? error.message : String(error),
        });
        return {
            status: "advisory",
            findings: [
                {
                    guardrail: "defined_terms",
                    severity: "advisory",
                    message:
                        "Automated QA could not complete; review the draft manually.",
                },
            ],
        };
    }
}

async function sectionFallback(params: {
    item: DocumentGenerationItemRow;
    outline: DraftOutline;
    checkpoint: DraftCheckpoint;
    context: string;
    model: string;
    apiKeys: Awaited<ReturnType<typeof getUserApiKeys>>;
    isCancelled: () => Promise<boolean>;
    onRetry: (n: number) => Promise<void>;
    onCheckpoint: (
        checkpoint: DraftCheckpoint,
        completed: number,
        total: number,
    ) => Promise<void>;
}) {
    const sections: DocxSection[] = [...params.checkpoint.sections];
    let activeSection = params.checkpoint.active_section;
    const documentWordTarget =
        params.outline.budget?.targetWords ??
        requestedDocumentWordTarget(params.item.drafting_instructions);
    const perSectionTarget = params.outline.budget
        ? Math.max(
              40,
              Math.floor(
                  params.outline.budget.targetWords /
                      params.outline.sections.length,
              ),
          )
        : targetWordsForSection(
              documentWordTarget,
              params.outline.sections.length,
          );
    const configuredChunks = Number(
        process.env.DOCUMENT_GENERATION_MAX_SECTION_CHUNKS ?? "64",
    );
    const maxChunks = Number.isFinite(configuredChunks)
        ? Math.max(4, Math.min(256, Math.trunc(configuredChunks)))
        : 64;

    for (
        let index = sections.length;
        index < params.outline.sections.length;
        index += 1
    ) {
        const section = params.outline.sections[index];
        if (await params.isCancelled()) {
            throw new DocumentGenerationCancelled();
        }
        const baseUser = [
            `Document: ${params.item.title}`,
            `Type: ${params.item.document_type}`,
            `Jurisdiction: ${params.item.jurisdiction ?? "not specified"}`,
            `Global instructions: ${params.item.drafting_instructions}`,
            `Section: ${section.heading}`,
            `Section instructions: ${section.instructions}`,
            params.outline.budget
                ? `Document-wide target: ${params.outline.budget.targetWords} words; ceiling: ${params.outline.budget.maxWords} words. This section's share is approximately ${perSectionTarget} words. Cover its required clauses concisely; do not repeat the whole document, add unrelated provisions, or pad to the target. Subclauses belong within this section, not in separate lengthy essays.`
                : "",
            params.context
                ? `Saved brief and pinned source material:\n${params.context}`
                : "",
        ]
            .filter(Boolean)
            .join("\n\n");
        let drafted: DocxSection | null = null;
        if (!activeSection) {
            try {
                const result = await withRetry(
                    () =>
                        completeStructured({
                            model: params.model,
                            systemPrompt:
                                "You are Quill, a careful legal document drafter. Draft only the requested section. Put any requested comparison, specification table, timeline, or checklist in the optional table field; never emit a pipe-delimited Markdown table in content. Do not discuss your process.",
                            user: baseUser,
                            schema: SECTION_BODY_SCHEMA,
                            schemaName: "legal_document_section",
                            maxTokens: calculatedDraftOutputTokens(
                                perSectionTarget,
                                capabilitiesForModel(params.model)
                                    .maxOutputTokens,
                            ),
                            apiKeys: params.apiKeys,
                        }),
                    params.onRetry,
                );
                const value = result.value as Record<string, unknown>;
                drafted =
                    validateGeneratedSections({
                        sections: [
                            {
                                heading: section.heading,
                                level: section.level,
                                content: value?.content,
                                table: value?.table,
                                pageBreak:
                                    !params.outline.budget &&
                                    index > 0 &&
                                    section.level === 1,
                            },
                        ],
                    })?.[0] ?? null;
            } catch (error) {
                if (isGenerationRefusal(error)) throw error;
                console.info(
                    "[document-generation] section switched to checkpointed chunks",
                    {
                        itemId: params.item.id,
                        sectionIndex: index,
                        sectionHeading: section.heading,
                        recoveredFailureCode: isGenerationMaxOutputError(error)
                            ? "DOCUMENT_GENERATION_MAX_OUTPUT"
                            : "DOCUMENT_SECTION_STRUCTURED_INVALID",
                    },
                );
            }
        }

        const structuredMeetsTarget =
            !!drafted &&
            (params.outline.budget?.source === "ordinary" ||
                !perSectionTarget ||
                countWords(drafted.content ?? "") >=
                    Math.floor(perSectionTarget * 0.9));
        if (drafted && structuredMeetsTarget) {
            sections.push(drafted);
            activeSection = null;
            await params.onCheckpoint(
                serializeDraftCheckpoint(sections, null),
                sections.length,
                params.outline.sections.length,
            );
            continue;
        }

        if (!activeSection) {
            activeSection = {
                index,
                heading: section.heading,
                level: section.level,
                content: drafted?.content?.trim() ?? "",
                pageBreak:
                    !params.outline.budget && index > 0 && section.level === 1,
                chunk_count: 0,
                ...(drafted?.table ? { table: drafted.table } : {}),
            };
            if (activeSection.content.trim() || activeSection.table) {
                await params.onCheckpoint(
                    serializeDraftCheckpoint(sections, activeSection),
                    sections.length,
                    params.outline.sections.length,
                );
            }
        }

        const chunked = await continueSectionInChunks({
            existingContent: activeSection.content,
            existingChunkCount: activeSection.chunk_count,
            targetWords:
                params.outline.budget?.source === "ordinary"
                    ? null
                    : perSectionTarget,
            maxChunks:
                params.outline.budget?.source === "ordinary"
                    ? Math.min(4, maxChunks)
                    : maxChunks,
            isCancelled: params.isCancelled,
            cancelledError: () => new DocumentGenerationCancelled(),
            shouldRetryError: isTransientGenerationError,
            onRetry: params.onRetry,
            runChunk: async ({
                chunkIndex,
                previousTail,
                currentWords,
                targetWords,
                onDelta,
            }) => {
                const continuation = previousTail
                    ? [
                          "Continue the same section with new substantive text. Do not repeat or summarize completed prose.",
                          `The saved ending of the section is:\n${previousTail}`,
                      ].join("\n\n")
                    : "Begin the requested section.";
                const lengthDirection = targetWords
                    ? `The section target is approximately ${targetWords} words; ${currentWords} words are already saved. Continue until the target is substantively satisfied.`
                    : "Complete the section at the length warranted by the instructions and source material.";
                const result = await streamChatWithTools({
                    model: params.model,
                    systemPrompt:
                        "You are Quill, a careful legal document drafter. Return only continuous prose or literal numbered/bulleted lines for this one section. Never repeat prior text, never emit a pipe-delimited Markdown table, and never discuss your process. Complete sentences and preserve legal precision.",
                    messages: [
                        {
                            role: "user",
                            content: [
                                baseUser,
                                `Saved chunk count: ${chunkIndex}`,
                                lengthDirection,
                                continuation,
                            ].join("\n\n"),
                        },
                    ],
                    tools: [],
                    maxIterations: 1,
                    maxContinuations: 0,
                    maxOutputTokens: calculatedDraftOutputTokens(
                        perSectionTarget,
                        capabilitiesForModel(params.model).maxOutputTokens,
                    ),
                    enableThinking: false,
                    callbacks: { onContentDelta: onDelta },
                    apiKeys: params.apiKeys,
                });
                return {
                    text: result.fullText,
                    finishReason: result.finishReason,
                };
            },
            onCheckpoint: async (content, chunkCount) => {
                activeSection = {
                    ...activeSection!,
                    content,
                    chunk_count: chunkCount,
                };
                await params.onCheckpoint(
                    serializeDraftCheckpoint(sections, activeSection),
                    sections.length,
                    params.outline.sections.length,
                );
            },
        });
        const completedSection: DocxSection = {
            heading: activeSection.heading,
            level: activeSection.level,
            content: chunked.content,
            pageBreak: activeSection.pageBreak,
            ...(activeSection.table ? { table: activeSection.table } : {}),
        };
        sections.push(completedSection);
        activeSection = null;
        await params.onCheckpoint(
            serializeDraftCheckpoint(sections, null),
            sections.length,
            params.outline.sections.length,
        );
    }
    return sections;
}

async function processItem(
    db: ReturnType<typeof createServerSupabase>,
    job: DocumentGenerationJobRow,
    item: DocumentGenerationItemRow,
    lease: DocumentJobLease,
) {
    const updateItem = (
        connection: ReturnType<typeof createServerSupabase>,
        id: string,
        patch: Record<string, unknown>,
    ) => checkpointDocumentGenerationItem(connection, id, patch, lease);
    const apiKeys = await getUserApiKeys(job.user_id, db);
    if (await recoverPersistedItem(db, job, item, apiKeys, lease)) return;
    await updateItem(db, item.id, {
        run_attempts: Math.max(0, item.run_attempts ?? 0) + 1,
        failure_stage: null,
        failure_code: null,
        retryable: false,
        error: null,
        started_at: new Date().toISOString(),
    });

    let outline = validateSavedOutline(item.outline_json);
    let checkpoint = readDraftCheckpoint(item.draft_sections_json, outline);
    let sections: DocxSection[] | null =
        outline &&
        checkpoint.sections.length === outline.sections.length &&
        !checkpoint.active_section
            ? checkpoint.sections
            : !outline
              ? validateGeneratedSections(
                    Array.isArray(item.draft_sections_json)
                        ? { sections: item.draft_sections_json }
                        : item.draft_sections_json,
                )
              : null;
    let context = "";

    if (!sections) {
        context = await runStage("planning", () =>
            loadDocumentGenerationContext(
                db,
                item.source_versions_json ?? [],
                job.compact_brief,
            ),
        );
        if (!outline) {
            await updateItem(db, item.id, {
                status: "planning",
                progress: 10,
            });
            const resolution = await runStage("planning", () =>
                resolveDraftOutline({
                    title: item.title,
                    documentType: item.document_type,
                    draftingInstructions: item.drafting_instructions,
                    explicitInstructions:
                        typeof job.compact_brief.user_request === "string"
                            ? job.compact_brief.user_request
                            : undefined,
                    shouldRethrow: isGenerationRefusal,
                    generate: async (sizingCorrection) => {
                        const result = await withRetry(
                            () =>
                                completeStructured({
                                    model: job.model_id,
                                    systemPrompt:
                                        "Plan a complete, internally consistent legal document. Return only an outline, not draft prose. Use at most 12 drafting units for an ordinary document; group related clauses and subclauses into those units. Only an explicit user request for a long document permits up to 80 units. Keep each heading to 12 words or fewer and each instruction to 80 words or fewer. Do not reproduce source passages or draft clauses." +
                                        (sizingCorrection
                                            ? " Your prior outline exceeded the allowed units. This is the one sizing correction: consolidate all required coverage into at most 12 units."
                                            : ""),
                                    user: [
                                        `Title: ${item.title}`,
                                        `Document type: ${item.document_type}`,
                                        `Jurisdiction: ${item.jurisdiction ?? "not specified"}`,
                                        `Drafting instructions: ${item.drafting_instructions}`,
                                    ].join("\n\n"),
                                    schema: OUTLINE_SCHEMA,
                                    schemaName: "document_outline",
                                    maxTokens: Math.min(
                                        16_000,
                                        capabilitiesForModel(job.model_id)
                                            .maxOutputTokens,
                                    ),
                                    apiKeys,
                                }),
                            async (n) =>
                                updateItem(db, item.id, { retries: n }),
                        );
                        return result.value;
                    },
                }),
            );
            outline = resolution.outline;
            const recoveredError = resolution.recoveredError;
            console.info("[document-generation] outline resolved", {
                jobId: job.id,
                itemId: item.id,
                strategy: resolution.strategy,
                sectionCount: outline.sections.length,
                modelCall: resolution.strategy === "model",
                recoveredFailureCode: recoveredError
                    ? isGenerationMaxOutputError(recoveredError)
                        ? "DOCUMENT_GENERATION_MAX_OUTPUT"
                        : "DOCUMENT_OUTLINE_INVALID"
                    : null,
                recoveredError:
                    recoveredError instanceof Error
                        ? recoveredError.message
                        : recoveredError == null
                          ? null
                          : String(recoveredError),
                runAttempt: Math.max(0, item.run_attempts ?? 0) + 1,
            });
        }
        checkpoint = readDraftCheckpoint(item.draft_sections_json, outline);
        // Persist the outline before any body-model call. A later failure or
        // cancellation can resume from this exact structure. Progress also
        // reflects any section prefix recovered from a v2 checkpoint.
        await updateItem(db, item.id, {
            status: "drafting",
            progress:
                30 +
                Math.round(
                    (checkpoint.sections.length / outline.sections.length) * 35,
                ),
            outline_json: outline,
        });
        if (await cancelled(db, job.id)) {
            throw new DocumentGenerationCancelled();
        }
        sections = await runStage("drafting", () =>
            sectionFallback({
                item,
                outline: outline as DraftOutline,
                checkpoint,
                context,
                model: job.model_id,
                apiKeys,
                isCancelled: async () => {
                    await lease.assertOwned();
                    return cancelled(db, job.id);
                },
                onRetry: async (n) => updateItem(db, item.id, { retries: n }),
                onCheckpoint: async (saved, completed, total) => {
                    await updateItem(db, item.id, {
                        status: "drafting",
                        progress: 30 + Math.round((completed / total) * 35),
                        draft_sections_json: saved,
                    });
                    console.info("[document-generation] draft checkpoint", {
                        jobId: job.id,
                        itemId: item.id,
                        completedSections: completed,
                        totalSections: total,
                        activeSectionIndex: saved.active_section?.index ?? null,
                        activeChunkCount:
                            saved.active_section?.chunk_count ?? null,
                        savedCharacters:
                            saved.sections.reduce(
                                (totalCharacters, section) =>
                                    totalCharacters +
                                    (section.content?.length ?? 0),
                                0,
                            ) + (saved.active_section?.content.length ?? 0),
                    });
                },
            }),
        );
    }
    sections = await runStage("drafting", () =>
        enforceDraftBudget(
            sections!,
            outline?.budget,
            async (overlong, budget) => {
                const wordCounts = overlong.map((section) =>
                    Math.max(1, draftedWordCount([section])),
                );
                let remainingWords = budget.maxWords;
                let remainingWeight = wordCounts.reduce(
                    (sum, count) => sum + count,
                    0,
                );
                const corrected: DocxSection[] = [];
                for (const [index, section] of overlong.entries()) {
                    await lease.assertOwned();
                    const remainingSections = overlong.length - index;
                    const minimumReserve = Math.max(
                        0,
                        (remainingSections - 1) * 50,
                    );
                    const sectionCeiling =
                        remainingSections === 1
                            ? remainingWords
                            : Math.max(
                                  50,
                                  Math.min(
                                      remainingWords - minimumReserve,
                                      Math.floor(
                                          (remainingWords * wordCounts[index]) /
                                              remainingWeight,
                                      ),
                                  ),
                              );
                    remainingWeight -= wordCounts[index];
                    if (wordCounts[index] <= sectionCeiling) {
                        corrected.push(section);
                        remainingWords -= wordCounts[index];
                        continue;
                    }
                    const correction = await completeStructured({
                        model: job.model_id,
                        apiKeys,
                        systemPrompt:
                            "Condense this one legal-document section to its assigned ceiling. Preserve every required clause, factual value, table, signature anchor, and complete sentence. Remove repetition and commentary. Return only the corrected section body and optional table. Do not add provisions.",
                        user: `Document target: ${budget.targetWords} words; document ceiling: ${budget.maxWords} words.\nSection ceiling: ${sectionCeiling} words.\nOriginal instructions: ${item.drafting_instructions}\nHeading: ${section.heading}\nSection: ${JSON.stringify(section)}`,
                        schema: SECTION_BODY_SCHEMA,
                        schemaName: "sized_document_section",
                        maxTokens: calculatedDraftOutputTokens(
                            sectionCeiling,
                            capabilitiesForModel(job.model_id).maxOutputTokens,
                        ),
                    });
                    const value = correction.value as Record<string, unknown>;
                    const normalized = validateGeneratedSections({
                        sections: [
                            {
                                ...section,
                                content: value.content,
                                table: value.table ?? section.table,
                            },
                        ],
                    })?.[0];
                    if (!normalized) throw new DocumentDraftSizingError();
                    corrected.push(normalized);
                    remainingWords -= draftedWordCount([normalized]);
                    if (remainingWords < 0) break;
                }
                return corrected;
            },
        ),
    );
    if (
        !sections.length ||
        sections.every((section) => !section.content?.trim())
    ) {
        throw new Error("Drafting produced no usable document sections.");
    }
    if (await cancelled(db, job.id)) throw new DocumentGenerationCancelled();

    // This write is the recovery boundary: after it succeeds, rendering and
    // persistence can be retried without another model call.
    await updateItem(db, item.id, {
        status: "assembling",
        progress: 70,
        draft_sections_json: serializeDraftCheckpoint(sections, null),
    });
    const layoutAttempts = Array.isArray(item.layout_attempts_json)
        ? ([...item.layout_attempts_json] as DocumentRenderAttempt[])
        : [];
    let rendered: Awaited<ReturnType<typeof renderDocumentWithRecovery>>;
    try {
        rendered = await renderDocumentWithRecovery({
            title: item.title,
            sections,
            landscape: item.layout_json?.landscape === true,
            onAttempt: async (attempt) => {
                layoutAttempts.push(attempt);
                await updateItem(db, item.id, {
                    status: "qa",
                    progress: 82,
                    layout_attempts_json: layoutAttempts,
                });
                console.info("[document-generation] layout attempt", {
                    jobId: job.id,
                    itemId: item.id,
                    rendererMode: attempt.renderer_mode,
                    attempt: attempt.attempt,
                    runAttempt: Math.max(0, item.run_attempts ?? 0) + 1,
                    status: attempt.summary.status,
                    failureCode: attempt.summary.failure_code,
                    qaReasons: attempt.summary.reasons,
                    affectedPages: attempt.summary.affected_pages,
                    textCoverage: attempt.summary.text_coverage,
                });
            },
        });
    } catch (error) {
        return markFailureStage(
            error,
            error instanceof DocumentRenderError ? "rendering" : "layout_qa",
        );
    }
    await lease.assertOwned();
    const persisted = await runStage("persistence", () =>
        persistAuthoredDocxOrThrow({
            db,
            userId: job.user_id,
            projectId: job.project_id,
            title: item.title,
            buffer: rendered.buffer,
            layoutQaReport: rendered.report,
            source: "authored",
            idempotencyKey: item.id,
            beforePublish: lease.assertOwned,
            lineage: { derivationKind: "durable_document_generation" },
        }),
    );

    // Cancellation is intentionally checked after the atomic render+save so a
    // completed file is retained, then no later item is started.
    await updateItem(db, item.id, { status: "qa", progress: 90 });
    const text = sections
        .map((section) => `${section.heading ?? ""}\n${section.content ?? ""}`)
        .join("\n\n");
    const qa = await performQa({ db, job, item, text, apiKeys });
    await updateItem(db, item.id, {
        status: "ready",
        progress: 100,
        qa_status: qa.status,
        qa_findings_json: qa.findings,
        result_document_id: persisted.document_id,
        result_version_id: persisted.version_id,
        completed_at: new Date().toISOString(),
    });
}

async function finalizeJob(
    db: ReturnType<typeof createServerSupabase>,
    job: DocumentGenerationJobRow,
    lease: DocumentJobLease,
) {
    await lease.assertOwned();
    const { data, error } = await db
        .from("document_generation_items")
        .select("status")
        .eq("job_id", job.id);
    if (error)
        throw new Error(`Could not finalize document packet: ${error.message}`);
    const statuses = (data ?? []).map((row) => String(row.status));
    if (statuses.length !== job.total_items)
        throw new Error("Document packet item count is incomplete.");
    const completed = statuses.filter((status) => status === "ready").length;
    const failed = statuses.filter((status) => status === "failed").length;
    const wasCancelled = await cancelled(db, job.id);
    if (wasCancelled) {
        await lease.assertOwned();
        const { error: cancelError } = await db
            .from("document_generation_items")
            .update({
                status: "cancelled",
                updated_at: new Date().toISOString(),
            })
            .eq("job_id", job.id)
            .eq("status", "queued");
        if (cancelError)
            throw new Error(
                `Could not cancel remaining drafts: ${cancelError.message}`,
            );
    } else if (
        statuses.some(
            (status) => !["ready", "failed", "cancelled"].includes(status),
        )
    ) {
        throw new Error(
            "Document packet still has active items; refusing to finalize it.",
        );
    }
    const status = wasCancelled
        ? completed > 0
            ? "partial"
            : "cancelled"
        : completed === job.total_items
          ? "completed"
          : completed > 0
            ? "partial"
            : "failed";
    await lease.assertOwned();
    const { data: committed, error: finishError } = await db
        .from("document_generation_jobs")
        .update({
            status,
            completed_items: completed,
            failed_items: failed,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("claimed_by", job.claimed_by!)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
    if (finishError)
        throw new Error(
            `Could not save packet completion: ${finishError.message}`,
        );
    if (!committed) throw new DocumentGenerationLeaseLost();
    console.info("[document-generation] job finished", {
        jobId: job.id,
        model: job.model_id,
        status,
        completed,
        failed,
        total: job.total_items,
    });
    if (job.assistant_message_id) {
        const { data: siblings, error: siblingError } = await db
            .from("document_generation_jobs")
            .select("status")
            .eq("assistant_message_id", job.assistant_message_id);
        if (siblingError)
            throw new Error(
                `Could not load related packet status: ${siblingError.message}`,
            );
        const states = (siblings ?? []).map((row) => row.status);
        // One finished packet must not mark a sibling packet complete.
        if (
            states.length &&
            !states.some((state) => state === "queued" || state === "running")
        ) {
            const generationStatus = states.every(
                (state) => state === "completed",
            )
                ? "completed"
                : wasCancelled || states.every((state) => state === "cancelled")
                  ? "cancelled"
                  : "failed";
            const { error: messageError } = await db
                .from("chat_messages")
                .update({
                    generation_status: generationStatus,
                    finish_reason:
                        generationStatus === "failed"
                            ? "error"
                            : generationStatus,
                    generation_updated_at: new Date().toISOString(),
                })
                .eq("id", job.assistant_message_id);
            if (messageError)
                throw new Error(
                    `Could not save packet response status: ${messageError.message}`,
                );
        }
    }
}

export async function executeDocumentGenerationJob(
    job: DocumentGenerationJobRow,
    db = createServerSupabase(),
) {
    const lease = createDocumentJobLease(db, job);
    try {
        await lease.start();
        const { data, error } = await db
            .from("document_generation_items")
            .select("*")
            .eq("job_id", job.id)
            .order("position", { ascending: true });
        if (error)
            throw new Error(`Could not load drafting items: ${error.message}`);
        for (const item of (data ?? []) as DocumentGenerationItemRow[]) {
            if (["ready", "failed", "cancelled"].includes(item.status))
                continue;
            await lease.assertOwned();
            if (await cancelled(db, job.id)) break;
            try {
                console.info("[document-generation] item started", {
                    jobId: job.id,
                    itemId: item.id,
                    position: item.position,
                    model: job.model_id,
                });
                await processItem(db, job, item, lease);
            } catch (error) {
                if (error instanceof DocumentGenerationLeaseLost) throw error;
                await lease.assertOwned();
                const failure = classifyItemFailure(error);
                console.error("[document-generation] item failed", {
                    jobId: job.id,
                    itemId: item.id,
                    failureCode: failure.code,
                    failureStage: failure.stage,
                    sourceErrorCode:
                        error instanceof DocumentSourceLoadError
                            ? error.databaseCode
                            : null,
                    error: failure.message,
                });
                await checkpointDocumentGenerationItem(
                    db,
                    item.id,
                    {
                        status:
                            error instanceof DocumentGenerationCancelled
                                ? "cancelled"
                                : "failed",
                        progress: 100,
                        error: failure.message,
                        failure_stage: failure.stage,
                        failure_code: failure.code,
                        retryable: failure.retryable,
                        completed_at: new Date().toISOString(),
                    },
                    lease,
                );
            }
        }
        await finalizeJob(db, job, lease);
    } finally {
        await lease.stop();
    }
}

export async function drainDocumentGenerationJobs() {
    if (draining || !documentGenerationCanaryPassed()) return;
    draining = true;
    try {
        const db = createServerSupabase();
        while (true) {
            const { data, error } = await db.rpc(
                "claim_document_generation_job",
                {
                    p_worker_id: workerId,
                },
            );
            if (error) {
                console.error(
                    "[document-generation] claim failed",
                    error.message,
                );
                return;
            }
            const job = (Array.isArray(data) ? data[0] : data) as
                | DocumentGenerationJobRow
                | undefined;
            if (!job) return;
            await executeDocumentGenerationJob(job);
        }
    } finally {
        draining = false;
    }
}

export function wakeDocumentGenerationWorker() {
    void drainDocumentGenerationJobs().catch((error) => {
        console.error("[document-generation] worker failed", error);
    });
}

export function startDocumentGenerationScheduler() {
    if (
        process.env.DOCUMENT_GENERATION_ENABLED === "false" ||
        timer ||
        !documentGenerationCanaryPassed()
    )
        return;
    wakeDocumentGenerationWorker();
    timer = setInterval(wakeDocumentGenerationWorker, 5_000);
    timer.unref?.();
}
