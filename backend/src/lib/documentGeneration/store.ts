import crypto from "node:crypto";
import type { createServerSupabase } from "../supabase";
import type {
    DocumentGenerationItemRow,
    DocumentGenerationJobRow,
    DraftDocumentRequest,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

export async function createDocumentGenerationJob(params: {
    db: Db;
    userId: string;
    projectId?: string | null;
    chatId?: string | null;
    initiatingMessageId?: string | null;
    assistantMessageId?: string | null;
    modelId: string;
    brief?: Record<string, unknown>;
    documents: DraftDocumentRequest[];
}): Promise<{ jobId: string }> {
    const jobId = crypto.randomUUID();
    const { error: jobError } = await params.db
        .from("document_generation_jobs")
        .insert({
            id: jobId,
            user_id: params.userId,
            project_id: params.projectId ?? null,
            chat_id: params.chatId ?? null,
            initiating_message_id: params.initiatingMessageId ?? null,
            assistant_message_id: params.assistantMessageId ?? null,
            model_id: params.modelId,
            compact_brief: params.brief ?? {},
            total_items: params.documents.length,
            status: "queued",
        });
    if (jobError)
        throw new Error(`Failed to queue drafting job: ${jobError.message}`);

    const rows = params.documents.map((document, position) => ({
        job_id: jobId,
        position,
        title: document.title,
        document_type: document.document_type,
        drafting_instructions: document.drafting_instructions,
        jurisdiction: document.jurisdiction ?? null,
        layout_json: { landscape: document.landscape === true },
        source_versions_json: document.source_version_ids ?? [],
        status: "queued",
    }));
    const { error: itemError } = await params.db
        .from("document_generation_items")
        .insert(rows);
    if (itemError) {
        const { error: failureError } = await params.db
            .from("document_generation_jobs")
            .update({ status: "failed", error: itemError.message })
            .eq("id", jobId);
        if (failureError)
            throw new Error(
                `Failed to queue drafting items (${itemError.message}) and save the job failure (${failureError.message}).`,
            );
        throw new Error(`Failed to queue drafting items: ${itemError.message}`);
    }
    return { jobId };
}

export async function getDocumentGenerationJob(db: Db, jobId: string) {
    const [{ data: job, error }, { data: items, error: itemsError }] =
        await Promise.all([
            db
                .from("document_generation_jobs")
                .select("*")
                .eq("id", jobId)
                .maybeSingle(),
            db
                .from("document_generation_items")
                .select("*")
                .eq("job_id", jobId)
                .order("position", { ascending: true }),
        ]);
    if (error) throw new Error(error.message);
    if (itemsError)
        throw new Error(`Failed to load drafting items: ${itemsError.message}`);
    return {
        job: (job as DocumentGenerationJobRow | null) ?? null,
        items: (items as DocumentGenerationItemRow[] | null) ?? [],
    };
}

export async function requestDocumentGenerationCancel(db: Db, jobId: string) {
    const now = new Date().toISOString();
    const { data, error } = await db
        .from("document_generation_jobs")
        .update({ cancel_requested_at: now, updated_at: now })
        .eq("id", jobId)
        .in("status", ["queued", "running"])
        .select("id")
        .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
}

/** Atomically requeue only failed items while preserving ready artifacts. */
export async function retryFailedDocumentGenerationItems(
    db: Db,
    jobId: string,
): Promise<DocumentGenerationJobRow | null> {
    const { data, error } = await db.rpc("retry_document_generation_job", {
        p_job_id: jobId,
    });
    if (error) throw new Error(error.message, { cause: error });
    const row = Array.isArray(data) ? data[0] : data;
    return (row as DocumentGenerationJobRow | null | undefined) ?? null;
}
