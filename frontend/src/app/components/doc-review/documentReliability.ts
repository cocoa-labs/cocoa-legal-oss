import type { AssistantEvent } from "@/app/components/shared/types";

export type OpenDocumentTab = {
    documentId: string;
    filename: string;
    versionId?: string | null;
    versionNumber?: number | null;
};

/** Capture IDs from one React render at submit time; labels are hints only. */
export function captureDisplayedDocumentContext(
    tabs: OpenDocumentTab[],
    activeDocumentId: string | null,
) {
    const openDocs = tabs.map((tab) => ({
        document_id: tab.documentId,
        version_id: tab.versionId ?? null,
        version_number: tab.versionNumber ?? null,
        displayed: tab.documentId === activeDocumentId,
    }));
    const active =
        tabs.find((tab) => tab.documentId === activeDocumentId) ?? null;
    return {
        displayedDoc: active
            ? {
                  filename: active.filename,
                  documentId: active.documentId,
                  versionId: active.versionId ?? null,
                  versionNumber: active.versionNumber ?? null,
              }
            : null,
        openDocs,
    };
}

export function normalizeDocEditedEvent(
    data: Record<string, unknown>,
): Extract<AssistantEvent, { type: "doc_edited" }> {
    return {
        type: "doc_edited",
        operation_id:
            typeof data.operation_id === "string" ? data.operation_id : null,
        filename:
            typeof data.filename === "string" ? data.filename : "Document",
        document_id:
            typeof data.document_id === "string" ? data.document_id : "",
        version_id:
            typeof data.version_id === "string" ? data.version_id : "",
        version_number:
            typeof data.version_number === "number"
                ? data.version_number
                : null,
        download_url:
            typeof data.download_url === "string" ? data.download_url : "",
        annotations: Array.isArray(data.annotations)
            ? (data.annotations as Extract<
                  AssistantEvent,
                  { type: "doc_edited" }
              >["annotations"])
            : [],
        layout_reflowed:
            typeof data.layout_reflowed === "boolean"
                ? data.layout_reflowed
                : undefined,
        layout_qa_status:
            data.layout_qa_status === "passed" ||
            data.layout_qa_status === "failed" ||
            data.layout_qa_status === "unverified"
                ? data.layout_qa_status
                : undefined,
        error: typeof data.error === "string" ? data.error : undefined,
        error_code:
            typeof data.error_code === "string"
                ? (data.error_code as Extract<
                      AssistantEvent,
                      { type: "doc_edited" }
                  >["error_code"])
                : undefined,
        retryable:
            typeof data.retryable === "boolean" ? data.retryable : undefined,
        resolution:
            data.resolution && typeof data.resolution === "object"
                ? (data.resolution as Record<string, unknown>)
                : undefined,
        candidates: Array.isArray(data.candidates)
            ? (data.candidates as Record<string, unknown>[])
            : undefined,
        target:
            data.target && typeof data.target === "object"
                ? (data.target as Extract<
                      AssistantEvent,
                      { type: "doc_edited" }
                  >["target"])
                : undefined,
        isStreaming: false,
    };
}
