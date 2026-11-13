// backend/src/lib/automation/pipeline.ts
//
// The run pipeline: a cold inbound email's automation_run walks
// queued → classifying → extracting → matching → staging → staged, with
// skipped / triage / failed exits. HARD BOUNDARIES this module owns:
//
//   - The pipeline stops at `staged`. Nothing here sends an email or
//     mutates case data — staging only creates pending-approval artifacts;
//     execution happens exclusively in approve.ts / caseWrites.ts after a
//     human decision.
//   - LLM calls happen ONLY via completeStructured (tool-free by
//     construction) and ONLY in three places: the classify fallback,
//     extraction, and the unverified-citation evaluator. Inbound content
//     is always framed as untrusted data by those modules.
//   - Runs are processed SERIALLY (processDueRuns awaits each processRun),
//     matching the store's concurrency assumptions; every status
//     transition is a claimRunStep CAS, so a stall-sweeper or competing
//     worker interleaving costs us the run, never a double-process.
//   - Failures are loud but contained: a thrown step schedules a backoff
//     retry (status back to queued) until automationMaxRetries, then the
//     run is `failed` with the error recorded; a misconfigured playbook is
//     a triage, never a crash loop.
//
// Every collaborator is injectable (ProcessRunDeps) so the state-machine
// logic is tested without a database or a model.

import type { createServerSupabase } from "../supabase";
import type { EmailMessage } from "../email/store";
import { getEmail } from "../email/store";
import { getUserApiKeys } from "../userSettings";
import type { UserApiKeys } from "../llm/types";
import {
    claimRunStep,
    getRun,
    listDueRuns,
    scheduleRetry,
    updateRun,
} from "./runsStore";
import {
    automationLlmClassifyEnabled,
    automationMaxRetries,
    automationModel,
} from "./env";
import {
    classifyEmailDeterministic,
    llmClassify,
    shouldLlmClassify,
} from "./classify";
import { isPdfAttachment, loadRunDocuments } from "./extract/pdfInputs";
import { emailVerificationText } from "./extract/shared";
import { extractClaims } from "./extract/claimCorrespondence";
import { extractInvoice } from "./extract/invoice";
import {
    aggregateConfidence,
    collectFields,
    evaluateUnverified,
    fieldAtPath,
    requiredPathsFor,
    verifyCitations,
    type CitationCheck,
    type Extraction,
} from "./extract/verify";
import { matchClaimRun, matchFromRun, matchInvoiceRun } from "./match";
import {
    loadPlaybookConfig,
    matchThresholds,
    type PlaybookConfig,
} from "./playbookConfig";
import { stageClaimRun, stageInvoiceRun } from "./stage";
import {
    parseClaimExtraction,
    parseInvoiceExtraction,
    type AutomationRun,
    type RunStatus,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

export type Step = "classify" | "extract" | "match" | "stage" | "done";

const WORKING_STATUS: Record<Exclude<Step, "done">, RunStatus> = {
    classify: "classifying",
    extract: "extracting",
    match: "matching",
    stage: "staging",
};

/** Statuses nextStep treats as "this run needs no further pipeline work". */
const SETTLED_STATUSES: readonly RunStatus[] = [
    "staged",
    "approved",
    "rejected",
    "failed",
    "skipped",
    "triage",
];

/**
 * Pure step decision from a run's PERSISTED fields, so re-entry (retry,
 * stall recovery) resumes exactly where the previous worker stopped:
 * no workflow_kind → classify; empty extracted → extract; no case →
 * match; else stage. Settled statuses are done.
 */
export function nextStep(
    run: Pick<
        AutomationRun,
        "status" | "workflow_kind" | "extracted" | "case_id"
    >,
): Step {
    if (SETTLED_STATUSES.includes(run.status)) return "done";
    if (!run.workflow_kind) return "classify";
    if (!run.extracted || Object.keys(run.extracted).length === 0) {
        return "extract";
    }
    if (!run.case_id) return "match";
    return "stage";
}

/** Exponential backoff: 2^retryCount × 30s, capped at 30 minutes. */
export function backoffDelayMs(retryCount: number): number {
    const capped = Math.min(Math.max(retryCount, 0), 20);
    return Math.min(2 ** capped * 30_000, 30 * 60_000);
}

/** Heartbeat cadence during steps (updated_at is the stall detector). */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Run `fn` with a periodic updated_at heartbeat on the run row, so the
 * stall sweeper (markStalledRunsQueued, 5-minute cutoff) never mistakes a
 * long LLM step for a dead worker. The interval is .unref()'d and ALWAYS
 * cleared; heartbeat failures are swallowed (a missed beat is recoverable,
 * a crashed step is not worth causing).
 */
export async function withHeartbeat<T>(
    opts: {
        db: Db;
        runId: string;
        intervalMs: number;
        updateRunFn: typeof updateRun;
    },
    fn: () => Promise<T>,
): Promise<T> {
    const timer = setInterval(() => {
        void opts.updateRunFn(opts.db, opts.runId, {}).catch(() => {});
    }, opts.intervalMs);
    timer.unref?.();
    try {
        return await fn();
    } finally {
        clearInterval(timer);
    }
}

/** The display-name part of a "Name <addr>" header value, or null. */
export function senderDisplayName(fromAddress: string | null): string | null {
    if (!fromAddress) return null;
    const match = fromAddress.match(/^\s*"?([^"<]+?)"?\s*</);
    const name = match?.[1]?.trim();
    return name || null;
}

export type ProcessRunOutcome =
    | "missing"
    | "lost-claim"
    | "skipped"
    | "triage"
    | "staged"
    | "failed"
    | "retry-scheduled"
    | "done";

/** Injectable collaborators; every default is the real implementation. */
export interface ProcessRunDeps {
    getRunFn?: typeof getRun;
    claimRunStepFn?: typeof claimRunStep;
    updateRunFn?: typeof updateRun;
    scheduleRetryFn?: typeof scheduleRetry;
    getEmailFn?: typeof getEmail;
    loadPlaybookConfigFn?: typeof loadPlaybookConfig;
    classifyDeterministicFn?: typeof classifyEmailDeterministic;
    llmClassifyFn?: typeof llmClassify;
    llmClassifyEnabledFn?: typeof automationLlmClassifyEnabled;
    loadRunDocumentsFn?: typeof loadRunDocuments;
    extractClaimsFn?: typeof extractClaims;
    extractInvoiceFn?: typeof extractInvoice;
    evaluateUnverifiedFn?: typeof evaluateUnverified;
    matchClaimRunFn?: typeof matchClaimRun;
    matchInvoiceRunFn?: typeof matchInvoiceRun;
    stageClaimRunFn?: typeof stageClaimRun;
    stageInvoiceRunFn?: typeof stageInvoiceRun;
    getUserApiKeysFn?: (userId: string, db: Db) => Promise<UserApiKeys>;
    maxRetriesFn?: typeof automationMaxRetries;
    modelFn?: typeof automationModel;
    heartbeatIntervalMs?: number;
}

interface StepContext {
    db: Db;
    run: AutomationRun;
    config: PlaybookConfig;
    email: EmailMessage;
    apiKeys: UserApiKeys | undefined;
    deps: Required<
        Pick<
            ProcessRunDeps,
            | "updateRunFn"
            | "classifyDeterministicFn"
            | "llmClassifyFn"
            | "llmClassifyEnabledFn"
            | "loadRunDocumentsFn"
            | "extractClaimsFn"
            | "extractInvoiceFn"
            | "evaluateUnverifiedFn"
            | "matchClaimRunFn"
            | "matchInvoiceRunFn"
            | "stageClaimRunFn"
            | "stageInvoiceRunFn"
            | "modelFn"
        >
    >;
}

type StepResult =
    | { kind: "continue"; run: AutomationRun }
    | { kind: "terminal"; outcome: ProcessRunOutcome };

async function toTriage(
    ctx: StepContext,
    reason: string,
): Promise<StepResult> {
    await ctx.deps.updateRunFn(ctx.db, ctx.run.id, {
        status: "triage",
        triageReason: reason,
    });
    return { kind: "terminal", outcome: "triage" };
}

async function runClassifyStep(ctx: StepContext): Promise<StepResult> {
    const { db, run, config, email, deps } = ctx;
    const attachments = email.attachments ?? [];
    const deterministic = deps.classifyDeterministicFn({
        fromAddress: email.from_address ?? "",
        subject: email.subject,
        attachmentNames: attachments.map((a) => a.filename),
        carriers: config.carriers,
        vendors: config.vendors,
    });
    let kind = deterministic?.kind ?? null;
    if (!kind) {
        const gate = shouldLlmClassify({
            deterministicMatched: false,
            hasPdfAttachment: attachments.some((a) => isPdfAttachment(a)),
            llmEnabled: deps.llmClassifyEnabledFn(),
        });
        if (gate) {
            kind = await deps.llmClassifyFn({
                subject: email.subject,
                bodyText: email.body_text,
                model: deps.modelFn(),
                apiKeys: ctx.apiKeys,
            });
        }
    }
    if (!kind) {
        // Deterministically uninteresting mail: a clean skip, not an error
        // and not a triage item.
        await deps.updateRunFn(db, run.id, {
            status: "skipped",
            triageReason: null,
            error: null,
        });
        return { kind: "terminal", outcome: "skipped" };
    }
    const updated = await deps.updateRunFn(db, run.id, { workflowKind: kind });
    return {
        kind: "continue",
        run: updated ?? { ...run, workflow_kind: kind },
    };
}

async function runExtractStep(ctx: StepContext): Promise<StepResult> {
    const { db, run, config, email, deps } = ctx;
    const docs = await deps.loadRunDocumentsFn(db, email);
    const emailInput = {
        fromAddress: email.from_address,
        subject: email.subject,
        bodyText: email.body_text,
    };

    let extraction: Extraction;
    if (run.workflow_kind === "vendor_invoice") {
        extraction = await deps.extractInvoiceFn({
            email: emailInput,
            documents: docs.documents,
            guidance: config.invoiceGuidance,
            model: deps.modelFn(),
            apiKeys: ctx.apiKeys,
            unprocessed: docs.unprocessed,
        });
    } else {
        const claims = await deps.extractClaimsFn({
            email: emailInput,
            documents: docs.documents,
            guidance: config.claimsGuidance,
            model: deps.modelFn(),
            apiKeys: ctx.apiKeys,
            unprocessed: docs.unprocessed,
        });
        if (claims.claims.length === 0) {
            return toTriage(
                ctx,
                "no claims extracted from claim correspondence",
            );
        }
        extraction = claims;
    }

    // Deterministic grounding check, then ONE evaluator pass for whatever
    // failed it (scanned PDFs). Anything still unsupported drops to 0
    // confidence; doubt never upgrades a field.
    const fields = collectFields(extraction);
    // Verify email_body quotes against the SAME text the model was shown
    // (From/Subject headers + body) — a vendor name quoted off the sender
    // header is a legitimate, checkable citation.
    const checks = verifyCitations(fields, {
        pageTexts: docs.pageTexts,
        bodyText: emailVerificationText(emailInput),
    });
    const verifiedByPath = new Map(checks.map((c) => [c.path, c.verified]));
    const unverifiedFields = fields.filter(
        (f) => verifiedByPath.get(f.path) === false,
    );

    const evaluatorSupported = new Set<string>();
    let evaluations: { path: string; supported: boolean; corrected_value?: string }[] =
        [];
    if (unverifiedFields.length > 0) {
        evaluations =
            docs.documents.length > 0
                ? await deps.evaluateUnverifiedFn({
                      unverifiedFields,
                      documents: docs.documents,
                      model: deps.modelFn(),
                      apiKeys: ctx.apiKeys,
                  })
                : unverifiedFields.map(({ path }) => ({
                      path,
                      supported: false,
                  }));
        for (const evaluation of evaluations) {
            const field = fieldAtPath(extraction, evaluation.path);
            if (!field) continue;
            if (evaluation.supported) {
                evaluatorSupported.add(evaluation.path);
                if (evaluation.corrected_value !== undefined) {
                    field.value = evaluation.corrected_value;
                }
            } else {
                field.confidence = 0;
            }
        }
    }

    const finalChecks: CitationCheck[] = checks.map((c) => ({
        path: c.path,
        verified: c.verified || evaluatorSupported.has(c.path),
    }));
    const requiredPaths = requiredPathsFor(extraction);
    const aggregate = aggregateConfidence({
        requiredPaths,
        fields,
        verification: finalChecks,
    });

    const updated = await deps.updateRunFn(db, run.id, {
        extracted: extraction as unknown as Record<string, unknown>,
        citations: fields.map(({ path, field }) => ({
            path,
            value: field.value,
            quote: field.quote,
            page: field.page,
            source: field.source,
        })),
        confidence: aggregate,
        verification: {
            checks: finalChecks,
            evaluations,
            aggregate,
            required_paths: requiredPaths,
            unprocessed_attachments: docs.unprocessed,
        },
    });
    const nextRun =
        updated ??
        ({
            ...run,
            extracted: extraction as unknown as Record<string, unknown>,
            confidence: aggregate,
        } as AutomationRun);

    const supportFor = new Map(finalChecks.map((c) => [c.path, c.verified]));
    const unsupportedRequired = requiredPaths.filter(
        (path) => supportFor.get(path) === false,
    );
    if (unsupportedRequired.length > 0) {
        return toTriage(
            { ...ctx, run: nextRun },
            `unverified required field(s): ${unsupportedRequired.join(", ")}`,
        );
    }
    if (aggregate < config.thresholds.extractionMin) {
        return toTriage(
            { ...ctx, run: nextRun },
            `extraction confidence ${aggregate.toFixed(2)} below threshold ${config.thresholds.extractionMin}`,
        );
    }
    return { kind: "continue", run: nextRun };
}

function parseStoredExtraction(run: AutomationRun): Extraction {
    return run.workflow_kind === "vendor_invoice"
        ? parseInvoiceExtraction(run.extracted)
        : parseClaimExtraction(run.extracted);
}

async function runMatchStep(ctx: StepContext): Promise<StepResult> {
    const { db, run, config, email, deps } = ctx;
    let extraction: Extraction;
    try {
        extraction = parseStoredExtraction(run);
    } catch (err) {
        return toTriage(
            ctx,
            `stored extraction unparseable: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const thresholds = matchThresholds(config);
    const result =
        run.workflow_kind === "vendor_invoice"
            ? await deps.matchInvoiceRunFn(
                  db,
                  run.user_id,
                  extraction as never,
                  thresholds,
                  { subject: email.subject },
              )
            : await deps.matchClaimRunFn(
                  db,
                  run.user_id,
                  extraction as never,
                  thresholds,
                  { senderDisplayName: senderDisplayName(email.from_address) },
              );
    if ("triage" in result) {
        return toTriage(ctx, result.triage);
    }
    const updated = await deps.updateRunFn(db, run.id, {
        caseId: result.caseId,
        matchMethod: result.method,
        matchConfidence: result.confidence,
    });
    return {
        kind: "continue",
        run:
            updated ??
            ({
                ...run,
                case_id: result.caseId,
                match_method: result.method,
                match_confidence: result.confidence,
            } as AutomationRun),
    };
}

async function runStageStep(ctx: StepContext): Promise<StepResult> {
    const { db, run, config, email, deps } = ctx;
    let extraction: Extraction;
    try {
        extraction = parseStoredExtraction(run);
    } catch (err) {
        return toTriage(
            ctx,
            `stored extraction unparseable: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const match = matchFromRun(run, matchThresholds(config));
    if (!match) {
        return toTriage(ctx, "match state missing before staging");
    }
    const outcome =
        run.workflow_kind === "vendor_invoice"
            ? await deps.stageInvoiceRunFn(db, {
                  run,
                  email,
                  extraction: extraction as never,
                  match,
                  config,
              })
            : await deps.stageClaimRunFn(db, {
                  run,
                  email,
                  extraction: extraction as never,
                  match,
                  config,
              });
    if ("triage" in outcome) {
        return toTriage(ctx, outcome.triage);
    }
    return { kind: "terminal", outcome: "staged" };
}

/**
 * Drive one run as far as it can go in this invocation. Never throws:
 * a step failure schedules a backoff retry (or fails the run at the retry
 * cap), and every transition is CAS-claimed so competing workers resolve
 * to one owner.
 */
export async function processRun(
    db: Db,
    runId: string,
    deps: ProcessRunDeps = {},
): Promise<{ outcome: ProcessRunOutcome }> {
    const getRunFn = deps.getRunFn ?? getRun;
    const claimFn = deps.claimRunStepFn ?? claimRunStep;
    const updateRunFn = deps.updateRunFn ?? updateRun;
    const scheduleRetryFn = deps.scheduleRetryFn ?? scheduleRetry;
    const getEmailFn = deps.getEmailFn ?? getEmail;
    const loadPlaybookConfigFn =
        deps.loadPlaybookConfigFn ?? loadPlaybookConfig;
    const getUserApiKeysFn = deps.getUserApiKeysFn ?? getUserApiKeys;
    const maxRetriesFn = deps.maxRetriesFn ?? automationMaxRetries;
    const heartbeatIntervalMs =
        deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    const stepDeps: StepContext["deps"] = {
        updateRunFn,
        classifyDeterministicFn:
            deps.classifyDeterministicFn ?? classifyEmailDeterministic,
        llmClassifyFn: deps.llmClassifyFn ?? llmClassify,
        llmClassifyEnabledFn:
            deps.llmClassifyEnabledFn ?? automationLlmClassifyEnabled,
        loadRunDocumentsFn: deps.loadRunDocumentsFn ?? loadRunDocuments,
        extractClaimsFn: deps.extractClaimsFn ?? extractClaims,
        extractInvoiceFn: deps.extractInvoiceFn ?? extractInvoice,
        evaluateUnverifiedFn: deps.evaluateUnverifiedFn ?? evaluateUnverified,
        matchClaimRunFn: deps.matchClaimRunFn ?? matchClaimRun,
        matchInvoiceRunFn: deps.matchInvoiceRunFn ?? matchInvoiceRun,
        stageClaimRunFn: deps.stageClaimRunFn ?? stageClaimRun,
        stageInvoiceRunFn: deps.stageInvoiceRunFn ?? stageInvoiceRun,
        modelFn: deps.modelFn ?? automationModel,
    };

    const initial = await getRunFn(db, runId);
    if (!initial) return { outcome: "missing" };
    // listDueRuns only hands out queued runs; anything else means another
    // worker (or a human decision) owns this run now.
    if (initial.status !== "queued") return { outcome: "lost-claim" };

    let run = initial;
    let currentStatus: RunStatus = "queued";
    let config: PlaybookConfig | null = null;
    let email: EmailMessage | null = null;
    let apiKeys: UserApiKeys | undefined;

    try {
        for (;;) {
            const step = nextStep(run);
            if (step === "done") return { outcome: "done" };

            const working = WORKING_STATUS[step];
            const claimed = await claimFn(db, runId, currentStatus, working);
            if (!claimed) return { outcome: "lost-claim" };
            currentStatus = working;

            // One playbook resolution per run, under our claim so a
            // misconfiguration parks the run in triage exactly once.
            if (!config) {
                const resolved = await loadPlaybookConfigFn(db, run.user_id);
                if (!resolved.ok) {
                    await updateRunFn(db, runId, {
                        status: "triage",
                        triageReason: `playbook misconfigured: ${resolved.key} (${resolved.detail})`,
                    });
                    return { outcome: "triage" };
                }
                config = resolved.config;
                try {
                    apiKeys = await getUserApiKeysFn(run.user_id, db);
                } catch {
                    apiKeys = undefined; // BYOK lookup is best-effort
                }
            }

            if (!email) {
                if (!run.email_id) {
                    await updateRunFn(db, runId, {
                        status: "triage",
                        triageReason: "run has no inbound email",
                    });
                    return { outcome: "triage" };
                }
                email = await getEmailFn(db, run.email_id);
                if (!email) {
                    await updateRunFn(db, runId, {
                        status: "triage",
                        triageReason: "inbound email not found",
                    });
                    return { outcome: "triage" };
                }
            }

            const ctx: StepContext = {
                db,
                run,
                config,
                email,
                apiKeys,
                deps: stepDeps,
            };
            const result = await withHeartbeat(
                { db, runId, intervalMs: heartbeatIntervalMs, updateRunFn },
                () => {
                    switch (step) {
                        case "classify":
                            return runClassifyStep(ctx);
                        case "extract":
                            return runExtractStep(ctx);
                        case "match":
                            return runMatchStep(ctx);
                        case "stage":
                            return runStageStep(ctx);
                    }
                },
            );
            if (result.kind === "terminal") return { outcome: result.outcome };
            run = result.run;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
            if (initial.retry_count >= maxRetriesFn()) {
                await updateRunFn(db, runId, {
                    status: "failed",
                    error: message,
                });
                return { outcome: "failed" };
            }
            await scheduleRetryFn(db, runId, {
                error: message,
                retryCount: initial.retry_count + 1,
                delayMs: backoffDelayMs(initial.retry_count),
            });
            return { outcome: "retry-scheduled" };
        } catch (persistErr) {
            // Even the failure bookkeeping failed (db down mid-run). The
            // stall sweeper will recover the row; log and report failed.
            console.error(
                `[automation] run ${runId} failed AND could not persist the failure`,
                { stepError: message, persistErr },
            );
            return { outcome: "failed" };
        }
    }
}

export interface ProcessDueRunsResult {
    /** Runs actually worked this tick (processRun completed, any outcome). */
    processed: number;
    /** Runs that were due at this tick (queued + backoff elapsed). */
    due: number;
}

export interface ProcessDueRunsDeps extends ProcessRunDeps {
    listDueRunsFn?: typeof listDueRuns;
    processRunFn?: typeof processRun;
}

/**
 * One scheduler tick's worth of run processing: list due runs, then work
 * them STRICTLY SEQUENTIALLY (the store's claim/heartbeat model assumes a
 * single worker per run, and serial processing keeps LLM concurrency at
 * one). Each run is individually wrapped: one poisoned run cannot starve
 * the rest of the batch. Throws only when the runs table itself is
 * unreachable (migration 023 unapplied) — the scheduler logs and skips.
 */
export async function processDueRuns(
    db: Db,
    opts: { limit: number },
    deps: ProcessDueRunsDeps = {},
): Promise<ProcessDueRunsResult> {
    const listFn = deps.listDueRunsFn ?? listDueRuns;
    const processFn = deps.processRunFn ?? processRun;

    const due = await listFn(db, { limit: opts.limit });
    let processed = 0;
    for (const run of due) {
        try {
            const { outcome } = await processFn(db, run.id, deps);
            if (outcome !== "missing" && outcome !== "lost-claim") {
                processed += 1;
            }
        } catch (err) {
            console.error(
                `[automation] processRun crashed for run ${run.id}`,
                err,
            );
        }
    }
    return { processed, due: due.length };
}
