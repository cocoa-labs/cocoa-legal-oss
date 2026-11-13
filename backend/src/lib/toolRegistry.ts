import type { OperationInverse, ToolPermissionScope } from "./operations";

export type RegisteredTool = {
    name: string;
    scope: ToolPermissionScope;
    mutating: boolean;
    requiresApproval: boolean;
    inverseOperation: OperationInverse;
    timeoutMs: number;
};

export const TOOL_REGISTRY: Record<string, RegisteredTool> = {
    read_document: {
        name: "read_document",
        scope: "read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 30000,
    },
    find_in_document: {
        name: "find_in_document",
        scope: "read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 15000,
    },
    legal_search: {
        name: "legal_search",
        scope: "search",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 60000,
    },
    highlight_document: {
        name: "highlight_document",
        scope: "document:annotate",
        mutating: true,
        requiresApproval: false,
        inverseOperation: "remove_highlights",
        timeoutMs: 30000,
    },
    apply_document_highlights: {
        name: "apply_document_highlights",
        scope: "document:mutate",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "restore_source_version",
        timeoutMs: 60000,
    },
    remove_document_highlights: {
        name: "remove_document_highlights",
        scope: "document:mutate",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "restore_source_version",
        timeoutMs: 60000,
    },
    edit_document: {
        name: "edit_document",
        scope: "document:mutate",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "restore_source_version",
        timeoutMs: 90000,
    },
    generate_docx: {
        name: "generate_docx",
        scope: "document:export",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "archive_generated_document",
        timeoutMs: 90000,
    },
    generate_template: {
        name: "generate_template",
        scope: "document:export",
        mutating: true,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 90000,
    },
    assemble_document: {
        name: "assemble_document",
        scope: "document:export",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "archive_generated_document",
        timeoutMs: 120000,
    },
    create_clean_document: {
        name: "create_clean_document",
        scope: "document:export",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "archive_generated_document",
        timeoutMs: 90000,
    },
    download_document: {
        name: "download_document",
        scope: "document:export",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 15000,
    },
    read_inbox: {
        name: "read_inbox",
        scope: "read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 30000,
    },
    read_email: {
        name: "read_email",
        scope: "read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 30000,
    },
    send_email: {
        name: "send_email",
        scope: "email:send",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "cancel_email",
        timeoutMs: 30000,
    },
    reply_to_email: {
        name: "reply_to_email",
        scope: "email:send",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "cancel_email",
        timeoutMs: 30000,
    },
    send_for_signature: {
        name: "send_for_signature",
        scope: "esign:send",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "void_signature_envelope",
        timeoutMs: 30000,
    },
    search_cases: {
        name: "search_cases",
        scope: "case:read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 15000,
    },
    read_case: {
        name: "read_case",
        scope: "case:read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 15000,
    },
    update_case_insurance: {
        name: "update_case_insurance",
        scope: "case:write",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "none",
        timeoutMs: 30000,
    },
    record_case_expense: {
        name: "record_case_expense",
        scope: "case:write",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "none",
        timeoutMs: 30000,
    },
    list_automation_queue: {
        name: "list_automation_queue",
        scope: "case:read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 15000,
    },
    list_events: {
        name: "list_events",
        scope: "calendar:read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 30000,
    },
    get_event: {
        name: "get_event",
        scope: "calendar:read",
        mutating: false,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 15000,
    },
    // Mutating calendar tools are registered requiresApproval:true as the
    // conservative governance default; the runtime handler downgrades to
    // auto-execute for no-attendee (private) events — exactly how send_email is
    // registered requiresApproval:true but the handler owns the real branch.
    create_event: {
        name: "create_event",
        scope: "calendar:write",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "cancel_calendar_event",
        timeoutMs: 30000,
    },
    update_event: {
        name: "update_event",
        scope: "calendar:write",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "restore_calendar_event",
        timeoutMs: 30000,
    },
    delete_event: {
        name: "delete_event",
        scope: "calendar:write",
        mutating: true,
        requiresApproval: true,
        inverseOperation: "restore_calendar_event",
        timeoutMs: 30000,
    },
    // Image generation/editing persist a new image document (mutating) but are
    // NOT approval-gated (general creative tool). They reuse document:export
    // scope since the artifact is a first-class generated document; there is no
    // inverse (a generated image is additive — the user can just ignore/delete
    // it). The long timeout covers high-quality gpt-image latency (~10-30s).
    generate_image: {
        name: "generate_image",
        scope: "document:export",
        mutating: true,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 120000,
    },
    edit_image: {
        name: "edit_image",
        scope: "document:export",
        mutating: true,
        requiresApproval: false,
        inverseOperation: "none",
        timeoutMs: 120000,
    },
};

export function registeredTool(name: string): RegisteredTool | null {
    return TOOL_REGISTRY[name] ?? null;
}
