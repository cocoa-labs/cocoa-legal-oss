import crypto from "node:crypto";
import type { createServerSupabase } from "./supabase";
import { downloadFile, uploadFile } from "./storage";
import { buildDownloadUrl } from "./downloadTokens";
import {
    describeSupabaseError,
    loadActiveVersion,
} from "./documentVersions";
import { applyDocxHighlights, removeDocxHighlights } from "./docxHighlights";
import { reflowFramedDocx } from "./docxLayout";
import {
    layoutQaVersionValues,
    verifyDerivedArtifact,
} from "./documentLayoutGate";

type Db = ReturnType<typeof createServerSupabase>;

export type HighlightTarget = {
    label?: string;
    term?: string;
    quote?: string;
    kind?: "term" | "idea";
};

export type HighlightAnchor = {
    id: string;
    document_id: string;
    version_id: string | null;
    quote: string;
    context: string;
    label: string;
    color: "yellow";
    occurrence_index: number;
    page: number | null;
    status: "kept" | "removed" | "applied";
};

export type HighlightApplyFallbackAnchor = {
    id?: string | null;
    quote?: string | null;
    occurrence_index?: number | null;
    status?: "kept" | "removed" | "applied" | null;
};

export type HighlightApplyRow = {
    id: string;
    quote: string;
    occurrence_index: number;
};

export type HighlightSetResult = {
    highlight_set_id: string;
    document_id: string;
    version_id: string | null;
    version_number: number | null;
    filename: string;
    title: string;
    total: number;
    groups: { label: string; count: number }[];
    highlights: HighlightAnchor[];
    failed_matches: { label: string; query: string; reason: string }[];
    truncated: boolean;
};

type Match = {
    quote: string;
    context: string;
    label: string;
    occurrence_index: number;
    page: number | null;
};

type EphemeralHighlightSet = {
    userId: string;
    documentId: string;
    versionId: string | null;
    versionNumber: number | null;
    filename: string;
    title: string;
    highlights: HighlightAnchor[];
    status: "reviewing" | "applied";
};

const ephemeralHighlightSets = new Map<string, EphemeralHighlightSet>();

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allowEphemeralHighlightFallback(): boolean {
    return process.env.NODE_ENV !== "production";
}

function isMissingVersionLineageColumn(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message ?? "")
              : String(error ?? "");
    return /created_by_operation_id|parent_version_id|content_status|extraction_quality|metadata/i.test(
        message,
    );
}

async function insertAssistantHighlightVersion(params: {
    db: Db;
    insert: Record<string, unknown>;
}): Promise<{ id: string }> {
    let insert = params.insert;
    let { data, error } = await params.db
        .from("document_versions")
        .insert(insert)
        .select("id")
        .single();

    if (error && isMissingVersionLineageColumn(error)) {
        const {
            parent_version_id: _parentVersionId,
            created_by_operation_id: _operationId,
            content_status: _contentStatus,
            extraction_quality: _quality,
            metadata: _metadata,
            ...legacyInsert
        } = insert;
        insert = legacyInsert;
        const retry = await params.db
            .from("document_versions")
            .insert(insert)
            .select("id")
            .single();
        data = retry.data;
        error = retry.error;
    }

    if (error) {
        const message = error.message ?? "";
        const canFallbackSource =
            /document_versions_source_check|violates check constraint|source/i.test(
                message,
            );
        if (canFallbackSource) {
            const retry = await params.db
                .from("document_versions")
                .insert({
                    ...insert,
                    source: "assistant_edit",
                })
                .select("id")
                .single();
            data = retry.data;
            error = retry.error;
        }
    }

    if (error || !data) {
        throw error ?? new Error("Failed to create document version.");
    }
    return { id: String(data.id) };
}

function isMissingHighlightSchema(error: unknown): boolean {
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" && error && "message" in error
              ? String((error as { message?: unknown }).message ?? "")
              : String(error ?? "");
    return (
        /document_highlight_sets|document_highlights/i.test(message) &&
        /schema cache|could not find|does not exist|relation/i.test(message)
    );
}

export function isDurableHighlightSetId(value: string): boolean {
    return UUID_RE.test(value);
}

export function normalizeHighlightApplyFallbackRows(
    highlights: HighlightApplyFallbackAnchor[] | undefined,
): HighlightApplyRow[] {
    if (!Array.isArray(highlights)) return [];
    return highlights.flatMap((highlight, index) => {
        const quote = highlight.quote?.trim();
        if (!quote || highlight.status === "removed") return [];
        return [
            {
                id: highlight.id?.trim() || `fallback-${index}`,
                quote,
                occurrence_index:
                    typeof highlight.occurrence_index === "number" &&
                    Number.isFinite(highlight.occurrence_index)
                        ? highlight.occurrence_index
                        : 0,
            },
        ];
    });
}

function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
            .replace(/[\u2018\u2019\u2032]/g, "'")
            .replace(/[\u201C\u201D\u2033]/g, '"')
            .replace(/[\u2013\u2014]/g, "-")
            .replace(/\u00A0/g, " ")
            .replace(/\u200B/g, " ");
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch.toLowerCase());
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

function normalizeNeedle(q: string): string {
    return normalizeWithMap(q.trim()).norm.replace(/\s+/g, " ");
}

function pageForOffset(text: string, offset: number): number | null {
    const before = text.slice(0, offset);
    const matches = before.match(/\[Page\s+(\d+)\]/g);
    const last = matches?.[matches.length - 1];
    if (!last) return null;
    const n = Number.parseInt(last.match(/\d+/)?.[0] ?? "", 10);
    return Number.isFinite(n) ? n : null;
}

function findMatches(
    text: string,
    query: string,
    label: string,
    capRemaining: number,
): Match[] {
    const { norm, origIdx } = normalizeWithMap(text);
    const needle = normalizeNeedle(query);
    if (!needle) return [];

    const matches: Match[] = [];
    let from = 0;
    let occurrence = 0;
    while (from <= norm.length - needle.length && matches.length < capRemaining) {
        const pos = norm.indexOf(needle, from);
        if (pos < 0) break;
        const endNorm = pos + needle.length;
        const origStart = origIdx[pos] ?? 0;
        const origEnd =
            endNorm - 1 < origIdx.length
                ? (origIdx[endNorm - 1] ?? text.length - 1) + 1
                : text.length;
        const ctxStart = Math.max(0, origStart - 90);
        const ctxEnd = Math.min(text.length, origEnd + 90);
        matches.push({
            quote: text.slice(origStart, origEnd),
            context:
                (ctxStart > 0 ? "..." : "") +
                text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
                (ctxEnd < text.length ? "..." : ""),
            label,
            occurrence_index: occurrence,
            page: pageForOffset(text, origStart),
        });
        occurrence++;
        from = pos + Math.max(1, needle.length);
    }
    return matches;
}

function groupCounts(highlights: HighlightAnchor[]): { label: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const h of highlights) counts.set(h.label, (counts.get(h.label) ?? 0) + 1);
    return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

function serializeRow(row: Record<string, unknown>): HighlightAnchor {
    return {
        id: String(row.id),
        document_id: String(row.document_id),
        version_id:
            typeof row.version_id === "string" ? row.version_id : null,
        quote: String(row.quote ?? ""),
        context: String(row.context ?? ""),
        label: String(row.label ?? "Highlight"),
        color: "yellow",
        occurrence_index:
            typeof row.occurrence_index === "number"
                ? row.occurrence_index
                : Number(row.occurrence_index ?? 0),
        page:
            typeof row.page === "number"
                ? row.page
                : row.page
                  ? Number(row.page)
                  : null,
        status:
            row.status === "removed" || row.status === "applied"
                ? row.status
                : "kept",
    };
}

function anchorsFromMatches(
    matches: Match[],
    documentId: string,
    versionId: string | null,
): HighlightAnchor[] {
    return matches.map((match) => ({
        id: crypto.randomUUID(),
        document_id: documentId,
        version_id: versionId,
        quote: match.quote,
        context: match.context,
        label: match.label,
        color: "yellow",
        occurrence_index: match.occurrence_index,
        page: match.page,
        status: "kept",
    }));
}

function createEphemeralHighlightSet(params: {
    userId: string;
    documentId: string;
    versionId: string | null;
    versionNumber: number | null;
    filename: string;
    title: string;
    matches: Match[];
    failed: HighlightSetResult["failed_matches"];
    truncated: boolean;
}): HighlightSetResult {
    const highlightSetId = `ephemeral-${crypto.randomUUID()}`;
    const highlights = anchorsFromMatches(
        params.matches,
        params.documentId,
        params.versionId,
    );
    ephemeralHighlightSets.set(highlightSetId, {
        userId: params.userId,
        documentId: params.documentId,
        versionId: params.versionId,
        versionNumber: params.versionNumber,
        filename: params.filename,
        title: params.title,
        highlights,
        status: "reviewing",
    });
    return {
        highlight_set_id: highlightSetId,
        document_id: params.documentId,
        version_id: params.versionId,
        version_number: params.versionNumber,
        filename: params.filename,
        title: params.title,
        total: highlights.length,
        groups: groupCounts(highlights),
        highlights,
        failed_matches: params.failed,
        truncated: params.truncated,
    };
}

export async function createHighlightSet(params: {
    db: Db;
    userId: string;
    chatMessageId?: string | null;
    documentId: string;
    filename: string;
    versionId: string | null;
    versionNumber: number | null;
    title?: string | null;
    text: string;
    targets: HighlightTarget[];
}): Promise<HighlightSetResult> {
    const {
        db,
        userId,
        chatMessageId,
        documentId,
        filename,
        versionId,
        versionNumber,
        text,
    } = params;
    const title = params.title?.trim() || "Document highlights";
    const failed: HighlightSetResult["failed_matches"] = [];
    const matches: Match[] = [];
    const cap = 200;

    for (const target of params.targets.slice(0, 25)) {
        if (matches.length >= cap) break;
        const raw = (target.term || target.quote || "").trim();
        const label = (target.label || target.term || target.quote || "Highlight")
            .trim()
            .slice(0, 120);
        if (!raw) {
            failed.push({ label, query: "", reason: "Target has no term or quote." });
            continue;
        }
        const found = findMatches(text, raw, label, cap - matches.length);
        if (found.length === 0) {
            failed.push({
                label,
                query: raw,
                reason: "No validated quote match found in the document.",
            });
            continue;
        }
        matches.push(...found);
    }

    const { data: setRow, error: setErr } = await db
        .from("document_highlight_sets")
        .insert({
            document_id: documentId,
            version_id: versionId,
            user_id: userId,
            chat_message_id: chatMessageId ?? null,
            title,
            query: params.targets
                .map((t) => t.term || t.quote)
                .filter(Boolean)
                .join("; ")
                .slice(0, 1000),
            status: "reviewing",
        })
        .select("id")
        .single();
    if (
        setErr &&
        isMissingHighlightSchema(setErr) &&
        allowEphemeralHighlightFallback()
    ) {
        return createEphemeralHighlightSet({
            userId,
            documentId,
            versionId,
            versionNumber,
            filename,
            title,
            matches,
            failed,
            truncated: matches.length >= cap,
        });
    }
    if (setErr || !setRow) throw setErr ?? new Error("Failed to create highlight set");

    const rows = matches.map((match) => ({
        set_id: setRow.id,
        document_id: documentId,
        version_id: versionId,
        quote: match.quote,
        context: match.context,
        label: match.label,
        color: "yellow",
        occurrence_index: match.occurrence_index,
        page: match.page,
        status: "kept",
    }));

    let highlights: HighlightAnchor[] = [];
    if (rows.length) {
        const { data, error } = await db
            .from("document_highlights")
            .insert(rows)
            .select(
                "id, document_id, version_id, quote, context, label, color, occurrence_index, page, status",
            );
        if (
            error &&
            isMissingHighlightSchema(error) &&
            allowEphemeralHighlightFallback()
        ) {
            return createEphemeralHighlightSet({
                userId,
                documentId,
                versionId,
                versionNumber,
                filename,
                title,
                matches,
                failed,
                truncated: matches.length >= cap,
            });
        }
        if (error) throw error;
        highlights = ((data ?? []) as Record<string, unknown>[]).map(serializeRow);
    }

    return {
        highlight_set_id: String(setRow.id),
        document_id: documentId,
        version_id: versionId,
        version_number: versionNumber,
        filename,
        title,
        total: highlights.length,
        groups: groupCounts(highlights),
        highlights,
        failed_matches: failed,
        truncated: matches.length >= cap,
    };
}

export async function updateHighlightStatus(params: {
    db: Db;
    userId: string;
    documentId: string;
    setId: string;
    highlightId: string;
    status: "kept" | "removed";
}): Promise<HighlightAnchor> {
    const ephemeral = ephemeralHighlightSets.get(params.setId);
    if (ephemeral) {
        if (
            ephemeral.userId !== params.userId ||
            ephemeral.documentId !== params.documentId
        ) {
            throw new Error("Highlight set not found.");
        }
        const highlight = ephemeral.highlights.find(
            (item) => item.id === params.highlightId,
        );
        if (!highlight) throw new Error("Highlight not found.");
        highlight.status = params.status;
        return { ...highlight };
    }

    const { data: setRow } = await params.db
        .from("document_highlight_sets")
        .select("id, user_id")
        .eq("id", params.setId)
        .eq("document_id", params.documentId)
        .single();
    if (!setRow || setRow.user_id !== params.userId) {
        throw new Error("Highlight set not found.");
    }
    const { data, error } = await params.db
        .from("document_highlights")
        .update({ status: params.status })
        .eq("id", params.highlightId)
        .eq("set_id", params.setId)
        .eq("document_id", params.documentId)
        .select(
            "id, document_id, version_id, quote, context, label, color, occurrence_index, page, status",
        )
        .single();
    if (error || !data) throw error ?? new Error("Highlight not found.");
    return serializeRow(data as Record<string, unknown>);
}

export async function applyHighlightSetToDocx(params: {
    db: Db;
    userId: string;
    documentId: string;
    setId: string;
    fallbackHighlights?: HighlightApplyFallbackAnchor[];
    operationId?: string | null;
}): Promise<{
    version_id: string;
    version_number: number;
    download_url: string;
    applied_count: number;
    applied_highlight_ids: string[];
    errors: { quote: string; occurrence_index: number; reason: string }[];
}> {
    const { db, userId, documentId, setId } = params;
    const { data: doc } = await db
        .from("documents")
        .select("id, filename, file_type")
        .eq("id", documentId)
        .single();
    if (!doc) throw new Error("Document not found.");
    if (doc.file_type !== "docx" && doc.file_type !== "doc") {
        throw new Error("Only DOCX documents can be exported with native highlights.");
    }

    const active = await loadActiveVersion(documentId, db);
    if (!active) throw new Error("No active document version found.");

    const ephemeral = ephemeralHighlightSets.get(setId);
    const fallback = normalizeHighlightApplyFallbackRows(
        params.fallbackHighlights,
    );
    let rows: HighlightApplyRow[];
    let rowSource: "ephemeral" | "durable" | "fallback";
    if (ephemeral) {
        if (ephemeral.userId !== userId || ephemeral.documentId !== documentId) {
            throw new Error("Highlight set not found.");
        }
        rows = ephemeral.highlights
            .filter((highlight) => highlight.status !== "removed")
            .map((highlight) => ({
                id: highlight.id,
                quote: highlight.quote,
                occurrence_index: highlight.occurrence_index,
            }));
        rowSource = "ephemeral";
    } else if (!isDurableHighlightSetId(setId)) {
        if (!fallback.length) throw new Error("Highlight set not found.");
        rows = fallback;
        rowSource = "fallback";
    } else {
        const { data: setRow, error: setErr } = await db
            .from("document_highlight_sets")
            .select("id, user_id")
            .eq("id", setId)
            .eq("document_id", documentId)
            .maybeSingle();
        if (setErr && isMissingHighlightSchema(setErr) && fallback.length) {
            rows = fallback;
            rowSource = "fallback";
        } else if (setErr) {
            throw setErr;
        } else if (!setRow || setRow.user_id !== userId) {
            if (!fallback.length) throw new Error("Highlight set not found.");
            rows = fallback;
            rowSource = "fallback";
        } else {
            const { data: highlights, error: highlightsErr } = await db
                .from("document_highlights")
                .select("id, quote, occurrence_index")
                .eq("set_id", setId)
                .eq("document_id", documentId)
                .in("status", ["kept", "applied"])
                .order("created_at", { ascending: true });
            if (highlightsErr && isMissingHighlightSchema(highlightsErr) && fallback.length) {
                rows = fallback;
                rowSource = "fallback";
            } else if (highlightsErr) {
                throw highlightsErr;
            } else {
                rows = (highlights ?? []) as {
                    id: string;
                    quote: string;
                    occurrence_index: number;
                }[];
                rowSource = "durable";
            }
        }
    }
    if (rows.length === 0) throw new Error("No kept highlights to apply.");

    const raw = await downloadFile(active.storage_path);
    if (!raw) throw new Error("Could not load document bytes.");
    const reflowed = await reflowFramedDocx(Buffer.from(raw));
    const result = await applyDocxHighlights(
        reflowed.bytes,
        rows.map((r) => ({
            quote: r.quote,
            occurrence_index: r.occurrence_index,
        })),
    );
    if (result.applied.length === 0) {
        throw new Error("No highlights could be applied to the DOCX.");
    }
    const qaReport = await verifyDerivedArtifact({
        bytes: result.bytes,
        fileType: "docx",
    });
    if (!qaReport) throw new Error("Highlight layout QA returned no result.");

    const slug = crypto.randomUUID().replace(/-/g, "");
    const newPath = `documents/${userId}/${documentId}/highlights/${slug}.docx`;
    const ab = result.bytes.buffer.slice(
        result.bytes.byteOffset,
        result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer;
    await uploadFile(
        newPath,
        ab,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const { data: maxRow } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", [
            "upload",
            "user_upload",
            "assistant_edit",
            "assistant_highlight",
            "assistant_undo",
            "generated",
            "authored",
            "clean_final",
        ])
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
    const nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;

    const versionInsert: Record<string, unknown> = {
        document_id: documentId,
        storage_path: newPath,
        source: "assistant_highlight",
        version_number: nextVersionNumber,
        display_name:
            (active.display_name as string | null) ?? (doc.filename as string),
        parent_version_id: active.id,
        created_by_operation_id: params.operationId ?? null,
        content_status: "ready",
        extraction_quality: {
            highlight_count: result.applied.length,
            operation_id: params.operationId ?? null,
        },
        metadata: {
            operation_id: params.operationId ?? null,
            source_version_id: active.id,
            inverse_operation: "restore_source_version",
            ...reflowed.metadata,
            layout_qa: {
                status: "passed",
                schema_version: qaReport.schema_version,
                checked_at: qaReport.checked_at,
            },
        },
        ...layoutQaVersionValues(qaReport),
    };
    const versionRow = await insertAssistantHighlightVersion({
        db,
        insert: versionInsert,
    });

    const { error: activateError } = await db
        .from("documents")
        .update({ current_version_id: versionRow.id })
        .eq("id", documentId);
    if (activateError) {
        throw new Error(
            `Verified highlighted version could not be activated. ${describeSupabaseError(activateError)}`,
        );
    }

    const appliedIds = rows
        .filter((row) =>
            result.applied.some(
                (a) =>
                    a.quote === row.quote &&
                    a.occurrence_index === row.occurrence_index,
            ),
        )
        .map((row) => row.id);

    if (ephemeral) {
        for (const highlight of ephemeral.highlights) {
            if (appliedIds.includes(highlight.id)) {
                highlight.status = "applied";
                highlight.version_id = String(versionRow.id);
            }
        }
        ephemeral.status = "applied";
        ephemeral.versionId = String(versionRow.id);
        ephemeral.versionNumber = nextVersionNumber;
    } else if (rowSource === "durable") {
        await db
            .from("document_highlights")
            .update({ status: "applied", version_id: versionRow.id })
            .eq("set_id", setId)
            .eq("document_id", documentId)
            .in("id", appliedIds);
        await db
            .from("document_highlight_sets")
            .update({ status: "applied" })
            .eq("id", setId);
    }

    return {
        version_id: String(versionRow.id),
        version_number: nextVersionNumber,
        download_url: buildDownloadUrl(newPath, doc.filename as string),
        applied_count: result.applied.length,
        applied_highlight_ids: appliedIds,
        errors: result.errors,
    };
}

export async function removeHighlightsFromDocx(params: {
    db: Db;
    userId: string;
    documentId: string;
    targets?: HighlightTarget[];
    all?: boolean;
    operationId?: string | null;
}): Promise<{
    version_id: string;
    version_number: number | null;
    storage_path: string;
    download_url: string;
    removed_count: number;
    errors: { quote: string; occurrence_index: number; reason: string }[];
}> {
    const { db, userId, documentId } = params;
    const { data: doc } = await db
        .from("documents")
        .select("id, filename, file_type")
        .eq("id", documentId)
        .single();
    if (!doc) throw new Error("Document not found.");
    if (doc.file_type !== "docx" && doc.file_type !== "doc") {
        throw new Error("Only DOCX documents can have native highlights removed.");
    }

    const active = await loadActiveVersion(documentId, db);
    if (!active) throw new Error("No active document version found.");

    const raw = await downloadFile(active.storage_path);
    if (!raw) throw new Error("Could not load document bytes.");
    const reflowed = await reflowFramedDocx(Buffer.from(raw));

    const inputs = (params.targets ?? [])
        .map((target) => (target.term || target.quote || "").trim())
        .filter(Boolean)
        .slice(0, 25)
        .map((quote) => ({
            quote,
            occurrence_index: -1,
        }));

    const removeAll = !!params.all || inputs.length === 0;
    const result = await removeDocxHighlights(reflowed.bytes, inputs, {
        all: removeAll,
    });
    if (result.removed_count === 0) {
        if (removeAll) {
            return {
                version_id: String(active.id),
                version_number:
                    typeof active.version_number === "number"
                        ? active.version_number
                        : null,
                storage_path: active.storage_path,
                download_url: buildDownloadUrl(
                    active.storage_path,
                    doc.filename as string,
                ),
                removed_count: 0,
                errors: result.errors,
            };
        }
        throw new Error("No matching DOCX highlights were found to remove.");
    }
    const qaReport = await verifyDerivedArtifact({
        bytes: result.bytes,
        fileType: "docx",
    });
    if (!qaReport) throw new Error("Highlight-removal layout QA returned no result.");

    const slug = crypto.randomUUID().replace(/-/g, "");
    const newPath = `documents/${userId}/${documentId}/highlights/${slug}-clean.docx`;
    const ab = result.bytes.buffer.slice(
        result.bytes.byteOffset,
        result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer;
    await uploadFile(
        newPath,
        ab,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const { data: maxRow } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", [
            "upload",
            "user_upload",
            "assistant_edit",
            "assistant_highlight",
            "assistant_undo",
            "generated",
            "authored",
            "clean_final",
        ])
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
    const nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;

    const versionInsert: Record<string, unknown> = {
        document_id: documentId,
        storage_path: newPath,
        source: "assistant_highlight",
        version_number: nextVersionNumber,
        display_name:
            (active.display_name as string | null) ?? (doc.filename as string),
        parent_version_id: active.id,
        created_by_operation_id: params.operationId ?? null,
        content_status: "ready",
        extraction_quality: {
            removed_highlight_count: result.removed_count,
            operation_id: params.operationId ?? null,
        },
        metadata: {
            operation_id: params.operationId ?? null,
            source_version_id: active.id,
            inverse_operation: "restore_source_version",
            ...reflowed.metadata,
            layout_qa: {
                status: "passed",
                schema_version: qaReport.schema_version,
                checked_at: qaReport.checked_at,
            },
        },
        ...layoutQaVersionValues(qaReport),
    };
    const versionRow = await insertAssistantHighlightVersion({
        db,
        insert: versionInsert,
    });

    const { error: activateError } = await db
        .from("documents")
        .update({ current_version_id: versionRow.id })
        .eq("id", documentId);
    if (activateError) {
        throw new Error(
            `Verified highlight-removal version could not be activated. ${describeSupabaseError(activateError)}`,
        );
    }

    return {
        version_id: String(versionRow.id),
        version_number: nextVersionNumber,
        storage_path: newPath,
        download_url: buildDownloadUrl(newPath, doc.filename as string),
        removed_count: result.removed_count,
        errors: result.errors,
    };
}
