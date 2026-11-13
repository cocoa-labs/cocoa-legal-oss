import type { createServerSupabase } from "../supabase";
import type {
    DocumentGenerationItemRow,
    DocumentGenerationJobRow,
} from "./types";

export interface Query {
    table: string;
    operation: string;
    values?: unknown;
    columns?: string;
    filters: Record<string, unknown>;
    single: boolean;
}
export type Reply = { data: unknown; error: { message: string } | null };

/** Like PostgREST, a query executes only when its thenable is awaited. */
export function fixtureDb(handle: (query: Query) => Reply | Promise<Reply>) {
    const calls: Query[] = [];
    const query = (table: string, operation = "select", values?: unknown) => {
        const request: Query = {
            table,
            operation,
            values,
            filters: {},
            single: false,
        };
        const chain = {
            select(columns = "*") {
                request.columns = columns;
                return chain;
            },
            update(values: unknown) {
                request.operation = "update";
                request.values = values;
                return chain;
            },
            insert(values: unknown) {
                request.operation = "insert";
                request.values = values;
                return chain;
            },
            upsert(values: unknown) {
                request.operation = "upsert";
                request.values = values;
                return chain;
            },
            eq(column: string, value: unknown) {
                request.filters[column] = value;
                return chain;
            },
            in(column: string, value: unknown) {
                request.filters[column] = value;
                return chain;
            },
            ilike(column: string, value: unknown) {
                request.filters[column] = value;
                return chain;
            },
            order() {
                return chain;
            },
            limit() {
                return chain;
            },
            maybeSingle() {
                request.single = true;
                return chain;
            },
            single() {
                request.single = true;
                return chain;
            },
            then(
                resolve: (reply: Reply) => unknown,
                reject: (error: unknown) => unknown,
            ) {
                calls.push(structuredClone(request));
                return Promise.resolve()
                    .then(() => handle(request))
                    .then(resolve, reject);
            },
        };
        return chain;
    };
    return {
        calls,
        db: {
            from: query,
            rpc: (name: string, values: unknown) => query(name, "rpc", values),
        } as unknown as ReturnType<typeof createServerSupabase>,
    };
}

export function savedJob(
    overrides: Partial<DocumentGenerationJobRow> = {},
): DocumentGenerationJobRow {
    return {
        id: "job-1",
        user_id: "owner",
        project_id: null,
        chat_id: "chat-1",
        initiating_message_id: "user-message",
        assistant_message_id: null,
        model_id: "claude-sonnet-5",
        compact_brief: {},
        status: "running",
        total_items: 2,
        completed_items: 0,
        failed_items: 0,
        cancel_requested_at: null,
        heartbeat_at: new Date().toISOString(),
        claimed_by: "worker-1",
        error: null,
        ...overrides,
    };
}
export function savedItem(
    overrides: Partial<DocumentGenerationItemRow> = {},
): DocumentGenerationItemRow {
    return {
        id: "item-1",
        job_id: "job-1",
        position: 0,
        title: "Bylaws",
        document_type: "bylaws",
        drafting_instructions: "Prepare ordinary bylaws.",
        jurisdiction: null,
        layout_json: null,
        source_versions_json: [],
        status: "drafting",
        progress: 25,
        outline_json: {
            sections: [
                {
                    heading: "Governance",
                    level: 1,
                    instructions: "Explain governance.",
                },
            ],
        },
        draft_sections_json: [
            {
                heading: "Governance",
                content: "Keep this saved drafting checkpoint.",
            },
        ],
        layout_attempts_json: [],
        qa_status: "pending",
        qa_findings_json: [],
        result_document_id: null,
        result_version_id: null,
        retries: 0,
        failure_stage: null,
        failure_code: null,
        retryable: false,
        run_attempts: 1,
        error: null,
        ...overrides,
    };
}
