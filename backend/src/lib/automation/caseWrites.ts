// backend/src/lib/automation/caseWrites.ts
//
// The case-write operation spine: staging helpers for PENDING
// update_case_insurance / record_case_expense operations, and the appliers
// that execute them once approved. Two approval surfaces share the SAME
// applier functions so their effects can never diverge:
//   - approveRun (lib/automation/approve.ts) — the automation review
//     surface's direct path;
//   - POST /operations/:id/approve → runApprovedOperationSideEffect's
//     caseWrite handler → applyCaseWriteOperation (this module) — the
//     generic operations surface a reloaded card uses.
// And two STAGING paths share stageExpenseOperation (the pipeline's invoice
// staging in stage.ts and the chat agent's record_case_expense tool), so the
// operation arguments the appliers execute can never drift either.
// Idempotent by construction: policy writes go through upsertPolicy (keyed
// on case_id + claim_number) and expense approval is a status (re-)set, so
// a double-approve converges instead of duplicating.
//
// This module deliberately has no email/LLM imports — chatTools.ts can pull
// the staging helpers without creating an import cycle through
// email/autoReply.ts (which imports chatTools).

import type { createServerSupabase } from "../supabase";
import type { SendOutcome } from "../operationSideEffects";
import {
    createAgentOperation,
    updateAgentOperation,
    type AgentOperation,
} from "../operations";
import {
    getCase,
    updateExpense,
    upsertPolicy,
    type PiCaseExpense,
    type PiCasePolicyInput,
} from "../pi/store";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * A createAgentOperation idempotency hit on a re-stage can return an
 * operation whose staged arguments still aim at a PREVIOUS case (e.g. the
 * run was reassigned and re-staged). Patch the arguments' case_id to the
 * run's current case when they differ, so the generic operations surface
 * (applyCaseWriteOperation) can never execute against a stale case.
 */
export async function retargetStaleOperationCase(
    db: Db,
    op: { id: string; arguments: Record<string, unknown> },
    caseId: string,
    updateOp: typeof updateAgentOperation,
): Promise<void> {
    const staleCaseId = op.arguments?.case_id;
    if (typeof staleCaseId !== "string" || staleCaseId === caseId) return;
    await updateOp(db, op.id, {
        arguments: { ...op.arguments, case_id: caseId },
    });
}

/** Injectable seams for stageExpenseOperation (testable without Supabase). */
export interface StageExpenseOperationDeps {
    createAgentOperationFn?: typeof createAgentOperation;
    updateAgentOperationFn?: typeof updateAgentOperation;
    updateExpenseFn?: typeof updateExpense;
}

/**
 * Create (or, via the idempotency key, converge on) the PENDING
 * record_case_expense operation for a staged expense and link it to the
 * expense row. The ONE code path that shapes this operation — shared by the
 * pipeline's invoice staging (stage.ts) and the chat agent's
 * record_case_expense tool — so the arguments the approval spine executes
 * ({case_id, expense_id}) can never drift between the two. Never writes
 * case data itself; the write happens only on approval (appliers below).
 */
export async function stageExpenseOperation(
    db: Db,
    input: {
        userId: string;
        caseId: string;
        expense: Pick<PiCaseExpense, "id" | "agent_operation_id">;
        projectId?: string | null;
        chatId?: string | null;
        chatMessageId?: string | null;
        /** The automation run staging this expense (absent for chat-staged). */
        runId?: string | null;
        idempotencyKey?: string | null;
    },
    deps: StageExpenseOperationDeps = {},
): Promise<AgentOperation> {
    const createOp = deps.createAgentOperationFn ?? createAgentOperation;
    const patchExpense = deps.updateExpenseFn ?? updateExpense;

    const expenseOp = await createOp({
        db,
        userId: input.userId,
        projectId: input.projectId ?? null,
        chatId: input.chatId ?? null,
        chatMessageId: input.chatMessageId ?? null,
        toolName: "record_case_expense",
        actionType: "case_write",
        mutating: true,
        requiresApproval: true,
        idempotencyKey: input.idempotencyKey ?? null,
        arguments: {
            ...(input.runId ? { run_id: input.runId } : {}),
            case_id: input.caseId,
            expense_id: input.expense.id,
        },
    });
    if (!expenseOp) {
        throw new Error(
            "stageExpenseOperation: agent_operations unavailable — cannot stage the expense write",
        );
    }
    // An idempotency hit can return an operation staged against a PREVIOUS
    // case (reassign + re-stage) — retarget before anyone can approve it.
    await retargetStaleOperationCase(
        db,
        expenseOp,
        input.caseId,
        deps.updateAgentOperationFn ?? updateAgentOperation,
    );
    if (input.expense.agent_operation_id !== expenseOp.id) {
        await patchExpense(db, input.userId, input.expense.id, {
            agentOperationId: expenseOp.id,
        });
    }
    return expenseOp;
}

function optString(v: unknown): string | null {
    return typeof v === "string" && v.trim() ? v : null;
}

function optRecord(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
}

/**
 * Convert one staged policy_upserts entry (proposal / operation-arguments
 * JSON) into a PiCasePolicyInput. Throws on a malformed entry — an
 * approval must fail loudly rather than write a half-parsed policy.
 */
export function policyInputFromUpsert(
    upsert: unknown,
    fallbackRunId: string | null,
): PiCasePolicyInput {
    if (!upsert || typeof upsert !== "object" || Array.isArray(upsert)) {
        throw new Error("policy upsert is not an object");
    }
    const row = upsert as Record<string, unknown>;
    const carrier = optString(row.carrier);
    if (!carrier) throw new Error("policy upsert is missing carrier");
    return {
        carrier,
        claimNumber: optString(row.claim_number),
        policyNumber: optString(row.policy_number),
        coverageType: optString(row.coverage_type),
        policyLimits: optRecord(row.policy_limits) ?? {},
        adjuster: optRecord(row.adjuster) ?? {},
        sourceDocumentId: optString(row.source_document_id),
        sourceRunId: optString(row.source_run_id) ?? fallbackRunId,
    };
}

/**
 * Apply staged policy_upserts to a case via upsertPolicy (idempotent on
 * case_id + claim_number). Returns how many policies were written.
 */
export async function applyPolicyUpserts(
    db: Db,
    caseId: string,
    upserts: unknown,
    fallbackRunId: string | null,
): Promise<number> {
    if (!Array.isArray(upserts)) {
        throw new Error("policy_upserts is not an array");
    }
    let applied = 0;
    for (const upsert of upserts) {
        await upsertPolicy(db, caseId, policyInputFromUpsert(upsert, fallbackRunId));
        applied += 1;
    }
    return applied;
}

/**
 * Flip a staged expense to approved (idempotent re-set), optionally with
 * an operator-edited amount. Throws when the expense does not exist for
 * this user — an approval must never silently approve nothing — and
 * refuses a non-positive / non-integer amount BEFORE any write (the route
 * layer validates too; this is the defensive backstop for every caller).
 */
export async function applyExpenseApproval(
    db: Db,
    userId: string,
    expenseId: string,
    edits?: { amountCents?: number },
): Promise<void> {
    if (
        edits?.amountCents !== undefined &&
        (!Number.isInteger(edits.amountCents) || edits.amountCents <= 0)
    ) {
        throw new Error(
            "amountCents must be a positive integer number of cents (e.g. $125.50 → 12550)",
        );
    }
    const updated = await updateExpense(db, userId, expenseId, {
        status: "approved",
        ...(edits?.amountCents !== undefined
            ? { amountCents: edits.amountCents }
            : {}),
    });
    if (!updated) {
        throw new Error(`expense ${expenseId} not found for this user`);
    }
}

/**
 * Apply the case write an approved operation describes — the
 * generic-operations-surface path (POST /operations/:id/approve). Loads
 * the operation, verifies the target case belongs to the operation's
 * actor, applies via the shared appliers above, and reconciles the
 * operation row to succeeded (mirroring sendEmailNow's discipline).
 */
export async function applyCaseWriteOperation(
    db: Db,
    operationId: string,
): Promise<SendOutcome> {
    const { data, error } = await db
        .from("agent_operations")
        .select("id, tool_name, arguments, actor_user_id, status")
        .eq("id", operationId)
        .maybeSingle();
    if (error) {
        return {
            ok: false,
            status: 500,
            detail: `Failed to load operation: ${error.message}`,
        };
    }
    if (!data) {
        return { ok: false, status: 404, detail: "Operation not found" };
    }
    const op = data as {
        id: string;
        tool_name: string;
        arguments: Record<string, unknown> | null;
        actor_user_id: string;
        status: string;
    };
    const args = op.arguments ?? {};
    const caseId = optString(args.case_id);
    const runId = optString(args.run_id);

    // Status guard (the same discipline the email/signature handlers apply
    // to their artifact rows): approveAgentOperation early-returns a
    // non-pending operation UNCHANGED and the route dispatches side effects
    // anyway, so the applier itself must refuse anything not awaiting
    // execution. `pending_approval` is the staged state; `approved` is the
    // in-flight status the approval spine sets just before this dispatch.
    // Anything else — `cancelled` most of all — must never execute:
    // applying it would overwrite a recorded human rejection with
    // `succeeded`.
    if (op.status !== "pending_approval" && op.status !== "approved") {
        return {
            ok: false,
            status: 409,
            detail: `Operation is ${op.status} — only a pending case write can be applied`,
        };
    }

    // Run-linked writes are the Automation queue's to decide: approving
    // one here would bypass the run-level gates (needs_case_confirm, the
    // staged→approved mutex, reassign retargeting) and leave the run
    // parked at `staged` with its ack draft orphaned. Chat-staged writes
    // carry no run_id and stay approvable on this surface.
    if (runId) {
        return {
            ok: false,
            status: 409,
            detail: `this write belongs to automation run ${runId} — approve or reject it from the Automation queue`,
        };
    }

    try {
        if (op.tool_name === "update_case_insurance") {
            if (!caseId) {
                return {
                    ok: false,
                    status: 400,
                    detail: "Operation is missing case_id",
                };
            }
            // Tenancy check: the staged case must belong to the operation's
            // actor (the run's user) — an approver cannot aim it elsewhere.
            const piCase = await getCase(db, op.actor_user_id, caseId);
            if (!piCase) {
                return {
                    ok: false,
                    status: 404,
                    detail: "Target case not found for the operation's owner",
                };
            }
            const applied = await applyPolicyUpserts(
                db,
                caseId,
                args.policy_upserts,
                runId,
            );
            await updateAgentOperation(db, op.id, {
                status: "succeeded",
                completed: true,
                metadata: { applied_policy_upserts: applied },
            });
            return { ok: true };
        }

        if (op.tool_name === "record_case_expense") {
            const expenseId = optString(args.expense_id);
            if (!expenseId) {
                return {
                    ok: false,
                    status: 400,
                    detail: "Operation is missing expense_id",
                };
            }
            await applyExpenseApproval(db, op.actor_user_id, expenseId);
            await updateAgentOperation(db, op.id, {
                status: "succeeded",
                completed: true,
            });
            return { ok: true };
        }

        return {
            ok: false,
            status: 400,
            detail: `Not a case-write operation: ${op.tool_name}`,
        };
    } catch (err) {
        const detail =
            err instanceof Error ? err.message : "Case write failed";
        return { ok: false, status: 500, detail };
    }
}
