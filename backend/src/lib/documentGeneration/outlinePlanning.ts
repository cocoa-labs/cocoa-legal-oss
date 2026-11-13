import {
    planDraftBudget,
    parseDraftBudget,
    DocumentDraftSizingError,
    MAX_EXPLICIT_DRAFT_UNITS,
    MAX_ORDINARY_DRAFT_UNITS,
    type DraftBudget,
} from "./draftBudget";
export type DraftOutline = {
    budget?: DraftBudget;
    sections: {
        heading: string;
        level: number;
        instructions: string;
    }[];
};

export type OutlinePlanningStrategy =
    | "explicit_instructions"
    | "model"
    | "deterministic_fallback";

export type OutlineResolution = {
    outline: DraftOutline;
    strategy: OutlinePlanningStrategy;
    recoveredError: unknown | null;
};

type ResolveOutlineParams = {
    title: string;
    documentType: string;
    draftingInstructions: string;
    /** Server-captured user request; model-authored instructions cannot opt into long form. */
    explicitInstructions?: string;
    generate: (sizingCorrection?: boolean) => Promise<unknown>;
    shouldRethrow?: (error: unknown) => boolean;
};

const EXPLICIT_SECTION_CUE = /\b(?:structure|sections?|outline)\s*:/i;
const PARENTHETICAL_SECTION = /(?:^|[;\n])\s*\(([1-9]\d{0,2}|[A-Z])\)\s+/g;
const LINE_SECTION = /(?:^|\n)\s*(\d{1,3}|[A-Z])[.)]\s+/g;
const MAX_EXPLICIT_SECTIONS = MAX_EXPLICIT_DRAFT_UNITS;
const MAX_SAVED_SECTIONS = 200;

function cleanHeading(value: string) {
    const normalized = value
        .replace(/^[\s'"“”]+|[\s'"“”]+$/g, "")
        .replace(/\s+/g, " ")
        .replace(/[.;,:-]+$/g, "")
        .trim();
    if (!normalized) return "Document Section";
    const words = normalized.split(" ");
    if (normalized.length <= 120 && words.length <= 16) return normalized;
    return words
        .slice(0, 12)
        .join(" ")
        .replace(/[.;,:-]+$/g, "");
}

function headingFromInstructions(value: string) {
    const firstClause = value.split(/\s+(?:—|–|-|:)\s+/, 1)[0]?.trim() ?? "";
    return cleanHeading(firstClause);
}

function findMatches(value: string, pattern: RegExp) {
    const matches: RegExpExecArray[] = [];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
        matches.push(match);
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    return matches;
}

function hasSequentialLabels(matches: RegExpExecArray[]) {
    const labels = matches.map((match) => match[1] ?? "");
    const numeric = labels.every((label) => /^\d+$/.test(label));
    const alphabetic = labels.every((label) => /^[A-Z]$/.test(label));
    if (!numeric && !alphabetic) return false;
    const values = numeric
        ? labels.map(Number)
        : labels.map((label) => label.charCodeAt(0) - 64);
    return values.every((value, index) => value === index + 1);
}

function outlineFromMatches(
    region: string,
    matches: RegExpExecArray[],
): DraftOutline | null {
    if (matches.length < 2 || !hasSequentialLabels(matches)) {
        return null;
    }
    if (matches.length > MAX_EXPLICIT_SECTIONS) {
        throw new DocumentDraftSizingError(
            `The supplied outline has ${matches.length} drafting units. Explicit long-form work supports up to ${MAX_EXPLICIT_SECTIONS}; combine related clauses or split the request into separate documents.`,
        );
    }
    const sections: DraftOutline["sections"] = [];
    for (const [index, match] of matches.entries()) {
        const next = matches[index + 1];
        const instructions = region
            .slice(match.index + match[0].length, next?.index ?? region.length)
            .trim()
            .replace(/^;+|;+$/g, "")
            .trim();
        if (!instructions) return null;
        sections.push({
            heading: headingFromInstructions(instructions),
            level: 1,
            instructions,
        });
    }

    // A separately requested final summary deserves its own drafting pass. A
    // normal "close with" instruction stays attached to the last section.
    const last = sections.at(-1);
    if (last) {
        const finish = /\bFinish with\b[\s\S]*$/i.exec(last.instructions);
        if (finish && finish.index > 0) {
            const closingInstructions = finish[0].trim();
            last.instructions = last.instructions
                .slice(0, finish.index)
                .trim()
                .replace(/[.;,:-]+$/g, "");
            sections.push({
                heading: /at[ -]a[ -]glance/i.test(closingInstructions)
                    ? "At-a-Glance Summary"
                    : "Final Summary",
                level: 1,
                instructions: closingInstructions,
            });
        }
    }
    return sections.every((section) => section.heading && section.instructions)
        ? { sections }
        : null;
}

/**
 * Preserve a section sequence supplied by the user instead of asking a model
 * to re-plan it. Top-level markers must follow the explicit structure cue and
 * a semicolon/newline boundary, so citations such as Reg. 4.14(a)(6) are not
 * mistaken for new sections.
 */
export function extractExplicitOutline(
    draftingInstructions: string,
): DraftOutline | null {
    const cue = EXPLICIT_SECTION_CUE.exec(draftingInstructions);
    if (!cue) return null;
    const region = draftingInstructions.slice(cue.index + cue[0].length).trim();
    if (!region) return null;

    const parenthetical = outlineFromMatches(
        region,
        findMatches(region, PARENTHETICAL_SECTION),
    );
    if (parenthetical) return parenthetical;
    return outlineFromMatches(region, findMatches(region, LINE_SECTION));
}

export function validateSavedOutline(value: unknown): DraftOutline | null {
    const rows = (value as { sections?: unknown })?.sections;
    if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        rows.length > MAX_SAVED_SECTIONS
    ) {
        return null;
    }
    const sections: DraftOutline["sections"] = [];
    for (const row of rows) {
        const candidate = row as Record<string, unknown>;
        if (
            typeof candidate.heading !== "string" ||
            typeof candidate.instructions !== "string" ||
            !candidate.heading.trim() ||
            !candidate.instructions.trim()
        ) {
            return null;
        }
        sections.push({
            heading: cleanHeading(candidate.heading),
            level:
                typeof candidate.level === "number"
                    ? Math.max(1, Math.min(3, candidate.level))
                    : 1,
            instructions: candidate.instructions.trim(),
        });
    }
    return {
        sections,
        ...(parseDraftBudget((value as { budget?: unknown }).budget)
            ? {
                  budget: parseDraftBudget(
                      (value as { budget?: unknown }).budget,
                  ),
              }
            : {}),
    };
}

export function deterministicFallbackOutline(
    documentType: string,
): DraftOutline {
    const checklist = /checklist|application package|filing package/i.test(
        documentType,
    );
    const headings = checklist
        ? [
              "Purpose and Preconditions",
              "Required Filings and Documentation",
              "Owners, Sequence, and Timeline",
              "Validation and Launch Gates",
              "Risks, Exceptions, and Follow-Up",
          ]
        : [
              "Executive Summary",
              "Background and Governing Framework",
              "Analysis and Recommendations",
              "Implementation Plan",
              "Risks and Open Items",
              "Next Steps",
          ];
    return {
        sections: headings.map((heading) => ({
            heading,
            level: 1,
            instructions: `Draft the ${heading.toLowerCase()} portion using the global drafting instructions and pinned source material. Do not invent missing facts.`,
        })),
    };
}

/**
 * Resolve an outline without allowing a planning-only model failure to discard
 * an otherwise draftable document. Refusals can still be rethrown by policy.
 */
export async function resolveDraftOutline(
    params: ResolveOutlineParams,
): Promise<OutlineResolution> {
    const explicitInstructions =
        params.explicitInstructions ?? params.draftingInstructions;
    const explicit = extractExplicitOutline(explicitInstructions);
    const budget = planDraftBudget(
        params.documentType,
        explicitInstructions,
        explicit?.sections.length,
    );
    if (explicit) {
        return {
            outline: { ...explicit, budget },
            strategy: "explicit_instructions",
            recoveredError: null,
        };
    }

    try {
        const maxUnits =
            budget.source === "ordinary"
                ? MAX_ORDINARY_DRAFT_UNITS
                : MAX_EXPLICIT_DRAFT_UNITS;
        const raw = await params.generate();
        let generated = validateSavedOutline(raw);
        const rawSections =
            raw && typeof raw === "object"
                ? (raw as { sections?: unknown }).sections
                : null;
        if (Array.isArray(rawSections) && rawSections.length > maxUnits) {
            generated = validateSavedOutline(await params.generate(true));
            if (!generated || generated.sections.length > maxUnits)
                throw new DocumentDraftSizingError();
        }
        if (generated) {
            return {
                outline: { ...generated, budget },
                strategy: "model",
                recoveredError: null,
            };
        }
        return {
            outline: {
                ...deterministicFallbackOutline(params.documentType),
                budget,
            },
            strategy: "deterministic_fallback",
            recoveredError: new Error(
                `The generated outline for ${params.title} was structurally invalid.`,
            ),
        };
    } catch (error) {
        if (
            error instanceof DocumentDraftSizingError ||
            params.shouldRethrow?.(error)
        )
            throw error;
        return {
            outline: {
                ...deterministicFallbackOutline(params.documentType),
                budget,
            },
            strategy: "deterministic_fallback",
            recoveredError: error,
        };
    }
}
