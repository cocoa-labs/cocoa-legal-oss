// backend/src/lib/legalCapabilities/run.ts
//
// The pure half of an in-chat capability run.
//
// A run turn is an ordinary chat turn that carries a confirmed
// `capability_run`. Two things make it a run: the prompt this module builds
// (the capability's own workflow prompt, plus an output contract generated
// from its `outputSpec`), and the validator this module exposes, which turns
// the model's single `record_capability_result` call into the persisted
// `capability_result` event.
//
// Everything here is pure: no db, no clock and no randomness except through
// the injectable `now` / `uuid` arguments, so the whole contract is testable
// without a stream.
//
// The validator is a TRUST BOUNDARY. Its input is model output, which is
// itself downstream of untrusted document text, so it is written to refuse
// rather than to repair: a wrong capability id, a missing required section, a
// mis-shaped table or an out-of-range score comes back as a tool error the
// model can retry against, never as a half-built card. The single exception is
// a citation naming a document handle this turn never had — that citation is
// DROPPED and the rest of the result stands, because losing one provenance
// link is a smaller harm than throwing away a completed analysis.

import type { DocIndex } from "../chatTools";
import type { DocxSection } from "../docxAssembly";
import type { PlaybookEntry } from "../playbooks";
import { substitute } from "../systemPrompt/substitute";
import { toUnifiedBand, type RiskInput, type UnifiedRiskBand } from "./riskMap";
import type {
    CapabilityOutputSection,
    CapabilitySectionKind,
    LegalCapability,
} from "./types";
import type { CapabilityRunRequest } from "../chatMessages";

/** Everything the tool branch needs to validate and record one run. */
export interface CapabilityRunContext {
    cap: LegalCapability;
    capabilityRun: CapabilityRunRequest;
    escalationTemplate: { subject: string; body: string } | null;
    /**
     * Set by the tool branch once this run has recorded its result. The
     * context is created ONCE per stream and threaded into every tool-call
     * round, so this is the only place a second `record_capability_result`
     * can be seen — the per-invocation accumulator cannot see an earlier
     * round's call. One confirmed run must produce exactly one card; two
     * would show a lawyer two contradictory overall ratings.
     */
    recorded?: boolean;
}

// ---------------------------------------------------------------------------
// Bounds. Every one of these caps model output that lands in a persisted
// event and is replayed into later prompts.
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 4000;
const MAX_TEXT_CHARS = 8000;
const MAX_LIST_ITEMS = 50;
const MAX_ITEM_CHARS = 1000;
const MAX_TABLE_ROWS = 100;
const MAX_CELL_CHARS = 1000;
const MAX_FINDINGS = 50;
const MAX_FINDING_LABEL_CHARS = 200;
const MAX_FINDING_VALUE_CHARS = 4000;
const MAX_QUOTE_CHARS = 500;

/** The only flag vocabulary a finding may use. */
const FLAG_VALUES = ["GREEN", "YELLOW", "ORANGE", "RED", "grey"] as const;
export type CapabilityResultFlag = (typeof FLAG_VALUES)[number];

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export interface CapabilityResultCitation {
    document_id: string;
    filename: string;
    page: number | null;
    quote: string | null;
}

export interface CapabilityResultFinding {
    label: string;
    value_md: string;
    flag: CapabilityResultFlag | null;
    /**
     * The unified band for `flag`, resolved server-side so the card never has
     * to map the flag vocabulary itself (a card-side map read RED as
     * "critical" while `toUnifiedBand` reads it as "high"). Consistent with
     * toUnifiedBand's traffic-light mapping; ORANGE, which that scheme lacks,
     * sits at "high". An unflagged or grey finding has no band.
     */
    band: UnifiedRiskBand | null;
    citation: CapabilityResultCitation | null;
}

/** {@link CapabilityResultFinding.band} for a validated finding flag. */
function bandForFlag(flag: CapabilityResultFlag | null): UnifiedRiskBand | null {
    switch (flag) {
        case "GREEN":
            return "low";
        case "YELLOW":
            return "medium";
        case "ORANGE":
        case "RED":
            return "high";
        default:
            return null;
    }
}

export interface CapabilityResultSection {
    id: string;
    label: string;
    kind: CapabilitySectionKind;
    text_md?: string;
    items?: string[];
    columns?: string[];
    rows?: string[][];
    findings?: CapabilityResultFinding[];
}

export interface CapabilityResultEvent {
    type: "capability_result";
    result_id: string;
    capability_id: string;
    proposal_id: string | null;
    title: string;
    summary_md: string;
    overall: {
        scheme: string;
        native_label: string;
        band: UnifiedRiskBand;
    } | null;
    sections: CapabilityResultSection[];
    escalation: { subject: string; body: string } | null;
    status: "complete" | "failed";
    error_code: string | null;
    recorded_at: string;
    /** Set on failed events so the UI can re-run with the same inputs. */
    retry: {
        document_ids: string[];
        inputs: { represented_party: string | null };
    } | null;
}

export type RecordOutcome =
    | { ok: true; event: CapabilityResultEvent; toolResult: Record<string, unknown> }
    | {
          ok: false;
          toolResult: { ok: false; error: string; expected_sections: string[] };
      };

// ---------------------------------------------------------------------------
// Scheme vocabulary
// ---------------------------------------------------------------------------

const SCHEME_VALUES: Record<string, readonly string[]> = {
    "traffic-light": ["GREEN", "YELLOW", "RED"],
    "risk-area": ["low", "medium", "high"],
    deviation: ["aligned", "minor", "material", "deal-breaker"],
};

/** Human description of what `overall` may carry, for the run prompt. */
function schemeValuesLine(scheme: string): string {
    if (scheme === "risk-score") {
        return "an integer 1–25 reported as `score` (severity × likelihood)";
    }
    const values = SCHEME_VALUES[scheme];
    return values
        ? `${values.join(" | ")} reported as \`value\``
        : "the values this scheme defines";
}

// ---------------------------------------------------------------------------
// buildCapabilityRunPrompt
// ---------------------------------------------------------------------------

/**
 * The per-turn prompt for a confirmed capability run, appended to the system
 * prompt as `systemPromptExtra`. Four parts, in order:
 *
 *   1. the capability's own workflow prompt, with its `{{playbook:…}}` and
 *      `{{representedParty}}` placeholders resolved;
 *   2. an OUTPUT CONTRACT generated from `outputSpec` — the section ids and
 *      kinds the validator will enforce, so the model is told the rules it is
 *      about to be judged against instead of guessing them;
 *   3. the focus documents the user pinned, named by this turn's doc-N
 *      handles (ids with no handle are simply omitted — a handle the model
 *      cannot call is worse than silence);
 *   4. the mandate: read first, then exactly one tool call, then a short
 *      wrap-up.
 *
 * Only assistant-type workflows reach this function; the route rejects the
 * others with a 400 before the turn starts.
 */
export function buildCapabilityRunPrompt(args: {
    cap: LegalCapability;
    resolvedPlaybook: Record<string, PlaybookEntry>;
    docIndex: DocIndex;
    documentIds: readonly string[];
    representedParty: string | null;
}): string {
    const { cap, resolvedPlaybook, docIndex, documentIds, representedParty } =
        args;
    const spec = cap.outputSpec;
    const promptMd =
        cap.workflow.type === "assistant" ? cap.workflow.prompt_md : "";

    const blocks: string[] = [
        substitute(promptMd, resolvedPlaybook, representedParty ?? undefined),
    ];

    // `substitute` blanks a placeholder whose key was never seeded, which
    // leaves the prompt reading "…the firm's position in " and the run
    // producing a confident card about a playbook it never had. Name the
    // missing keys instead so the model reports the gap.
    const missingPlaybookKeys = cap.playbookKeys.filter(
        (key) => !(key in resolvedPlaybook),
    );
    if (missingPlaybookKeys.length) {
        blocks.push(
            [
                "## UNRESOLVED FIRM POSITIONS",
                `The firm has no recorded position for: ${missingPlaybookKeys.join(", ")}.`,
                "Where the analysis would have relied on one of these, say so plainly rather than asserting a position the firm has not taken.",
            ].join("\n"),
        );
    }

    if (spec) {
        const lines = spec.sections.map((section) => {
            const parts = [
                `- id="${section.id}"`,
                `label="${section.label}"`,
                `kind=${section.kind}`,
            ];
            if (section.kind === "table" && section.columns?.length) {
                parts.push(`columns=${JSON.stringify(section.columns)}`);
            }
            if (section.required) parts.push("required");
            return parts.join(" ");
        });
        blocks.push(
            [
                "## OUTPUT CONTRACT",
                "Record this run through the `record_capability_result` tool, using exactly these section ids and kinds:",
                ...lines,
                `Finding flags: ${FLAG_VALUES.join(" | ")}`,
                `Overall scheme: ${spec.overall_scheme} — ${schemeValuesLine(spec.overall_scheme)}`,
                'Every YELLOW/ORANGE/RED/high finding must carry a citation `{ doc_id: "doc-N", page?, quote? }` when a document was read; cite the doc-N handles exactly as listed under AVAILABLE DOCUMENTS',
            ].join("\n"),
        );
    }

    const handleByDocumentId = new Map<string, string>();
    for (const [handle, info] of Object.entries(docIndex)) {
        if (info.document_id && !handleByDocumentId.has(info.document_id)) {
            handleByDocumentId.set(info.document_id, handle);
        }
    }
    const focusLines: string[] = [];
    for (const documentId of documentIds) {
        const handle = handleByDocumentId.get(documentId);
        if (!handle) continue;
        focusLines.push(
            `- Focus document: ${handle} ("${docIndex[handle].filename}")`,
        );
    }
    if (focusLines.length) {
        blocks.push(["## FOCUS DOCUMENTS", ...focusLines].join("\n"));
    }

    blocks.push(
        [
            "## HOW THIS TURN MUST END",
            `Read every focus document with \`read_document\` before analysing. Your final act this turn MUST be exactly one \`record_capability_result\` call with \`capability_id: "${cap.id}"\`; prose alone does not record a result. After the tool succeeds, reply in 2–4 sentences and do not restate the card.`,
        ].join("\n"),
    );

    return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * The capability's OWN severity label for an accepted `overall` — the
 * vocabulary `escalation.severities_requiring_escalation` is written in.
 *
 * risk-score is the reason this exists: legal-risk-assessment escalates on
 * ["ORANGE", "RED"] but reports a 1-25 product, so comparing the raw score
 * against those labels would never match and the escalation draft would
 * silently never fire. The thresholds are the ones the capability's own
 * methodology and the seeded matrix use (GREEN 1-4, YELLOW 5-9, ORANGE 10-15,
 * RED 16-25).
 */
function nativeSeverityLabel(overall: RiskInput): string {
    switch (overall.scheme) {
        case "risk-score": {
            if (overall.score <= 4) return "GREEN";
            if (overall.score <= 9) return "YELLOW";
            if (overall.score <= 15) return "ORANGE";
            return "RED";
        }
        case "traffic-light":
        case "risk-area":
        case "deviation":
            return overall.value;
        default:
            return "";
    }
}

function nativeLabel(overall: RiskInput): string {
    return overall.scheme === "risk-score"
        ? String(overall.score)
        : overall.scheme === "severity-likelihood"
          ? `${overall.severity} / ${overall.likelihood}`
          : overall.value;
}

/**
 * Read the model's `overall` against the capability's declared scheme.
 * Returns an error string rather than a repaired value: a score of 26 is
 * refused, never clamped to 25, because a clamp would report a rating the
 * model never gave.
 */
function parseOverall(
    value: unknown,
    scheme: string,
): { ok: true; overall: RiskInput } | { ok: false; error: string } {
    const row = asRecord(value);
    if (!row) {
        return { ok: false, error: "overall must be an object" };
    }
    if (row.scheme !== scheme) {
        return {
            ok: false,
            error: `overall.scheme must be "${scheme}" for this capability, got ${JSON.stringify(row.scheme)}`,
        };
    }
    if (scheme === "risk-score") {
        const score = row.score;
        if (
            typeof score !== "number" ||
            !Number.isInteger(score) ||
            score < 1 ||
            score > 25
        ) {
            return {
                ok: false,
                error: `overall.score must be an integer from 1 to 25, got ${JSON.stringify(score)}`,
            };
        }
        return { ok: true, overall: { scheme: "risk-score", score } };
    }
    const allowed = SCHEME_VALUES[scheme];
    if (!allowed) {
        return {
            ok: false,
            error: `overall scheme "${scheme}" cannot be recorded from chat`,
        };
    }
    if (typeof row.value !== "string" || !allowed.includes(row.value)) {
        return {
            ok: false,
            error: `overall.value must be one of ${allowed.join(", ")}, got ${JSON.stringify(row.value)}`,
        };
    }
    return { ok: true, overall: { scheme, value: row.value } as RiskInput };
}

/**
 * Resolve a model-supplied citation against THIS turn's doc handles. An
 * unresolvable handle yields null — the caller drops the citation and keeps
 * the finding.
 */
function resolveCitation(
    value: unknown,
    docIndex: DocIndex,
): CapabilityResultCitation | null {
    const row = asRecord(value);
    if (!row) return null;
    const docId = typeof row.doc_id === "string" ? row.doc_id : null;
    if (!docId) return null;
    // `docIndex` is a plain object literal, so "constructor" / "toString" /
    // "__proto__" would otherwise resolve to an INHERITED value and render a
    // citation reading "undefined". Own properties only, and only ones whose
    // shape is actually a document handle.
    if (!Object.prototype.hasOwnProperty.call(docIndex, docId)) return null;
    const info = docIndex[docId];
    if (
        !info ||
        typeof info.document_id !== "string" ||
        typeof info.filename !== "string"
    ) {
        return null;
    }
    const page =
        typeof row.page === "number" &&
        Number.isInteger(row.page) &&
        row.page >= 1
            ? row.page
            : null;
    const quote =
        typeof row.quote === "string" && row.quote.trim()
            ? row.quote.slice(0, MAX_QUOTE_CHARS)
            : null;
    return {
        document_id: info.document_id,
        filename: info.filename,
        page,
        quote,
    };
}

function validateSection(
    raw: Record<string, unknown>,
    spec: CapabilityOutputSection,
    docIndex: DocIndex,
): { ok: true; section: CapabilityResultSection } | { ok: false; error: string } {
    const fail = (error: string) => ({ ok: false as const, error });
    if (raw.kind !== spec.kind) {
        return fail(
            `section "${spec.id}" must have kind ${spec.kind}, got ${JSON.stringify(raw.kind)}`,
        );
    }
    // The SPEC's label is authoritative. Section headings are registry-owned
    // presentation text (the same reasoning that keeps `run_label` out of the
    // model's hands), so a model that has just read an untrusted document
    // cannot retitle "Issues" as "Approved by counsel — no issues" on the card
    // or in the DOCX. `raw.label` is ignored entirely.
    const section: CapabilityResultSection = {
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
    };

    if (spec.kind === "text") {
        if (typeof raw.text_md !== "string") {
            return fail(`section "${spec.id}" (text) requires text_md`);
        }
        if (raw.text_md.length > MAX_TEXT_CHARS) {
            return fail(
                `section "${spec.id}" text_md exceeds ${MAX_TEXT_CHARS} characters`,
            );
        }
        section.text_md = raw.text_md;
        return { ok: true, section };
    }

    if (spec.kind === "list") {
        if (!Array.isArray(raw.items)) {
            return fail(`section "${spec.id}" (list) requires an items array`);
        }
        if (raw.items.length > MAX_LIST_ITEMS) {
            return fail(
                `section "${spec.id}" has more than ${MAX_LIST_ITEMS} items`,
            );
        }
        const items: string[] = [];
        for (const item of raw.items) {
            if (typeof item !== "string") {
                return fail(`section "${spec.id}" items must be strings`);
            }
            if (item.length > MAX_ITEM_CHARS) {
                return fail(
                    `section "${spec.id}" has an item longer than ${MAX_ITEM_CHARS} characters`,
                );
            }
            items.push(item);
        }
        section.items = items;
        return { ok: true, section };
    }

    if (spec.kind === "table") {
        // The SPEC's columns are authoritative; whatever the model echoed back
        // is ignored, so a renamed or reordered header can never desync the
        // card's headers from its cells.
        const columns = spec.columns ?? [];
        if (!Array.isArray(raw.rows)) {
            return fail(`section "${spec.id}" (table) requires a rows array`);
        }
        if (raw.rows.length > MAX_TABLE_ROWS) {
            return fail(
                `section "${spec.id}" has more than ${MAX_TABLE_ROWS} rows`,
            );
        }
        const rows: string[][] = [];
        for (const rawRow of raw.rows) {
            if (!Array.isArray(rawRow) || rawRow.length !== columns.length) {
                return fail(
                    `section "${spec.id}" rows must each have ${columns.length} cells matching columns ${JSON.stringify(columns)}`,
                );
            }
            const row: string[] = [];
            for (const cell of rawRow) {
                if (typeof cell !== "string") {
                    return fail(
                        `section "${spec.id}" table cells must be strings`,
                    );
                }
                if (cell.length > MAX_CELL_CHARS) {
                    return fail(
                        `section "${spec.id}" has a cell longer than ${MAX_CELL_CHARS} characters`,
                    );
                }
                row.push(cell);
            }
            rows.push(row);
        }
        section.columns = [...columns];
        section.rows = rows;
        return { ok: true, section };
    }

    // findings
    if (!Array.isArray(raw.findings)) {
        return fail(`section "${spec.id}" (findings) requires a findings array`);
    }
    if (raw.findings.length > MAX_FINDINGS) {
        return fail(
            `section "${spec.id}" has more than ${MAX_FINDINGS} findings`,
        );
    }
    const findings: CapabilityResultFinding[] = [];
    for (const rawFinding of raw.findings) {
        const row = asRecord(rawFinding);
        if (!row) {
            return fail(`section "${spec.id}" findings must be objects`);
        }
        if (typeof row.label !== "string" || !row.label.trim()) {
            return fail(
                `section "${spec.id}" findings require a non-empty label`,
            );
        }
        if (row.label.length > MAX_FINDING_LABEL_CHARS) {
            return fail(
                `section "${spec.id}" has a finding label longer than ${MAX_FINDING_LABEL_CHARS} characters`,
            );
        }
        if (typeof row.value_md !== "string") {
            return fail(`section "${spec.id}" findings require value_md`);
        }
        if (row.value_md.length > MAX_FINDING_VALUE_CHARS) {
            return fail(
                `section "${spec.id}" has a finding value_md longer than ${MAX_FINDING_VALUE_CHARS} characters`,
            );
        }
        let flag: CapabilityResultFlag | null = null;
        if (row.flag !== undefined && row.flag !== null) {
            if (
                typeof row.flag !== "string" ||
                !(FLAG_VALUES as readonly string[]).includes(row.flag)
            ) {
                return fail(
                    `section "${spec.id}" finding flag must be one of ${FLAG_VALUES.join(", ")}, got ${JSON.stringify(row.flag)}`,
                );
            }
            flag = row.flag as CapabilityResultFlag;
        }
        findings.push({
            label: row.label,
            value_md: row.value_md,
            flag,
            band: bandForFlag(flag),
            citation: resolveCitation(row.citation, docIndex),
        });
    }
    section.findings = findings;
    return { ok: true, section };
}

// ---------------------------------------------------------------------------
// recordCapabilityResult
// ---------------------------------------------------------------------------

/**
 * Validate one `record_capability_result` tool call and build the persisted
 * event. On refusal the caller hands `toolResult` straight back to the model,
 * which retries in-loop — hence `expected_sections`, which tells it exactly
 * which ids the contract wants.
 */
export function recordCapabilityResult(args: {
    ctx: CapabilityRunContext;
    toolArgs: unknown;
    docIndex: DocIndex;
    now?: () => Date;
    uuid?: () => string;
}): RecordOutcome {
    const { ctx, toolArgs, docIndex } = args;
    const now = args.now ?? (() => new Date());
    const uuid = args.uuid ?? (() => crypto.randomUUID());
    const spec = ctx.cap.outputSpec;
    const expectedSections = spec ? spec.sections.map((s) => s.id) : [];
    const refuse = (error: string): RecordOutcome => ({
        ok: false,
        toolResult: { ok: false, error, expected_sections: expectedSections },
    });

    if (!spec) {
        return refuse(
            `capability "${ctx.cap.id}" declares no output spec and cannot record a result`,
        );
    }

    const row = asRecord(toolArgs);
    if (!row) return refuse("arguments must be an object");

    if (row.capability_id !== ctx.cap.id) {
        return refuse(
            `capability_id must be "${ctx.cap.id}" (the capability this run was confirmed for), got ${JSON.stringify(row.capability_id)}`,
        );
    }

    if (typeof row.title !== "string" || !row.title.trim()) {
        return refuse("title must be a non-empty string");
    }
    if (row.title.length > MAX_TITLE_CHARS) {
        return refuse(`title exceeds ${MAX_TITLE_CHARS} characters`);
    }
    if (typeof row.summary_md !== "string") {
        return refuse("summary_md must be a string");
    }
    if (row.summary_md.length > MAX_SUMMARY_CHARS) {
        return refuse(`summary_md exceeds ${MAX_SUMMARY_CHARS} characters`);
    }

    const overallParsed = parseOverall(row.overall, spec.overall_scheme);
    if (!overallParsed.ok) return refuse(overallParsed.error);

    if (!Array.isArray(row.sections)) {
        return refuse("sections must be an array");
    }

    const specById = new Map(spec.sections.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const sections: CapabilityResultSection[] = [];
    for (const rawSection of row.sections) {
        const sectionRow = asRecord(rawSection);
        if (!sectionRow) return refuse("each section must be an object");
        const id = sectionRow.id;
        if (typeof id !== "string" || !specById.has(id)) {
            return refuse(
                `unknown section id ${JSON.stringify(id)}; use only the ids in expected_sections`,
            );
        }
        if (seen.has(id)) {
            return refuse(`section "${id}" appears more than once`);
        }
        seen.add(id);
        const validated = validateSection(
            sectionRow,
            specById.get(id)!,
            docIndex,
        );
        if (!validated.ok) return refuse(validated.error);
        sections.push(validated.section);
    }

    const missing = spec.sections
        .filter((s) => s.required && !seen.has(s.id))
        .map((s) => s.id);
    if (missing.length) {
        return refuse(`missing required section(s): ${missing.join(", ")}`);
    }

    // Order the recorded sections the way the SPEC declares them, so the card
    // and the DOCX export read in the capability's intended order whatever
    // order the model emitted.
    const specOrder = new Map(spec.sections.map((s, index) => [s.id, index]));
    sections.sort((a, b) => specOrder.get(a.id)! - specOrder.get(b.id)!);

    const overall = overallParsed.overall;
    const severity = nativeSeverityLabel(overall);
    const escalation =
        ctx.cap.escalation &&
        ctx.escalationTemplate &&
        ctx.cap.escalation.severities_requiring_escalation.includes(severity)
            ? {
                  subject: fillTemplate(ctx.escalationTemplate.subject, {
                      title: row.title,
                      severity,
                      summary: row.summary_md,
                  }),
                  body: fillTemplate(ctx.escalationTemplate.body, {
                      title: row.title,
                      severity,
                      summary: row.summary_md,
                  }),
              }
            : null;

    const resultId = uuid();
    const event: CapabilityResultEvent = {
        type: "capability_result",
        result_id: resultId,
        capability_id: ctx.cap.id,
        proposal_id: ctx.capabilityRun.proposalId,
        title: row.title,
        summary_md: row.summary_md,
        overall: {
            scheme: spec.overall_scheme,
            native_label: nativeLabel(overall),
            band: toUnifiedBand(overall),
        },
        sections,
        escalation,
        status: "complete",
        error_code: null,
        recorded_at: now().toISOString(),
        retry: null,
    };

    return {
        ok: true,
        event,
        toolResult: {
            ok: true,
            result_id: resultId,
            next_required_action:
                "Wrap up in 2–4 sentences; do not restate the card.",
        },
    };
}

/**
 * The event recorded when a run turn ends without a complete result — the
 * model answered in prose and never called the tool. Persisted so the card
 * shows a failure the user can retry, instead of the run silently evaporating.
 */
export function failedCapabilityResult(args: {
    ctx: CapabilityRunContext;
    errorCode: "no_result_recorded";
    now?: () => Date;
    uuid?: () => string;
}): CapabilityResultEvent {
    const { ctx, errorCode } = args;
    const now = args.now ?? (() => new Date());
    const uuid = args.uuid ?? (() => crypto.randomUUID());
    return {
        type: "capability_result",
        result_id: uuid(),
        capability_id: ctx.cap.id,
        proposal_id: ctx.capabilityRun.proposalId,
        title: ctx.cap.title,
        summary_md: "",
        overall: null,
        sections: [],
        escalation: null,
        status: "failed",
        error_code: errorCode,
        recorded_at: now().toISOString(),
        retry: {
            document_ids: [...ctx.capabilityRun.documentIds],
            inputs: {
                represented_party: ctx.capabilityRun.inputs.representedParty,
            },
        },
    };
}

/**
 * Read the capability's escalation notice template out of the firm's resolved
 * playbook. Returns null when the capability declares no escalation, the key
 * is absent, or the stored value is not a `{subject, body}` pair of strings —
 * in which case no escalation draft is offered at all, which is the correct
 * degradation: a half-filled notice to senior counsel is worse than none.
 */
export function resolveEscalationTemplate(
    cap: LegalCapability,
    resolvedPlaybook: Record<string, PlaybookEntry>,
): { subject: string; body: string } | null {
    const key = cap.escalation?.notification_template;
    if (!key) return null;
    const value = asRecord(resolvedPlaybook[key]?.value_json);
    if (!value) return null;
    const { subject, body } = value;
    if (typeof subject !== "string" || typeof body !== "string") return null;
    if (!subject.trim() || !body.trim()) return null;
    return { subject, body };
}

/** Fill the `{{title}}` / `{{severity}}` / `{{summary}}` escalation slots. */
function fillTemplate(
    template: string,
    values: { title: string; severity: string; summary: string },
): string {
    return template
        .replace(/\{\{title\}\}/g, values.title)
        .replace(/\{\{severity\}\}/g, values.severity)
        .replace(/\{\{summary\}\}/g, values.summary);
}

// ---------------------------------------------------------------------------
// capabilityResultToDocxSections
// ---------------------------------------------------------------------------

/**
 * Render one citation as the memo's Citation cell: `filename, p. N — "quote"`,
 * dropping the page when the model never gave one and the quote when it never
 * gave one. A finding with no citation gets an empty cell rather than a
 * placeholder — an empty cell reads as "unsourced", which is the truth.
 */
function citationText(citation: CapabilityResultCitation | null): string {
    if (!citation) return "";
    let text = citation.filename;
    if (citation.page !== null && citation.page !== undefined) {
        text += `, p. ${citation.page}`;
    }
    if (citation.quote) text += ` — "${citation.quote}"`;
    return text;
}

/** True when a recorded section carries anything worth putting on a page. */
function sectionHasContent(section: CapabilityResultSection): boolean {
    switch (section.kind) {
        case "text":
            return Boolean(section.text_md?.trim());
        case "list":
            return Boolean(section.items?.length);
        case "table":
            return Boolean(section.rows?.length);
        case "findings":
            return Boolean(section.findings?.length);
        default:
            return false;
    }
}

/**
 * Map a recorded `capability_result` event onto the `DocxSection[]` the shared
 * renderer takes. Deterministic and pure — no model call, no clock, no db — so
 * exporting the same result twice produces the same document, and the export
 * can never invent a finding the card does not show.
 *
 * Order: the summary (prefixed with the overall band line when there is one),
 * then the recorded sections in the order they were recorded (which
 * `recordCapabilityResult` has already sorted into the capability's declared
 * order), then the escalation draft. Markdown inside cells and content is
 * passed through verbatim; the renderer decides what to do with it.
 */
export function capabilityResultToDocxSections(
    event: CapabilityResultEvent,
): DocxSection[] {
    if (event.status === "failed") {
        return [
            {
                content:
                    "This capability run recorded no result, so there is nothing to export. Re-run the capability from the chat to produce one.",
            },
        ];
    }

    const overallLine = event.overall
        ? `Overall: ${event.overall.native_label} (${event.overall.band})`
        : null;
    const summary = overallLine
        ? event.summary_md
            ? `${overallLine}\n\n${event.summary_md}`
            : overallLine
        : event.summary_md;
    const sections: DocxSection[] = [{ content: summary }];

    // The event is typed, but the export route reads it back out of a jsonb
    // column, so a corrupt row degrades to a summary-only memo instead of
    // throwing inside a request that has already been authorized.
    const recorded = Array.isArray(event.sections) ? event.sections : [];
    for (const section of recorded) {
        if (!sectionHasContent(section)) continue;
        if (section.kind === "text") {
            sections.push({
                heading: section.label,
                level: 2,
                content: section.text_md ?? "",
            });
        } else if (section.kind === "list") {
            sections.push({
                heading: section.label,
                level: 2,
                content: (section.items ?? [])
                    .map((item) => `- ${item}`)
                    .join("\n"),
            });
        } else if (section.kind === "table") {
            sections.push({
                heading: section.label,
                level: 2,
                table: {
                    headers: [...(section.columns ?? [])],
                    rows: (section.rows ?? []).map((row) => [...row]),
                },
            });
        } else {
            sections.push({
                heading: section.label,
                level: 2,
                table: {
                    headers: ["Item", "Flag", "Detail", "Citation"],
                    rows: (section.findings ?? []).map((finding) => [
                        finding.label,
                        finding.flag ?? "",
                        finding.value_md,
                        citationText(finding.citation),
                    ]),
                },
            });
        }
    }

    if (event.escalation) {
        sections.push({
            heading: "Escalation draft",
            level: 2,
            content: `Subject: ${event.escalation.subject}\n\n${event.escalation.body}`,
        });
    }

    return sections;
}
