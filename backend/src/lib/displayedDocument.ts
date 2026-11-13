import type { createServerSupabase } from "./supabase";
import { loadActiveVersion } from "./documentVersions";

type Db = ReturnType<typeof createServerSupabase>;

export type DisplayedDocumentInput = {
    document_id: string;
    version_id?: string | null;
    filename?: string | null;
    version_number?: number | null;
};

export type OpenDocumentInput = {
    document_id: string;
    version_id?: string | null;
    displayed?: boolean;
};

export type ResolvedDisplayedDocument = {
    document_id: string;
    version_id: string;
    version_number: number | null;
    current_version_id: string;
    filename: string;
    file_type: string;
    source: string | null;
    modified_at: string | null;
    is_current: boolean;
    editable: boolean;
    /** Current-turn model handle, filled after buildProjectDocContext. */
    doc_handle: string | null;
};

export type ResolvedOpenDocument = {
    document_id: string;
    version_id: string;
    version_number: number | null;
    displayed: boolean;
};

export type DisplayedDocumentErrorCode =
    | "DISPLAYED_DOCUMENT_UNAVAILABLE"
    | "DISPLAYED_VERSION_UNAVAILABLE";

export class DisplayedDocumentResolutionError extends Error {
    readonly status = 409;

    constructor(
        readonly code: DisplayedDocumentErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "DisplayedDocumentResolutionError";
    }
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the viewer's client hint to database-owned document/version facts.
 * Filename and version_number are deliberately ignored: they are UI labels,
 * never authority. The project filter prevents a valid UUID from another
 * matter becoming part of a persisted prompt or version_context snapshot.
 */
export async function resolveDisplayedDocument(params: {
    db: Db;
    projectId: string;
    input?: DisplayedDocumentInput | null;
}): Promise<ResolvedDisplayedDocument | null> {
    if (!params.input) return null;
    const documentId = nonEmptyString(params.input.document_id);
    if (!documentId) {
        throw new DisplayedDocumentResolutionError(
            "DISPLAYED_DOCUMENT_UNAVAILABLE",
            "The displayed document is no longer available in this matter.",
        );
    }

    const { data: document } = await params.db
        .from("documents")
        .select(
            "id, project_id, filename, file_type, status, current_version_id, updated_at, created_at",
        )
        .eq("id", documentId)
        .eq("project_id", params.projectId)
        .maybeSingle();

    if (
        !document ||
        document.status !== "ready" ||
        !nonEmptyString(document.current_version_id)
    ) {
        throw new DisplayedDocumentResolutionError(
            "DISPLAYED_DOCUMENT_UNAVAILABLE",
            "The displayed document is no longer available or ready to edit.",
        );
    }

    const requestedVersionId = nonEmptyString(params.input.version_id);
    const versionId = requestedVersionId ?? String(document.current_version_id);
    const version = await loadActiveVersion(documentId, params.db, versionId);
    if (!version) {
        throw new DisplayedDocumentResolutionError(
            "DISPLAYED_VERSION_UNAVAILABLE",
            "The displayed document version no longer exists or does not belong to this document.",
        );
    }

    const currentVersionId = String(document.current_version_id);
    return {
        document_id: documentId,
        version_id: version.id,
        version_number: version.version_number,
        current_version_id: currentVersionId,
        filename: String(document.filename ?? "Document"),
        file_type: String(document.file_type ?? ""),
        source: version.source,
        modified_at:
            version.created_at ||
            (typeof document.updated_at === "string" && document.updated_at) ||
            (typeof document.created_at === "string" && document.created_at) ||
            null,
        is_current: version.id === currentVersionId,
        editable:
            version.id === currentVersionId && document.file_type === "docx",
        doc_handle: null,
    };
}

/**
 * Validate every open-tab snapshot before it is persisted. Unknown documents
 * and mismatched versions fail the request rather than poisoning provenance.
 * Missing version ids resolve to each document's current version.
 */
export async function resolveOpenDocuments(params: {
    db: Db;
    projectId: string;
    inputs?: OpenDocumentInput[] | null;
    displayed?: ResolvedDisplayedDocument | null;
}): Promise<ResolvedOpenDocument[]> {
    const inputs = Array.isArray(params.inputs) ? params.inputs : [];
    const unique = new Map<string, OpenDocumentInput>();
    for (const input of inputs) {
        const id = nonEmptyString(input?.document_id);
        if (!id) continue;
        unique.set(id, { ...input, document_id: id });
    }
    if (params.displayed && !unique.has(params.displayed.document_id)) {
        unique.set(params.displayed.document_id, {
            document_id: params.displayed.document_id,
            version_id: params.displayed.version_id,
            displayed: true,
        });
    }

    const resolved: ResolvedOpenDocument[] = [];
    for (const input of unique.values()) {
        if (
            params.displayed &&
            input.document_id === params.displayed.document_id
        ) {
            resolved.push({
                document_id: params.displayed.document_id,
                version_id: params.displayed.version_id,
                version_number: params.displayed.version_number,
                displayed: true,
            });
            continue;
        }

        const { data: document } = await params.db
            .from("documents")
            .select("id, current_version_id, status")
            .eq("id", input.document_id)
            .eq("project_id", params.projectId)
            .maybeSingle();
        if (
            !document ||
            document.status !== "ready" ||
            !nonEmptyString(document.current_version_id)
        ) {
            throw new DisplayedDocumentResolutionError(
                "DISPLAYED_DOCUMENT_UNAVAILABLE",
                `An open document (${input.document_id}) is no longer available in this matter.`,
            );
        }
        const versionId =
            nonEmptyString(input.version_id) ?? String(document.current_version_id);
        const version = await loadActiveVersion(
            input.document_id,
            params.db,
            versionId,
        );
        if (!version) {
            throw new DisplayedDocumentResolutionError(
                "DISPLAYED_VERSION_UNAVAILABLE",
                `An open document version (${versionId}) is no longer available.`,
            );
        }
        resolved.push({
            document_id: input.document_id,
            version_id: version.id,
            version_number: version.version_number,
            displayed: !!input.displayed,
        });
    }
    return resolved;
}
