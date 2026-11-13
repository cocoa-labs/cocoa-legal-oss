import { countWords, requestedDocumentWordTarget } from "./chunkedDrafting";
import {
    normalizeDocxWhitespaceEntities,
    type DocxSection,
} from "../docxAssembly";

export interface DraftBudget {
    targetWords: number;
    maxWords: number;
    source: "ordinary" | "explicit_length" | "explicit_outline";
}
export const MAX_ORDINARY_DRAFT_UNITS = 12;
export const MAX_EXPLICIT_DRAFT_UNITS = 80;
export const MAX_EXPLICIT_WORD_TARGET = 100_000;
export const MAX_EXPLICIT_WORDS_WITH_MARGIN = 115_000;

export class DocumentDraftSizingError extends Error {
    readonly code = "DOCUMENT_DRAFT_SIZE_LIMIT";
    constructor(message?: string) {
        super(
            message ??
                "The draft exceeded its document-wide size limit after one sizing correction. Saved content is retained; request a shorter scope or an explicit longer document before retrying.",
        );
        this.name = "DocumentDraftSizingError";
    }
}

function ordinaryDraftBudget(documentType: string): DraftBudget {
    const type = documentType.trim();
    if (
        /multi[- ]policy|policy package|governance policies|bylaws?|agreements?|contracts?/i.test(
            type,
        )
    ) {
        return { targetWords: 15_000, maxWords: 30_000, source: "ordinary" };
    }
    if (/memorand(?:um|a)|memos?|narratives?|roadmaps?/i.test(type)) {
        return { targetWords: 10_000, maxWords: 20_000, source: "ordinary" };
    }
    if (/polic(?:y|ies)|consents?|resolutions?/i.test(type)) {
        return { targetWords: 6_000, maxWords: 15_000, source: "ordinary" };
    }
    if (/filings?|articles?(?: of incorporation)?|incorporation/i.test(type)) {
        return { targetWords: 3_000, maxWords: 10_000, source: "ordinary" };
    }
    return { targetWords: 8_000, maxWords: 20_000, source: "ordinary" };
}

export function planDraftBudget(
    documentType: string,
    instructions: string,
    explicitSections = 0,
): DraftBudget {
    const requested = requestedDocumentWordTarget(instructions);
    if (requested) {
        if (requested > MAX_EXPLICIT_WORD_TARGET) {
            throw new DocumentDraftSizingError(
                `The requested length is ${requested.toLocaleString("en-US")} words. A single document can target up to ${MAX_EXPLICIT_WORD_TARGET.toLocaleString("en-US")} words; split the request into separate volumes or reduce the requested length.`,
            );
        }
        return {
            targetWords: requested,
            maxWords: Math.ceil(requested * 1.15),
            source: "explicit_length",
        };
    }
    if (
        /\b(long[- ]form|book[- ]length|treatise|monograph)\b/i.test(
            instructions,
        )
    )
        return {
            targetWords: 30_000,
            maxWords: 34_500,
            source: "explicit_length",
        };
    const ordinary = ordinaryDraftBudget(documentType);
    if (explicitSections > MAX_EXPLICIT_DRAFT_UNITS) {
        throw new DocumentDraftSizingError(
            `The supplied outline has ${explicitSections} drafting units. Explicit long-form work supports up to ${MAX_EXPLICIT_DRAFT_UNITS}; combine related clauses or split the request into separate documents.`,
        );
    }
    if (explicitSections > MAX_ORDINARY_DRAFT_UNITS) {
        const targetWords = Math.min(
            30_000,
            Math.max(ordinary.targetWords, explicitSections * 350),
        );
        return {
            targetWords,
            maxWords: Math.min(
                30_000,
                Math.max(
                    ordinary.maxWords,
                    Math.ceil(targetWords * 1.15),
                    explicitSections * 500,
                ),
            ),
            source: "explicit_outline",
        };
    }
    return ordinary;
}
export function parseDraftBudget(value: unknown): DraftBudget | undefined {
    if (!value || typeof value !== "object") return undefined;
    const row = value as DraftBudget;
    if (
        !["ordinary", "explicit_length", "explicit_outline"].includes(
            row.source,
        ) ||
        !Number.isFinite(row.targetWords) ||
        !Number.isFinite(row.maxWords) ||
        row.targetWords <= 0 ||
        row.maxWords < row.targetWords
    )
        return undefined;
    if (row.source === "ordinary" && row.maxWords > 30_000) return undefined;
    if (
        row.source === "explicit_length" &&
        (row.targetWords > MAX_EXPLICIT_WORD_TARGET ||
            row.maxWords > MAX_EXPLICIT_WORDS_WITH_MARGIN)
    )
        return undefined;
    if (row.source === "explicit_outline" && row.maxWords > 30_000)
        return undefined;
    return {
        targetWords: row.targetWords,
        maxWords: row.maxWords,
        source: row.source,
    };
}
export function draftedWordCount(sections: DocxSection[]) {
    return sections.reduce(
        (total, section) =>
            total +
            countWords(
                normalizeDocxWhitespaceEntities(
                    [
                        section.heading,
                        section.content,
                        ...(section.table?.headers ?? []),
                        ...(section.table?.rows.flat() ?? []),
                    ]
                        .filter(Boolean)
                        .join(" "),
                ),
            ),
        0,
    );
}
export async function enforceDraftBudget(
    sections: DocxSection[],
    budget: DraftBudget | undefined,
    correct: (
        sections: DocxSection[],
        budget: DraftBudget,
    ) => Promise<DocxSection[]>,
) {
    if (!budget || draftedWordCount(sections) <= budget.maxWords)
        return sections;
    const corrected = await correct(sections, budget);
    if (
        !corrected.length ||
        corrected.length !== sections.length ||
        corrected.some(
            (section, i) => section.heading !== sections[i].heading,
        ) ||
        draftedWordCount(corrected) > budget.maxWords
    )
        throw new DocumentDraftSizingError();
    return corrected;
}
