// backend/src/lib/automation/approve.ts
//
// The human decision surface for staged automation runs: approveRun /
// rejectRun / reassignRun. This module is the ONLY automation code path
// that executes staged case writes and the only automation path that can
// reach sendEmailNow — and even here, automationDraftsOnly() (default ON)
// keeps the acknowledgement as a pending draft the operator sends from the
// email surface.
//
// Concurrency: every terminal decision is mutexed by claimRunStep's
// conditional UPDATE (staged→approved etc.) — the loser of a double-click
// gets a 409, never a double-execute. Case writes go through the SAME
// applier functions the generic operations surface uses
// (lib/automation/caseWrites.ts), so the two approval paths cannot drift.

import type { createServerSupabase } from "../supabase";
import { updateAgentOperation } from "../operations";
import { sendEmailNow } from "../email/send";
import { cancelPendingEmail, getEmail } from "../email/store";
import { findExpenseByRunId, getCase, updateExpense } from "../pi/store";
import { ensureCaseProject, setDocumentProject } from "../pi/project";
import { applyExpenseApproval, applyPolicyUpserts } from "./caseWrites";
import { automationDraftsOnly } from "./env";
import {
    claimRunStep,
    getRun,
    updateRun,
    type AutomationRunPatch,
} from "./runsStore";
import { loadPlaybookConfig } from "./playbookConfig";
import {
    stageAckDraft,
    stageClaimRun,
    stageInvoiceRun,
    type CaseMatch,
} from "./stage";
import {
    parseClaimExtraction,
    parseInvoiceExtraction,
    type AutomationRun,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

export type RunActionResult =
    | { ok: true; sent: boolean }
    | { ok: false; status: number; detail: string };

/** Operator edits applied at approval time (shallow field overrides). */
export interface ApproveEdits {
    /** Confirms a needs_case_confirm match (required to approve one). */
    confirmCase?: boolean;
    /** Per-claim shallow overrides, merged by index into policy_upserts. */
    policyUpserts?: Record<string, unknown>[];
    /** Invoice amount override, in cents. */
    amountCents?: number;
}

/**
 * Route-layer validation for an operator amount edit: the 400 detail for
 * an unusable value, or null when the value is absent (no edit) or a
 * positive integer number of cents. The applier (applyExpenseApproval)
 * re-checks defensively; this is the message the HTTP surface returns.
 */
export function invalidAmountCentsEdit(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return "edits.amount_cents must be a positive integer number of cents (e.g. $125.50 → 12550)";
    }
    return null;
}

/** Injectable seams so the decision logic is testable without Supabase. */
export interface ApproveDeps {
    getRunFn?: typeof getRun;
    claimRunStepFn?: typeof claimRunStep;
    updateRunFn?: typeof updateRun;
    getEmailFn?: typeof getEmail;
    getCaseFn?: typeof getCase;
    findExpenseByRunIdFn?: typeof findExpenseByRunId;
    updateExpenseFn?: typeof updateExpense;
    applyPolicyUpsertsFn?: typeof applyPolicyUpserts;
    applyExpenseApprovalFn?: typeof applyExpenseApproval;
    updateAgentOperationFn?: typeof updateAgentOperation;
    sendEmailNowFn?: typeof sendEmailNow;
    cancelPendingEmailFn?: typeof cancelPendingEmail;
    loadPlaybookConfigFn?: typeof loadPlaybookConfig;
    stageClaimRunFn?: typeof stageClaimRun;
    stageInvoiceRunFn?: typeof stageInvoiceRun;
    stageAckDraftFn?: typeof stageAckDraft;
    ensureCaseProjectFn?: typeof ensureCaseProject;
    setDocumentProjectFn?: typeof setDocumentProject;
    /** Load operation rows for the run's operation_ids. */
    loadOperationsFn?: (
        db: Db,
        ids: string[],
    ) => Promise<LoadedOperation[]>;
    draftsOnlyFn?: typeof automationDraftsOnly;
}

/** The compact operation row the decision paths work from. */
export interface LoadedOperation {
    id: string;
    tool_name: string;
    status: string;
    arguments?: Record<string, unknown> | null;
}

async function defaultLoadOperations(
    db: Db,
    ids: string[],
): Promise<LoadedOperation[]> {
    if (ids.length === 0) return [];
    const { data, error } = await db
        .from("agent_operations")
        .select("id, tool_name, status, arguments")
        .in("id", ids);
    if (error) throw error;
    return (data ?? []) as LoadedOperation[];
}

const CASE_WRITE_TOOLS = new Set([
    "update_case_insurance",
    "record_case_expense",
]);

function proposalNeedsCaseConfirm(run: AutomationRun): boolean {
    return (
        (run.proposal as { needs_case_confirm?: unknown })
            ?.needs_case_confirm === true
    );
}

/** Shallow-merge operator edits into the staged proposal. */
export function applyProposalEdits(
    proposal: Record<string, unknown>,
    edits: ApproveEdits | undefined,
): Record<string, unknown> {
    if (!edits) return proposal;
    const next: Record<string, unknown> = { ...proposal };
    if (edits.policyUpserts && Array.isArray(next.policy_upserts)) {
        next.policy_upserts = (next.policy_upserts as unknown[]).map(
            (upsert, i) => {
                const override = edits.policyUpserts?.[i];
                return override &&
                    upsert &&
                    typeof upsert === "object" &&
                    !Array.isArray(upsert)
                    ? { ...(upsert as Record<string, unknown>), ...override }
                    : upsert;
            },
        );
    }
    if (edits.amountCents !== undefined) {
        next.amount_cents = edits.amountCents;
    }
    return next;
}

/**
 * Approve a staged run: execute its staged case writes, reconcile the
 * pending operations, and — unless drafts-only is on (the default) — send
 * the acknowledgement draft. Every mutating step happens strictly AFTER
 * the staged→approved claim, so a concurrent double-approve resolves to
 * one winner and one 409.
 */
export async function approveRun(
    db: Db,
    input: { runId: string; userId: string; edits?: ApproveEdits },
    deps: ApproveDeps = {},
): Promise<RunActionResult> {
    const loadRun = deps.getRunFn ?? getRun;
    const claim = deps.claimRunStepFn ?? claimRunStep;
    const update = deps.updateRunFn ?? updateRun;
    const applyPolicies = deps.applyPolicyUpsertsFn ?? applyPolicyUpserts;
    const approveExpense = deps.applyExpenseApprovalFn ?? applyExpenseApproval;
    const updateOp = deps.updateAgentOperationFn ?? updateAgentOperation;
    const send = deps.sendEmailNowFn ?? sendEmailNow;
    const loadOps = deps.loadOperationsFn ?? defaultLoadOperations;
    const draftsOnly = deps.draftsOnlyFn ?? automationDraftsOnly;

    const run = await loadRun(db, input.runId);
    if (!run) return { ok: false, status: 404, detail: "Run not found" };
    if (run.user_id !== input.userId) {
        return { ok: false, status: 403, detail: "Not your run" };
    }
    if (run.status !== "staged") {
        return {
            ok: false,
            status: 409,
            detail: `Run is ${run.status}, not staged`,
        };
    }
    if (proposalNeedsCaseConfirm(run) && input.edits?.confirmCase !== true) {
        return {
            ok: false,
            status: 409,
            detail: "The case match needs confirmation — approve with confirmCase, or reassign the run first",
        };
    }
    if (!run.case_id) {
        return { ok: false, status: 409, detail: "Run has no matched case" };
    }

    // The mutex: exactly one approver flips staged → approved.
    const won = await claim(db, run.id, "staged", "approved");
    if (!won) {
        return {
            ok: false,
            status: 409,
            detail: "Run was already approved or changed state",
        };
    }

    // Re-fetch AFTER winning the claim and execute from the FRESH snapshot:
    // a reassign that landed between our pre-check read and the claim
    // changed case_id / proposal, and applying the stale snapshot would
    // write against the old case. The pre-claim checks above are only the
    // cheap fast path; these are the authoritative ones.
    const fresh = (await loadRun(db, input.runId)) ?? run;
    const revertToStaged = async (detail: string): Promise<RunActionResult> => {
        await update(db, run.id, { status: "staged" }).catch(() => {});
        return { ok: false, status: 409, detail };
    };
    if (!fresh.case_id) {
        return revertToStaged("Run has no matched case");
    }
    if (proposalNeedsCaseConfirm(fresh) && input.edits?.confirmCase !== true) {
        return revertToStaged(
            "The case match needs confirmation — approve with confirmCase, or reassign the run first",
        );
    }

    const proposal = applyProposalEdits(fresh.proposal, input.edits);

    try {
        // Execute the staged case writes via the SHARED appliers.
        if (fresh.workflow_kind === "claim_correspondence") {
            await applyPolicies(
                db,
                fresh.case_id,
                proposal.policy_upserts,
                fresh.id,
            );
        } else if (fresh.workflow_kind === "vendor_invoice") {
            const expenseId = (proposal as { expense_id?: unknown }).expense_id;
            if (typeof expenseId !== "string" || !expenseId) {
                throw new Error("staged proposal is missing expense_id");
            }
            await approveExpense(db, fresh.user_id, expenseId, {
                ...(input.edits?.amountCents !== undefined
                    ? { amountCents: input.edits.amountCents }
                    : {}),
            });
        } else {
            throw new Error(`run has no workflow kind (${fresh.workflow_kind})`);
        }

        // Reconcile the pending CASE-WRITE operations to approved+succeeded.
        // The ack operation is deliberately left alone here: in drafts-only
        // mode it stays pending with its email; otherwise sendEmailNow
        // reconciles it as part of the send.
        const operations = await loadOps(db, fresh.operation_ids);
        for (const op of operations) {
            if (!CASE_WRITE_TOOLS.has(op.tool_name)) continue;
            // Operator edits changed what was applied — write the edited
            // values back to the operation record in the same reconcile, so
            // the ops audit trail records the arguments that actually
            // executed, not the original staging.
            let editedArguments: Record<string, unknown> | undefined;
            if (
                op.tool_name === "update_case_insurance" &&
                input.edits?.policyUpserts &&
                Array.isArray(proposal.policy_upserts)
            ) {
                editedArguments = {
                    ...(op.arguments ?? {}),
                    policy_upserts: proposal.policy_upserts,
                };
            } else if (
                op.tool_name === "record_case_expense" &&
                input.edits?.amountCents !== undefined
            ) {
                editedArguments = {
                    ...(op.arguments ?? {}),
                    amount_cents: input.edits.amountCents,
                };
            }
            await updateOp(db, op.id, {
                status: "succeeded",
                approvalStatus: "approved",
                approvedByUserId: input.userId,
                completed: true,
                ...(editedArguments ? { arguments: editedArguments } : {}),
            });
        }
    } catch (err) {
        // Execution failed AFTER the claim: put the run back to staged with
        // the error recorded so the operator can retry — never a half-lost
        // "approved but nothing happened" state.
        const message = err instanceof Error ? err.message : String(err);
        await update(db, run.id, { status: "staged", error: message }).catch(
            () => {},
        );
        return { ok: false, status: 500, detail: message };
    }

    await update(db, run.id, {
        proposal,
        error: null,
        reviewedBy: input.userId,
        reviewedAt: new Date().toISOString(),
    });

    // Acknowledgement: drafts-only (default) leaves the pending_approval
    // draft for the operator to send from the email surface. Only with the
    // safety explicitly disarmed does approval dispatch it — and a send
    // failure never un-does the case writes above.
    if (!fresh.ack_email_id) return { ok: true, sent: false };
    if (draftsOnly()) return { ok: true, sent: false };
    try {
        await send(db, fresh.ack_email_id, { approvedBy: input.userId });
        return { ok: true, sent: true };
    } catch (err) {
        const message =
            err instanceof Error ? err.message : "acknowledgement send failed";
        await update(db, run.id, { error: `ack send failed: ${message}` }).catch(
            () => {},
        );
        return { ok: true, sent: false };
    }
}

/**
 * Reject a staged or triaged run: pending operations are cancelled, the
 * acknowledgement DRAFT is cancelled — via the status-guarded
 * cancelPendingEmail, so an ack the operator already dispatched from the
 * email surface keeps its sent record (reject must never falsify what
 * actually went out) — and the run lands in `rejected` with the operator's
 * reason in triage_reason.
 */
export async function rejectRun(
    db: Db,
    input: { runId: string; userId: string; reason?: string },
    deps: ApproveDeps = {},
): Promise<RunActionResult> {
    const loadRun = deps.getRunFn ?? getRun;
    const claim = deps.claimRunStepFn ?? claimRunStep;
    const update = deps.updateRunFn ?? updateRun;
    const updateOp = deps.updateAgentOperationFn ?? updateAgentOperation;
    const cancelEmail = deps.cancelPendingEmailFn ?? cancelPendingEmail;
    const loadOps = deps.loadOperationsFn ?? defaultLoadOperations;

    const run = await loadRun(db, input.runId);
    if (!run) return { ok: false, status: 404, detail: "Run not found" };
    if (run.user_id !== input.userId) {
        return { ok: false, status: 403, detail: "Not your run" };
    }
    if (run.status !== "staged" && run.status !== "triage") {
        return {
            ok: false,
            status: 409,
            detail: `Run is ${run.status}; only staged or triage runs can be rejected`,
        };
    }
    const won = await claim(db, run.id, run.status, "rejected");
    if (!won) {
        return { ok: false, status: 409, detail: "Run changed state" };
    }

    const operations = await loadOps(db, run.operation_ids);
    for (const op of operations) {
        if (op.status !== "pending_approval") continue;
        await updateOp(db, op.id, {
            status: "cancelled",
            approvalStatus: "rejected",
            completed: true,
        });
    }
    if (run.ack_email_id) {
        // Status-guarded: only a still-pending draft is cancelled. A null
        // return means the email already left pending_approval (sent,
        // sending, failed, or cancelled) — leave its record untouched.
        const cancelled = await cancelEmail(db, run.ack_email_id);
        if (!cancelled) {
            console.log(
                `[automation] reject: ack email ${run.ack_email_id} is no longer pending (already sent or cancelled) — record left untouched`,
            );
        }
    }
    await update(db, run.id, {
        reviewedBy: input.userId,
        reviewedAt: new Date().toISOString(),
        ...(input.reason !== undefined ? { triageReason: input.reason } : {}),
    });
    return { ok: true, sent: false };
}

/**
 * Reassign a staged/triaged run to a different case (pre-approval only).
 * Staged runs are retargeted in place: run.case_id, the staged expense's
 * case, the pending case-write operation's arguments, the filed invoice
 * document, and the acknowledgement draft all move. Triage runs (e.g.
 * no-match) are re-staged against the new case via the normal stage
 * functions and land in `staged`.
 */
export async function reassignRun(
    db: Db,
    input: { runId: string; userId: string; caseId: string },
    deps: ApproveDeps = {},
): Promise<RunActionResult> {
    const loadRun = deps.getRunFn ?? getRun;
    const claim = deps.claimRunStepFn ?? claimRunStep;
    const update = deps.updateRunFn ?? updateRun;
    const loadCase = deps.getCaseFn ?? getCase;
    const loadEmail = deps.getEmailFn ?? getEmail;
    const findExpense = deps.findExpenseByRunIdFn ?? findExpenseByRunId;
    const patchExpense = deps.updateExpenseFn ?? updateExpense;
    const updateOp = deps.updateAgentOperationFn ?? updateAgentOperation;
    const loadOps = deps.loadOperationsFn ?? defaultLoadOperations;
    const loadConfig = deps.loadPlaybookConfigFn ?? loadPlaybookConfig;
    const stageClaim = deps.stageClaimRunFn ?? stageClaimRun;
    const stageInvoice = deps.stageInvoiceRunFn ?? stageInvoiceRun;
    const stageAck = deps.stageAckDraftFn ?? stageAckDraft;
    const cancelEmail = deps.cancelPendingEmailFn ?? cancelPendingEmail;
    const ensureProject = deps.ensureCaseProjectFn ?? ensureCaseProject;
    const fileDocument = deps.setDocumentProjectFn ?? setDocumentProject;

    const run = await loadRun(db, input.runId);
    if (!run) return { ok: false, status: 404, detail: "Run not found" };
    if (run.user_id !== input.userId) {
        return { ok: false, status: 403, detail: "Not your run" };
    }
    if (run.status !== "staged" && run.status !== "triage") {
        return {
            ok: false,
            status: 409,
            detail: `Run is ${run.status}; only staged or triage runs can be reassigned`,
        };
    }
    // Tenancy: the target case must belong to the SAME user.
    const targetCase = await loadCase(db, input.userId, input.caseId);
    if (!targetCase) {
        return { ok: false, status: 404, detail: "Target case not found" };
    }

    if (run.status === "staged") {
        // Retarget in place; the run stays staged.
        const expense = await findExpense(db, run.user_id, run.id);
        if (expense) {
            await patchExpense(db, run.user_id, expense.id, {
                caseId: input.caseId,
            });
        }
        const operations = await loadOps(db, run.operation_ids);
        for (const op of operations) {
            if (!CASE_WRITE_TOOLS.has(op.tool_name)) continue;
            if (op.status !== "pending_approval") continue;
            const { data } = await db
                .from("agent_operations")
                .select("arguments")
                .eq("id", op.id)
                .maybeSingle();
            const args =
                (data as { arguments?: Record<string, unknown> } | null)
                    ?.arguments ?? {};
            await updateOp(db, op.id, {
                arguments: { ...args, case_id: input.caseId },
                metadata: { reassigned_by: input.userId },
            });
        }
        // A manual assignment IS the confirmation.
        const proposal: Record<string, unknown> = {
            ...run.proposal,
            needs_case_confirm: false,
        };
        const runPatch: AutomationRunPatch = {
            caseId: input.caseId,
            matchMethod: "manual",
            matchConfidence: null,
            proposal,
        };

        if (run.workflow_kind === "vendor_invoice") {
            // Re-file the invoice PDF into the NEW case's project — the
            // mirror of stageInvoiceRun's filing — so the document does not
            // stay parked in the old case's project after the reassign.
            const projectId = await ensureProject(db, targetCase);
            const documentId =
                typeof proposal.document_id === "string" && proposal.document_id
                    ? proposal.document_id
                    : null;
            if (documentId) await fileDocument(db, documentId, projectId);
            proposal.project_id = projectId;
        }

        if (run.workflow_kind === "claim_correspondence" && run.ack_email_id) {
            // The staged ack body can embed the OLD case's client name
            // (ackTemplateVars falls back to the matched case's name), so a
            // reassign must refresh the draft. Status-guarded: only a
            // still-pending draft is replaced — an ack the operator already
            // dispatched keeps its sent record and is flagged stale instead.
            const oldAckEmailId = run.ack_email_id;
            const cancelledDraft = await cancelEmail(db, oldAckEmailId);
            // A prior reassign attempt that crashed after its cancel leaves
            // the draft `cancelled` — converge by recreating. Anything else
            // non-pending (sent / sending / failed) means the ack already
            // left the approval gate and must NOT be re-drafted.
            const supersededDraft =
                cancelledDraft ??
                (await loadEmail(db, oldAckEmailId).then((row) =>
                    row?.status === "cancelled" ? row : null,
                ));
            if (!supersededDraft) {
                proposal.ack_stale_after_reassign = true;
            } else {
                // The superseded draft's operation is spent — cancel it so
                // the op ledger matches its cancelled email.
                if (supersededDraft.agent_operation_id) {
                    await updateOp(db, supersededDraft.agent_operation_id, {
                        status: "cancelled",
                        completed: true,
                        metadata: { superseded_by_reassign: true },
                    });
                }
                if (!run.email_id) throw new Error("run has no inbound email");
                const inbound = await loadEmail(db, run.email_id);
                if (!inbound) throw new Error("inbound email not found");
                const resolved = await loadConfig(db, run.user_id);
                if (!resolved.ok) {
                    throw new Error(`playbook misconfigured: ${resolved.key}`);
                }
                const ack = await stageAck(
                    db,
                    {
                        run,
                        email: inbound,
                        extraction: parseClaimExtraction(run.extracted),
                        caseId: input.caseId,
                        config: resolved.config,
                        // Keyed on the draft being superseded: a retry of
                        // THIS reassign converges on the operation it
                        // already created; a later reassign (new
                        // ack_email_id) mints a new key.
                        idempotencyKey: `automation:${run.id}:ack:reassign:${oldAckEmailId}`,
                    },
                    {
                        getCaseFn: deps.getCaseFn,
                        updateAgentOperationFn: deps.updateAgentOperationFn,
                    },
                );
                runPatch.ackEmailId = ack.ackEmailId;
                if (ack.ackOpId) {
                    runPatch.operationIds = [
                        ...new Set([...run.operation_ids, ack.ackOpId]),
                    ];
                }
                if (ack.noAckReason) proposal.no_ack_reason = ack.noAckReason;
            }
        }

        await update(db, run.id, runPatch);
        return { ok: true, sent: false };
    }

    // Triage → re-stage against the operator-chosen case.
    const won = await claim(db, run.id, "triage", "staging");
    if (!won) {
        return { ok: false, status: 409, detail: "Run changed state" };
    }
    try {
        if (!run.email_id) throw new Error("run has no inbound email");
        const email = await loadEmail(db, run.email_id);
        if (!email) throw new Error("inbound email not found");
        const resolved = await loadConfig(db, run.user_id);
        if (!resolved.ok) {
            throw new Error(`playbook misconfigured: ${resolved.key}`);
        }
        const match: CaseMatch = {
            caseId: input.caseId,
            method: "manual",
            confidence: 1,
            needsCaseConfirm: false,
        };
        await update(db, run.id, {
            caseId: input.caseId,
            matchMethod: "manual",
            matchConfidence: null,
            triageReason: null,
        });
        const freshRun = (await loadRun(db, run.id)) ?? run;
        const outcome =
            run.workflow_kind === "vendor_invoice"
                ? await stageInvoice(db, {
                      run: freshRun,
                      email,
                      extraction: parseInvoiceExtraction(run.extracted),
                      match,
                      config: resolved.config,
                  })
                : await stageClaim(db, {
                      run: freshRun,
                      email,
                      extraction: parseClaimExtraction(run.extracted),
                      match,
                      config: resolved.config,
                  });
        if ("triage" in outcome) {
            await update(db, run.id, {
                status: "triage",
                triageReason: outcome.triage,
            });
            return { ok: false, status: 409, detail: outcome.triage };
        }
        return { ok: true, sent: false };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await update(db, run.id, {
            status: "triage",
            triageReason: run.triage_reason,
            error: message,
        }).catch(() => {});
        return { ok: false, status: 500, detail: message };
    }
}
