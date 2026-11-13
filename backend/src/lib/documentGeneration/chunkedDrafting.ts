import type { DocxSection } from "../docxAssembly";
import type { LlmFinishReason } from "../llm";

export const DRAFT_CHECKPOINT_SCHEMA_VERSION = 2 as const;
export const DEFAULT_MAX_SECTION_CHUNKS = 64;

export interface ActiveSectionCheckpoint extends DocxSection {
    index: number;
    heading: string;
    content: string;
    chunk_count: number;
}

export interface DraftCheckpoint {
    schema_version: typeof DRAFT_CHECKPOINT_SCHEMA_VERSION;
    sections: DocxSection[];
    active_section: ActiveSectionCheckpoint | null;
}

export interface DraftChunkResult {
    text: string;
    finishReason: LlmFinishReason;
}

function normalizeTable(value: unknown) {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const headers = Array.isArray(raw.headers)
        ? raw.headers
              .map((header) =>
                  typeof header === "string" ? header.trim() : "",
              )
              .filter(Boolean)
              .slice(0, 12)
        : [];
    if (headers.length < 2 || !Array.isArray(raw.rows)) return null;
    return {
        headers,
        rows: raw.rows
            .filter((row): row is unknown[] => Array.isArray(row))
            .slice(0, 250)
            .map((row) =>
                headers.map((_, index) =>
                    typeof row[index] === "string" ? row[index] : "",
                ),
            ),
    };
}

export function normalizeGeneratedSection(value: unknown): DocxSection | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.heading !== "string" || typeof row.content !== "string") {
        return null;
    }
    const table = normalizeTable(row.table);
    if (row.content.trim().length <= 20 && !table?.rows.length) return null;
    return {
        heading: row.heading,
        content: row.content,
        level:
            typeof row.level === "number"
                ? Math.max(1, Math.min(3, row.level))
                : 1,
        pageBreak: row.pageBreak === true,
        ...(table ? { table } : {}),
    };
}

export function normalizeGeneratedSections(
    value: unknown,
): DocxSection[] | null {
    const rows = (value as { sections?: unknown })?.sections;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const sections = rows.map(normalizeGeneratedSection);
    return sections.every((section): section is DocxSection => !!section)
        ? sections
        : null;
}

function normalizeActiveSection(
    value: unknown,
): ActiveSectionCheckpoint | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (
        !Number.isInteger(row.index) ||
        Number(row.index) < 0 ||
        typeof row.heading !== "string" ||
        typeof row.content !== "string" ||
        !Number.isInteger(row.chunk_count) ||
        Number(row.chunk_count) < 0
    ) {
        return null;
    }
    const table = normalizeTable(row.table);
    return {
        index: Number(row.index),
        heading: row.heading,
        level:
            typeof row.level === "number"
                ? Math.max(1, Math.min(3, row.level))
                : 1,
        content: row.content,
        pageBreak: row.pageBreak === true,
        chunk_count: Number(row.chunk_count),
        ...(table ? { table } : {}),
    };
}

/**
 * Read both legacy arrays and the v2 restart-safe checkpoint envelope. A
 * partial checkpoint is only accepted when it is an exact prefix of the
 * current outline; this prevents stale draft content from being assembled
 * against a newly planned structure.
 */
export function readDraftCheckpoint(
    value: unknown,
    outline?: { sections: { heading: string }[] } | null,
): DraftCheckpoint {
    const envelope =
        value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    const rows = Array.isArray(value)
        ? value
        : Array.isArray(envelope?.sections)
          ? envelope.sections
          : [];
    const sections: DocxSection[] = [];
    for (const row of rows) {
        const normalized = normalizeGeneratedSection(row);
        if (!normalized) break;
        sections.push(normalized);
    }

    const prefixMatches =
        !outline ||
        (sections.length <= outline.sections.length &&
            sections.every(
                (section, index) =>
                    section.heading?.trim() ===
                    outline.sections[index]?.heading.trim(),
            ));
    if (!prefixMatches) {
        return {
            schema_version: DRAFT_CHECKPOINT_SCHEMA_VERSION,
            sections: [],
            active_section: null,
        };
    }

    const active = normalizeActiveSection(envelope?.active_section);
    const activeMatches =
        !!active &&
        active.index === sections.length &&
        (!outline ||
            (active.index < outline.sections.length &&
                active.heading.trim() ===
                    outline.sections[active.index]?.heading.trim()));
    return {
        schema_version: DRAFT_CHECKPOINT_SCHEMA_VERSION,
        sections,
        active_section: activeMatches ? active : null,
    };
}

export function serializeDraftCheckpoint(
    sections: DocxSection[],
    activeSection: ActiveSectionCheckpoint | null,
): DraftCheckpoint {
    return {
        schema_version: DRAFT_CHECKPOINT_SCHEMA_VERSION,
        sections,
        active_section: activeSection,
    };
}

export function countWords(value: string) {
    return value.trim() ? value.trim().split(/\s+/).length : 0;
}

/** Extract only an explicit requested output length, never page citations. */
export function requestedDocumentWordTarget(value: string): number | null {
    const wordMatch =
        /\b(?:draft|prepare|produce|write|create|generate|provide|target(?:ing)?|length(?:\s+of)?|approximately|about|at\s+least)\D{0,24}([1-9]\d{0,6}(?:,\d{3})*)\s*[- ]?words?\b/i.exec(
            value,
        ) ??
        /\b([1-9]\d{2,}(?:,\d{3})*)\s*[- ]?word\s+(?:draft|document|memorandum|brief|agreement|packet)\b/i.exec(
            value,
        );
    if (wordMatch) {
        const words = Number(wordMatch[1].replace(/,/g, ""));
        if (Number.isFinite(words)) return Math.min(words, 2_000_000);
    }
    const pageMatch =
        /\b(?:draft|prepare|produce|write|create|generate|provide|target(?:ing)?|length(?:\s+of)?|approximately|about|at\s+least)\D{0,24}([1-9]\d{0,3})\s*[- ]?pages?\b/i.exec(
            value,
        ) ??
        /\b([1-9]\d{1,3})\s*[- ]?page\s+(?:draft|document|memorandum|brief|agreement|packet)\b/i.exec(
            value,
        );
    if (!pageMatch) return null;
    const pages = Number(pageMatch[1]);
    return Number.isFinite(pages) ? Math.min(pages * 450, 2_000_000) : null;
}

export function targetWordsForSection(
    totalWords: number | null,
    sectionCount: number,
) {
    return totalWords && sectionCount > 0
        ? Math.max(250, Math.ceil(totalWords / sectionCount))
        : null;
}

export function appendContinuation(existing: string, continuation: string) {
    const next = continuation.trim();
    if (!next) return existing;
    if (!existing.trim()) return next;
    const maxOverlap = Math.min(4_000, existing.length, next.length);
    for (let size = maxOverlap; size >= 40; size -= 1) {
        if (existing.slice(-size) === next.slice(0, size)) {
            return `${existing}${next.slice(size)}`.trim();
        }
    }
    return `${existing.trimEnd()}\n\n${next}`;
}

export class DocumentSectionChunkLimitError extends Error {
    readonly code = "DOCUMENT_SECTION_CHUNK_LIMIT";
    readonly retryable = true;

    constructor(maxChunks: number) {
        super(
            `A single document section exceeded ${maxChunks} saved drafting chunks.`,
        );
        this.name = "DocumentSectionChunkLimitError";
    }
}

export async function continueSectionInChunks(params: {
    existingContent?: string;
    existingChunkCount?: number;
    targetWords?: number | null;
    maxChunks?: number;
    isCancelled: () => Promise<boolean>;
    cancelledError?: () => Error;
    shouldRetryError?: (error: unknown) => boolean;
    onRetry?: (attempt: number) => Promise<void>;
    runChunk: (input: {
        chunkIndex: number;
        previousTail: string;
        currentWords: number;
        targetWords: number | null;
        onDelta: (delta: string) => void;
    }) => Promise<DraftChunkResult>;
    onCheckpoint: (content: string, chunkCount: number) => Promise<void>;
}) {
    let content = params.existingContent?.trim() ?? "";
    let chunkCount = Math.max(0, params.existingChunkCount ?? 0);
    const maxChunks = Math.max(
        4,
        Math.min(256, params.maxChunks ?? DEFAULT_MAX_SECTION_CHUNKS),
    );
    let emptyAttempts = 0;
    let transientAttempts = 0;

    while (chunkCount < maxChunks) {
        if (await params.isCancelled()) {
            throw (
                params.cancelledError?.() ??
                new Error("[cancelled] Document generation was cancelled.")
            );
        }
        let streamed = "";
        let result: DraftChunkResult;
        try {
            result = await params.runChunk({
                chunkIndex: chunkCount,
                previousTail: content.slice(-12_000),
                currentWords: countWords(content),
                targetWords: params.targetWords ?? null,
                onDelta: (delta) => {
                    streamed += delta;
                },
            });
        } catch (error) {
            if (streamed.trim()) {
                content = appendContinuation(content, streamed);
                chunkCount += 1;
                await params.onCheckpoint(content, chunkCount);
            }
            if (
                params.shouldRetryError?.(error) &&
                transientAttempts < 2 &&
                chunkCount < maxChunks
            ) {
                transientAttempts += 1;
                await params.onRetry?.(transientAttempts);
                await new Promise((resolve) =>
                    setTimeout(
                        resolve,
                        350 * 2 ** (transientAttempts - 1) +
                            Math.random() * 250,
                    ),
                );
                continue;
            }
            throw error;
        }

        const generated = result.text.trim() || streamed.trim();
        if (!generated) {
            emptyAttempts += 1;
            if (emptyAttempts >= 3) {
                throw new Error(
                    "Document drafting returned three empty continuation chunks.",
                );
            }
            continue;
        }
        emptyAttempts = 0;
        transientAttempts = 0;
        content = appendContinuation(content, generated);
        chunkCount += 1;
        await params.onCheckpoint(content, chunkCount);

        if (result.finishReason === "refused") {
            throw new Error(
                "[refused] The model refused the document section.",
            );
        }
        if (result.finishReason === "cancelled") {
            throw (
                params.cancelledError?.() ??
                new Error("[cancelled] Document generation was cancelled.")
            );
        }
        const targetSatisfied =
            !params.targetWords ||
            countWords(content) >= Math.floor(params.targetWords * 0.9);
        if (result.finishReason === "completed" && targetSatisfied) {
            return { content, chunkCount };
        }
        // max_output and context_limit are usable partial responses. A fresh,
        // bounded request continues from the saved tail without growing one
        // conversation until it exhausts the model context window.
    }

    throw new DocumentSectionChunkLimitError(maxChunks);
}
