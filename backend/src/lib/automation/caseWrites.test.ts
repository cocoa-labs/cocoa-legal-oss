// backend/src/lib/automation/caseWrites.test.ts
//
// The generic-operations-surface applier (applyCaseWriteOperation) is the
// one automation code path a RELOADED approval card reaches, so this file
// pins its pilot-hardening guards with a scripted db (no Supabase):
//   - a non-pending operation (cancelled / succeeded / failed / …) is
//     REFUSED with a 409 and nothing is mutated — the generic approve path
//     early-returns non-pending ops unchanged and then dispatches side
//     effects anyway, and without the guard a human rejection recorded as
//     `cancelled` would be applied and overwritten to `succeeded`;
//   - a run-linked operation (arguments.run_id set) is refused toward the
//     Automation queue, closing the needs_case_confirm / reassign bypass —
//     while chat-staged writes (no run_id) keep working;
//   - the happy path (approved, chat-staged) still applies the write and
//     reconciles the operation to succeeded;
//   - applyExpenseApproval validates an operator-edited amount BEFORE any
//     write (positive integer cents only).

import assert from "node:assert/strict";
import {
    applyCaseWriteOperation,
    applyExpenseApproval,
} from "./caseWrites";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

interface DbCall {
    table: string;
    method: string;
    args: unknown[];
}

/**
 * Scripted supabase-shaped db: from(table) returns a chain that records
 * every call and resolves maybeSingle()/single() from the per-table result
 * queue (in call order). Any table without a script resolves { data: null }.
 */
function scriptedDb(script: Record<string, { data: unknown }[]> = {}) {
    const calls: DbCall[] = [];
    const queues: Record<string, { data: unknown }[]> = {};
    for (const [table, results] of Object.entries(script)) {
        queues[table] = [...results];
    }
    const db = {
        from(table: string) {
            const chain: Record<string, unknown> = {};
            for (const m of ["select", "eq", "update", "insert", "is", "order", "limit"]) {
                chain[m] = (...args: unknown[]) => {
                    calls.push({ table, method: m, args });
                    return chain;
                };
            }
            const resolve = async () => ({
                error: null,
                ...(queues[table]?.shift() ?? { data: null }),
            });
            chain.maybeSingle = resolve;
            chain.single = resolve;
            return chain;
        },
    };
    return { db: db as never, calls };
}

function opRow(partial: Record<string, unknown>): Record<string, unknown> {
    return {
        id: "op-1",
        tool_name: "update_case_insurance",
        status: "approved",
        actor_user_id: "user-1",
        arguments: {
            case_id: "case-1",
            policy_upserts: [{ carrier: "Example Mutual", claim_number: "24-1" }],
        },
        ...partial,
    };
}

async function main() {
    console.log("automation/caseWrites.test.ts");

    // ── Fix 1: status guard ─────────────────────────────────────────────────

    await test("a cancelled (human-rejected) op is refused 409 and left untouched", async () => {
        // rejectRun lands the op at status=cancelled. The generic approve
        // path (approveAgentOperation) early-returns it UNCHANGED and then
        // dispatches this applier anyway — the applier itself must refuse.
        const { db, calls } = scriptedDb({
            agent_operations: [{ data: opRow({ status: "cancelled" }) }],
        });
        const result = await applyCaseWriteOperation(db, "op-1");
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.status, 409);
            assert.match(result.detail, /cancelled/);
        }
        assert.equal(
            calls.filter((c) => c.method === "update").length,
            0,
            "NOTHING is mutated — the recorded rejection stands",
        );
        assert.ok(
            calls.every((c) => c.table === "agent_operations"),
            "no case/expense table is even read",
        );
    });

    await test("every non-executable status is refused (succeeded, failed, running, undone)", async () => {
        for (const status of ["succeeded", "failed", "running", "undone"]) {
            const { db, calls } = scriptedDb({
                agent_operations: [
                    {
                        data: opRow({
                            status,
                            tool_name: "record_case_expense",
                            arguments: { case_id: "case-1", expense_id: "exp-1" },
                        }),
                    },
                ],
            });
            const result = await applyCaseWriteOperation(db, "op-1");
            assert.equal(result.ok, false, `status=${status} must be refused`);
            if (!result.ok) assert.equal(result.status, 409);
            assert.equal(
                calls.filter((c) => c.method === "update").length,
                0,
                `status=${status}: nothing mutated`,
            );
        }
    });

    // ── Fix 2: run-linked ops belong to the Automation queue ───────────────

    await test("a run-linked op is refused toward the Automation queue, untouched", async () => {
        // Approving a run-linked write here would bypass the run-level
        // gates (needs_case_confirm, reassign retargeting, the staged
        // mutex) and leave the run parked at `staged` forever.
        const { db, calls } = scriptedDb({
            agent_operations: [
                {
                    data: opRow({
                        status: "approved",
                        arguments: {
                            run_id: "run-1",
                            case_id: "case-1",
                            policy_upserts: [{ carrier: "Example Mutual" }],
                        },
                    }),
                },
            ],
        });
        const result = await applyCaseWriteOperation(db, "op-1");
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.status, 409);
            assert.equal(
                result.detail,
                "this write belongs to automation run run-1 — approve or reject it from the Automation queue",
            );
        }
        assert.equal(
            calls.filter((c) => c.method === "update").length,
            0,
            "nothing mutated",
        );
    });

    await test("a run-linked expense op is refused the same way", async () => {
        const { db } = scriptedDb({
            agent_operations: [
                {
                    data: opRow({
                        tool_name: "record_case_expense",
                        status: "pending_approval",
                        arguments: {
                            run_id: "run-9",
                            case_id: "case-1",
                            expense_id: "exp-1",
                        },
                    }),
                },
            ],
        });
        const result = await applyCaseWriteOperation(db, "op-1");
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.status, 409);
            assert.match(result.detail, /automation run run-9/);
            assert.match(result.detail, /Automation queue/);
        }
    });

    // ── The legit path (chat-staged, spine-approved) still executes ────────

    await test("a chat-staged expense op (approved, no run_id) is applied and reconciled", async () => {
        // The spine flips pending_approval → approved just before the side
        // effect dispatch — that in-flight status must pass the guard.
        const expenseRow = {
            id: "exp-1",
            case_id: "case-1",
            user_id: "user-1",
            vendor: "SampleRecords",
            invoice_number: "INV-77",
            amount_cents: 300_000,
            currency: "USD",
            status: "approved",
            metadata: {},
        };
        const { db, calls } = scriptedDb({
            agent_operations: [
                {
                    data: opRow({
                        tool_name: "record_case_expense",
                        status: "approved",
                        arguments: { case_id: "case-1", expense_id: "exp-1" },
                    }),
                },
                { data: opRow({ status: "succeeded" }) },
            ],
            pi_case_expenses: [{ data: expenseRow }],
        });
        const result = await applyCaseWriteOperation(db, "op-1");
        assert.deepEqual(result, { ok: true });

        const expenseUpdate = calls.find(
            (c) => c.table === "pi_case_expenses" && c.method === "update",
        );
        assert.ok(expenseUpdate, "the expense write executed");
        assert.equal(
            (expenseUpdate.args[0] as Record<string, unknown>).status,
            "approved",
        );
        const opUpdate = calls.find(
            (c) => c.table === "agent_operations" && c.method === "update",
        );
        assert.ok(opUpdate, "the operation is reconciled");
        assert.equal(
            (opUpdate.args[0] as Record<string, unknown>).status,
            "succeeded",
        );
    });

    await test("a still-pending op (no spine in front) also passes the guard", async () => {
        const expenseRow = {
            id: "exp-1",
            user_id: "user-1",
            status: "approved",
            metadata: {},
        };
        const { db } = scriptedDb({
            agent_operations: [
                {
                    data: opRow({
                        tool_name: "record_case_expense",
                        status: "pending_approval",
                        arguments: { case_id: "case-1", expense_id: "exp-1" },
                    }),
                },
                { data: opRow({ status: "succeeded" }) },
            ],
            pi_case_expenses: [{ data: expenseRow }],
        });
        const result = await applyCaseWriteOperation(db, "op-1");
        assert.deepEqual(result, { ok: true });
    });

    // ── Fix 5 (applier side): amount edits are validated before any write ──

    await test("applyExpenseApproval refuses a non-positive / non-integer amount before touching the db", async () => {
        const untouchable = new Proxy(
            {},
            {
                get() {
                    throw new Error("db must not be touched on invalid input");
                },
            },
        ) as never;
        for (const bad of [0, -1, -250_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await assert.rejects(
                applyExpenseApproval(untouchable, "user-1", "exp-1", {
                    amountCents: bad,
                }),
                /positive integer/,
                `amountCents=${bad} must be rejected`,
            );
        }
    });

    await test("applyExpenseApproval still applies a valid edited amount", async () => {
        const { db, calls } = scriptedDb({
            pi_case_expenses: [
                { data: { id: "exp-1", user_id: "user-1", metadata: {} } },
            ],
        });
        await applyExpenseApproval(db, "user-1", "exp-1", {
            amountCents: 250_000,
        });
        const update = calls.find(
            (c) => c.table === "pi_case_expenses" && c.method === "update",
        );
        assert.ok(update);
        assert.equal(
            (update.args[0] as Record<string, unknown>).amount_cents,
            250_000,
        );
    });

    console.log("automation/caseWrites.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
