/**
 * Cocoa Legal API client — all requests to the Node.js backend.
 * Attaches the Supabase auth token for user authentication.
 */

import { supabase } from "@/lib/supabase";
import { API_BASE } from "@/app/lib/apiBase";
import type {
    AgentOperation,
    AssistantEvent,
    AuthoringJobStatus,
    CapabilityRunRecord,
    DocumentGenerationJobStatus,
    CocoaLegalChat,
    CocoaLegalChatDetailOut,
    CocoaLegalCitationAnnotation,
    CocoaLegalDocument,
    CocoaLegalFolder,
    CocoaLegalMessage,
    CocoaLegalProject,
    CocoaLegalWorkflow,
    CocoaLegalHighlightAnnotation,
    CocoaLegalImageAttachment,
    CocoaLegalMessageAttachment,
    DocTemplate,
    DocTemplateSection,
    DocTemplateVariable,
    DocTemplateVersion,
    LegalSearchResult,
    Recording,
    TabularReview,
    TabularReviewDetailOut,
    VersionContextSnapshot,
} from "@/app/components/shared/types";
import { assistantContentFromEvents } from "@/app/lib/conversationContent";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: CocoaLegalMessageAttachment[] | null;
    workflow?: { id: string; title: string } | null;
    annotations?: CocoaLegalCitationAnnotation[] | null;
    inherited_from_chat_id?: string | null;
    version_context?: VersionContextSnapshot | null;
    created_at: string;
    generation_status?: string | null;
    finish_reason?: string | null;
    /** Present on user turns confirmed from a proposal chip. */
    capability_run?: CapabilityRunRecord | null;
}
interface ServerChatDetailOut {
    chat: CocoaLegalChat;
    messages: ServerMessage[];
}

async function getAuthHeader(): Promise<Record<string, string>> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return {};
    return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * What every failed `apiRequest` throws.
 *
 * `message` is still the backend's `detail` string, byte for byte, so the many
 * `err instanceof Error ? err.message : "…"` handlers across the app keep
 * rendering exactly what they rendered before this class existed. `status` and
 * `code` are purely additive, for the handful of callers that must tell WHICH
 * refusal they got apart from merely showing it — a 409 the user can answer
 * looks nothing like a 500 they can't.
 */
export class ApiError extends Error {
    status: number;
    /** The backend's machine-readable `code`, when it sent one. */
    code: string | null;
    constructor(message: string, status: number, code: string | null = null) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

/**
 * A successful local mutation can change several matter-wide projections at
 * once (documents, mail, signatures, tasks, or pending operations). Consumers
 * listen for this event so they can refresh immediately instead of waiting for
 * the next consolidated 15-second poll.
 */
export const ACTION_STATE_MUTATED_EVENT = "cocoa:action-state-mutated";

function notifyActionStateMutation(method: string | undefined): void {
    if (
        !method ||
        method.toUpperCase() === "GET" ||
        typeof window === "undefined"
    ) {
        return;
    }
    window.dispatchEvent(new Event(ACTION_STATE_MUTATED_EVENT));
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = await getAuthHeader();
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...authHeaders,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        const detail = await response.text();
        let message = detail;
        let code: string | null = null;
        try {
            const parsed = JSON.parse(detail) as {
                detail?: unknown;
                code?: unknown;
            };
            if (typeof parsed.detail === "string") message = parsed.detail;
            if (typeof parsed.code === "string") code = parsed.code;
        } catch {
            // Keep the raw text body when the backend did not return JSON.
        }
        throw new ApiError(
            message || `API error: ${response.status}`,
            response.status,
            code,
        );
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        notifyActionStateMutation(restInit.method);
        return undefined as T;
    }

    const result = (await response.json()) as T;
    notifyActionStateMutation(restInit.method);
    return result;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<CocoaLegalProject[]> {
    return apiRequest<CocoaLegalProject[]>("/projects");
}

export async function createProject(
    name: string,
    cm_number?: string,
    shared_with?: string[],
): Promise<CocoaLegalProject> {
    return apiRequest<CocoaLegalProject>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, shared_with }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    apiKeyStatus: ApiKeyStatus;
}

export async function getUserProfile(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile");
}

export async function updateUserProfile(payload: {
    displayName?: string | null;
    organisation?: string | null;
    tabularModel?: string;
}): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export type ApiKeyProvider = "claude" | "gemini" | "openai" | "openrouter";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<
    ApiKeyProvider,
    {
        configured: boolean;
        source: ApiKeySource;
    }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

// --- model catalog -------------------------------------------------------
// The picker is served from the backend so newly released models appear
// without a frontend deploy. MODELS in ModelToggle.tsx is the offline
// fallback when this request fails.

export type ModelHealthMetadata = {
    status: "healthy" | "degraded" | "unverified" | "unhealthy";
    verificationStatus: "verified" | "unverified";
    capabilityResults: Record<string, unknown>;
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    lastErrorCode: string | null;
};

export type FeaturedModelEntry = {
    id: string;
    label: string;
    group: string;
    provider: string;
    contextLength: number;
    maxOutputTokens: number;
    health: ModelHealthMetadata;
};

export type OpenRouterCatalogEntry = {
    id: string;
    name: string;
    contextLength: number;
    maxCompletionTokens: number | null;
    /** Per-token USD, as strings — multiply by 1e6 for a per-million figure. */
    pricing: { prompt: string; completion: string };
    inputModalities: string[];
    supportsTools: boolean;
    health: ModelHealthMetadata;
};

export type ModelsCatalogResponse = {
    featured: FeaturedModelEntry[];
    openrouter: OpenRouterCatalogEntry[];
    openrouterCatalogAvailable: boolean;
};

export async function getModelsCatalog(opts?: {
    toolsOnly?: boolean;
}): Promise<ModelsCatalogResponse> {
    const qs = opts?.toolsOnly ? "?tools=1" : "";
    return apiRequest<ModelsCatalogResponse>(`/models${qs}`);
}

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export async function saveApiKey(
    provider: ApiKeyProvider,
    apiKey: string | null,
): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
    });
}

export async function updateDocumentHighlightStatus(
    documentId: string,
    setId: string,
    highlightId: string,
    status: "kept" | "removed",
): Promise<{ highlight: CocoaLegalHighlightAnnotation }> {
    return apiRequest<{ highlight: CocoaLegalHighlightAnnotation }>(
        `/single-documents/${documentId}/highlight-sets/${setId}/highlights/${highlightId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
        },
    );
}

export async function applyDocumentHighlightSet(
    documentId: string,
    setId: string,
    highlights?: CocoaLegalHighlightAnnotation[],
): Promise<{
    version_id: string;
    version_number: number;
    download_url: string;
    applied_count: number;
    applied_highlight_ids?: string[];
    operation_id?: string | null;
    errors: { quote: string; occurrence_index: number; reason: string }[];
}> {
    return apiRequest(
        `/single-documents/${documentId}/highlight-sets/${setId}/apply`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                highlights: (highlights ?? []).map((highlight) => ({
                    id: highlight.id,
                    quote: highlight.quote,
                    occurrence_index: highlight.occurrence_index,
                    status: highlight.status,
                })),
            }),
        },
    );
}

export async function listOperations(filters?: {
    projectId?: string;
    matterId?: string;
    documentId?: string;
    chatId?: string;
    limit?: number;
}): Promise<AgentOperation[]> {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("project_id", filters.projectId);
    if (filters?.matterId) params.set("matter_id", filters.matterId);
    if (filters?.documentId) params.set("document_id", filters.documentId);
    if (filters?.chatId) params.set("chat_id", filters.chatId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const response = await apiRequest<{ operations: AgentOperation[] }>(
        `/operations${suffix}`,
    );
    return response.operations;
}

export async function getOperation(
    operationId: string,
): Promise<AgentOperation> {
    const response = await apiRequest<{ operation: AgentOperation }>(
        `/operations/${operationId}`,
    );
    return response.operation;
}

export async function approveOperation(
    operationId: string,
): Promise<AgentOperation> {
    const response = await apiRequest<{ operation: AgentOperation }>(
        `/operations/${operationId}/approve`,
        { method: "POST" },
    );
    return response.operation;
}

/**
 * Approve an `assemble_document` operation. Unlike the generic approve, this
 * endpoint kicks off a DETACHED background assembly job and returns a kickoff
 * payload (`{ status: "assembling", job_id, operation_id }`) instead of a
 * finished operation — the heavy work no longer blocks the request. The caller
 * then polls `getAuthoringJob(job_id)` for the terminal result. (Other approve
 * types still return `{ operation }`; use `approveOperation` for those.)
 */
export async function approveAssembleOperation(
    operationId: string,
): Promise<{ status: string; job_id: string; operation_id: string }> {
    return apiRequest<{ status: string; job_id: string; operation_id: string }>(
        `/operations/${operationId}/approve`,
        { method: "POST" },
    );
}

export async function undoOperation(
    operationId: string,
): Promise<AgentOperation> {
    const response = await apiRequest<{ operation: AgentOperation }>(
        `/operations/${operationId}/undo`,
        { method: "POST" },
    );
    return response.operation;
}

export async function getProject(projectId: string): Promise<CocoaLegalProject> {
    return apiRequest<CocoaLegalProject>(`/projects/${projectId}`);
}

export interface DocumentActionState {
    document_id: string;
    filename: string;
    current_version: {
        id: string | null;
        number: number | null;
        source: string | null;
        modified_at: string | null;
    };
    delivery: {
        current_version_sent: boolean;
        sent_versions: {
            email_id: string;
            version_id: string;
            version_number: number | null;
            sent_at: string | null;
            from_address: string | null;
            to_addresses: string[];
            cc_addresses: string[];
            bcc_addresses: string[];
            replies: {
                email_id: string;
                from_address: string | null;
                received_at: string;
            }[];
        }[];
        pending_versions: {
            version_id: string;
            status: string;
            email_id: string;
            from_address: string | null;
            to_addresses: string[];
            cc_addresses: string[];
            bcc_addresses: string[];
            sent_at: string | null;
        }[];
        newer_version_available: boolean;
    };
    signature: {
        current_version_status: string | null;
        latest_envelope_id: string | null;
        versions: {
            version_id: string;
            status: string;
            envelope_id: string;
            updated_at: string;
            completed_at: string | null;
            signers: {
                id: string;
                name: string;
                email: string;
                status: string;
                viewed_at: string | null;
                signed_at: string | null;
                declined_at: string | null;
            }[];
        }[];
        newer_version_available: boolean;
    };
    pending_operations: {
        id: string;
        tool_name: string;
        status: string;
        created_at: string;
    }[];
}

export async function getProjectDocumentActionState(
    projectId: string,
): Promise<{
    project_id: string;
    generated_at: string;
    documents: DocumentActionState[];
}> {
    return apiRequest(`/projects/${projectId}/document-action-state`);
}

export interface MatterTask {
    id: string;
    project_id: string;
    title: string;
    description: string | null;
    status: "open" | "completed" | "cancelled";
    assignee_user_id: string | null;
    completion_rule: {
        type:
            | "manual"
            | "email_sent"
            | "signature_completed"
            | "document_version_created"
            | "operation_succeeded";
    };
    completion_evidence_type: string | null;
    completion_evidence_id: string | null;
    completion_evidence_at: string | null;
    due_at: string | null;
    completed_at: string | null;
    reopened_at: string | null;
    revision: number;
    created_at: string;
    updated_at: string;
}

export interface ProjectActionState {
    project_id: string;
    generated_at: string;
    cursor: string;
    documents: DocumentActionState[];
    communications: {
        id: string;
        status: string;
        from_address: string | null;
        to_addresses: string[];
        cc_addresses: string[];
        bcc_addresses: string[];
        sent_at: string | null;
        replies: {
            email_id: string;
            from_address: string | null;
            received_at: string;
        }[];
    }[];
    signatures: {
        id: string;
        document_id: string | null;
        source_version_id: string | null;
        status: string;
        completed_at: string | null;
        updated_at: string;
        signers: {
            id: string;
            name: string;
            email: string;
            status: "pending" | "viewed" | "signed" | "declined";
            viewed_at: string | null;
            signed_at: string | null;
            declined_at: string | null;
        }[];
    }[];
    operations: {
        id: string;
        source_document_id: string | null;
        result_document_id: string | null;
        tool_name: string;
        status: string;
        created_at: string;
    }[];
    tasks: MatterTask[];
}

export type ProjectActionStatePoll =
    | { unchanged: true; cursor: string }
    | ({ unchanged: false } & ProjectActionState);

export async function getProjectActionState(
    projectId: string,
    cursor?: string | null,
): Promise<ProjectActionStatePoll> {
    const authHeaders = await getAuthHeader();
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(
        `${API_BASE}/projects/${projectId}/action-state${query}`,
        {
            cache: "no-store",
            headers: {
                Accept: "application/json",
                ...authHeaders,
                ...(cursor ? { "If-None-Match": `W/\"${cursor}\"` } : {}),
            },
        },
    );
    if (response.status === 304) {
        return { unchanged: true, cursor: cursor ?? "" };
    }
    if (!response.ok) {
        const body = await response.text();
        let detail = body || `API error: ${response.status}`;
        let code: string | null = null;
        try {
            const parsed = JSON.parse(body) as {
                detail?: unknown;
                code?: unknown;
            };
            if (typeof parsed.detail === "string") detail = parsed.detail;
            if (typeof parsed.code === "string") code = parsed.code;
        } catch {
            // Preserve the raw response for non-JSON failures.
        }
        throw new ApiError(detail, response.status, code);
    }
    return {
        unchanged: false,
        ...((await response.json()) as ProjectActionState),
    };
}

export interface BetaPolicy {
    /** False outside beta mode: no panel, no upload gate, neutral signature wording. */
    enabled: boolean;
    accepted: boolean;
    data_policy_accepted_at: string | null;
    allowed_recipient_emails: string[];
    allowed_recipient_domains: string[];
    signatures_nonbinding: boolean;
}

export interface ManagedBetaPolicy extends BetaPolicy {
    enabled: boolean;
    organization_id: string | null;
    available: boolean;
    can_manage: boolean;
}

export interface EmailBetaPolicyReadiness extends ManagedBetaPolicy {
    recipients: string[];
}

export async function getUserBetaPolicy(): Promise<ManagedBetaPolicy> {
    return apiRequest<ManagedBetaPolicy>("/user/beta-policy");
}

export async function updateUserBetaPolicy(payload: {
    accept_data_policy?: boolean;
    policy_acknowledged?: boolean;
    allowed_recipient_emails?: string[];
    allowed_recipient_domains?: string[];
}): Promise<ManagedBetaPolicy> {
    return apiRequest<ManagedBetaPolicy>("/user/beta-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getProjectBetaPolicy(
    projectId: string,
): Promise<BetaPolicy> {
    return apiRequest<BetaPolicy>(`/projects/${projectId}/beta-policy`);
}

export async function updateProjectBetaPolicy(
    projectId: string,
    payload: {
        accept_data_policy?: boolean;
        policy_acknowledged?: boolean;
        allowed_recipient_emails?: string[];
        allowed_recipient_domains?: string[];
    },
): Promise<BetaPolicy> {
    return apiRequest<BetaPolicy>(`/projects/${projectId}/beta-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listProjectTasks(
    projectId: string,
): Promise<MatterTask[]> {
    const response = await apiRequest<{ tasks: MatterTask[] }>(
        `/projects/${projectId}/tasks`,
    );
    return response.tasks;
}

export async function createProjectTask(
    projectId: string,
    payload: {
        title: string;
        description?: string | null;
        assignee_user_id?: string | null;
        due_at?: string | null;
        completion_rule: MatterTask["completion_rule"];
        document_id?: string | null;
        document_version_id?: string | null;
        email_message_id?: string | null;
        signature_envelope_id?: string | null;
        agent_operation_id?: string | null;
    },
): Promise<MatterTask> {
    return apiRequest<MatterTask>(`/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateProjectTask(
    projectId: string,
    taskId: string,
    payload: {
        expected_revision: number;
        title?: string;
        description?: string | null;
        assignee_user_id?: string | null;
        due_at?: string | null;
        status?: "completed";
    },
): Promise<MatterTask> {
    return apiRequest<MatterTask>(`/projects/${projectId}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function reopenProjectTask(
    projectId: string,
    taskId: string,
    expectedRevision: number,
): Promise<MatterTask> {
    return apiRequest<MatterTask>(
        `/projects/${projectId}/tasks/${taskId}/reopen`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expected_revision: expectedRevision }),
        },
    );
}

export async function cancelProjectTask(
    projectId: string,
    taskId: string,
    expectedRevision: number,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/tasks/${taskId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: expectedRevision }),
    });
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
    },
): Promise<CocoaLegalProject> {
    return apiRequest<CocoaLegalProject>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/**
 * File a document into a matter (set its project_id). Used by the authoring
 * flow's "Open document" → file-into-matter step so a standalone draft can be
 * opened in the matter-scoped Doc Review interface. Returns the moved document.
 */
export async function moveDocumentToProject(
    documentId: string,
    projectId: string,
): Promise<{ id: string; project_id: string | null; filename: string }> {
    return apiRequest(`/single-documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
    current_user_role?: ProjectMemberRole;
    can_manage?: boolean;
    owner?: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: ProjectMember[];
}

export type ProjectMemberRole =
    | "owner"
    | "admin"
    | "lawyer"
    | "editor"
    | "reviewer"
    | "viewer";

export interface ProjectMember {
    id?: string;
    user_id?: string | null;
    email: string | null;
    display_name: string | null;
    role?: ProjectMemberRole;
    status?: "active" | "invited" | "disabled";
    invitation_expires_at?: string | null;
    accepted_at?: string | null;
    is_current_user?: boolean;
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/members`);
}

export async function inviteProjectMember(
    projectId: string,
    email: string,
    role: Exclude<ProjectMemberRole, "owner">,
): Promise<{ membership_id: string; status: string; invite_delivery: string }> {
    return apiRequest(`/projects/${projectId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function updateProjectMemberRole(
    projectId: string,
    membershipId: string,
    role: Exclude<ProjectMemberRole, "owner">,
): Promise<ProjectMember> {
    return apiRequest(`/projects/${projectId}/members/${membershipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
    });
}

export async function removeProjectMember(
    projectId: string,
    membershipId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/members/${membershipId}`, {
        method: "DELETE",
    });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<CocoaLegalFolder> {
    return apiRequest<CocoaLegalFolder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<CocoaLegalFolder> {
    return apiRequest<CocoaLegalFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<CocoaLegalFolder> {
    return apiRequest<CocoaLegalFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<CocoaLegalDocument> {
    return apiRequest<CocoaLegalDocument>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameProjectDocument(
    projectId: string,
    documentId: string,
    filename: string,
): Promise<CocoaLegalDocument> {
    return apiRequest<CocoaLegalDocument>(
        `/projects/${projectId}/documents/${documentId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<CocoaLegalDocument> {
    return apiRequest<CocoaLegalDocument>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface VersionProvenance {
    version_id: string;
    chat_id: string | null;
    chat_message_id: string | null;
    operation_id: string | null;
    source: "edit" | "operation" | "highlight";
}

export interface CocoaLegalDocumentVersion {
    id: string;
    document_id?: string;
    version_number: number | null;
    source:
        | "upload"
        | "user_upload"
        | "assistant_edit"
        | "assistant_highlight"
        | "assistant_undo"
        | "user_accept"
        | "user_reject"
        | "generated"
        | "authored"
        | "clean_final";
    created_at: string;
    display_name: string | null;
    created_by_user_id?: string | null;
    parent_version_id?: string | null;
    created_by_operation_id?: string | null;
    metadata?: Record<string, unknown>;
    layout_qa_status?: "source" | "unverified" | "passed" | "failed" | null;
    layout_qa_checked_at?: string | null;
    layout_qa_report?: Record<string, unknown> | null;
    /** The conversation turn that produced this version (null for uploads). */
    provenance?: VersionProvenance | null;
}

export interface DocumentVersionNode extends CocoaLegalDocumentVersion {
    document_id: string;
}

export interface DerivedDocumentNode {
    document: CocoaLegalDocument;
    version: DocumentVersionNode | null;
    source_document_id: string;
    source_version_id: string | null;
    derivation_kind: string;
    operation_id: string | null;
}

export interface DocumentTreeNode {
    document: CocoaLegalDocument;
    versions: DocumentVersionNode[];
    derived_documents: DerivedDocumentNode[];
    is_derived?: boolean;
}

export interface ProjectDocumentTree {
    project_id: string;
    folders: CocoaLegalFolder[];
    documents: DocumentTreeNode[];
}

export async function listDocumentVersions(
    documentId: string,
    options?: { includeDecisions?: boolean },
): Promise<{
    current_version_id: string | null;
    versions: CocoaLegalDocumentVersion[];
}> {
    const qs = options?.includeDecisions ? "?include_decisions=true" : "";
    return apiRequest(`/single-documents/${documentId}/versions${qs}`);
}

export async function getProjectDocumentTree(
    projectId: string,
): Promise<ProjectDocumentTree> {
    return apiRequest<ProjectDocumentTree>(
        `/projects/${projectId}/document-tree`,
    );
}

export async function finalizeCleanDocument(
    documentId: string,
    displayName?: string,
): Promise<{
    ok: boolean;
    document_id: string;
    version_id: string;
    version_number: number | null;
    filename: string;
    download_url: string;
    remaining_pending: number;
    already_final?: boolean;
    version?: CocoaLegalDocumentVersion;
}> {
    return apiRequest(`/single-documents/${documentId}/finalize-clean`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
    });
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    displayName?: string,
): Promise<CocoaLegalDocumentVersion> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (displayName) form.append("display_name", displayName);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as CocoaLegalDocumentVersion;
    notifyActionStateMutation("POST");
    return result;
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    displayName: string | null,
): Promise<CocoaLegalDocumentVersion> {
    return apiRequest<CocoaLegalDocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: displayName }),
        },
    );
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
): Promise<CocoaLegalDocument> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
        `${API_BASE}/projects/${projectId}/documents`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as CocoaLegalDocument;
    notifyActionStateMutation("POST");
    return result;
}

export async function uploadStandaloneDocument(
    file: File,
): Promise<CocoaLegalDocument> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${API_BASE}/single-documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as CocoaLegalDocument;
    notifyActionStateMutation("POST");
    return result;
}

export async function uploadChatImageAttachment(
    file: File,
    options?: { projectId?: string },
): Promise<CocoaLegalImageAttachment> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (options?.projectId) form.append("project_id", options.projectId);
    const response = await fetch(`${API_BASE}/chat-attachments/images`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    const raw = (await response.json()) as {
        id: string;
        filename: string;
        mime_type: CocoaLegalImageAttachment["mime_type"];
        size_bytes: number;
    };
    return {
        kind: "image",
        filename: raw.filename,
        attachment_id: raw.id,
        mime_type: raw.mime_type,
        size_bytes: raw.size_bytes,
    };
}

export async function fetchChatImageAttachment(
    attachmentId: string,
): Promise<Blob> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(
        `${API_BASE}/chat-attachments/${attachmentId}/image`,
        { headers: { ...authHeaders } },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.blob();
}

export async function listStandaloneDocuments(): Promise<CocoaLegalDocument[]> {
    return apiRequest<CocoaLegalDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
    purpose: "view" | "export" = "view",
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const params = new URLSearchParams();
    if (versionId) params.set("version_id", versionId);
    if (purpose === "export") params.set("purpose", purpose);
    const qs = params.size ? `?${params.toString()}` : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export async function downloadDocumentsZip(
    documentIds: string[],
): Promise<Blob> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders,
        },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Recordings & Transcription
// ---------------------------------------------------------------------------

export async function createRecording(input: {
    file: Blob;
    filename: string;
    source: "mic" | "upload";
    consent: true;
    title?: string;
    projectId?: string;
    chatId?: string;
    durationSeconds?: number;
}): Promise<Recording> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", input.file, input.filename);
    form.append("source", input.source);
    form.append("consent", String(input.consent));
    if (input.title) form.append("title", input.title);
    if (input.projectId) form.append("project_id", input.projectId);
    if (input.chatId) form.append("chat_id", input.chatId);
    if (typeof input.durationSeconds === "number")
        form.append("duration_seconds", String(input.durationSeconds));
    const response = await fetch(`${API_BASE}/recordings`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as Recording;
    notifyActionStateMutation("POST");
    return result;
}

export async function listRecordings(projectId?: string): Promise<Recording[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    const query = params.toString();
    const { recordings } = await apiRequest<{ recordings: Recording[] }>(
        `/recordings${query ? `?${query}` : ""}`,
    );
    return recordings;
}

export async function getRecording(id: string): Promise<Recording> {
    const { recording } = await apiRequest<{ recording: Recording }>(
        `/recordings/${id}`,
    );
    return recording;
}

export async function getRecordingAudioUrl(id: string): Promise<string> {
    const { url } = await apiRequest<{ url: string }>(
        `/recordings/${id}/audio`,
    );
    return url;
}

export async function updateRecording(
    id: string,
    patch: { title?: string; project_id?: string | null },
): Promise<Recording> {
    const { recording } = await apiRequest<{ recording: Recording }>(
        `/recordings/${id}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        },
    );
    return recording;
}

export async function toggleRecordingActionItem(
    id: string,
    itemId: string,
): Promise<Recording> {
    const { recording } = await apiRequest<{ recording: Recording }>(
        `/recordings/${id}/action-items/${encodeURIComponent(itemId)}/toggle`,
        { method: "POST" },
    );
    return recording;
}

export async function deleteRecording(id: string): Promise<void> {
    await apiRequest(`/recordings/${id}`, { method: "DELETE" });
}

/** Generated-artifact response shape shared by the two on-demand generators:
 * the reloaded recording (its *_document_id now set), the artifact's document id,
 * and whether this call created it (false = an already-generated one was reused). */
export interface RecordingArtifactResult {
    recording: Recording;
    document_id: string;
    created: boolean;
}

export async function generateRecordingVoiceBriefing(
    id: string,
    force = false,
): Promise<RecordingArtifactResult> {
    return apiRequest<RecordingArtifactResult>(
        `/recordings/${id}/voice-briefing`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
        },
    );
}

export async function generateRecordingTimelineImage(
    id: string,
    force = false,
): Promise<RecordingArtifactResult> {
    return apiRequest<RecordingArtifactResult>(
        `/recordings/${id}/timeline-image`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ force }),
        },
    );
}

/** Draft (never send) an email carrying the recording's summary + transcript
 * PDF, through the existing draft-then-approve email rails. Returns the linked
 * recording, the pending email's id, and whether this call created a fresh
 * draft (false = a still-pending draft was reused). The email is sent/cancelled
 * only via the existing POST /email/:id/approve | /email/:id/cancel routes. */
export async function draftRecordingEmail(
    id: string,
    input?: {
        to?: string[];
        cc?: string[];
        subject?: string;
        note?: string;
        /** Embed + attach the timeline image (default ON server-side). */
        include_timeline_image?: boolean;
        force?: boolean;
    },
): Promise<{ recording: Recording; email_id: string; created: boolean }> {
    return apiRequest<{
        recording: Recording;
        email_id: string;
        created: boolean;
    }>(`/recordings/${id}/email-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input ?? {}),
    });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(options?: {
    limit?: number;
    /** Case-insensitive chat-TITLE substring filter. Bodies aren't searched. */
    search?: string;
}): Promise<CocoaLegalChat[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    // URLSearchParams.toString() percent-encodes values for us.
    const search = options?.search?.trim();
    if (search) params.set("search", search);
    const query = params.toString();
    return apiRequest<CocoaLegalChat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(
    projectId: string,
): Promise<CocoaLegalChat[]> {
    return apiRequest<CocoaLegalChat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<CocoaLegalChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: CocoaLegalMessage[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
                capability_run: m.capability_run ?? undefined,
                inherited_from_chat_id: m.inherited_from_chat_id ?? undefined,
                version_context: m.version_context ?? undefined,
                generation_status: m.generation_status ?? undefined,
                finish_reason: m.finish_reason ?? undefined,
            };
        }
        const storedEvents = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : [];
        const finishReason = m.finish_reason;
        const hasFinishEvent = storedEvents.some(
            (event) => event.type === "generation_finish",
        );
        const validFinishReason:
            | Extract<
                  AssistantEvent,
                  { type: "generation_finish" }
              >["finish_reason"]
            | null =
            finishReason === "completed" ||
            finishReason === "max_output" ||
            finishReason === "context_limit" ||
            finishReason === "refused" ||
            finishReason === "cancelled" ||
            finishReason === "iteration_limit" ||
            finishReason === "error"
                ? finishReason
                : null;
        const events =
            validFinishReason &&
            validFinishReason !== "completed" &&
            !hasFinishEvent
                ? [
                      ...storedEvents,
                      {
                          type: "generation_finish" as const,
                          finish_reason: validFinishReason,
                      },
                  ]
                : storedEvents;
        return {
            id: m.id,
            role: "assistant",
            content: assistantContentFromEvents(events),
            annotations: m.annotations ?? undefined,
            events: events.length ? events : undefined,
            inherited_from_chat_id: m.inherited_from_chat_id ?? undefined,
            version_context: m.version_context ?? undefined,
            generation_status: m.generation_status ?? undefined,
            finish_reason: m.finish_reason ?? undefined,
        };
    });
    return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

/**
 * Per-chat control over capability suggestion chips: `dismiss` stops one
 * capability from being suggested in this chat, `suppress` mutes every
 * suggestion here, `unsuppress` un-mutes. The setting is per-user inside a
 * shared chat, so the backend merges rather than replaces.
 */
export async function updateChatSuggestions(
    chatId: string,
    body: {
        action: "dismiss" | "suppress" | "unsuppress";
        capability_id?: string;
        proposal_id?: string | null;
    },
): Promise<void> {
    await apiRequest(`/chat/${chatId}/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export interface CapabilityResultDocxOut {
    document_id: string;
    filename: string;
    download_url: string;
    version_id: string;
    version_number: number;
}

/** Export one persisted capability result as a DOCX document in the chat. */
export async function exportCapabilityResultDocx(
    chatId: string,
    messageId: string,
    resultId: string,
): Promise<CapabilityResultDocxOut> {
    return apiRequest<CapabilityResultDocxOut>(
        `/chat/${chatId}/messages/${messageId}/capability-results/${resultId}/docx`,
        { method: "POST" },
    );
}

export interface ForkChatOut {
    chat_id: string;
    title: string | null;
    parent_chat_id: string;
    root_chat_id: string;
    forked_from_message_id: string;
    anchor_document_id: string | null;
    anchor_version_id: string | null;
}

/**
 * Branch a conversation from a specific message. The new chat inherits the
 * parent's turns up to that message (by reference) and is anchored to the
 * document version that was displayed at the fork point.
 */
export async function forkChat(
    projectId: string,
    chatId: string,
    payload: { forked_from_message_id: string; fork_label?: string },
): Promise<ForkChatOut> {
    return apiRequest<ForkChatOut>(
        `/projects/${projectId}/chat/${chatId}/fork`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

// ---------------------------------------------------------------------------
// Version × conversation graph (the History view)
// ---------------------------------------------------------------------------

export interface VersionGraphNode {
    id: string;
    document_id: string;
    filename: string | null;
    version_number: number | null;
    source: string;
    created_at: string | null;
    parent_version_id: string | null;
    is_current: boolean;
    provenance?: VersionProvenance | null;
}

export interface VersionGraphForkNode {
    chat_id: string;
    title: string | null;
    fork_label: string | null;
    parent_chat_id: string | null;
    root_chat_id: string | null;
    forked_from_message_id: string | null;
    anchor_version_id: string | null;
    branch_tip_version_id: string | null;
    created_at: string | null;
}

export interface VersionGraphEdge {
    from: string;
    to: string;
    kind: "lineage" | "fork";
}

export interface VersionGraph {
    project_id: string;
    version_nodes: VersionGraphNode[];
    fork_nodes: VersionGraphForkNode[];
    edges: VersionGraphEdge[];
}

export async function getVersionGraph(
    projectId: string,
): Promise<VersionGraph> {
    return apiRequest<VersionGraph>(`/projects/${projectId}/version-graph`);
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

export async function streamChat(payload: {
    message: {
        content: string;
        files?: CocoaLegalMessageAttachment[];
        workflow?: { id: string; title: string };
    };
    chat_id?: string;
    project_id?: string;
    model?: string;
    /** Browser IANA timezone (e.g. "America/New_York") for temporal grounding. */
    client_time_zone?: string;
    /** Source image for an image-to-image edit, bound by the "Edit" affordance. */
    edit_image_source?: {
        document_id?: string | null;
        attachment_id?: string | null;
    } | null;
    /** Confirmed in-chat capability run this turn executes (proposal chip). */
    capability_run?: CapabilityRunPayload | null;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    content: string;
    files?: CocoaLegalMessageAttachment[];
    workflow?: { id: string; title: string };
};

/**
 * Request-level `capability_run` — the record the composer chip posts when the
 * user confirms "Run <capability>" and the run happens in THIS chat. Mirrors
 * the shape `parseCapabilityRun` accepts in backend/src/lib/chatMessages.ts;
 * every field is re-validated and bounded there, never trusted as sent.
 */
export type CapabilityRunPayload = {
    capability_id: string;
    proposal_id?: string | null;
    document_ids?: string[];
    inputs?: { represented_party?: string | null };
};

export async function streamProjectChat(payload: {
    projectId: string;
    message: StreamChatMessage;
    chat_id?: string;
    model?: string;
    displayed_doc?: {
        filename: string;
        document_id: string;
        version_id?: string | null;
        version_number?: number | null;
    };
    open_docs?: {
        document_id: string;
        version_id?: string | null;
        version_number?: number | null;
        displayed?: boolean;
    }[];
    attached_documents?: { filename: string; document_id: string }[];
    /** Browser IANA timezone (e.g. "America/New_York") for temporal grounding. */
    client_time_zone?: string;
    /** Source image for an image-to-image edit, bound by the "Edit" affordance. */
    edit_image_source?: {
        document_id?: string | null;
        attachment_id?: string | null;
    } | null;
    /** Confirmed in-chat capability run this turn executes (proposal chip). */
    capability_run?: CapabilityRunPayload | null;
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<TabularReview[]> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
    /**
     * The side the user represents for a CRE review (e.g. "Tenant", "Buyer").
     * Persisted on the row and substituted into the {{representedParty}}
     * placeholder in the CRE column prompts. Omit / null for non-CRE reviews.
     */
    represented_party?: string | null;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

/**
 * Export a CRE tabular review as a lease-abstract DOCX memo. The backend
 * assembles the memo deterministically and persists it as a `documents` row,
 * returning a download handle (the relative `download_url` plus the persisted
 * document id).
 */
export async function exportTabularReviewDocx(reviewId: string): Promise<{
    file_id: string;
    document_id: string;
    filename: string;
    download_url: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/export-docx`, {
        method: "POST",
    });
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<CocoaLegalDocument> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { ...authHeaders },
    });
}

export async function streamTabularChat(
    reviewId: string,
    message: { content: string },
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
            message,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    generation_status?: string | null;
    finish_reason?: string | null;
    created_at: string;
}

export interface TRDisplayMessage {
    id?: string;
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
    generation_status?: string | null;
    finish_reason?: string | null;
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
                generation_status: m.generation_status ?? undefined,
                finish_reason: m.finish_reason ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content = assistantContentFromEvents(events);
        return {
            id: m.id,
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
            generation_status: m.generation_status ?? undefined,
            finish_reason: m.finish_reason ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    documentId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            document_id: documentId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    documentIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: documentIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = CocoaLegalWorkflow["type"];

export async function listWorkflows(
    type: WorkflowType,
): Promise<CocoaLegalWorkflow[]> {
    return apiRequest<CocoaLegalWorkflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(
    workflowId: string,
): Promise<CocoaLegalWorkflow> {
    return apiRequest<CocoaLegalWorkflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    prompt_md?: string;
    columns_config?: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[];
    practice?: string | null;
}): Promise<CocoaLegalWorkflow> {
    return apiRequest<CocoaLegalWorkflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function generateWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    practice?: string | null;
    goal: string;
    jurisdiction?: string | null;
    document_type?: string | null;
    target_output?: string | null;
    use_legal_research?: boolean;
}): Promise<{
    prompt_md?: string;
    columns_config?: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[];
    summary: string;
    warnings: string[];
    sources: Pick<
        LegalSearchResult,
        "title" | "url" | "provider" | "sourceType" | "confidence"
    >[];
}> {
    return apiRequest("/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        title?: string;
        prompt_md?: string;
        columns_config?: {
            index: number;
            name: string;
            prompt: string;
            format?: string;
            tags?: string[];
        }[];
        practice?: string | null;
    },
): Promise<CocoaLegalWorkflow> {
    return apiRequest<CocoaLegalWorkflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(workflowId: string): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}

// ---------------------------------------------------------------------------
// Agent email (approval-gated outbound + inbound inbox)
// ---------------------------------------------------------------------------

export interface EmailAttachmentRef {
    document_id: string;
    source_kind?: "document" | "chat_attachment";
    source_id?: string;
    chat_attachment_id?: string | null;
    version_id?: string | null;
    filename: string;
    content_type?: string | null;
    size?: number | null;
    previewable?: boolean;
}

export interface EmailAttachmentManifestItem extends EmailAttachmentRef {
    index: number;
    source_kind: "document" | "chat_attachment";
    source_id: string;
    content_type: string;
    size: number | null;
    previewable: boolean;
    content_url: string;
}

export interface InboundEmailAttachment {
    attachment_id: string;
    index: number;
    filename: string;
    content_type?: string | null;
    size?: number | null;
    document_id: string | null;
    version_id?: string | null;
    status: "pending" | "processing" | "ready" | "partial" | "failed" | "unsupported" | "blocked" | "deleted";
    retryable: boolean;
    detail: string | null;
    error_code?: string | null;
}

export async function getInboundEmailAttachmentManifest(id: string): Promise<{ attachments: InboundEmailAttachment[] }> {
    return apiRequest(`/email/${encodeURIComponent(id)}/attachments`);
}
export async function retryEmailAttachment(id: string, attachmentId: string): Promise<void> {
    await apiRequest(`/email/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/retry`, { method: "POST" });
}

/** A single agent email record as returned by the email endpoints. */
export interface EmailRecord {
    id: string;
    operation_id: string | null;
    direction: "inbound" | "outbound";
    status: string;
    to_addresses: string[];
    cc_addresses: string[];
    from_address: string | null;
    subject: string | null;
    body_text?: string | null;
    body_preview: string | null;
    attachments: EmailAttachmentRef[];
    attachment_manifest?: InboundEmailAttachment[];
    received_at: string | null;
    sent_at: string | null;
    created_at: string;
    /** Provider-side thread id, present on ingested inbound messages. */
    provider_thread_id?: string | null;
    /**
     * The Quill conversation this message belongs to, when known (set on
     * agent-initiated threads). Powers the "open the reply in Assistant" jump.
     */
    chat_id?: string | null;
    /** Set when an inbound message is tied to a signature envelope. */
    signature_envelope_id?: string | null;
}

/** A single email plus every message on its thread (read view / deep-link). */
export interface EmailThreadOut {
    email: EmailRecord;
    thread: {
        provider_thread_id: string | null;
        messages: EmailRecord[];
    };
}

/** Fetch a single email and its full thread, oldest-first. */
export async function getEmail(id: string): Promise<EmailThreadOut> {
    return apiRequest<EmailThreadOut>(`/email/${encodeURIComponent(id)}`);
}

export async function getEmailAttachmentManifest(
    id: string,
): Promise<{ attachments: EmailAttachmentManifestItem[] }> {
    return apiRequest<{ attachments: EmailAttachmentManifestItem[] }>(
        `/email/${encodeURIComponent(id)}/attachments`,
    );
}

export async function fetchEmailAttachmentContent(
    id: string,
    index: number | string,
): Promise<Blob> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(
        `${API_BASE}/email/${encodeURIComponent(id)}/attachments/${encodeURIComponent(String(index))}/content`,
        { cache: "no-store", headers: { ...authHeaders } },
    );
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new ApiError(
            payload?.detail || "Could not load the email attachment preview.",
            response.status,
            payload?.code ?? null,
        );
    }
    return response.blob();
}

/** Approve a pending agent email, which sends it. */
export async function approveEmail(
    id: string,
): Promise<{ email: EmailRecord }> {
    return apiRequest<{ email: EmailRecord }>(`/email/${id}/approve`, {
        method: "POST",
    });
}

/** Preflight the exact organization policy and recipients for one draft. */
export async function getEmailBetaPolicy(
    id: string,
): Promise<EmailBetaPolicyReadiness> {
    return apiRequest<EmailBetaPolicyReadiness>(
        `/email/${encodeURIComponent(id)}/beta-policy`,
    );
}

/** Complete only the safeguards attached to this server-stored draft. */
export async function updateEmailBetaPolicy(
    id: string,
    payload: {
        accept_data_policy?: boolean;
        policy_acknowledged?: boolean;
    },
): Promise<EmailBetaPolicyReadiness> {
    return apiRequest<EmailBetaPolicyReadiness>(
        `/email/${encodeURIComponent(id)}/beta-policy`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

/** Cancel a pending agent email so it is never sent. */
export async function cancelEmail(id: string): Promise<{ email: EmailRecord }> {
    return apiRequest<{ email: EmailRecord }>(`/email/${id}/cancel`, {
        method: "POST",
    });
}

/** List emails, optionally filtered by direction (inbound | outbound). */
export async function listEmails(
    direction?: "inbound" | "outbound",
): Promise<{ emails: EmailRecord[] }> {
    const qs = direction ? `?direction=${encodeURIComponent(direction)}` : "";
    return apiRequest<{ emails: EmailRecord[] }>(`/email${qs}`);
}

/**
 * On-demand inbound pull: ask the backend to poll the connected mailbox and
 * ingest any new inbound messages. Returns the number of newly ingested
 * emails so the UI can surface a "n new" confirmation before reloading the
 * inbound list.
 */
export async function refreshInbound(): Promise<{
    ok: true;
    ingested: number;
}> {
    return apiRequest<{ ok: true; ingested: number }>(
        `/email/inbound/refresh`,
        {
            method: "POST",
        },
    );
}

// ---------------------------------------------------------------------------
// E-signature (approval-gated envelopes)
// ---------------------------------------------------------------------------

export interface SignerRef {
    id?: string;
    name: string | null;
    email: string | null;
    role: string | null;
    /** pending | viewed | signed | declined */
    status?: string;
    signing_order?: number | null;
    /** ISO timestamp the signer first opened the document, if any. */
    viewed_at?: string | null;
    /** ISO timestamp the signer completed signing, if any. */
    signed_at?: string | null;
}

/** A single e-signature envelope record. */
export interface SignatureEnvelope {
    id: string;
    operation_id?: string | null;
    document_id: string | null;
    document_name?: string | null;
    subject: string | null;
    /**
     * draft | pending_approval | sent | partially_signed | completed |
     * declined | expired | cancelled
     */
    status: string;
    created_at: string;
    sent_at?: string | null;
    /** Optional fields present once an envelope has been routed/completed. */
    message?: string | null;
    executed_document_id?: string | null;
    expires_at?: string | null;
    completed_at?: string | null;
}

/**
 * How an envelope's pinned source version stands against the document's current
 * one. Mirrors the backend `EnvelopeVersionState` (routes/signatures.ts) field
 * for field.
 *
 * `document_changed: true` is a FACT, not a fault: a request prepared while the
 * user was reading an older version in Doc Review is born changed and is
 * exactly what they asked for. Present it neutrally.
 */
export interface EnvelopeVersionState {
    /** True when the document's current version differs from the pinned one. */
    document_changed: boolean;
    /** Null when the pinned version row itself no longer resolves. */
    prepared_version_number: number | null;
    current_version_number: number | null;
    /**
     * False when the pinned version ROW is gone, not merely superseded — the
     * difference between "an earlier version" and "an earlier version that no
     * longer exists", which is the difference between a request that can still
     * be sent as prepared and one that has to be prepared again.
     *
     * Optional only because the frontend and backend deploy separately (Vercel
     * and Railway), so a poll can land on a backend that predates the field.
     * Treat `undefined` as "unknown", never as "gone": asserting a deletion the
     * server did not report is the one wrong answer here.
     */
    prepared_version_resolved?: boolean;
}

/**
 * The `code` on the 409 the approve route returns when the document has moved
 * off the version the request was pinned to. Exported so callers branch on a
 * symbol rather than a re-typed string literal.
 */
export const SIGNATURE_STALE_VERSION = "SIGNATURE_STALE_VERSION";

/**
 * The `code` on the 409 the approve route returns when `confirmPreparedVersion`
 * names a version whose row is gone. Distinct from the staleness refusal above:
 * that one opens the choice, this one closes half of it — the prepared version
 * cannot be sent at all, and only the current version or a cancel remain.
 * Neither refusal touches the envelope or the agent operation.
 */
export const SIGNATURE_PREPARED_VERSION_UNAVAILABLE =
    "SIGNATURE_PREPARED_VERSION_UNAVAILABLE";

/** The detail payload returned for a single envelope (status + assets). */
export interface SignatureEnvelopeDetail {
    envelope: SignatureEnvelope;
    signers: SignerRef[];
    /**
     * Sent ONLY for a `pending_approval` envelope that carries a version pin —
     * absent everywhere else, including legacy unpinned envelopes. Treat
     * "absent" as "there is nothing to choose between".
     */
    version_state?: EnvelopeVersionState;
    /** Signed/executed combined PDF, available once `completed`. */
    executed_pdf_url: string | null;
    /** Completion certificate PDF, available once `completed`. */
    certificate_url: string | null;
    /**
     * Freshly-minted signing links, present ONLY on the resend response. Lets the
     * owner copy a link and deliver it directly when the email is delayed or
     * spam-filtered (external-domain delivery isn't guaranteed yet).
     */
    resent_links?: { email: string; link: string }[];
}

/** Payload for the authed in-app self-signing endpoint. */
export interface SignSelfPayload {
    typed_name: string;
    signature_png: string | null;
    consent: true;
    drawn: boolean;
}

/** Payload to create (and immediately route) an e-signature request for a document. */
/** A sender-placed field. Coordinates are TOP-LEFT origin, normalized to the
 * page (x/y = box top-left corner fraction, y from the top; w/h = size). */
export interface PlacedFieldPayload {
    signer_email: string;
    type: "signature" | "initials" | "date" | "name";
    page: number;
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
}

export interface CreateSignatureRequestPayload {
    document_id: string;
    signers: { name: string; email: string; role?: "signer" | "cc" }[];
    subject?: string;
    message?: string;
    expires_in_days?: number;
    /** Add the signed-in user (their account email) as a signer too. */
    include_self_as_signer?: boolean;
    /** Visual field placements; when omitted the server auto-places (anchors). */
    fields?: PlacedFieldPayload[];
}

/**
 * Create a signature request for a document straight from a non-chat action
 * (doc viewer toolbar / explorer). Returns the same detail shape as
 * `getSignatureEnvelope` so the caller can render a live status card.
 */
export async function createSignatureRequest(
    payload: CreateSignatureRequestPayload,
): Promise<SignatureEnvelopeDetail> {
    return apiRequest<SignatureEnvelopeDetail>(`/signatures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/**
 * Fetch the document's active version flattened to PDF (the exact bytes the
 * signature pipeline stamps). Used by the field-placement UI so placed
 * coordinates line up with the executed PDF. Returns raw PDF bytes.
 */
export async function getSignatureDocumentPdf(
    documentId: string,
): Promise<ArrayBuffer> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(
        `${API_BASE}/signatures/document-pdf/${encodeURIComponent(documentId)}`,
        { cache: "no-store", headers: { ...authHeaders } },
    );
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `API error: ${response.status}`);
    }
    return response.arrayBuffer();
}

/**
 * Approve a pending signature envelope; signing links are emailed to signers.
 *
 * Called with no options this is the plain approve, which the backend REFUSES
 * with a 409 `SIGNATURE_STALE_VERSION` when the document has moved off the
 * version the request was pinned to. The two options answer that refusal and
 * are mutually exclusive — the backend 400s both together, and 400s either one
 * on a legacy envelope carrying no pin. So only ever send one, and only after a
 * mismatch has actually been reported.
 *
 * The no-option call is deliberately left byte-identical to what it was before
 * the options existed: no body, no Content-Type.
 */
export async function approveSignature(
    id: string,
    options?: {
        /** Send the version the request was prepared against, unchanged. */
        confirmPreparedVersion?: boolean;
        /** Re-pin the request to the document's current version, then send. */
        useCurrentVersion?: boolean;
    },
): Promise<{ envelope: SignatureEnvelope; signers: SignerRef[] }> {
    const body: Record<string, true> = {};
    if (options?.confirmPreparedVersion) body.confirm_prepared_version = true;
    if (options?.useCurrentVersion) body.use_current_version = true;
    const versionChoice = Object.keys(body).length > 0;
    return apiRequest<{ envelope: SignatureEnvelope; signers: SignerRef[] }>(
        `/signatures/${id}/approve`,
        {
            method: "POST",
            ...(versionChoice
                ? {
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                  }
                : {}),
        },
    );
}

/** Cancel a pending signature envelope so links are never sent. */
export async function cancelSignature(
    id: string,
): Promise<{ envelope: SignatureEnvelope }> {
    return apiRequest<{ envelope: SignatureEnvelope }>(
        `/signatures/${id}/cancel`,
        { method: "POST" },
    );
}

/**
 * Re-mint and re-email signing links for an envelope's still-pending external
 * signers. Recovers a lost / wrong-port / undelivered link without recreating
 * the envelope (the prior link is rotated dead). Returns the refreshed detail.
 */
export async function resendSignatureLinks(
    id: string,
): Promise<SignatureEnvelopeDetail> {
    return apiRequest<SignatureEnvelopeDetail>(`/signatures/${id}/resend`, {
        method: "POST",
    });
}

/** One row from the signatures list: the envelope plus its signers. */
export interface SignatureEnvelopeSummary {
    envelope: SignatureEnvelope;
    signers: SignerRef[];
}

/**
 * List signature envelopes — the caller's own across all matters, or (when
 * `projectId` is given) just that matter's. Returns the nested
 * `{ envelope, signers }` shape the API actually sends (the signers power the
 * "N of M signed" progress + Pending/Completed grouping).
 */
export async function listSignatures(
    projectId?: string,
): Promise<{ envelopes: SignatureEnvelopeSummary[] }> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
    return apiRequest<{ envelopes: SignatureEnvelopeSummary[] }>(
        `/signatures${qs}`,
    );
}

/**
 * Fetch a single signature envelope plus its signers and (once completed) the
 * executed-PDF and certificate download URLs. Used by the in-chat status card
 * to poll progress and offer the signed document for download.
 */
export async function getSignatureEnvelope(
    id: string,
): Promise<SignatureEnvelopeDetail> {
    return apiRequest<SignatureEnvelopeDetail>(`/signatures/${id}`);
}

/**
 * Sign the envelope yourself, in-app. Authenticated: the backend matches the
 * caller to a pending signer on this envelope and records the signature.
 * Resolves with the new signer status and whether all parties are now done.
 * Throws (via apiRequest) with the backend `detail` on 404 (no pending signer
 * for you), 409 (already signed), or 400 (consent missing).
 */
export async function signSelf(
    id: string,
    payload: SignSelfPayload,
): Promise<{ ok: true; status: string; all_complete: boolean }> {
    return apiRequest<{ ok: true; status: string; all_complete: boolean }>(
        `/signatures/${id}/sign-self`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

// ---------------------------------------------------------------------------
// Document authoring (templates → intake → assembly)
// ---------------------------------------------------------------------------

/**
 * List the caller's firm templates (firm rows overlaid on the Cocoa Legal
 * default-shared rows). The server wraps the list in `{ templates }`, so we
 * unwrap to the bare array the UI expects. Optional `docType` filter.
 */
export async function listTemplates(docType?: string): Promise<DocTemplate[]> {
    const q = docType ? `?doc_type=${encodeURIComponent(docType)}` : "";
    const res = await apiRequest<{ templates: DocTemplate[] }>(
        `/templates${q}`,
    );
    return res.templates;
}

/** Resolve a template (by slug or uuid) plus its current version. */
export async function getTemplate(
    id: string,
): Promise<{ template: DocTemplate; version: DocTemplateVersion }> {
    return apiRequest<{ template: DocTemplate; version: DocTemplateVersion }>(
        `/templates/${id}`,
    );
}

/** The variable schema + clause slots that drive the dynamic intake wizard. */
export async function getTemplateSchema(
    id: string,
): Promise<{ variableSchema: DocTemplateVariable[]; clauseSlots: unknown[] }> {
    return apiRequest<{
        variableSchema: DocTemplateVariable[];
        clauseSlots: unknown[];
    }>(`/templates/${id}/schema`);
}

/** Create a firm-authored template (new row or a new version of a firm slug). */
export async function createTemplate(body: {
    slug: string;
    title: string;
    docType: string;
    jurisdiction?: string;
    description?: string;
    skeleton: DocTemplateSection[];
    variableSchema: DocTemplateVariable[];
    clauseSlots?: unknown[];
}): Promise<{
    template_id: string;
    version_id: string;
    version_number: number;
}> {
    return apiRequest<{
        template_id: string;
        version_id: string;
        version_number: number;
    }>(`/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

/** Soft-delete (archive) the firm's OWN template. Shared defaults 403 server-side. */
export async function deleteTemplate(id: string): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`/templates/${id}`, { method: "DELETE" });
}

/**
 * AI-generate a parameterized template and persist its first version. JSON
 * in / JSON out — the explicit submit is the authoring act (no approval gate).
 */
export async function generateTemplate(body: {
    doc_type: string;
    title: string;
    description?: string;
    sample_document_id?: string;
    jurisdiction?: string;
    model?: string;
}): Promise<{
    template_id: string;
    version_id: string;
    version_number: number;
    title: string;
    variableSchema: DocTemplateVariable[];
    skeleton: DocTemplateSection[];
}> {
    return apiRequest<{
        template_id: string;
        version_id: string;
        version_number: number;
        title: string;
        variableSchema: DocTemplateVariable[];
        skeleton: DocTemplateSection[];
    }>(`/templates/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

/**
 * Kick off the intake wizard's assemble as a DETACHED background job. Returns
 * immediately with the staged job id (no SSE / no blocking) — the caller then
 * polls `getAuthoringJob(job_id)` for assembling → qa → ready|failed. The
 * wizard submit IS the approval (no gate). JSON in / JSON out.
 */
export async function startAuthorDocument(args: {
    templateId: string;
    variables: Record<string, unknown>;
    /**
     * Top-level jurisdiction for the assemble run, derived from the filled
     * variables when the schema has a `jurisdiction`-typed field. Feeds the QA
     * jurisdiction guardrail (the backend `/assemble` route reads
     * `body.jurisdiction`).
     */
    jurisdiction?: string;
    projectId?: string;
    chat_id?: string;
    model?: string;
}): Promise<{ job_id: string; operation_id: string; status: string }> {
    return apiRequest<{ job_id: string; operation_id: string; status: string }>(
        `/templates/${args.templateId}/assemble`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                variables: args.variables,
                jurisdiction: args.jurisdiction,
                project_id: args.projectId,
                chat_id: args.chat_id,
                model: args.model,
            }),
        },
    );
}

/**
 * Poll a background assembly job's status + result. The caller loops this until
 * `status` is `ready`/`failed` or `stalled` is true. `result` (and its relative
 * `download_url`) is present only once `status === "ready"`.
 */
export async function getAuthoringJob(
    jobId: string,
): Promise<AuthoringJobStatus> {
    return apiRequest<AuthoringJobStatus>(`/templates/jobs/${jobId}`);
}

export async function getDocumentGenerationJob(
    jobId: string,
): Promise<DocumentGenerationJobStatus> {
    return apiRequest<DocumentGenerationJobStatus>(
        `/document-generation-jobs/${jobId}`,
    );
}

export async function cancelDocumentGenerationJob(
    jobId: string,
): Promise<{ id: string; cancellation_requested: boolean; status: string }> {
    return apiRequest(`/document-generation-jobs/${jobId}/cancel`, {
        method: "POST",
    });
}

export async function retryFailedDocumentGenerationJob(jobId: string): Promise<{
    id: string;
    status: string;
    requeued_items: number;
    completed_items: number;
    failed_items: number;
}> {
    return apiRequest(`/document-generation-jobs/${jobId}/retry-failed`, {
        method: "POST",
    });
}

// ---------------------------------------------------------------------------
// Personal Injury cases (pi_cases / policies / expenses)
// ---------------------------------------------------------------------------

export type PiCaseStatus = "open" | "settled" | "closed" | "provisional";
export type PiCaseOrigin = "csv_import" | "manual" | "auto_created";
export type PiExpenseStatus =
    | "pending_approval"
    | "approved"
    | "paid"
    | "rejected"
    | "void";

export const PI_CASE_STATUSES: readonly PiCaseStatus[] = [
    "open",
    "settled",
    "closed",
    "provisional",
];

/** One pi_cases row (mirrors backend/src/lib/pi/store.ts). */
export interface PiCase {
    id: string;
    project_id: string | null;
    case_number: string | null;
    client_name: string;
    date_of_loss: string | null;
    status: PiCaseStatus;
    origin: PiCaseOrigin;
    needs_review: boolean;
    attributes: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

/** One pi_case_policies row. `policy_limits.raw_text` carries the quoted
 * limits text; `adjuster` holds { name?, email?, phone? }. */
export interface PiCasePolicy {
    id: string;
    case_id: string;
    carrier: string;
    claim_number: string | null;
    policy_number: string | null;
    coverage_type: string | null;
    policy_limits: Record<string, unknown>;
    adjuster: Record<string, unknown>;
    source_document_id: string | null;
    source_run_id: string | null;
    created_at: string;
}

/** One pi_case_expenses row. */
export interface PiCaseExpense {
    id: string;
    case_id: string | null;
    vendor: string;
    invoice_number: string | null;
    amount_cents: number | null;
    currency: string;
    status: PiExpenseStatus;
    payment_portal_url: string | null;
    document_id: string | null;
    automation_run_id: string | null;
    incurred_at: string | null;
    paid_at: string | null;
    paid_by: string | null;
    notes: string | null;
    created_at: string;
}

/** Narrow document row included in the case detail response. */
export interface PiCaseDocument {
    id: string;
    filename: string;
    file_type: string | null;
    created_at: string;
}

/** GET /cases/:id response: the case plus everything filed against it. */
export interface PiCaseDetailOut {
    case: PiCase;
    policies: PiCasePolicy[];
    expenses: PiCaseExpense[];
    documents: PiCaseDocument[];
    runs: AutomationRun[];
}

export async function listCases(filters?: {
    status?: PiCaseStatus;
    needsReview?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
}): Promise<PiCase[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.needsReview !== undefined)
        params.set("needs_review", String(filters.needsReview));
    if (filters?.search) params.set("search", filters.search);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const res = await apiRequest<{ cases: PiCase[] }>(`/cases${qs}`);
    return res.cases;
}

export async function createCase(payload: {
    client_name: string;
    case_number?: string;
    date_of_loss?: string;
    status?: PiCaseStatus;
}): Promise<PiCase> {
    const res = await apiRequest<{ case: PiCase }>("/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return res.case;
}

export async function getCase(caseId: string): Promise<PiCaseDetailOut> {
    return apiRequest<PiCaseDetailOut>(`/cases/${encodeURIComponent(caseId)}`);
}

export async function updateCase(
    caseId: string,
    patch: {
        client_name?: string;
        case_number?: string | null;
        date_of_loss?: string | null;
        status?: PiCaseStatus;
        needs_review?: boolean;
    },
): Promise<PiCase> {
    const res = await apiRequest<{ case: PiCase }>(
        `/cases/${encodeURIComponent(caseId)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        },
    );
    return res.case;
}

export async function updateCaseExpense(
    caseId: string,
    expenseId: string,
    patch: {
        status?: PiExpenseStatus;
        paid_by?: string;
        notes?: string | null;
    },
): Promise<PiCaseExpense> {
    const res = await apiRequest<{ expense: PiCaseExpense }>(
        `/cases/${encodeURIComponent(caseId)}/expenses/${encodeURIComponent(expenseId)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        },
    );
    return res.expense;
}

// --- CasePeer CSV import ----------------------------------------------------

/** One rejected CSV row. rowIndex counts parsed rows (0 = header, data
 * rows start at 1) — i.e. the row's 1-based line within the data. */
export interface CsvImportRowError {
    rowIndex: number;
    detail: string;
}

/** One importable row from the dry-run plan. */
export interface CsvImportRowPlan {
    rowIndex: number;
    row: {
        caseNumber: string;
        clientName?: string;
        dateOfLoss?: string | null;
        status?: PiCaseStatus;
        attributes?: Record<string, unknown>;
    };
}

/** 200 response of POST /cases/import with dry_run=true. */
export interface CsvImportDryRunOut {
    plans: CsvImportRowPlan[];
    errors: CsvImportRowError[];
    summary: { total_rows: number; planned: number; invalid: number };
}

/** 200 response of POST /cases/import with dry_run=false. Invariant:
 * skipped === errors.length (row-level failures only — header/mapping
 * failures are a 400 `{ detail }` on both paths and nothing is written). */
export interface CsvImportExecuteOut {
    created: number;
    updated: number;
    skipped: number;
    errors: CsvImportRowError[];
}

/**
 * CasePeer CSV import (multipart). `mapping` is case field → CSV header name;
 * `case_number` and `client_name` are required keys. Header/mapping-level
 * failures reject with the backend `{ detail }` on BOTH the dry-run and
 * execute paths; a 200's `errors` are purely row-level.
 */
export async function importCasesCsv(
    file: File,
    mapping: Record<string, string>,
    dryRun: true,
): Promise<CsvImportDryRunOut>;
export async function importCasesCsv(
    file: File,
    mapping: Record<string, string>,
    dryRun: false,
): Promise<CsvImportExecuteOut>;
export async function importCasesCsv(
    file: File,
    mapping: Record<string, string>,
    dryRun: boolean,
): Promise<CsvImportDryRunOut | CsvImportExecuteOut> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(mapping));
    form.append("dry_run", dryRun ? "true" : "false");
    const response = await fetch(`${API_BASE}/cases/import`, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", ...authHeaders },
        body: form,
    });
    if (!response.ok) {
        const detail = await response.text();
        let message = detail;
        try {
            const parsed = JSON.parse(detail) as { detail?: unknown };
            if (typeof parsed.detail === "string") message = parsed.detail;
        } catch {
            // Keep the raw text body when the backend did not return JSON.
        }
        throw new Error(message || `API error: ${response.status}`);
    }
    return (await response.json()) as CsvImportDryRunOut | CsvImportExecuteOut;
}

// ---------------------------------------------------------------------------
// Email automation queue (automation_runs)
// ---------------------------------------------------------------------------

/** Every automation_runs.status (backend/src/lib/automation/types.ts). */
export const AUTOMATION_RUN_STATUSES = [
    "queued",
    "classifying",
    "extracting",
    "matching",
    "staging",
    "staged",
    "approved",
    "rejected",
    "failed",
    "triage",
    "skipped",
] as const;

export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export type AutomationWorkflowKind = "claim_correspondence" | "vendor_invoice";

/** One automation_runs row — an inbound email's trip through the pipeline.
 * `extracted` / `verification` / `proposal` are the pipeline's JSON blobs;
 * components/pi/piShared.ts knows how to flatten them for display. */
export interface AutomationRun {
    id: string;
    email_id: string | null;
    workflow_kind: AutomationWorkflowKind | null;
    status: AutomationRunStatus;
    case_id: string | null;
    match_method: string | null;
    match_confidence: number | null;
    extracted: Record<string, unknown>;
    citations: unknown[];
    confidence: number | null;
    verification: Record<string, unknown>;
    proposal: Record<string, unknown>;
    ack_email_id: string | null;
    error: string | null;
    retry_count: number;
    triage_reason: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
}

/** Compact inbound-email enrichment on the run detail. */
export interface AutomationRunEmail {
    id: string;
    from_address: string | null;
    subject: string | null;
    received_at: string | null;
}

/** The acknowledgement draft on the run detail (rendered subset of the
 * full email row the backend returns). */
export interface AutomationAckEmail {
    id: string;
    status: string;
    subject: string;
    to_addresses: string[];
    cc_addresses: string[];
    reply_to_address: string | null;
    body_text: string;
}

/** Compact matched-case enrichment on the run detail. */
export interface AutomationRunCase {
    id: string;
    client_name: string;
    case_number: string | null;
}

/** GET /automation/runs/:id response. */
export interface AutomationRunDetail {
    run: AutomationRun;
    ackEmail: AutomationAckEmail | null;
    email: AutomationRunEmail | null;
    case: AutomationRunCase | null;
}

/** GET /automation/status response. Pre-migration databases report
 * schema_ready:false with zeroed counts instead of erroring. */
export interface AutomationStatusOut {
    enabled: boolean;
    draftsOnly: boolean;
    pollIntervalMs: number;
    cursorPresent: boolean;
    counts: Record<AutomationRunStatus, number>;
    schema_ready: boolean;
}

export async function listAutomationRuns(opts?: {
    status?: AutomationRunStatus;
    limit?: number;
    offset?: number;
}): Promise<{ runs: AutomationRun[]; schema_ready?: boolean }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ runs: AutomationRun[]; schema_ready?: boolean }>(
        `/automation/runs${qs}`,
    );
}

export async function getAutomationRun(
    runId: string,
): Promise<AutomationRunDetail> {
    return apiRequest<AutomationRunDetail>(
        `/automation/runs/${encodeURIComponent(runId)}`,
    );
}

/** Operator edits applied at approval time. `policyUpserts` are per-claim
 * shallow overrides merged by index into the staged proposal's
 * policy_upserts; `amountCents` overrides an invoice amount. */
export interface ApproveRunEdits {
    policyUpserts?: Record<string, unknown>[];
    amountCents?: number;
}

/**
 * Approve a staged run. `confirmCase: true` is REQUIRED when the run's
 * proposal has needs_case_confirm (the backend 409s otherwise). A 409 also
 * means the run changed state under you — reload and re-render.
 */
export async function approveAutomationRun(
    runId: string,
    opts?: { confirmCase?: boolean; edits?: ApproveRunEdits },
): Promise<{ run: AutomationRun | null; sent: boolean }> {
    const edits: Record<string, unknown> = {};
    if (opts?.edits?.policyUpserts)
        edits.policy_upserts = opts.edits.policyUpserts;
    if (opts?.edits?.amountCents !== undefined)
        edits.amount_cents = opts.edits.amountCents;
    return apiRequest<{ run: AutomationRun | null; sent: boolean }>(
        `/automation/runs/${encodeURIComponent(runId)}/approve`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...(opts?.confirmCase ? { confirm_case: true } : {}),
                ...(Object.keys(edits).length > 0 ? { edits } : {}),
            }),
        },
    );
}

export async function rejectAutomationRun(
    runId: string,
    reason?: string,
): Promise<{ run: AutomationRun | null }> {
    return apiRequest<{ run: AutomationRun | null }>(
        `/automation/runs/${encodeURIComponent(runId)}/reject`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reason ? { reason } : {}),
        },
    );
}

export async function retryAutomationRun(
    runId: string,
): Promise<{ run: AutomationRun }> {
    return apiRequest<{ run: AutomationRun }>(
        `/automation/runs/${encodeURIComponent(runId)}/retry`,
        { method: "POST" },
    );
}

export async function reassignAutomationRun(
    runId: string,
    caseId: string,
): Promise<{ run: AutomationRun | null }> {
    return apiRequest<{ run: AutomationRun | null }>(
        `/automation/runs/${encodeURIComponent(runId)}/reassign`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ case_id: caseId }),
        },
    );
}

export async function getAutomationStatus(): Promise<AutomationStatusOut> {
    return apiRequest<AutomationStatusOut>("/automation/status");
}

/** Authed force-poll: cursor-mode ingest + one batch of due runs. */
export async function forceAutomationPoll(): Promise<{
    ingested: number;
    processed: number;
    schema_ready?: boolean;
}> {
    return apiRequest<{
        ingested: number;
        processed: number;
        schema_ready?: boolean;
    }>("/automation/poll", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Calendar — Quill's own Google Calendar(s). The client works in
// "primary" | "firm"; the backend resolves those to real Google calendar ids.
// Mirrors the /calendar route contract 1:1 (camelCase DTO).
// ---------------------------------------------------------------------------

export type CalendarSource = "primary" | "firm";

export interface EventDateTime {
    dateTime?: string | null;
    date?: string | null;
    timeZone?: string | null;
}

export interface EventAttendee {
    email: string;
    displayName?: string | null;
    responseStatus?:
        | "needsAction"
        | "accepted"
        | "declined"
        | "tentative"
        | string
        | null;
    organizer?: boolean;
    optional?: boolean;
}

export type DeadlineType =
    | "court_date"
    | "filing"
    | "statute_of_limitations"
    | "other";

export interface EventDeadline {
    type: DeadlineType | string;
    dueAt: string | null;
    leadDays: number | null;
}

export interface CalendarEvent {
    id: string;
    calendar: CalendarSource;
    title: string;
    description: string | null;
    location: string | null;
    start: EventDateTime;
    end: EventDateTime;
    allDay: boolean;
    attendees: EventAttendee[];
    meetLink: string | null;
    htmlLink: string | null;
    organizer: { email: string } | null;
    recurrence: string[];
    status: string;
    // Enriched from calendar_event_meta (Phase B); null/false when unlinked.
    matterId: string | null;
    projectId: string | null;
    recordingId: string | null;
    isDeadline: boolean;
    deadline: EventDeadline | null;
    created: string | null;
    updated: string | null;
}

export interface AgendaResponse {
    events: CalendarEvent[];
    range: { from: string | null; to: string | null };
    calendars: { id: CalendarSource; name: string }[];
}

/** Request body for create/update. `attendees` are bare email strings; when
 * non-empty the write is approval-gated (invitations sent on approval). */
export interface EventInput {
    calendar: CalendarSource;
    title: string;
    description?: string;
    location?: string;
    allDay: boolean;
    start: EventDateTime;
    end: EventDateTime;
    timeZone?: string;
    attendees: string[];
    addMeet: boolean;
    recurrence?: string[];
}

/** The pending-operation half of a write result (present for outward writes). */
export interface CalendarPendingOp {
    write_id: string;
    operation_id: string | null;
    kind: "create" | "update" | "delete";
    status: string;
}

/** A create/update/delete result: an event when applied directly (internal),
 * or a pending operation when approval-gated (attendees present). */
export interface CalendarWriteResult {
    event: CalendarEvent | null;
    operation: CalendarPendingOp | null;
    write_id?: string | null;
}

export interface CalendarWrite {
    id: string;
    status: string;
    op_kind: "create" | "update" | "delete";
    agent_operation_id: string | null;
    result_event_id: string | null;
}

export async function listEvents(params: {
    from: string;
    to: string;
    calendar?: CalendarSource | "all";
    matterId?: string; // Phase B
}): Promise<AgendaResponse> {
    const q = new URLSearchParams();
    q.set("time_min", params.from);
    q.set("time_max", params.to);
    if (params.calendar) q.set("calendar", params.calendar);
    if (params.matterId) q.set("matter_id", params.matterId);
    return apiRequest<AgendaResponse>(`/calendar/events?${q.toString()}`);
}

/** The calendar event linked to a recording, or null. Degrades to null when the
 * calendar isn't configured. */
export async function getEventForRecording(
    recordingId: string,
): Promise<CalendarEvent | null> {
    const { event } = await apiRequest<{ event: CalendarEvent | null }>(
        `/calendar/recordings/${encodeURIComponent(recordingId)}/event`,
    );
    return event;
}

export async function getEvent(
    id: string,
    calendar: CalendarSource = "primary",
): Promise<CalendarEvent> {
    const { event } = await apiRequest<{ event: CalendarEvent }>(
        `/calendar/events/${encodeURIComponent(id)}?calendar=${calendar}`,
    );
    return event;
}

export async function createEvent(
    input: EventInput,
): Promise<CalendarWriteResult> {
    return apiRequest<CalendarWriteResult>("/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export async function updateEvent(
    id: string,
    patch: Partial<EventInput> & { calendar: CalendarSource },
): Promise<CalendarWriteResult> {
    return apiRequest<CalendarWriteResult>(
        `/calendar/events/${encodeURIComponent(id)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        },
    );
}

export async function deleteEvent(
    id: string,
    calendar: CalendarSource = "primary",
): Promise<CalendarWriteResult> {
    return apiRequest<CalendarWriteResult>(
        `/calendar/events/${encodeURIComponent(id)}?calendar=${calendar}`,
        { method: "DELETE" },
    );
}

/** Approve a pending outward calendar write (invitations sent on approval). */
export async function approveCalendarWrite(
    writeId: string,
): Promise<CalendarWrite> {
    const { write } = await apiRequest<{ write: CalendarWrite }>(
        `/calendar/writes/${encodeURIComponent(writeId)}/approve`,
        { method: "POST" },
    );
    return write;
}

/** Cancel a still-pending calendar write (before it is applied). */
export async function cancelCalendarWrite(
    writeId: string,
): Promise<CalendarWrite> {
    const { write } = await apiRequest<{ write: CalendarWrite }>(
        `/calendar/writes/${encodeURIComponent(writeId)}/cancel`,
        { method: "POST" },
    );
    return write;
}

/** Undo an applied calendar write (delete a created event / restore a change). */
export async function undoCalendarWrite(
    writeId: string,
): Promise<CalendarWrite> {
    const { write } = await apiRequest<{ write: CalendarWrite }>(
        `/calendar/writes/${encodeURIComponent(writeId)}/undo`,
        { method: "POST" },
    );
    return write;
}
