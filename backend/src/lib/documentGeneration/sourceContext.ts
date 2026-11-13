import type { createServerSupabase } from "../supabase";
import { downloadFile } from "../storage";
import { extractDocumentText } from "../documentExtraction";

export class DocumentSourceLoadError extends Error {
    readonly code = "DOCUMENT_SOURCE_LOAD_FAILED";
    readonly databaseCode: string | null;

    constructor(cause: unknown, databaseCode?: unknown) {
        super(
            "The source files could not be loaded. Your drafting request is saved and can be retried.",
            { cause },
        );
        this.name = "DocumentSourceLoadError";
        // Only database identifiers belong in logs, never error details that
        // may contain source text, storage paths, or credentials.
        this.databaseCode =
            typeof databaseCode === "string" &&
            /^(?:PGRST\d{3}|[A-Z0-9]{5})$/.test(databaseCode)
                ? databaseCode
                : null;
    }
}

export function savedBriefContext(value: unknown) {
    if (!value || typeof value !== "object") return "";
    const summary = (value as Record<string, unknown>).summary;
    if (typeof summary === "string" && summary.trim()) {
        return `SAVED JOB BRIEF:\n${summary.trim().slice(0, 60_000)}`;
    }
    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized && serialized !== "{}"
            ? `SAVED JOB BRIEF:\n${serialized.slice(0, 60_000)}`
            : "";
    } catch {
        return "";
    }
}

/** Load the exact pinned versions, even when a document has since changed. */
export async function loadDocumentGenerationContext(
    db: ReturnType<typeof createServerSupabase>,
    versionIds: string[],
    brief: unknown,
    deps = { downloadFile, extractDocumentText },
) {
    const chunks: string[] = [];
    try {
        if (versionIds.length) {
            const { data, error } = await db
                .from("document_versions")
                .select(
                    "id, storage_path, pdf_storage_path, document_id, documents!document_versions_document_id_fkey(filename, file_type)",
                )
                .in("id", versionIds);
            if (error) throw new DocumentSourceLoadError(error, error.code);
            const ordered = new Map(
                (data ?? []).map((row) => [String(row.id), row]),
            );
            for (const id of versionIds) {
                const row = ordered.get(id) as
                    | Record<string, unknown>
                    | undefined;
                if (!row || typeof row.storage_path !== "string") continue;
                const doc = (
                    Array.isArray(row.documents)
                        ? row.documents[0]
                        : row.documents
                ) as { filename?: string; file_type?: string } | undefined;
                const [raw, pdf] = await Promise.all([
                    deps.downloadFile(row.storage_path),
                    typeof row.pdf_storage_path === "string"
                        ? deps.downloadFile(row.pdf_storage_path)
                        : Promise.resolve(null),
                ]);
                if (!raw) continue;
                const text = await deps.extractDocumentText({
                    fileType: doc?.file_type ?? "docx",
                    rawBuf: raw,
                    pdfRenditionBuf: pdf,
                });
                if (text.trim())
                    chunks.push(`SOURCE: ${doc?.filename ?? id}\n${text}`);
            }
        }
    } catch (error) {
        if (error instanceof DocumentSourceLoadError) throw error;
        throw new DocumentSourceLoadError(error);
    }
    return [
        savedBriefContext(brief),
        chunks.join("\n\n---\n\n").slice(0, 180_000),
    ]
        .filter(Boolean)
        .join("\n\n---\n\n");
}
