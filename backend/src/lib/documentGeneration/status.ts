import type { createServerSupabase } from "../supabase";
import { checkProjectAccess } from "../access";
import { buildDownloadUrl } from "../downloadTokens";
import {
    getDocumentGenerationJob,
    retryFailedDocumentGenerationItems,
} from "./store";
import { getDocumentGenerationCanaryState } from "./canary";
import type {
    DocumentGenerationJobRow,
    DocumentGenerationItemRow,
} from "./types";
import { draftedWordCount, parseDraftBudget } from "./draftBudget";
import { readDraftCheckpoint } from "./chunkedDrafting";
import { validateSavedOutline } from "./outlinePlanning";

type Db = ReturnType<typeof createServerSupabase>;
export interface DocumentJobScope {
    userId: string;
    userEmail?: string | null;
    chatId?: string | null;
}
export class DocumentJobAccessError extends Error {
    constructor() {
        super("Document packet not found in this conversation.");
    }
}
export function assertDocumentSchedulingAvailable(
    readiness = getDocumentGenerationCanaryState(),
) {
    if (
        process.env.DOCUMENT_GENERATION_ENABLED === "false" ||
        readiness.status === "failed"
    ) {
        throw new Error(
            "Document drafting is unavailable because the renderer is not ready. No work was queued. Try again when the service recovers.",
        );
    }
}
export function documentJobActivity(
    job: DocumentGenerationJobRow,
    items: DocumentGenerationItemRow[],
    now = Date.now(),
) {
    const times = [
        job.heartbeat_at,
        job.updated_at,
        job.created_at,
        ...items.map((item) => item.updated_at),
    ].filter(
        (value): value is string =>
            !!value && Number.isFinite(Date.parse(value)),
    );
    const last = times.length ? Math.max(...times.map(Date.parse)) : null;
    return {
        last_activity_at: last === null ? null : new Date(last).toISOString(),
        stalled:
            ["queued", "running"].includes(job.status) &&
            last !== null &&
            now - last > 120_000,
    };
}
export async function authorizedDocumentJob(
    db: Db,
    jobId: string,
    scope: DocumentJobScope,
    permission: "read" | "mutate" = "read",
) {
    const loaded = await getDocumentGenerationJob(db, jobId);
    const { job } = loaded;
    if (!job || (scope.chatId && job.chat_id !== scope.chatId))
        throw new DocumentJobAccessError();
    const allowed = job.project_id
        ? (
              await checkProjectAccess(
                  job.project_id,
                  scope.userId,
                  scope.userEmail,
                  db,
                  permission,
              )
          ).ok
        : job.user_id === scope.userId;
    if (!allowed) throw new DocumentJobAccessError();
    return { job, items: loaded.items };
}
function sanitizedLayoutSummary(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const attempt = value as Record<string, unknown>;
    const rawSummary =
        attempt.summary && typeof attempt.summary === "object"
            ? (attempt.summary as Record<string, unknown>)
            : null;
    if (!rawSummary) return null;
    return {
        renderer_mode:
            attempt.renderer_mode === "standard" ||
            attempt.renderer_mode === "compatibility"
                ? attempt.renderer_mode
                : null,
        status:
            rawSummary.status === "passed" ||
            rawSummary.status === "failed" ||
            rawSummary.status === "unavailable"
                ? rawSummary.status
                : null,
        reasons: Array.isArray(rawSummary.reasons)
            ? rawSummary.reasons
                  .filter(
                      (reason): reason is string => typeof reason === "string",
                  )
                  .slice(0, 10)
            : [],
        affected_pages: Array.isArray(rawSummary.affected_pages)
            ? rawSummary.affected_pages
                  .filter((page): page is number => Number.isInteger(page))
                  .slice(0, 20)
            : [],
        page_count:
            typeof rawSummary.page_count === "number"
                ? rawSummary.page_count
                : null,
        text_coverage:
            typeof rawSummary.text_coverage === "number"
                ? rawSummary.text_coverage
                : null,
        analyzer_version:
            typeof rawSummary.analyzer_version === "number"
                ? rawSummary.analyzer_version
                : null,
        missing_token_count:
            typeof rawSummary.missing_token_count === "number"
                ? rawSummary.missing_token_count
                : null,
    };
}

function draftStatusMetadata(item: DocumentGenerationItemRow) {
    const outline = validateSavedOutline(item.outline_json);
    const checkpoint = readDraftCheckpoint(item.draft_sections_json, outline);
    const sections = checkpoint.active_section
        ? [
              ...checkpoint.sections,
              {
                  heading: checkpoint.active_section.heading,
                  level: checkpoint.active_section.level,
                  content: checkpoint.active_section.content,
                  pageBreak: checkpoint.active_section.pageBreak,
                  ...(checkpoint.active_section.table
                      ? { table: checkpoint.active_section.table }
                      : {}),
              },
          ]
        : checkpoint.sections;
    const rawBudget =
        outline?.budget ??
        parseDraftBudget(
            (item.outline_json as { budget?: unknown } | null)?.budget,
        );
    return {
        word_count: sections.length ? draftedWordCount(sections) : null,
        word_budget: rawBudget
            ? {
                  target_words: rawBudget.targetWords,
                  max_words: rawBudget.maxWords,
                  source: rawBudget.source,
              }
            : null,
    };
}

export async function getDocumentGenerationStatus(
    db: Db,
    jobId: string,
    scope: DocumentJobScope,
) {
    const { job, items } = await authorizedDocumentJob(db, jobId, scope);
    const versionIds = items
        .map((item) => item.result_version_id)
        .filter((id): id is string => !!id);
    let versions: unknown[] = [];
    if (versionIds.length) {
        const { data, error: versionsError } = await db
            .from("document_versions")
            .select(
                "id, storage_path, document_id, documents!document_versions_document_id_fkey(filename)",
            )
            .in("id", versionIds);
        if (versionsError) {
            throw new Error(
                `Failed to load generated document downloads: ${versionsError.message}`,
                { cause: versionsError },
            );
        }
        versions = data ?? [];
    }
    const resultByVersion = new Map(
        versions.map((unknownRow) => {
            const row = unknownRow as Record<string, unknown>;
            const doc = (
                Array.isArray(row.documents) ? row.documents[0] : row.documents
            ) as { filename?: string } | null;
            const filename = doc?.filename ?? "document.docx";
            return [
                String(row.id),
                {
                    document_id: String(row.document_id),
                    version_id: String(row.id),
                    filename,
                    download_url: buildDownloadUrl(
                        String(row.storage_path),
                        filename,
                    ),
                },
            ];
        }),
    );

    return {
        id: job.id,
        status: job.status,
        model_id: job.model_id,
        total_items: job.total_items,
        completed_items: items.filter((item) => item.status === "ready").length,
        failed_items: items.filter((item) => item.status === "failed").length,
        cancellation_requested: !!job.cancel_requested_at,
        error: job.error,
        ...documentJobActivity(job, items),
        items: items.map((item) => {
            const attempts = Array.isArray(item.layout_attempts_json)
                ? item.layout_attempts_json
                : [];
            return {
                id: item.id,
                position: item.position,
                title: item.title,
                document_type: item.document_type,
                status: item.status,
                progress: item.progress,
                qa_status: item.qa_status,
                qa_findings: item.qa_findings_json,
                error: item.error,
                failure_code: item.failure_code ?? null,
                failure_stage: item.failure_stage ?? null,
                retryable: item.retryable === true,
                can_retry: item.status === "failed",
                ...draftStatusMetadata(item),
                layout_summary: sanitizedLayoutSummary(attempts.at(-1)),
                result: item.result_version_id
                    ? (resultByVersion.get(item.result_version_id) ?? null)
                    : null,
            };
        }),
    };
}
export type DocumentGenerationSnapshot = Awaited<
    ReturnType<typeof getDocumentGenerationStatus>
>;

export async function listChatDocumentGenerationStatuses(
    db: Db,
    scope: DocumentJobScope,
) {
    if (!scope.chatId) return [];
    const { data, error } = await db
        .from("document_generation_jobs")
        .select("id")
        .eq("chat_id", scope.chatId)
        .order("created_at", { ascending: false });
    if (error)
        throw new Error(
            `Could not load document packet status: ${error.message}`,
        );
    return Promise.all(
        (data ?? []).map((row) =>
            getDocumentGenerationStatus(db, String(row.id), scope),
        ),
    );
}

export async function retryDocumentGeneration(
    db: Db,
    jobId: string,
    scope: DocumentJobScope,
    retriedThisTurn = new Set<string>(),
) {
    const { job, items } = await authorizedDocumentJob(
        db,
        jobId,
        scope,
        "mutate",
    );
    if (retriedThisTurn.has(jobId))
        return { outcome: "already_requested", requeued_items: 0 };
    if (job.status === "queued" || job.status === "running")
        return { outcome: "running", requeued_items: 0 };
    if (job.status === "completed" || job.status === "cancelled")
        return { outcome: job.status, requeued_items: 0 };
    const failed = items.filter((item) => item.status === "failed");
    if (!failed.length) return { outcome: "not_retryable", requeued_items: 0 };
    assertDocumentSchedulingAvailable();
    retriedThisTurn.add(jobId);
    const updated = await retryFailedDocumentGenerationItems(db, jobId);
    return {
        outcome: updated ? "requeued" : "already_requested",
        requeued_items: updated ? failed.length : 0,
    };
}

export function documentGenerationContext(jobs: DocumentGenerationSnapshot[]) {
    if (!jobs.length)
        return "No document generation jobs are saved in this conversation.";
    return JSON.stringify(
        jobs.map((job) => ({
            id: job.id,
            status: job.status,
            total: job.total_items,
            ready: job.completed_items,
            failed: job.failed_items,
            last_activity_at: job.last_activity_at,
            delayed: job.stalled,
            items: job.items.map((item) => ({
                title: item.title,
                status: item.status,
                failure_code: item.failure_code,
                document_id: item.result?.document_id,
                version_id: item.result?.version_id,
            })),
        })),
    );
}
export function documentGenerationSummary(jobs: DocumentGenerationSnapshot[]) {
    if (!jobs.length)
        return "No document packet is saved in this conversation.";
    return jobs
        .map(
            (job) =>
                `${job.completed_items} of ${job.total_items} documents ready; ${job.failed_items} failed. ${job.stalled ? "Progress is delayed; current worker activity cannot be confirmed." : `Packet status: ${job.status}.`}`,
        )
        .join("\n\n");
}
