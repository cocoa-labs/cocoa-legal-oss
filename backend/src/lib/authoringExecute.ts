// backend/src/lib/authoringExecute.ts
//
// LLM-backed execution helpers + the orchestrator for the approval-gated
// `assemble_document` tool. The chat dispatch (chatTools.ts) only STAGES an
// authoring_jobs row + a pending_approval agent_operation; the heavy work —
// per-section drafting, template assembly, and the four-guardrail QA pass —
// runs HERE when the operation is approved (called from approveAgentOperation
// in operations.ts).
//
// Why a separate module: keep the LLM / assembly / QA logic OUT of
// operations.ts (which stays a thin reconcile layer mirroring the
// apply_document_highlights branch). The approve branch calls a single
// entrypoint, `executeAuthoringJob`, and reconciles its `{...}` | `{error}`
// result into the agent_operation exactly the way the highlight branch
// reconciles its apply result.
//
// Surfacing to the client: the approve route is a plain JSON endpoint
// (`res.json({ operation })`) — there is NO SSE stream on approval. The
// frontend reads the result off the returned AgentOperation (result_document_id,
// result_version_id, metadata). So this module returns the data the approve
// branch persists into the operation; the `doc_created` + `draft_qa` events are
// reconstructed by the client from that operation row. The optional `write`
// callback is threaded for parity with other executors but is a no-op on the
// approve path (the route cannot stream after it returns).

import type { createServerSupabase } from "./supabase";
import type { AgentOperation } from "./operations";
import { failAgentOperation, updateAgentOperation } from "./operations";
import { completeText, resolveAvailableMainModel, type UserApiKeys } from "./llm";
import { runLegalSearch } from "./legalSearch";
import { assembleFromTemplate } from "./templateAssembly";
import { runAuthoringQa, type QaFinding } from "./authoringQa";
import {
    resolveTemplate,
    validateTemplateShape,
    type TemplateSection,
    type TemplateVariable,
    type ClauseSlot,
} from "./templates";
import {
    resolveFirmId,
    getEffectivePlaybookEntries,
    type PlaybookEntry,
} from "./playbooks";
import { CRE_PLAYBOOK_KEYS } from "./legalCapabilities/creProfiles";
import { extractDocxBodyText } from "./docxTrackedChanges";
import { loadActiveVersion } from "./documentVersions";
import { downloadFile } from "./storage";
import { extractJsonObject } from "./jsonExtract";

type Db = ReturnType<typeof createServerSupabase>;

/** The result the approve branch surfaces back onto the agent_operation. */
export interface AuthoringExecuteResult {
    document_id: string;
    version_id: string;
    version_number: number;
    download_url: string;
    filename: string;
    qa: { findings: QaFinding[]; status: "passed" | "advisory" | "blocked" };
    provenance: unknown[];
}

/**
 * Shared LLM-generation core for a REUSABLE, parameterized template (skeleton +
 * typed variable schema + optional clause slots). Used by BOTH the chat
 * `generate_template` dispatch (chatTools.ts) and the POST /templates/generate
 * route so the prompt + parse + structural-validation behavior is authored once.
 *
 * It is a PURE generation step: it does not touch the DB, record an operation,
 * or persist a template version — the caller owns that lifecycle (the chat
 * dispatch records its operation + createTemplateVersion + `template_created`
 * SSE event; the route calls createTemplateVersion + returns JSON). The caller
 * also pre-resolves the two grounding inputs and passes them in:
 *   - `sampleText`: text of an uploaded sample to parameterize (or null).
 *   - `playbookGrounding`: the firm's standard-positions text, already rendered
 *     to the compact `- key: value` form (see `renderPlaybookGrounding`).
 *
 * Returns the parsed + structurally-validated parts, or `{ error }` on a parse
 * failure (model did not return JSON) or a `validateTemplateShape` failure
 * (joined error strings). The prompt text is identical to what the chat
 * dispatch previously built inline so behavior is preserved exactly.
 */
export async function generateTemplateDraft(args: {
    docType: string;
    title: string;
    description: string;
    /** Pre-resolved sample document text (caller extracts it); null/"" → omit. */
    sampleText?: string | null;
    jurisdiction?: string | null;
    /** Pre-formatted playbook standard-positions text (caller resolves). */
    playbookGrounding?: string;
    model?: string;
    apiKeys?: UserApiKeys;
}): Promise<
    | {
          skeleton: TemplateSection[];
          variableSchema: TemplateVariable[];
          clauseSlots: ClauseSlot[];
          generationNotes: string;
      }
    | { error: string }
> {
    const docType = args.docType || "";
    const title = args.title?.trim() || "Untitled Template";
    const description = args.description ?? "";
    const jurisdiction = args.jurisdiction || null;
    const sampleText = args.sampleText ?? "";
    const playbookGrounding = args.playbookGrounding ?? "";

    const systemPrompt = [
        "You are a senior commercial real estate (CRE) attorney building a REUSABLE, parameterized document template.",
        "Return ONLY a single JSON object (no prose, no markdown fence) with exactly these keys:",
        '{ "skeleton": [...], "variableSchema": [...], "clauseSlots": [...], "generationNotes": "..." }',
        "",
        "skeleton: an ORDERED array of sections. Each section is { id, heading, body_md, pageBreak? }.",
        "  - id: a short stable kebab-case identifier, unique within the array.",
        "  - heading: the section heading (omit or empty for a lead-in/recitals block).",
        "  - body_md: Markdown body. It MAY embed {{var.NAME}} placeholders that get substituted at assembly time.",
        '  - Leave body_md EMPTY ("") for sections that must be drafted per-instance (substantive negotiated clauses); a non-empty body_md is boilerplate reused verbatim with variables filled in.',
        "  - pageBreak: true only when the section must start on a fresh page.",
        "",
        "variableSchema: an array of { name, label, type, required, group?, enum_options? }.",
        "  - type MUST be one of: party | date | money | jurisdiction | enum | text | multiline | number | boolean | duration.",
        "  - enum types MUST include a non-empty enum_options array.",
        "  - group is an optional UI grouping label (e.g. 'Parties', 'Economics').",
        "  - EVERY {{var.NAME}} used in any body_md MUST have a matching entry here (by name); do not reference a variable you did not declare.",
        "",
        "clauseSlots: an array of { key, title } for swappable clause positions; use [] if none are needed.",
        "",
        "Signature section rule (REQUIRED): the FINAL section must be a signatures section with pageBreak: true. Its body_md is plain unnumbered signature-block text for each party, and on its own line directly above each party's signature line it MUST include the exact 0-BASED anchor token {{cocoa-sign:N}} — the first party uses {{cocoa-sign:0}}, the second {{cocoa-sign:1}}, and so on. Emit these tokens verbatim; do not number, letter, or explain them. This matches the e-signature placer convention.",
        "",
        "Make the template practical, well-structured, and faithful to standard CRE drafting. Do not include commentary outside the JSON object.",
    ].join("\n");

    const userPromptParts: string[] = [
        `Document type: ${docType || "(unspecified)"}`,
        `Template title: ${title}`,
        `Description / house-style notes: ${
            description || "(none provided)"
        }`,
    ];
    if (jurisdiction) {
        userPromptParts.push(
            `Default governing-law jurisdiction: ${jurisdiction}`,
        );
    }
    if (playbookGrounding) {
        userPromptParts.push(
            "",
            "Firm standard positions to honor where relevant:",
            playbookGrounding,
        );
    }
    if (sampleText) {
        userPromptParts.push(
            "",
            "Parameterize the following uploaded sample document into the template (turn concrete party names, dates, amounts, and other instance-specific values into {{var.NAME}} placeholders with matching variableSchema entries):",
            "--- SAMPLE START ---",
            sampleText,
            "--- SAMPLE END ---",
        );
    }
    userPromptParts.push("", "Return ONLY the JSON object described above.");

    const completionModel = resolveAvailableMainModel(args.model, args.apiKeys);
    const rawCompletion = await completeText({
        model: completionModel,
        systemPrompt,
        user: userPromptParts.join("\n"),
        maxTokens: 8000,
        apiKeys: args.apiKeys,
    });

    // Defensively extract + parse the JSON object the model returned. On parse
    // failure return `{ error }` (the caller decides how to surface it) — do NOT
    // persist anything.
    let parsed: {
        skeleton?: unknown;
        variableSchema?: unknown;
        clauseSlots?: unknown;
        generationNotes?: unknown;
    };
    try {
        parsed = JSON.parse(extractJsonObject(rawCompletion));
    } catch (parseErr) {
        return {
            error: `Template generation failed: the model did not return valid JSON (${
                parseErr instanceof Error
                    ? parseErr.message
                    : String(parseErr)
            }). Ask the user to try again or refine the description.`,
        };
    }

    const skeleton = (
        Array.isArray(parsed.skeleton) ? parsed.skeleton : []
    ) as TemplateSection[];
    const variableSchema = (
        Array.isArray(parsed.variableSchema) ? parsed.variableSchema : []
    ) as TemplateVariable[];
    const clauseSlots = (
        Array.isArray(parsed.clauseSlots) ? parsed.clauseSlots : []
    ) as ClauseSlot[];
    const generationNotes =
        typeof parsed.generationNotes === "string"
            ? parsed.generationNotes
            : "";

    // Deterministic structural validation BEFORE the caller persists.
    const check = validateTemplateShape(skeleton, variableSchema, clauseSlots);
    if (!check.ok) {
        return {
            error: `Generated template failed structural validation: ${check.errors.join(
                "; ",
            )}`,
        };
    }

    return { skeleton, variableSchema, clauseSlots, generationNotes };
}

/**
 * Render a playbook entry's value to compact prose for prompt grounding.
 * Mirrors the inline rendering generate_template uses (string verbatim,
 * everything else JSON-stringified; null/"null" suppressed). Exported so route
 * callers (POST /templates/generate) can format the same grounding string that
 * `generateTemplateDraft` expects, keeping one canonical renderer.
 */
export function renderPlaybookGrounding(
    entries: Record<string, PlaybookEntry>,
    keys: readonly string[],
): string {
    const parts: string[] = [];
    for (const key of keys) {
        const entry = entries[key];
        if (!entry) continue;
        const valueText =
            typeof entry.value_json === "string"
                ? entry.value_json
                : JSON.stringify(entry.value_json);
        if (!valueText || valueText === "null") continue;
        const notes = entry.notes_md ? `\n  notes: ${entry.notes_md}` : "";
        parts.push(`- ${key}: ${valueText}${notes}`);
    }
    return parts.join("\n");
}

/**
 * Build a per-section drafter for the sections of a template skeleton that
 * carry NO boilerplate body_md (the substantive negotiated clauses left empty
 * for per-instance drafting). Each call drafts ONE section's prose, bounded to
 * a few thousand tokens so a multi-section document never approaches the ~32k
 * whole-doc completion cap that previously truncated `generate_docx` output.
 *
 * The returned function matches the `DraftSection` signature `assembleSections`
 * expects: `(section, { variables, playbookEntries }) => Promise<string>`. On
 * any LLM failure it logs and returns "" so assembly still produces a
 * (possibly thinner) document rather than throwing mid-assembly — assembly
 * robustness is preserved and the QA pass will flag the resulting gap.
 */
export function makeLlmSectionDrafter(params: {
    userId: string;
    model?: string;
    apiKeys?: UserApiKeys;
    docType: string;
    jurisdiction?: string | null;
}): (
    section: TemplateSection,
    ctx: {
        variables: Record<string, unknown>;
        playbookEntries: Record<string, PlaybookEntry>;
    },
) => Promise<string> {
    const completionModel = resolveAvailableMainModel(
        params.model,
        params.apiKeys,
    );

    return async (section, ctx) => {
        const heading = section.heading?.trim() || section.id;
        const relevantKeys = section.variables_used?.length
            ? section.variables_used
            : Object.keys(ctx.variables);
        const variableLines = relevantKeys
            .map((name) => {
                const value = ctx.variables[name];
                if (value === undefined || value === null || value === "") {
                    return null;
                }
                const rendered =
                    typeof value === "string" ? value : JSON.stringify(value);
                return `- ${name}: ${rendered}`;
            })
            .filter((l): l is string => l !== null);

        const playbookGrounding = renderPlaybookGrounding(
            ctx.playbookEntries,
            CRE_PLAYBOOK_KEYS,
        );

        const systemPrompt = [
            `You are a senior commercial real estate (CRE) attorney drafting ONE section of a ${
                params.docType || "commercial real estate"
            } document.`,
            "Draft ONLY the body prose for the single section named below — do NOT restate the heading, do NOT number the section, and do NOT draft any other section.",
            "Write clean, enforceable, plain-prose contract language faithful to standard CRE drafting. Return the section body text only (no markdown fence, no commentary).",
            params.jurisdiction
                ? `Use language appropriate to the governing law of ${params.jurisdiction}.`
                : "",
            "Honor the firm's standard positions where relevant to this section; do not invent facts beyond the variables supplied.",
        ]
            .filter(Boolean)
            .join("\n");

        const userParts: string[] = [`Section to draft: ${heading}`];
        if (variableLines.length) {
            userParts.push("", "Filled values for this document:", ...variableLines);
        }
        if (playbookGrounding) {
            userParts.push(
                "",
                "Firm standard positions to honor where relevant:",
                playbookGrounding,
            );
        }
        userParts.push("", `Draft the body of "${heading}" now.`);

        try {
            const text = await completeText({
                model: completionModel,
                systemPrompt,
                user: userParts.join("\n"),
                maxTokens: 3000,
                apiKeys: params.apiKeys,
            });
            return (text ?? "").trim();
        } catch (err) {
            // Per-section failure is non-fatal: log and return empty so the
            // rest of the document still assembles. The QA pass surfaces the
            // resulting gap to the user.
            console.error(
                `[authoringExecute] section drafter failed for "${heading}"`,
                { error: err instanceof Error ? err.message : String(err) },
            );
            return "";
        }
    };
}

/**
 * Build the `runCheck` function `runAuthoringQa` expects: an LLM reviewer that
 * grades the assembled text for playbook-compliance + jurisdiction-appropriate
 * language and returns QaFinding[] (guardrail "playbook" / "jurisdiction").
 *
 * runAuthoringQa wraps this in `.catch(() => [])`, which would SILENTLY swallow
 * any failure — so we log internally here before returning [] so a broken QA
 * check is still observable. Returning [] (rather than throwing) keeps QA
 * advisory: a flaky reviewer never blocks an otherwise-valid draft.
 */
export function makeQaCheck(params: {
    model?: string;
    apiKeys?: UserApiKeys;
}): (a: {
    text: string;
    docType: string;
    playbookEntries: Record<string, unknown>;
    jurisdiction?: string | null;
}) => Promise<QaFinding[]> {
    const completionModel = resolveAvailableMainModel(
        params.model,
        params.apiKeys,
    );

    return async (a) => {
        try {
            const playbookGrounding = renderPlaybookGrounding(
                a.playbookEntries as Record<string, PlaybookEntry>,
                CRE_PLAYBOOK_KEYS,
            );
            const systemPrompt = [
                "You are a senior CRE attorney running a compliance QA pass over an assembled draft document.",
                "Review the draft against (1) the firm's standard positions and deal-breakers and (2) whether its language is appropriate for the stated governing-law jurisdiction.",
                "Return ONLY a JSON array (no prose, no markdown fence) of finding objects. Each finding is:",
                '{ "guardrail": "playbook" | "jurisdiction", "severity": "info" | "advisory" | "blocking", "message": "...", "evidence": "...", "suggestion": "..." }',
                "Use severity \"blocking\" ONLY for a clear, material deviation from a firm deal-breaker; use \"advisory\" for off-market terms; use \"info\" for minor notes.",
                "If the draft is compliant and jurisdiction-appropriate, return an empty array []. Do not invent deviations.",
            ].join("\n");

            const userParts: string[] = [
                `Document type: ${a.docType || "(unspecified)"}`,
                a.jurisdiction
                    ? `Governing-law jurisdiction: ${a.jurisdiction}`
                    : "Governing-law jurisdiction: (not specified)",
            ];
            if (playbookGrounding) {
                userParts.push(
                    "",
                    "Firm standard positions / deal-breakers:",
                    playbookGrounding,
                );
            }
            userParts.push(
                "",
                "Draft to review:",
                "--- DRAFT START ---",
                a.text.slice(0, 24000),
                "--- DRAFT END ---",
                "",
                "Return ONLY the JSON array of findings.",
            );

            const raw = await completeText({
                model: completionModel,
                systemPrompt,
                user: userParts.join("\n"),
                maxTokens: 2000,
                apiKeys: params.apiKeys,
            });
            return parseQaFindings(raw, ["playbook", "jurisdiction"]);
        } catch (err) {
            console.error("[authoringExecute] QA playbook/jurisdiction check failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    };
}

/**
 * Build the `runResearch` function `runAuthoringQa` expects: grounds novel
 * clauses against external authority via legal_search and returns QaFinding[]
 * (guardrail "research") with citations. Advisory infrastructure — it NEVER
 * blocks: if legal_search is unconfigured/unavailable, or anything throws, it
 * logs and returns []. The aggregator's `.catch(() => [])` would otherwise hide
 * a failure, so we log internally here for observability.
 */
export function makeQaResearch(params: {
    model?: string;
    apiKeys?: UserApiKeys;
}): (a: { text: string; jurisdiction?: string | null }) => Promise<QaFinding[]> {
    const completionModel = resolveAvailableMainModel(
        params.model,
        params.apiKeys,
    );

    return async (a) => {
        try {
            // Ask the model for a single, focused research query that would
            // best ground the most novel / unusual clause in the draft. Keep
            // this cheap — one short completion, one search.
            const querySystem =
                "You identify the single most novel or unusual clause in a draft CRE document that would benefit from external legal grounding. Respond with ONE concise legal research query (a single line, no quotes, no preamble). If nothing is novel enough to research, respond with exactly NONE.";
            const queryRaw = await completeText({
                model: completionModel,
                systemPrompt: querySystem,
                user: [
                    a.jurisdiction ? `Jurisdiction: ${a.jurisdiction}` : "",
                    "Draft:",
                    a.text.slice(0, 16000),
                ]
                    .filter(Boolean)
                    .join("\n"),
                maxTokens: 200,
                apiKeys: params.apiKeys,
            });
            const query = (queryRaw ?? "").trim().split("\n")[0]?.trim() ?? "";
            if (!query || /^none$/i.test(query)) return [];

            const response = await runLegalSearch({
                query,
                mode: "authority",
                maxResults: 4,
                jurisdiction: a.jurisdiction ?? undefined,
            });

            // No providers configured (or all failed) → advisory infra is
            // simply unavailable; return [] without a finding so it never
            // blocks. The warnings already capture the reason.
            if (response.results.length === 0) {
                if (response.warnings.length) {
                    console.warn(
                        "[authoringExecute] QA research returned no results",
                        { warnings: response.warnings },
                    );
                }
                return [];
            }

            const citations = response.results.map((r) => ({
                title: r.title,
                url: r.url,
                source_type: r.sourceType,
                snippet: r.snippet ?? null,
            }));
            return [
                {
                    guardrail: "research",
                    severity: "info",
                    message: `Authority found for review of a novel clause (query: "${query}"). Confirm the draft is consistent with the cited sources.`,
                    citations,
                },
            ];
        } catch (err) {
            console.error("[authoringExecute] QA research failed", {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    };
}

/**
 * Defensively parse the QA reviewer's JSON-array output into QaFinding[],
 * keeping only the guardrails this check is responsible for and coercing
 * severity to the allowed set. Tolerates a stray code fence / surrounding
 * prose by slicing from the first `[` to the last `]`.
 */
function parseQaFindings(
    raw: string,
    allowedGuardrails: QaFinding["guardrail"][],
): QaFinding[] {
    if (!raw) return [];
    let candidate = raw.trim();
    const fence = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fence) candidate = fence[1].trim();
    const first = candidate.indexOf("[");
    const last = candidate.lastIndexOf("]");
    if (first !== -1 && last !== -1 && last > first) {
        candidate = candidate.slice(first, last + 1);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set(allowedGuardrails);
    const severities = new Set(["info", "advisory", "blocking"]);
    const out: QaFinding[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const row = item as Record<string, unknown>;
        const guardrail = row.guardrail as QaFinding["guardrail"];
        if (!allowed.has(guardrail)) continue;
        const severity = severities.has(String(row.severity))
            ? (row.severity as QaFinding["severity"])
            : "advisory";
        const message =
            typeof row.message === "string" && row.message.trim()
                ? row.message.trim()
                : "(no message)";
        out.push({
            guardrail,
            severity,
            message,
            evidence:
                typeof row.evidence === "string" ? row.evidence : undefined,
            suggestion:
                typeof row.suggestion === "string" ? row.suggestion : undefined,
            section_id:
                typeof row.section_id === "string" ? row.section_id : undefined,
        });
    }
    return out;
}

/**
 * Load the active version bytes of an authored document and extract its body
 * text for the QA pass. Reuses extractDocxBodyText (the same flatten path the
 * tracked-change editor uses) so the QA scanners see the same plain text the
 * user would read. Returns "" if the document/version/bytes are unavailable so
 * QA degrades to "no findings" rather than throwing.
 */
export async function extractAuthoredText(
    db: Db,
    documentId: string,
): Promise<string> {
    const active = await loadActiveVersion(documentId, db);
    if (!active?.storage_path) return "";
    const raw = await downloadFile(active.storage_path);
    if (!raw) return "";
    try {
        return await extractDocxBodyText(Buffer.from(raw));
    } catch (err) {
        console.error("[authoringExecute] extractAuthoredText failed", {
            documentId,
            error: err instanceof Error ? err.message : String(err),
        });
        return "";
    }
}

/**
 * Resolve the authoring_jobs id an operation drives, the same way
 * executeAuthoringJob does (off `op.arguments.authoring_job_id`). Shared so the
 * fire-and-forget launcher (startAuthoringJob) and its last-resort failure path
 * key the SAME row the worker would have. Returns null when the operation
 * carries no job id.
 */
export function resolveAuthoringJobId(op: AgentOperation): string | null {
    return typeof op.arguments?.authoring_job_id === "string" &&
        op.arguments.authoring_job_id
        ? (op.arguments.authoring_job_id as string)
        : null;
}

/**
 * Best-effort terminal-failure marker for an authoring_jobs row. Lands the row
 * in the terminal `failed` status (reusing the existing status enum — no
 * migration) so a status poller stops polling and surfaces an error. Never
 * throws: a failed update is swallowed (the caller is already on an error
 * path). Exported so the background launcher's last-resort catch can mark the
 * row failed even if executeAuthoringJob threw before it could.
 */
export async function markJobFailed(
    db: Db,
    jobId: string | null | undefined,
    error?: string,
): Promise<void> {
    if (!jobId) return;
    const update: Record<string, unknown> = {
        status: "failed",
        updated_at: new Date().toISOString(),
    };
    if (error) {
        // Surface the reason to the poller without a schema change: stash it in
        // qa_findings_json (a jsonb column that already exists) as a single
        // error finding. The status endpoint reads it back for `error`.
        update.qa_findings_json = [
            { guardrail: "error", severity: "blocking", message: error },
        ];
    }
    await db
        .from("authoring_jobs")
        .update(update)
        .eq("id", jobId)
        .then(
            () => {},
            () => {},
        );
}

/**
 * Fire-and-forget launcher for the background authoring worker. Kicks off
 * executeAuthoringJob WITHOUT awaiting it, so the HTTP caller (chat-approve or
 * the wizard route) returns immediately with the job id instead of blocking for
 * the ~50-90s draft+QA — eliminating the proxy / load-balancer timeout risk and
 * the client-disconnect orphan. The poller (GET /templates/jobs/:id) watches the
 * authoring_jobs row for the terminal state the worker lands.
 *
 * Crash-safety contract: this can NEVER throw into the caller and NEVER leave an
 * unhandled promise rejection. executeAuthoringJob is itself throw-safe (it
 * converts internal throws to `{ error }` and reconciles on every path), but the
 * `void (async () => …)()` wrapper adds a belt-and-suspenders catch: if anything
 * slipped through, mark the job row failed AND fail the operation so the poller
 * still sees a terminal state rather than a job wedged in `assembling` forever.
 */
export function startAuthoringJob(params: {
    db: Db;
    op: AgentOperation;
    model?: string;
    apiKeys?: UserApiKeys;
}): void {
    const { db, op } = params;
    void (async () => {
        try {
            await executeAuthoringJob(params);
        } catch (err) {
            // executeAuthoringJob already reconciles on every path it controls;
            // this only fires if it threw before doing so (it shouldn't). Land a
            // terminal state both places so the poller is never stuck.
            const message = err instanceof Error ? err.message : String(err);
            try {
                await markJobFailed(db, resolveAuthoringJobId(op), message);
            } catch {
                /* ignore */
            }
            try {
                await failAgentOperation(db, op.id, message);
            } catch {
                /* ignore */
            }
        }
    })();
}

/**
 * Orchestrator for the approval-gated `assemble_document` work. Reads the staged
 * authoring_jobs row, drafts + assembles the document, runs the four-guardrail
 * QA, lands the job row in a terminal status, AND reconciles the agent_operation
 * — on EVERY path (success, assemble error, QA-degraded, throw).
 *
 * Background-safe: this is launched detached via startAuthoringJob, so it CANNOT
 * depend on the HTTP request being alive. It therefore owns the operation
 * reconcile itself (updateAgentOperation succeeded / failAgentOperation) rather
 * than returning the result for a caller to persist — by the time it returns,
 * the caller may be long gone. The returned `{...} | { error }` is kept for the
 * focused failure tests and any future synchronous caller, but the durable
 * record of the outcome is the authoring_jobs row + the agent_operation, both
 * written here.
 *
 * Status progression (reuses the existing `authoring_jobs.status` enum, no
 * migration): the row enters `assembling` at stage time → flips to `qa` right
 * before the QA pass so a poller can show the QA phase → lands `ready` (with the
 * result + qa_status) or `failed`.
 *
 * Throw-safety: the entire body is wrapped in try/catch. assembleFromTemplate
 * resolves the template via DB reads that can THROW (resolveTemplate /
 * resolveAvailableMainModel are not internally caught), so a throw is converted
 * into a clean `{ error }` here, after marking the job row failed and failing
 * the operation.
 */
export async function executeAuthoringJob(params: {
    db: Db;
    op: AgentOperation;
    /**
     * Optional streaming callback for parity with other executors. Background
     * mode (the only mode now) has NO client connection, so it defaults to a
     * no-op. Threaded so a future streaming path can light up without changing
     * this signature.
     */
    write?: (s: string) => void;
    /**
     * Optional model + API keys for the headless drafting / QA completions.
     * Both approve and wizard callers fetch the user's stored keys
     * (`getUserApiKeys`) and pass them so drafting + QA run under the user's
     * own credentials — essential for BYOK-only users, who have no environment
     * key for the default provider and would otherwise get every section draft
     * swallowed to "" (a blank document). `model` is usually undefined on the
     * approve path (no per-request picker), so
     * `resolveAvailableMainModel(undefined, apiKeys)` selects a model the user's
     * keys can reach. The wizard route forwards an explicit `body.model` when
     * the user picked one.
     */
    model?: string;
    apiKeys?: UserApiKeys;
}): Promise<AuthoringExecuteResult | { error: string }> {
    const { db, op } = params;
    // Optional writer defaults to a no-op: in detached background mode there is
    // no client connection to stream to.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const write = params.write ?? (() => {});
    const jobId = resolveAuthoringJobId(op);

    // Terminal-failure path shared by every error branch below: mark the job
    // row failed AND fail the agent_operation, then return `{ error }`. The
    // background worker owns this reconcile (the HTTP caller is detached), so it
    // must happen here, not in the caller.
    const failJob = async (message: string): Promise<{ error: string }> => {
        await markJobFailed(db, jobId, message);
        await failAgentOperation(db, op.id, message).catch(() => {});
        return { error: message };
    };

    // Heartbeat timer. The poller (GET /templates/jobs/:id) treats an
    // assembling/qa job whose `updated_at` is older than STALL_MS (5 min) as a
    // dead worker. Nothing else bumps `updated_at` during drafting, and the row
    // was staged with `updated_at` set when the assistant PROPOSED the draft —
    // so a user who approves >5 min after the proposal would otherwise see a
    // false "stalled" on the very first poll. We keep `updated_at` fresh for the
    // whole duration the worker runs (immediate bump + every 60s) so `stalled`
    // only ever fires when the PROCESS actually dies. The interval is ALWAYS
    // cleared in the `finally` below, including every early-return/throw path,
    // so no timer dangles after the job reaches a terminal state (a leaked
    // setInterval would also keep node:test's loop alive).
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stopHeartbeat = () => {
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
        }
    };

    try {
        if (!jobId) {
            // No job row to mark (markJobFailed(null) no-ops), but still
            // reconcile the operation to failed so a poller / the operations
            // view sees a terminal state.
            return failJob("Authoring job id is missing from the operation.");
        }

        const { data: job, error: jobErr } = await db
            .from("authoring_jobs")
            .select("*")
            .eq("id", jobId)
            .maybeSingle();
        if (jobErr) {
            return failJob(`Failed to read authoring job: ${jobErr.message}`);
        }
        if (!job) {
            return failJob("Authoring job not found.");
        }

        // FIRST action now that the job id is resolved and the row exists, and
        // BEFORE assembleFromTemplate: write an immediate heartbeat. This
        // refreshes the staged-at-proposal-time timestamp to ~worker-start,
        // closing the approve-lag window (user approved long after the
        // proposal). Best-effort — a failed heartbeat write must never fail the
        // job (swallow both rejection arms; never leak an unhandled rejection).
        await db
            .from("authoring_jobs")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", jobId)
            .then(
                () => {},
                () => {},
            );
        // Periodic heartbeat: bump `updated_at = now()` every 60s for as long
        // as the worker runs. This closes the long-draft window (a template
        // whose drafting itself exceeds 5 min). `.unref()` so the timer can
        // never by itself hold the process open. Swallow write errors.
        heartbeat = setInterval(() => {
            db.from("authoring_jobs")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", jobId)
                .then(
                    () => {},
                    () => {},
                );
        }, 60_000);
        heartbeat.unref?.();

        const userId = op.actor_user_id;
        const templateId =
            (job.template_id as string | null) ??
            (typeof op.arguments?.template_id === "string"
                ? (op.arguments.template_id as string)
                : null);
        if (!templateId) {
            return failJob("Authoring job is missing a template id.");
        }
        const variables = (job.variables_json ?? {}) as Record<string, unknown>;
        const jurisdiction =
            typeof op.arguments?.jurisdiction === "string" &&
            op.arguments.jurisdiction
                ? (op.arguments.jurisdiction as string)
                : null;

        // Resolve the template once to get docType (Task 7 carry-forward: the
        // QA pass must be told the document type, taken from the resolved
        // template, not guessed) and the template's default jurisdiction as a
        // fallback for the QA language check. assembleFromTemplate re-resolves
        // internally from templateId — a minor double-read kept to preserve its
        // self-contained contract.
        const firmId = await resolveFirmId(userId);
        const resolved = await resolveTemplate(db, firmId, templateId);
        if (!resolved) {
            return failJob(`Template not found: ${templateId}`);
        }
        const docType = resolved.template.doc_type;
        const effectiveJurisdiction =
            jurisdiction ?? resolved.template.jurisdiction ?? null;

        const draftSection = makeLlmSectionDrafter({
            userId,
            model: params.model,
            apiKeys: params.apiKeys,
            docType,
            jurisdiction: effectiveJurisdiction,
        });

        const assembled = await assembleFromTemplate({
            db,
            userId,
            templateId,
            variables,
            projectId: op.project_id,
            jurisdiction: effectiveJurisdiction,
            operationId: op.id,
            draftSection,
            playbookKeys: [...CRE_PLAYBOOK_KEYS],
        });
        if ("error" in assembled) {
            return failJob(assembled.error);
        }

        // Assembly succeeded; the document is persisted. Flip the job to the
        // `qa` phase so a poller can show "running QA" before the QA pass runs.
        // Best-effort: a failed status write here doesn't block QA.
        await db
            .from("authoring_jobs")
            .update({ status: "qa", updated_at: new Date().toISOString() })
            .eq("id", jobId)
            .then(
                () => {},
                () => {},
            );

        // Extract the authored text and run the four-guardrail QA. Jurisdiction
        // flows into the QA pass (Task 7 carry-forward). playbookEntries are
        // resolved firm-effective so the QA reviewer grades against the firm's
        // actual positions.
        //
        // The document is ALREADY PERSISTED at this point (assembleFromTemplate
        // succeeded above). The QA pass must never discard it: a QA failure or
        // an unreadable draft degrades QA HONESTLY to "advisory" — it does not
        // fail the job (which would orphan a fully-valid document and tell the
        // user it failed) and it does not false-"pass" a document QA never
        // inspected. So the whole QA pass is wrapped in its OWN try/catch
        // (FIX 3), and an empty/whitespace-only extraction short-circuits to an
        // advisory before runAuthoringQa would otherwise find "nothing" and
        // report "passed" over text it never saw (FIX 4).
        let qa: { findings: QaFinding[]; status: "passed" | "advisory" | "blocked" };
        try {
            const text = await extractAuthoredText(db, assembled.documentId);
            if (!text.trim()) {
                // Bytes couldn't be read back (download failure / storage lag).
                // Don't claim "passed" over a document we never inspected.
                qa = {
                    findings: [
                        {
                            guardrail: "defined_terms",
                            severity: "advisory",
                            message:
                                "Automated QA could not read the assembled document; review manually.",
                        },
                    ],
                    status: "advisory",
                };
            } else {
                const playbookEntries = await getEffectivePlaybookEntries(
                    db,
                    firmId,
                    [...CRE_PLAYBOOK_KEYS],
                );
                qa = await runAuthoringQa({
                    text,
                    docType,
                    variables,
                    playbookEntries,
                    jurisdiction: effectiveJurisdiction,
                    runCheck: makeQaCheck({
                        model: params.model,
                        apiKeys: params.apiKeys,
                    }),
                    runResearch: makeQaResearch({
                        model: params.model,
                        apiKeys: params.apiKeys,
                    }),
                });
            }
        } catch (qaErr) {
            // QA threw (e.g. getEffectivePlaybookEntries hit a DB error). The
            // assembled document is valid and persisted — degrade QA to a
            // single advisory and STILL deliver the document. Never fail the
            // job from here.
            console.error(
                "[authoringExecute] QA pass failed; degrading to advisory",
                {
                    jobId,
                    documentId: assembled.documentId,
                    error: qaErr instanceof Error ? qaErr.message : String(qaErr),
                },
            );
            qa = {
                findings: [
                    {
                        guardrail: "defined_terms",
                        severity: "advisory",
                        message:
                            "Automated QA could not complete; review the draft manually.",
                    },
                ],
                status: "advisory",
            };
        }

        await db
            .from("authoring_jobs")
            .update({
                status: "ready",
                qa_status: qa.status,
                qa_findings_json: qa.findings,
                result_document_id: assembled.documentId,
                result_version_id: assembled.versionId,
                provenance_json: assembled.provenance,
                updated_at: new Date().toISOString(),
            })
            .eq("id", jobId)
            .then(
                () => {},
                (err: unknown) => {
                    // A failed job-row update must not lose the assembled
                    // document — log and continue; the operation still carries
                    // the result.
                    console.error(
                        "[authoringExecute] failed to mark job ready",
                        {
                            jobId,
                            error:
                                err instanceof Error ? err.message : String(err),
                        },
                    );
                },
            );

        // Reconcile the agent_operation to succeeded HERE — the background
        // worker owns the terminal reconcile (the HTTP caller that launched us
        // is detached and may be gone). This mirrors the metadata the approve
        // branch previously wrote so the client still reconstructs its
        // `doc_created` + `draft_qa` events off the operation row, and the
        // History/operations views see a clean terminal record. Best-effort:
        // the durable result also lives on the authoring_jobs row the poller
        // reads, so a failed reconcile here doesn't lose the document.
        await updateAgentOperation(db, op.id, {
            status: "succeeded",
            completed: true,
            resultDocumentId: assembled.documentId,
            resultVersionId: assembled.versionId,
            metadata: {
                qa_status: qa.status,
                qa_findings: qa.findings,
                download_url: assembled.downloadUrl,
                filename: assembled.filename,
                version_number: assembled.versionNumber,
                provenance: assembled.provenance,
                ...(typeof op.arguments?.approved_by_user_id === "string"
                    ? {
                          approved_by_user_id:
                              op.arguments.approved_by_user_id,
                      }
                    : {}),
            },
        }).catch((err: unknown) => {
            console.error(
                "[authoringExecute] failed to reconcile operation succeeded",
                {
                    operationId: op.id,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            return null;
        });

        return {
            document_id: assembled.documentId,
            version_id: assembled.versionId,
            version_number: assembled.versionNumber,
            download_url: assembled.downloadUrl,
            filename: assembled.filename,
            qa,
            provenance: assembled.provenance,
        };
    } catch (err) {
        return failJob(
            err instanceof Error
                ? err.message
                : `Authoring execution failed: ${String(err)}`,
        );
    } finally {
        // Stop the heartbeat the instant the job reaches a terminal state (or
        // throws / early-returns). Covers EVERY post-resolve path — success,
        // assemble error, QA-degraded, throw — so no timer leaks after the job
        // completes.
        stopHeartbeat();
    }
}
