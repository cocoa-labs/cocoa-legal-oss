import type { createServerSupabase } from "./supabase";
import type {
    DocumentLayoutQaReport,
    LayoutQaStatus,
} from "./documentLayoutQa";

type Supa = ReturnType<typeof createServerSupabase>;

interface DocRow {
    id: string;
    latest_version_number?: number | null;
    [k: string]: unknown;
}

interface VersionPathRow extends DocRow {
    /** Set from document_versions.storage_path of the active version. */
    storage_path?: string | null;
    /** Set from document_versions.pdf_storage_path of the active version. */
    pdf_storage_path?: string | null;
    current_version_id?: string | null;
    /** Set from document_versions.version_number of the active version. */
    active_version_number?: number | null;
    active_version_source?: string | null;
}

export interface ActiveVersion {
    id: string;
    storage_path: string;
    pdf_storage_path: string | null;
    version_number: number | null;
    display_name: string | null;
    source: string | null;
    created_at?: string | null;
    layout_qa_status?: LayoutQaStatus | null;
    layout_qa_report?: DocumentLayoutQaReport | null;
    layout_qa_checked_at?: string | null;
}

export function describeSupabaseError(error: unknown): string {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message ?? "")
              : String(error ?? "");
    if (!error || error instanceof Error || typeof error !== "object") {
        return message || "Unknown error";
    }

    const parts = [message];
    const err = error as {
        code?: unknown;
        details?: unknown;
        hint?: unknown;
    };
    if (err.code) parts.push(`code: ${String(err.code)}`);
    if (err.details) parts.push(`details: ${String(err.details)}`);
    if (err.hint) parts.push(`hint: ${String(err.hint)}`);
    return parts.filter(Boolean).join(" ");
}

function missingVersionColumn(error: unknown): string | null {
    const message = describeSupabaseError(error);
    const patterns = [
        /'([^']+)' column of 'document_versions'/i,
        /column document_versions\.([a-zA-Z0-9_]+) does not exist/i,
        /column "([^"]+)" of relation "document_versions" does not exist/i,
    ];
    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match?.[1]) return match[1];
    }
    return null;
}

function isVersionSourceCheckError(error: unknown): boolean {
    const message = describeSupabaseError(error);
    return /document_versions_source_check|violates check constraint|source/i.test(
        message,
    );
}

export async function insertDocumentVersionCompat(params: {
    db: Supa;
    values: Record<string, unknown>;
    fallbackSource?: string;
    errorMessage?: string;
}): Promise<{ id: string }> {
    const insert = { ...params.values };

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const { data, error } = await params.db
            .from("document_versions")
            .insert(insert)
            .select("id")
            .single();
        if (!error && data) return { id: String(data.id) };

        const missing = missingVersionColumn(error);
        if (missing && Object.hasOwn(insert, missing)) {
            delete insert[missing];
            continue;
        }
        if (
            params.fallbackSource &&
            insert.source !== params.fallbackSource &&
            isVersionSourceCheckError(error)
        ) {
            insert.source = params.fallbackSource;
            continue;
        }

        throw new Error(
            `${params.errorMessage ?? "Failed to record document version."} ${describeSupabaseError(error)}`.trim(),
        );
    }

    throw new Error(params.errorMessage ?? "Failed to record document version.");
}

export async function insertUploadDocumentVersion(params: {
    db: Supa;
    documentId: string;
    storagePath: string;
    pdfStoragePath: string | null;
    filename: string;
    userId: string;
    renditionQaReport?: DocumentLayoutQaReport | null;
}): Promise<{ id: string }> {
    return insertDocumentVersionCompat({
        db: params.db,
        fallbackSource: "user_upload",
        errorMessage: "Failed to record upload version.",
        values: {
            document_id: params.documentId,
            storage_path: params.storagePath,
            pdf_storage_path: params.pdfStoragePath,
            source: "upload",
            version_number: 1,
            display_name: params.filename,
            created_by_user_id: params.userId,
            layout_qa_status: "source",
            layout_qa_report: params.renditionQaReport ?? null,
            layout_qa_checked_at:
                params.renditionQaReport?.checked_at ?? null,
        },
    });
}

/**
 * Resolve storage paths for a document. Prefers the version pointed to by
 * `versionId` (if it belongs to this document); else falls back to
 * `documents.current_version_id`. Returns null if no usable version exists.
 *
 * After the storage_path/pdf_storage_path columns moved off `documents`,
 * every read-from-storage path goes through here.
 */
export async function loadActiveVersion(
    documentId: string,
    db: Supa,
    versionId?: string | null,
): Promise<ActiveVersion | null> {
    const { data: doc } = await db
        .from("documents")
        .select("current_version_id")
        .eq("id", documentId)
        .single();
    const targetVersionId =
        (typeof versionId === "string" && versionId) ||
        (doc?.current_version_id as string | undefined) ||
        null;
    if (!targetVersionId) return null;

    const { data: v } = await db
        .from("document_versions")
        .select(
            "id, document_id, storage_path, pdf_storage_path, version_number, display_name, source, created_at, layout_qa_status, layout_qa_report, layout_qa_checked_at",
        )
        .eq("id", targetVersionId)
        .single();
    if (!v || v.document_id !== documentId || !v.storage_path) return null;
    return {
        id: v.id as string,
        storage_path: v.storage_path as string,
        pdf_storage_path: (v.pdf_storage_path as string | null) ?? null,
        version_number: (v.version_number as number | null) ?? null,
        display_name: (v.display_name as string | null) ?? null,
        source: (v.source as string | null) ?? null,
        created_at: (v.created_at as string | null) ?? null,
        layout_qa_status:
            (v.layout_qa_status as LayoutQaStatus | null) ?? null,
        layout_qa_report:
            (v.layout_qa_report as DocumentLayoutQaReport | null) ?? null,
        layout_qa_checked_at:
            (v.layout_qa_checked_at as string | null) ?? null,
    };
}

/**
 * For a list of documents, look up the active version for each and merge
 * `storage_path` + `pdf_storage_path` onto the row. One round-trip total
 * regardless of list size. Documents with no current_version_id retain
 * null paths.
 */
export async function attachActiveVersionPaths<T extends VersionPathRow>(
    db: Supa,
    docs: T[],
): Promise<T[]> {
    if (docs.length === 0) return docs;
    const versionIds = docs
        .map((d) => d.current_version_id)
        .filter((id): id is string => typeof id === "string");
    if (versionIds.length === 0) {
        for (const d of docs) {
            d.storage_path = null;
            d.pdf_storage_path = null;
        }
        return docs;
    }
    const { data: rows } = await db
        .from("document_versions")
        .select("id, storage_path, pdf_storage_path, version_number, source")
        .in("id", versionIds);
    const byId = new Map<
        string,
        {
            storage_path: string | null;
            pdf_storage_path: string | null;
            version_number: number | null;
            source: string | null;
        }
    >();
    for (const r of (rows ?? []) as {
        id: string;
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
        source: string | null;
    }[]) {
        byId.set(r.id, {
            storage_path: r.storage_path ?? null,
            pdf_storage_path: r.pdf_storage_path ?? null,
            version_number: r.version_number ?? null,
            source: r.source ?? null,
        });
    }
    for (const d of docs) {
        const v = d.current_version_id ? byId.get(d.current_version_id) : null;
        d.storage_path = v?.storage_path ?? null;
        d.pdf_storage_path = v?.pdf_storage_path ?? null;
        d.active_version_number = v?.version_number ?? null;
        d.active_version_source = v?.source ?? null;
    }
    return docs;
}

/**
 * Given a list of document rows, attach `latest_version_number` — the
 * max visible `version_number` beyond the original upload for that doc,
 * or null if none. Decision snapshots are intentionally unnumbered/hidden.
 * Mutates rows in place and returns the same reference. One extra query
 * regardless of list size.
 */
export async function attachLatestVersionNumbers<T extends DocRow>(
    db: Supa,
    docs: T[],
): Promise<T[]> {
    if (docs.length === 0) return docs;
    const ids = docs.map((d) => d.id);
    const { data: rows } = await db
        .from("document_versions")
        .select("document_id, version_number")
        .in("document_id", ids)
        .in("source", [
            "user_upload",
            "assistant_edit",
            "assistant_highlight",
            "assistant_undo",
            "generated",
            "authored",
            "clean_final",
        ])
        .not("version_number", "is", null);

    const latestByDoc = new Map<string, number>();
    for (const r of (rows ?? []) as {
        document_id: string;
        version_number: number | null;
    }[]) {
        if (r.version_number == null) continue;
        const prev = latestByDoc.get(r.document_id) ?? 0;
        if (r.version_number > prev)
            latestByDoc.set(r.document_id, r.version_number);
    }
    for (const d of docs) {
        d.latest_version_number = latestByDoc.get(d.id) ?? null;
    }
    return docs;
}
