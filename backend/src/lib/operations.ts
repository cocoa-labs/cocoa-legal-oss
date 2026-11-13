import crypto from "node:crypto";
import type { createServerSupabase } from "./supabase";
import { listAccessibleProjectIds } from "./access";
import { authorize } from "./authorization";
import {
    applyHighlightSetToDocx,
    removeHighlightsFromDocx,
    type HighlightApplyFallbackAnchor,
    type HighlightTarget,
} from "./documentHighlights";
import { loadActiveVersion } from "./documentVersions";
import { startAuthoringJob } from "./authoringExecute";
import type { UserApiKeys } from "./llm";
import { ensureVersionExportable } from "./documentLayoutGate";

type Db = ReturnType<typeof createServerSupabase>;

const NUMBERED_VERSION_SOURCES = [
    "upload",
    "user_upload",
    "assistant_edit",
    "assistant_highlight",
    "assistant_undo",
    "generated",
    "authored",
    "clean_final",
];

export type OperationStatus =
    | "pending_approval"
    | "approved"
    | "running"
    | "succeeded"
    | "failed"
    | "undone"
    | "cancelled";

export type OperationApproval =
    | "not_required"
    | "required"
    | "approved"
    | "rejected";

export type MatterRole =
    | "owner"
    | "admin"
    | "lawyer"
    | "editor"
    | "reviewer"
    | "viewer";

export type ToolPermissionScope =
    | "read"
    | "search"
    | "document:annotate"
    | "document:mutate"
    | "document:export"
    | "matter:admin"
    | "email:send"
    | "esign:send"
    | "case:read"
    | "case:write"
    | "calendar:read"
    | "calendar:write";

export type OperationInverse =
    | "none"
    | "restore_source_version"
    | "remove_highlights"
    | "archive_generated_document"
    | "restore_archived_document"
    | "revert_tabular_cells"
    | "cancel_email"
    | "void_signature_envelope"
    | "cancel_calendar_event"
    | "restore_calendar_event";

export type AgentOperation = {
    id: string;
    org_id: string | null;
    matter_id: string | null;
    project_id: string | null;
    chat_id: string | null;
    actor_user_id: string;
    actor_role: string | null;
    tool_name: string;
    action_type: string;
    status: OperationStatus;
    approval_status: OperationApproval;
    mutating: boolean;
    requires_approval: boolean;
    source_document_id: string | null;
    source_version_id: string | null;
    result_document_id: string | null;
    result_version_id: string | null;
    input_hash: string | null;
    arguments: Record<string, unknown>;
    metadata: Record<string, unknown>;
    providers: unknown[];
    citations: unknown[];
    anchors: unknown[];
    affected_ranges: unknown[];
    errors: unknown[];
    inverse_operation: OperationInverse | string | null;
    parent_operation_id: string | null;
    idempotency_key: string | null;
    approved_by_user_id: string | null;
    approved_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
};

export type CreateAgentOperationInput = {
    db: Db;
    userId: string;
    orgId?: string | null;
    matterId?: string | null;
    projectId?: string | null;
    chatId?: string | null;
    /** The turn's user message id, for message-precise chain-of-custody (migration 018). */
    chatMessageId?: string | null;
    toolName: string;
    actionType: string;
    status?: OperationStatus;
    approvalStatus?: OperationApproval;
    mutating?: boolean;
    requiresApproval?: boolean;
    sourceDocumentId?: string | null;
    sourceVersionId?: string | null;
    resultDocumentId?: string | null;
    resultVersionId?: string | null;
    arguments?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    providers?: unknown[];
    citations?: unknown[];
    anchors?: unknown[];
    affectedRanges?: unknown[];
    errors?: unknown[];
    inverseOperation?: OperationInverse | string | null;
    parentOperationId?: string | null;
    idempotencyKey?: string | null;
};

function isProduction(): boolean {
    return process.env.NODE_ENV === "production";
}

function isMissingOperationSchema(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message ?? "")
              : String(error ?? "");
    return /agent_operations|organizations|matters/i.test(message) &&
        /schema cache|could not find|does not exist|relation|column/i.test(message);
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function stringArg(
    args: Record<string, unknown>,
    key: string,
): string | null {
    return typeof args[key] === "string" && args[key]
        ? (args[key] as string)
        : null;
}

function normalizeHighlightTargets(value: unknown): HighlightTarget[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(
            (item): item is Record<string, unknown> =>
                !!item && typeof item === "object" && !Array.isArray(item),
        )
        .map((item): HighlightTarget => {
            const kind: HighlightTarget["kind"] =
                item.kind === "idea" || item.kind === "term"
                    ? item.kind
                    : undefined;
            return {
                label: typeof item.label === "string" ? item.label : undefined,
                term: typeof item.term === "string" ? item.term : undefined,
                quote: typeof item.quote === "string" ? item.quote : undefined,
                kind,
            };
        })
        .filter((item) => item.term || item.quote);
}

function normalizeHighlightFallbacks(value: unknown): HighlightApplyFallbackAnchor[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): HighlightApplyFallbackAnchor[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        const quote = typeof row.quote === "string" ? row.quote.trim() : "";
        if (!quote) return [];
        return [
            {
                id: typeof row.id === "string" ? row.id : null,
                quote,
                occurrence_index:
                    typeof row.occurrence_index === "number" &&
                    Number.isFinite(row.occurrence_index)
                        ? row.occurrence_index
                        : 0,
                status:
                    row.status === "kept" ||
                    row.status === "removed" ||
                    row.status === "applied"
                        ? row.status
                        : "kept",
            },
        ];
    });
}

function stableJson(value: unknown): string {
    const normalize = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(normalize);
        if (input && typeof input === "object") {
            return Object.fromEntries(
                Object.entries(input as Record<string, unknown>)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => [k, normalize(v)]),
            );
        }
        return input;
    };
    return JSON.stringify(normalize(value));
}

function inputHash(args: Record<string, unknown>): string {
    return crypto.createHash("sha256").update(stableJson(args)).digest("hex");
}

function serializeOperation(row: Record<string, unknown>): AgentOperation {
    return {
        id: String(row.id),
        org_id: typeof row.org_id === "string" ? row.org_id : null,
        matter_id: typeof row.matter_id === "string" ? row.matter_id : null,
        project_id: typeof row.project_id === "string" ? row.project_id : null,
        chat_id: typeof row.chat_id === "string" ? row.chat_id : null,
        actor_user_id: String(row.actor_user_id ?? ""),
        actor_role: typeof row.actor_role === "string" ? row.actor_role : null,
        tool_name: String(row.tool_name ?? ""),
        action_type: String(row.action_type ?? ""),
        status: String(row.status ?? "running") as OperationStatus,
        approval_status: String(row.approval_status ?? "not_required") as OperationApproval,
        mutating: !!row.mutating,
        requires_approval: !!row.requires_approval,
        source_document_id:
            typeof row.source_document_id === "string" ? row.source_document_id : null,
        source_version_id:
            typeof row.source_version_id === "string" ? row.source_version_id : null,
        result_document_id:
            typeof row.result_document_id === "string" ? row.result_document_id : null,
        result_version_id:
            typeof row.result_version_id === "string" ? row.result_version_id : null,
        input_hash: typeof row.input_hash === "string" ? row.input_hash : null,
        arguments: toRecord(row.arguments),
        metadata: toRecord(row.metadata),
        providers: Array.isArray(row.providers) ? row.providers : [],
        citations: Array.isArray(row.citations) ? row.citations : [],
        anchors: Array.isArray(row.anchors) ? row.anchors : [],
        affected_ranges: Array.isArray(row.affected_ranges)
            ? row.affected_ranges
            : [],
        errors: Array.isArray(row.errors) ? row.errors : [],
        inverse_operation:
            typeof row.inverse_operation === "string" ? row.inverse_operation : null,
        parent_operation_id:
            typeof row.parent_operation_id === "string" ? row.parent_operation_id : null,
        idempotency_key:
            typeof row.idempotency_key === "string" ? row.idempotency_key : null,
        approved_by_user_id:
            typeof row.approved_by_user_id === "string"
                ? row.approved_by_user_id
                : null,
        approved_at: typeof row.approved_at === "string" ? row.approved_at : null,
        completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
        created_at: String(row.created_at ?? ""),
        updated_at: String(row.updated_at ?? ""),
    };
}

async function tolerateMissingSchema<T>(
    label: string,
    work: () => Promise<T>,
): Promise<T | null> {
    try {
        return await work();
    } catch (err) {
        if (isMissingOperationSchema(err) && !isProduction()) {
            console.warn(`[operations] ${label} skipped; migration not applied`, {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
        throw err;
    }
}

function isLegacyVersionInsertError(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message ?? "")
              : String(error ?? "");
    return /document_versions_source_check|violates check constraint|source|parent_version_id|created_by_operation_id|content_status|extraction_quality|schema cache|could not find/i.test(
        message,
    );
}

async function nextDocumentVersionNumber(
    db: Db,
    documentId: string,
): Promise<number> {
    const { data } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", NUMBERED_VERSION_SOURCES)
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
    return ((data?.version_number as number | null) ?? 1) + 1;
}

async function insertRestoredVersion(params: {
    db: Db;
    userId: string;
    documentId: string;
    restoreVersionId: string;
    parentVersionId: string | null;
    operationId: string | null;
    restoredFromOperationId: string;
}): Promise<{ id: string; version_number: number }> {
    const { data: sourceVersion, error: sourceErr } = await params.db
        .from("document_versions")
        .select(
            "id, document_id, storage_path, pdf_storage_path, display_name, source, metadata",
        )
        .eq("id", params.restoreVersionId)
        .single();
    if (sourceErr || !sourceVersion) {
        throw sourceErr ?? new Error("Source version for undo was not found.");
    }
    if (sourceVersion.document_id !== params.documentId) {
        throw new Error("Undo source version does not belong to this document.");
    }
    if (!sourceVersion.storage_path) {
        throw new Error("Undo source version is missing document bytes.");
    }
    const { data: sourceDocument } = await params.db
        .from("documents")
        .select("file_type")
        .eq("id", params.documentId)
        .single();
    const verifiedSource = await ensureVersionExportable({
        db: params.db,
        documentId: params.documentId,
        versionId: params.restoreVersionId,
        fileType: (sourceDocument?.file_type as string | null) ?? null,
    });

    const versionNumber = await nextDocumentVersionNumber(
        params.db,
        params.documentId,
    );
    const baseInsert: Record<string, unknown> = {
        document_id: params.documentId,
        storage_path: sourceVersion.storage_path,
        pdf_storage_path: sourceVersion.pdf_storage_path ?? null,
        source: "assistant_undo",
        version_number: versionNumber,
        display_name:
            (sourceVersion.display_name as string | null) ?? "Restored version",
        created_by_user_id: params.userId,
        parent_version_id: params.parentVersionId,
        created_by_operation_id: params.operationId,
        content_status: "ready",
        extraction_quality: {
            restored_from_version_id: params.restoreVersionId,
            restored_from_operation_id: params.restoredFromOperationId,
        },
        layout_qa_status:
            verifiedSource.status === "passed" ? "passed" : "source",
        layout_qa_report: verifiedSource.report,
        layout_qa_checked_at: verifiedSource.report?.checked_at ?? null,
        metadata: {
            ...((sourceVersion.metadata as Record<string, unknown> | null) ??
                {}),
            source: "assistant_undo",
            restored_from_version_id: params.restoreVersionId,
            restored_from_operation_id: params.restoredFromOperationId,
            parent_version_id: params.parentVersionId,
            operation_id: params.operationId,
            inverse_operation: "restore_source_version",
        },
    };

    let { data: inserted, error } = await params.db
        .from("document_versions")
        .insert(baseInsert)
        .select("id, version_number")
        .single();

    if (error && isLegacyVersionInsertError(error)) {
        const legacyInsert = {
            document_id: baseInsert.document_id,
            storage_path: baseInsert.storage_path,
            pdf_storage_path: baseInsert.pdf_storage_path,
            source: "assistant_highlight",
            version_number: baseInsert.version_number,
            display_name: baseInsert.display_name,
            created_by_user_id: baseInsert.created_by_user_id,
            metadata: baseInsert.metadata,
        };
        const retry = await params.db
            .from("document_versions")
            .insert(legacyInsert)
            .select("id, version_number")
            .single();
        inserted = retry.data;
        error = retry.error;
    }

    if (error || !inserted) {
        throw error ?? new Error("Failed to create undo document version.");
    }

    const restoredId = String(inserted.id);
    const { error: activateError } = await params.db
        .from("documents")
        .update({
            current_version_id: restoredId,
            updated_at: new Date().toISOString(),
        })
        .eq("id", params.documentId);
    if (activateError) {
        throw activateError;
    }

    return {
        id: restoredId,
        version_number:
            (inserted.version_number as number | null) ?? versionNumber,
    };
}

export async function createAgentOperation(
    input: CreateAgentOperationInput,
): Promise<AgentOperation | null> {
    const args = input.arguments ?? {};
    return tolerateMissingSchema("create", async () => {
        if (input.idempotencyKey) {
            const { data: existing, error: existingErr } = await input.db
                .from("agent_operations")
                .select("*")
                .eq("idempotency_key", input.idempotencyKey)
                .maybeSingle();
            if (existingErr) throw existingErr;
            if (existing) {
                return serializeOperation(existing as Record<string, unknown>);
            }
        }
        const status =
            input.status ??
            (input.requiresApproval ? "pending_approval" : "running");
        const { data, error } = await input.db
            .from("agent_operations")
            .insert({
                org_id: input.orgId ?? null,
                matter_id: input.matterId ?? null,
                project_id: input.projectId ?? null,
                chat_id: input.chatId ?? null,
                chat_message_id: input.chatMessageId ?? null,
                actor_user_id: input.userId,
                actor_role: null,
                tool_name: input.toolName,
                action_type: input.actionType,
                status,
                approval_status:
                    input.approvalStatus ??
                    (input.requiresApproval ? "required" : "not_required"),
                mutating: !!input.mutating,
                requires_approval: !!input.requiresApproval,
                source_document_id: input.sourceDocumentId ?? null,
                source_version_id: input.sourceVersionId ?? null,
                result_document_id: input.resultDocumentId ?? null,
                result_version_id: input.resultVersionId ?? null,
                input_hash: inputHash(args),
                arguments: args,
                metadata: input.metadata ?? {},
                providers: input.providers ?? [],
                citations: input.citations ?? [],
                anchors: input.anchors ?? [],
                affected_ranges: input.affectedRanges ?? [],
                errors: input.errors ?? [],
                inverse_operation: input.inverseOperation ?? null,
                parent_operation_id: input.parentOperationId ?? null,
                idempotency_key: input.idempotencyKey ?? null,
                completed_at: ["succeeded", "failed", "undone"].includes(status)
                    ? new Date().toISOString()
                    : null,
            })
            .select("*")
            .single();
        if (error) {
            if (input.idempotencyKey) {
                const message =
                    typeof error.message === "string" ? error.message : "";
                if (/duplicate|agent_operations_idempotency/i.test(message)) {
                    const { data: existing } = await input.db
                        .from("agent_operations")
                        .select("*")
                        .eq("idempotency_key", input.idempotencyKey)
                        .maybeSingle();
                    if (existing) {
                        return serializeOperation(
                            existing as Record<string, unknown>,
                        );
                    }
                }
            }
            throw error;
        }
        return serializeOperation(data as Record<string, unknown>);
    });
}

export async function updateAgentOperation(
    db: Db,
    operationId: string | null | undefined,
    updates: Partial<CreateAgentOperationInput> & {
        status?: OperationStatus;
        approvalStatus?: OperationApproval;
        completed?: boolean;
        approvedByUserId?: string | null;
        resultDocumentId?: string | null;
        resultVersionId?: string | null;
        errors?: unknown[];
    },
): Promise<AgentOperation | null> {
    if (!operationId) return null;
    return tolerateMissingSchema("update", async () => {
        const row: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
        };
        if (updates.status) row.status = updates.status;
        if (updates.approvalStatus) row.approval_status = updates.approvalStatus;
        if (updates.completed) row.completed_at = new Date().toISOString();
        if (updates.approvedByUserId) {
            row.approved_by_user_id = updates.approvedByUserId;
            row.approved_at = new Date().toISOString();
        }
        if ("resultDocumentId" in updates)
            row.result_document_id = updates.resultDocumentId ?? null;
        if ("resultVersionId" in updates)
            row.result_version_id = updates.resultVersionId ?? null;
        // Staged-argument updates (e.g. the PI automation's reassignRun
        // retargeting a pending case-write to a different case). input_hash
        // is left as the proposal-time hash on purpose — it records what
        // was originally proposed, not the post-edit state.
        if (updates.arguments) row.arguments = updates.arguments;
        if (updates.metadata) row.metadata = updates.metadata;
        if (updates.providers) row.providers = updates.providers;
        if (updates.citations) row.citations = updates.citations;
        if (updates.anchors) row.anchors = updates.anchors;
        if (updates.affectedRanges) row.affected_ranges = updates.affectedRanges;
        if (updates.errors) row.errors = updates.errors;

        const { data, error } = await db
            .from("agent_operations")
            .update(row)
            .eq("id", operationId)
            .select("*")
            .single();
        if (error) throw error;
        return serializeOperation(data as Record<string, unknown>);
    });
}

export async function failAgentOperation(
    db: Db,
    operationId: string | null | undefined,
    error: unknown,
): Promise<AgentOperation | null> {
    const message = error instanceof Error ? error.message : String(error);
    return updateAgentOperation(db, operationId, {
        status: "failed",
        completed: true,
        errors: [{ message }],
    });
}

export async function listAgentOperations(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    projectId?: string | null;
    matterId?: string | null;
    documentId?: string | null;
    chatId?: string | null;
    limit?: number;
}): Promise<AgentOperation[]> {
    return (
        (await tolerateMissingSchema("list", async () => {
            const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
            let query = params.db
                .from("agent_operations")
                .select("*")
                .order("created_at", { ascending: false })
                .limit(limit);

            if (params.documentId) {
                const { data: doc } = await params.db
                    .from("documents")
                    .select("id, user_id, project_id")
                    .eq("id", params.documentId)
                    .single();
                if (!doc) return [];
                const access = await authorize({
                    db: params.db,
                    userId: params.userId,
                    userEmail: params.userEmail,
                    action: "operation:read",
                    resource: { documentId: params.documentId },
                });
                if (!access.ok) return [];
                query = query.or(
                    `source_document_id.eq.${params.documentId},result_document_id.eq.${params.documentId}`,
                );
            } else if (params.chatId) {
                query = query
                    .eq("chat_id", params.chatId)
                    .eq("actor_user_id", params.userId);
            } else if (params.matterId) {
                const access = await authorize({
                    db: params.db,
                    userId: params.userId,
                    userEmail: params.userEmail,
                    action: "operation:read",
                    resource: { matterId: params.matterId },
                });
                if (!access.ok) return [];
                query = query.eq("matter_id", params.matterId);
            } else if (params.projectId) {
                const access = await authorize({
                    db: params.db,
                    userId: params.userId,
                    userEmail: params.userEmail,
                    action: "operation:read",
                    resource: { projectId: params.projectId },
                });
                if (!access.ok) return [];
                query = query.eq("project_id", params.projectId);
            } else {
                const accessibleProjects = await listAccessibleProjectIds(
                    params.userId,
                    params.userEmail,
                    params.db,
                );
                const actorFilter = `actor_user_id.eq.${params.userId}`;
                if (accessibleProjects.length > 0) {
                    query = query.or(
                        `${actorFilter},project_id.in.(${accessibleProjects.join(",")})`,
                    );
                } else {
                    query = query.eq("actor_user_id", params.userId);
                }
            }

            const { data, error } = await query;
            if (error) throw error;
            return ((data ?? []) as Record<string, unknown>[]).map(
                serializeOperation,
            );
        })) ?? []
    );
}

export async function getAgentOperation(params: {
    db: Db;
    operationId: string;
    userId: string;
    userEmail?: string | null;
}): Promise<AgentOperation | null> {
    return tolerateMissingSchema("get", async () => {
        const { data, error } = await params.db
            .from("agent_operations")
            .select("*")
            .eq("id", params.operationId)
            .single();
        if (error || !data) return null;
        const op = serializeOperation(data as Record<string, unknown>);
        const access = await authorize({
            db: params.db,
            userId: params.userId,
            userEmail: params.userEmail,
            action: "operation:read",
            resource: {
                orgId: op.org_id,
                matterId: op.matter_id,
                projectId: op.project_id,
                documentId: op.result_document_id ?? op.source_document_id,
                actorUserId: op.actor_user_id,
            },
        });
        return access.ok ? op : null;
    });
}

/**
 * Non-AgentOperation result returned by approveAgentOperation ONLY for the
 * `assemble_document` branch: that branch no longer blocks on the ~50-90s
 * draft+QA — it launches a detached background worker (startAuthoringJob) and
 * returns this kickoff payload IMMEDIATELY so the HTTP request finishes before
 * any proxy/LB timeout. The client then polls GET /templates/jobs/:job_id for the
 * terminal state. `status` is always "assembling" here; the worker advances the
 * authoring_jobs row to qa → ready|failed out-of-band.
 */
export type AssembleKickoff = {
    status: "assembling";
    job_id: string | null;
    operation_id: string;
};

export function isAssembleKickoff(
    value: AgentOperation | AssembleKickoff | null,
): value is AssembleKickoff {
    return (
        !!value &&
        "status" in value &&
        (value as AssembleKickoff).status === "assembling" &&
        "operation_id" in value
    );
}

export async function approveAgentOperation(params: {
    db: Db;
    operationId: string;
    userId: string;
    userEmail?: string | null;
    /**
     * Optional model + API keys for the headless drafting / QA completions of
     * the `assemble_document` branch. The approve route fetches the approving
     * user's keys (the same `getUserApiKeys` the chat + wizard routes use) so a
     * BYOK-only user — who has no environment credential for the default
     * provider — drafts with THEIR key instead of getting blank sections. Only
     * the `assemble_document` branch reads these; every other branch
     * (highlights / removal) ignores them. `model` is typically left undefined
     * on the approve path (no per-request picker) so
     * `resolveAvailableMainModel(undefined, apiKeys)` selects a model the user's
     * keys can actually reach.
     */
    model?: string;
    apiKeys?: UserApiKeys;
}): Promise<AgentOperation | AssembleKickoff | null> {
    const op = await getAgentOperation(params);
    if (!op) return null;
    const access = await authorize({
        db: params.db,
        userId: params.userId,
        userEmail: params.userEmail,
        action: "operation:approve",
        resource: {
            orgId: op.org_id,
            matterId: op.matter_id,
            projectId: op.project_id,
            documentId: op.result_document_id ?? op.source_document_id,
            actorUserId: op.actor_user_id,
        },
    });
    if (!access.ok) {
        throw new Error("You do not have permission to approve this operation.");
    }
    if (op.status !== "pending_approval" && op.approval_status !== "required") {
        return op;
    }

    await updateAgentOperation(params.db, op.id, {
        status: "approved",
        approvalStatus: "approved",
        approvedByUserId: params.userId,
    });

    if (!op.requires_approval) {
        return getAgentOperation(params);
    }

    const actingUserId = op.actor_user_id || params.userId;
    try {
        if (op.tool_name === "apply_document_highlights") {
            const documentId =
                op.source_document_id ?? stringArg(op.arguments, "document_id");
            const setId = stringArg(op.arguments, "highlight_set_id");
            if (!documentId || !setId) {
                throw new Error("Highlight operation is missing document or set metadata.");
            }
            const active = await loadActiveVersion(documentId, params.db);
            if (
                op.source_version_id &&
                active?.id &&
                active.id !== op.source_version_id
            ) {
                throw new Error(
                    "This document changed after the operation was proposed. Create a new highlight proposal before applying.",
                );
            }
            await updateAgentOperation(params.db, op.id, { status: "running" });
            const result = await applyHighlightSetToDocx({
                db: params.db,
                userId: actingUserId,
                documentId,
                setId,
                fallbackHighlights: normalizeHighlightFallbacks(
                    op.arguments?.fallback_highlights,
                ),
                operationId: op.id,
            });
            return updateAgentOperation(params.db, op.id, {
                status: "succeeded",
                completed: true,
                resultDocumentId: documentId,
                resultVersionId: result.version_id,
                metadata: {
                    applied_count: result.applied_count,
                    errors: result.errors,
                    approved_by_user_id: params.userId,
                },
                affectedRanges: result.applied_highlight_ids,
            });
        }

        if (op.tool_name === "assemble_document") {
            // DETACHED BACKGROUND JOB (no longer blocks the approve request).
            // The drafting + assembly + four-guardrail QA take ~50-90s — long
            // enough to trip a proxy / load-balancer idle timeout if we awaited
            // it inside the HTTP request. So instead of running it inline, we
            // mark the operation running and fire-and-forget startAuthoringJob,
            // returning the job id IMMEDIATELY. The background worker
            // (executeAuthoringJob) OWNS the terminal reconcile: it lands the
            // authoring_jobs row in ready|failed AND updates this operation to
            // succeeded|failed out-of-band. We deliberately do NOT mark the
            // operation succeeded/failed here — that would race the worker.
            //
            // The client switches from "wait for the operation" to polling
            // GET /templates/jobs/:job_id (the status endpoint) for the terminal
            // state + result. The approving user's model + API keys are still
            // threaded so drafting + QA run under THEIR credentials (critical
            // for BYOK-only users, who have no env key for the default
            // provider — otherwise every section draft hits an auth error and is
            // swallowed to "", yielding a blank document).
            await updateAgentOperation(params.db, op.id, { status: "running" });
            const jobId =
                typeof op.arguments?.authoring_job_id === "string"
                    ? (op.arguments.authoring_job_id as string)
                    : null;
            startAuthoringJob({
                db: params.db,
                op,
                model: params.model,
                apiKeys: params.apiKeys,
            });
            return {
                status: "assembling",
                job_id: jobId,
                operation_id: op.id,
            };
        }

        if (op.tool_name === "remove_document_highlights") {
            const documentId =
                op.source_document_id ?? stringArg(op.arguments, "document_id");
            if (!documentId) {
                throw new Error("Highlight removal operation is missing document metadata.");
            }
            const active = await loadActiveVersion(documentId, params.db);
            if (
                op.source_version_id &&
                active?.id &&
                active.id !== op.source_version_id
            ) {
                throw new Error(
                    "This document changed after the operation was proposed. Create a new removal proposal before applying.",
                );
            }
            const targets = normalizeHighlightTargets(op.arguments.targets);
            const removeAll =
                op.arguments.all === true ||
                (typeof op.arguments.all === "string" &&
                    op.arguments.all.toLowerCase() === "true") ||
                targets.length === 0;
            await updateAgentOperation(params.db, op.id, { status: "running" });
            const result = await removeHighlightsFromDocx({
                db: params.db,
                userId: actingUserId,
                documentId,
                targets,
                all: removeAll,
                operationId: op.id,
            });
            return updateAgentOperation(params.db, op.id, {
                status: "succeeded",
                completed: true,
                resultDocumentId: documentId,
                resultVersionId: result.version_id,
                metadata: {
                    removed_count: result.removed_count,
                    errors: result.errors,
                    all: removeAll,
                    approved_by_user_id: params.userId,
                },
            });
        }

        return getAgentOperation(params);
    } catch (err) {
        await failAgentOperation(params.db, op.id, err).catch(() => {});
        throw err;
    }
}

export async function undoAgentOperation(params: {
    db: Db;
    operationId: string;
    userId: string;
    userEmail?: string | null;
}): Promise<AgentOperation | null> {
    const op = await getAgentOperation(params);
    if (!op) return null;
    const access = await authorize({
        db: params.db,
        userId: params.userId,
        userEmail: params.userEmail,
        action: "operation:undo",
        resource: {
            orgId: op.org_id,
            matterId: op.matter_id,
            projectId: op.project_id,
            documentId: op.result_document_id ?? op.source_document_id,
            actorUserId: op.actor_user_id,
        },
    });
    if (!access.ok) {
        throw new Error("You do not have permission to undo this operation.");
    }
    if (op.inverse_operation !== "restore_source_version") {
        throw new Error("This operation does not have an automatic undo.");
    }
    if (!op.result_document_id || !op.source_version_id) {
        throw new Error("This operation is missing source version metadata.");
    }

    const undoOperation = await createAgentOperation({
        db: params.db,
        userId: params.userId,
        orgId: op.org_id,
        matterId: op.matter_id,
        projectId: op.project_id,
        chatId: op.chat_id,
        toolName: "undo_operation",
        actionType: "undo",
        status: "running",
        approvalStatus: "approved",
        mutating: true,
        requiresApproval: false,
        sourceDocumentId: op.result_document_id,
        sourceVersionId: op.result_version_id,
        resultDocumentId: op.result_document_id,
        arguments: { operation_id: op.id },
        metadata: {
            inverse_of: op.id,
            restored_version_id: op.source_version_id,
        },
        inverseOperation: "restore_source_version",
        parentOperationId: op.id,
    });

    try {
        const restored = await insertRestoredVersion({
            db: params.db,
            userId: params.userId,
            documentId: op.result_document_id,
            restoreVersionId: op.source_version_id,
            parentVersionId: op.result_version_id,
            operationId: undoOperation?.id ?? null,
            restoredFromOperationId: op.id,
        });

        await updateAgentOperation(params.db, op.id, {
            status: "undone",
            completed: true,
        });

        return updateAgentOperation(params.db, undoOperation?.id, {
            status: "succeeded",
            completed: true,
            resultDocumentId: op.result_document_id,
            resultVersionId: restored.id,
            metadata: {
                inverse_of: op.id,
                restored_version_id: op.source_version_id,
                created_version_id: restored.id,
                created_version_number: restored.version_number,
            },
        });
    } catch (err) {
        await failAgentOperation(params.db, undoOperation?.id, err).catch(
            () => {},
        );
        throw err;
    }
}
