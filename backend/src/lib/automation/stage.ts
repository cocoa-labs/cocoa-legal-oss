// backend/src/lib/automation/stage.ts
//
// The staging step: turn a verified extraction + case match into
// HUMAN-APPROVABLE artifacts, then park the run at `staged`. Nothing here
// mutates case data and nothing here sends mail:
//   - claim runs stage an `update_case_insurance` agent operation (pending
//     approval) plus an acknowledgement email draft (`pending_approval`,
//     tied to an `auto_ack_email` operation) whose body is DETERMINISTIC
//     template substitution — renderAckTemplate over the playbook template
//     + signature block; no LLM text can reach the outbound path;
//   - invoice runs stage a pending_approval pi_case_expense plus a
//     `record_case_expense` operation, and file the invoice PDF into the
//     case's project.
// Re-entry safe by construction: the ack draft is guarded by
// run.ack_email_id, operations dedupe on idempotency keys, and the expense
// insert is preceded by a lookup on automation_run_id (so only a GENUINE
// duplicate — same vendor+invoice from another email — trips the unique
// index and routes to triage).

import type { createServerSupabase } from "../supabase";
import { createAgentOperation, updateAgentOperation } from "../operations";
import {
    retargetStaleOperationCase,
    stageExpenseOperation,
} from "./caseWrites";
import {
    createPendingEmail,
    getEmailByOperationId,
    type EmailMessage,
} from "../email/store";
import { extractAddress } from "../email/autoReply";
import { getEmailConnector } from "../connectors/registry";
import {
    findExpenseByRunId,
    getCase,
    insertExpense,
    updateExpense,
} from "../pi/store";
import { ensureCaseProject, setDocumentProject } from "../pi/project";
import { updateRun } from "./runsStore";
import { renderAckTemplate } from "./ackTemplate";
import { classifyEmailDeterministic, type RegistryEntry } from "./classify";
import { isPdfAttachment } from "./extract/pdfInputs";
import { toIsoDate, type MatchResult } from "./match";
import type { PlaybookConfig } from "./playbookConfig";
import type {
    AutomationRun,
    ClaimExtraction,
    ExtractedField,
    InvoiceExtraction,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

export type StageOutcome = { staged: true } | { triage: string };

/** A successful (non-triage) match — the only shape stage accepts. */
export type CaseMatch = Extract<MatchResult, { caseId: string }>;

/** Injectable seams so stage logic is testable without Supabase/Gmail. */
export interface StageDeps {
    createAgentOperationFn?: typeof createAgentOperation;
    updateAgentOperationFn?: typeof updateAgentOperation;
    createPendingEmailFn?: typeof createPendingEmail;
    getEmailByOperationIdFn?: typeof getEmailByOperationId;
    updateRunFn?: typeof updateRun;
    getCaseFn?: typeof getCase;
    ensureCaseProjectFn?: typeof ensureCaseProject;
    setDocumentProjectFn?: typeof setDocumentProject;
    insertExpenseFn?: typeof insertExpense;
    findExpenseByRunIdFn?: typeof findExpenseByRunId;
    updateExpenseFn?: typeof updateExpense;
    /** Best-effort RFC822 Message-ID recovery for reply threading. */
    fetchMessageIdHeaderFn?: (email: EmailMessage) => Promise<string | null>;
    /** The agent mailbox address (From on the ack draft). */
    agentAddress?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    if ((error as { code?: string }).code === "23505") return true;
    return /duplicate key|unique constraint/i.test(
        (error as { message?: string }).message ?? "",
    );
}

/**
 * The inbound row does not persist the RFC822 Message-ID (only ingest sees
 * it), so recover it from the provider when possible — In-Reply-To makes
 * the ack thread correctly in the CARRIER's mail client, not just in
 * Gmail (which threads on provider_thread_id). Strictly best-effort: any
 * failure returns null and the ack still threads via the thread id.
 */
async function defaultFetchMessageIdHeader(
    email: EmailMessage,
): Promise<string | null> {
    try {
        if (!email.provider_message_id) return null;
        const connector = getEmailConnector();
        if (!connector.isConfigured()) return null;
        const message = await connector.getMessage(email.provider_message_id);
        return message.messageIdHeader ?? null;
    } catch {
        return null;
    }
}

/** First PDF attachment's document id — provenance for staged writes. */
export function firstPdfDocumentId(
    email: Pick<EmailMessage, "attachments">,
): string | null {
    for (const ref of email.attachments ?? []) {
        if (isPdfAttachment(ref)) return ref.document_id;
    }
    return null;
}

function reliable(
    field: ExtractedField | undefined,
    fieldMin: number,
): string | null {
    if (!field) return null;
    if (field.confidence < fieldMin) return null;
    const value = field.value.trim();
    return value || null;
}

/**
 * Build the policy_upserts array staged into the proposal AND the
 * update_case_insurance operation's arguments. Required fields (carrier /
 * claim_number) always stage — the human is the gate; OPTIONAL fields
 * below the playbook field_min are omitted as unreliable.
 */
export function buildPolicyUpserts(
    extraction: ClaimExtraction,
    input: {
        runId: string;
        sourceDocumentId: string | null;
        fieldMin: number;
    },
): Record<string, unknown>[] {
    return extraction.claims.map((claim) => {
        const adjuster: Record<string, string> = {};
        const adjusterName = reliable(claim.adjuster_name, input.fieldMin);
        const adjusterEmail = reliable(claim.adjuster_email, input.fieldMin);
        const adjusterPhone = reliable(claim.adjuster_phone, input.fieldMin);
        if (adjusterName) adjuster.name = adjusterName;
        if (adjusterEmail) adjuster.email = adjusterEmail;
        if (adjusterPhone) adjuster.phone = adjusterPhone;
        const limitsText = reliable(claim.policy_limits_text, input.fieldMin);
        return {
            carrier: claim.carrier.value,
            claim_number: claim.claim_number.value,
            policy_number: reliable(claim.policy_number, input.fieldMin),
            coverage_type: reliable(claim.coverage_type, input.fieldMin),
            policy_limits: limitsText ? { raw_text: limitsText } : {},
            adjuster,
            source_document_id: input.sourceDocumentId,
            source_run_id: input.runId,
        };
    });
}

/**
 * Deterministic ack-template variables from the extraction (+ case).
 * OPTIONAL fields go through the same reliable(field, fieldMin) gate as
 * buildPolicyUpserts — a value that failed citation verification (its
 * confidence was dropped to 0) or sits below the playbook field_min must
 * never reach an outbound draft. Unreliable client name falls back to the
 * MATCHED case's client_name; unreliable adjuster name falls back to ""
 * (the template reads fine without it). The required vars (claim_number /
 * carrier) are triage-guaranteed verified before staging is reachable.
 */
export function ackTemplateVars(
    extraction: ClaimExtraction,
    caseClientName: string | null,
    fieldMin: number,
): Record<string, string> {
    const first = extraction.claims[0];
    const claimNumbers = extraction.claims
        .map((c) => c.claim_number.value.trim())
        .filter(Boolean);
    return {
        claim_number: claimNumbers.join(", "),
        carrier: first?.carrier.value ?? "",
        client_name:
            reliable(first?.client_or_insured_name, fieldMin) ??
            caseClientName ??
            "",
        adjuster_name: reliable(first?.adjuster_name, fieldMin) ?? "",
    };
}

/** `Re: <subject>` unless the subject already is a reply (autoReply's rule). */
function replySubject(subject: string): string {
    return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** What stageAckDraft produced (or why it produced nothing). */
export interface StagedAckDraft {
    ackEmailId: string | null;
    ackOpId: string | null;
    /** Set when no draft could be staged (e.g. unusable sender address). */
    noAckReason: string | null;
}

/**
 * Stage the acknowledgement draft for a claim run against a specific case:
 * the pending `auto_ack_email` operation plus its `pending_approval` email
 * row, body rendered by DETERMINISTIC template substitution only. The ONE
 * code path that shapes the ack — shared by stageClaimRun and reassignRun's
 * ack refresh — so the rendering and the draft↔operation linkage can never
 * diverge between staging and a reassign. Idempotent per `idempotencyKey`:
 * a re-entered call converges on the operation it already created, adopting
 * any draft already tied to it instead of drafting twice.
 */
export async function stageAckDraft(
    db: Db,
    input: {
        run: AutomationRun;
        email: EmailMessage;
        extraction: ClaimExtraction;
        /** The case whose client_name backs the template fallback. */
        caseId: string;
        config: PlaybookConfig;
        idempotencyKey: string;
    },
    deps: StageDeps = {},
): Promise<StagedAckDraft> {
    const { run, email, extraction, config } = input;
    const createOp = deps.createAgentOperationFn ?? createAgentOperation;
    const createEmail = deps.createPendingEmailFn ?? createPendingEmail;
    const loadCase = deps.getCaseFn ?? getCase;
    const fetchMessageIdHeader =
        deps.fetchMessageIdHeaderFn ?? defaultFetchMessageIdHeader;
    const agentAddress =
        deps.agentAddress !== undefined
            ? deps.agentAddress
            : (process.env.GMAIL_AGENT_ADDRESS ?? null);

    const to = extractAddress(email.from_address ?? "");
    if (!to || !to.includes("@")) {
        return {
            ackEmailId: null,
            ackOpId: null,
            noAckReason: "inbound sender address unusable",
        };
    }

    const piCase = await loadCase(db, run.user_id, input.caseId);
    const body =
        renderAckTemplate(
            config.ackTemplate,
            ackTemplateVars(
                extraction,
                piCase?.client_name ?? null,
                config.thresholds.fieldMin,
            ),
        ) +
        "\n\n" +
        config.signatureBlock;
    const subject = replySubject(email.subject);

    const ackOp = await createOp({
        db,
        userId: run.user_id,
        projectId: email.project_id ?? null,
        chatId: null,
        toolName: "auto_ack_email",
        actionType: "send_email",
        mutating: true,
        requiresApproval: true,
        idempotencyKey: input.idempotencyKey,
        arguments: { run_id: run.id, to: [to], subject },
    });
    // Second idempotency layer: a crash between the draft insert and the
    // updateRun that persists ack_email_id would otherwise draft twice —
    // the ack operation is idempotency-keyed, so any draft already tied to
    // it is THE draft.
    const findByOp = deps.getEmailByOperationIdFn ?? getEmailByOperationId;
    const existingDraft = ackOp ? await findByOp(db, ackOp.id) : null;
    const inReplyTo = existingDraft ? null : await fetchMessageIdHeader(email);
    const draft =
        existingDraft ??
        (await createEmail(db, {
            userId: run.user_id,
            projectId: email.project_id ?? null,
            chatId: null,
            agentOperationId: ackOp?.id ?? null,
            fromAddress: agentAddress || null,
            to: [to],
            subject,
            bodyText: body,
            attachments: [],
            providerThreadId: email.provider_thread_id,
            inReplyTo,
            replyToAddress: config.replyTo || undefined,
        }));
    if (!draft) {
        throw new Error(
            "stageAckDraft: email schema unavailable — cannot stage the acknowledgement draft",
        );
    }
    return {
        ackEmailId: draft.id,
        ackOpId: ackOp?.id ?? null,
        noAckReason: null,
    };
}

/**
 * Stage a claim-correspondence run: pending update_case_insurance
 * operation + acknowledgement draft, then run → staged.
 */
export async function stageClaimRun(
    db: Db,
    input: {
        run: AutomationRun;
        email: EmailMessage;
        extraction: ClaimExtraction;
        match: CaseMatch;
        config: PlaybookConfig;
    },
    deps: StageDeps = {},
): Promise<StageOutcome> {
    const { run, email, extraction, match, config } = input;
    const createOp = deps.createAgentOperationFn ?? createAgentOperation;
    const update = deps.updateRunFn ?? updateRun;

    const sourceDocumentId = firstPdfDocumentId(email);
    const policyUpserts = buildPolicyUpserts(extraction, {
        runId: run.id,
        sourceDocumentId,
        fieldMin: config.thresholds.fieldMin,
    });

    const proposal: Record<string, unknown> = {
        kind: "claim_correspondence",
        policy_upserts: policyUpserts,
        needs_case_confirm: match.needsCaseConfirm,
        summary: extraction.summary,
    };

    // Pending case-write operation. The idempotency key makes a re-entered
    // staging attempt converge on the operation it already created.
    const caseOp = await createOp({
        db,
        userId: run.user_id,
        chatId: null,
        toolName: "update_case_insurance",
        actionType: "case_write",
        mutating: true,
        requiresApproval: true,
        idempotencyKey: `automation:${run.id}:case-write`,
        arguments: {
            run_id: run.id,
            case_id: match.caseId,
            policy_upserts: policyUpserts,
        },
    });
    if (!caseOp) {
        throw new Error(
            "stageClaimRun: agent_operations unavailable — cannot stage a case write",
        );
    }
    await retargetStaleOperationCase(
        db,
        caseOp,
        match.caseId,
        deps.updateAgentOperationFn ?? updateAgentOperation,
    );

    // Acknowledgement draft — DETERMINISTIC template substitution only
    // (stageAckDraft). Idempotency guard: a re-entered run that already
    // drafted its ack (ack_email_id set) must not draft a second one.
    let ackEmailId = run.ack_email_id;
    let ackOpId: string | null = null;
    if (!ackEmailId) {
        const ack = await stageAckDraft(
            db,
            {
                run,
                email,
                extraction,
                caseId: match.caseId,
                config,
                idempotencyKey: `automation:${run.id}:ack`,
            },
            deps,
        );
        ackEmailId = ack.ackEmailId;
        ackOpId = ack.ackOpId;
        if (ack.noAckReason) proposal.no_ack_reason = ack.noAckReason;
    }

    const operationIds = [
        ...new Set(
            [...run.operation_ids, caseOp.id, ackOpId].filter(
                (id): id is string => !!id,
            ),
        ),
    ];
    await update(db, run.id, {
        status: "staged",
        proposal,
        ackEmailId: ackEmailId ?? null,
        operationIds,
    });
    return { staged: true };
}

/** The vendor-registry entry for this email's sender, if any. */
export function matchVendorEntry(
    email: Pick<EmailMessage, "from_address" | "subject" | "attachments">,
    vendors: RegistryEntry[],
): RegistryEntry | null {
    const matched = classifyEmailDeterministic({
        fromAddress: email.from_address ?? "",
        subject: email.subject,
        attachmentNames: (email.attachments ?? []).map((a) => a.filename),
        carriers: [],
        vendors,
    });
    return matched?.matched ?? null;
}

/**
 * Stage a vendor-invoice run: ensure the case has a project, file the
 * invoice PDF into it, insert the pending_approval expense (idempotent on
 * automation_run_id; a genuine (vendor, invoice_number) duplicate →
 * triage), stage the record_case_expense operation, then run → staged.
 */
export async function stageInvoiceRun(
    db: Db,
    input: {
        run: AutomationRun;
        email: EmailMessage;
        extraction: InvoiceExtraction;
        match: CaseMatch;
        config: PlaybookConfig;
    },
    deps: StageDeps = {},
): Promise<StageOutcome> {
    const { run, email, extraction, match, config } = input;
    const update = deps.updateRunFn ?? updateRun;
    const loadCase = deps.getCaseFn ?? getCase;
    const ensureProject = deps.ensureCaseProjectFn ?? ensureCaseProject;
    const fileDocument = deps.setDocumentProjectFn ?? setDocumentProject;
    const insert = deps.insertExpenseFn ?? insertExpense;
    const findByRun = deps.findExpenseByRunIdFn ?? findExpenseByRunId;
    const patchExpense = deps.updateExpenseFn ?? updateExpense;

    const piCase = await loadCase(db, run.user_id, match.caseId);
    if (!piCase) {
        throw new Error(
            `stageInvoiceRun: matched case ${match.caseId} not found for user`,
        );
    }
    const projectId = await ensureProject(db, piCase);
    const documentId = firstPdfDocumentId(email);
    if (documentId) await fileDocument(db, documentId, projectId);

    const vendorEntry = matchVendorEntry(email, config.vendors);
    const vendor = vendorEntry?.name ?? extraction.vendor.value;

    // Idempotent insert: re-entry reuses the expense this run already
    // staged; only a duplicate from a DIFFERENT run trips the unique index.
    // A reused expense staged against a PREVIOUS case (reassign + re-stage)
    // is retargeted to the run's current case first.
    let expense = await findByRun(db, run.user_id, run.id);
    if (expense && expense.case_id !== match.caseId) {
        expense =
            (await patchExpense(db, run.user_id, expense.id, {
                caseId: match.caseId,
            })) ?? expense;
    }
    if (!expense) {
        try {
            expense = await insert(db, {
                userId: run.user_id,
                vendor,
                caseId: match.caseId,
                invoiceNumber: extraction.invoice_number.value,
                amountCents: extraction.amount_cents,
                currency: extraction.currency.trim().toUpperCase() || "USD",
                status: "pending_approval",
                paymentPortalUrl: vendorEntry?.portal_url?.trim() || null,
                documentId,
                automationRunId: run.id,
                // Only an unambiguous ISO / US-format date reaches the date
                // column; prose dates stay in metadata rather than a guess.
                incurredAt: toIsoDate(extraction.invoice_date?.value),
                metadata: {
                    invoice_date_text: extraction.invoice_date?.value ?? null,
                    matter_reference: extraction.matter_reference?.value ?? null,
                },
            });
        } catch (err) {
            if (isUniqueViolation(err)) return { triage: "duplicate invoice" };
            throw err;
        }
    }

    const expenseOp = await stageExpenseOperation(
        db,
        {
            userId: run.user_id,
            caseId: match.caseId,
            expense,
            projectId,
            runId: run.id,
            idempotencyKey: `automation:${run.id}:case-write`,
        },
        deps,
    );

    const flagThreshold = config.expenseFlagAboveUsd;
    const flagged =
        flagThreshold !== null &&
        extraction.amount_cents > Math.round(flagThreshold * 100);

    const proposal: Record<string, unknown> = {
        kind: "vendor_invoice",
        expense_id: expense.id,
        vendor,
        invoice_number: extraction.invoice_number.value,
        amount_cents: extraction.amount_cents,
        currency: extraction.currency,
        payment_portal_url: vendorEntry?.portal_url?.trim() || null,
        document_id: documentId,
        project_id: projectId,
        needs_case_confirm: match.needsCaseConfirm,
        flagged_above_threshold: flagged,
        flag_threshold_usd: flagThreshold,
        summary: extraction.summary,
    };

    const operationIds = [
        ...new Set([...run.operation_ids, expenseOp.id]),
    ];
    await update(db, run.id, {
        status: "staged",
        proposal,
        operationIds,
    });
    return { staged: true };
}
