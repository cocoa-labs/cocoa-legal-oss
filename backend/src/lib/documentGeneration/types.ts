export type DocumentGenerationJobStatus =
    | "queued"
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";

export type DocumentGenerationItemStatus =
    | "queued"
    | "planning"
    | "drafting"
    | "assembling"
    | "qa"
    | "ready"
    | "failed"
    | "cancelled";

export interface DraftDocumentRequest {
    title: string;
    document_type: string;
    drafting_instructions: string;
    jurisdiction?: string | null;
    landscape?: boolean;
    source_version_ids?: string[];
}

export interface DocumentGenerationJobRow {
    id: string;
    user_id: string;
    project_id: string | null;
    chat_id: string | null;
    initiating_message_id: string | null;
    assistant_message_id: string | null;
    model_id: string;
    compact_brief: Record<string, unknown>;
    status: DocumentGenerationJobStatus;
    total_items: number;
    completed_items: number;
    failed_items: number;
    cancel_requested_at: string | null;
    heartbeat_at: string | null;
    claimed_by?: string | null;
    created_at?: string;
    updated_at?: string;
    error: string | null;
}

export interface DocumentGenerationItemRow {
    id: string;
    job_id: string;
    position: number;
    title: string;
    document_type: string;
    drafting_instructions: string;
    jurisdiction: string | null;
    layout_json: { landscape?: boolean } | null;
    source_versions_json: string[] | null;
    status: DocumentGenerationItemStatus;
    progress: number;
    outline_json: unknown;
    draft_sections_json: unknown;
    layout_attempts_json: unknown[];
    qa_status: "pending" | "passed" | "advisory" | "blocked";
    qa_findings_json: unknown[];
    result_document_id: string | null;
    result_version_id: string | null;
    retries: number;
    failure_stage: string | null;
    failure_code: string | null;
    retryable: boolean;
    run_attempts: number;
    error: string | null;
    updated_at?: string;
}
