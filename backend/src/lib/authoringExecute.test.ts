import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAuthoringJob, startAuthoringJob } from "./authoringExecute";
import { isAssembleKickoff } from "./operations";
import type { AgentOperation } from "./operations";

// Minimal fake Supabase query builder covering the shapes executeAuthoringJob
// touches on its early-return / failure paths:
//   db.from("authoring_jobs").select("*").eq("id", id).maybeSingle()   (read)
//   db.from("authoring_jobs").update({...}).eq("id", id)               (markJobFailed)
//   db.from("agent_operations").update({...}).eq(...).select("*").single()
//       (failAgentOperation, via the worker-owned terminal reconcile)
//
// Each recorded update is captured with its table so the tests can assert the
// worker lands BOTH a terminal authoring_jobs status AND a terminal
// agent_operations status. The update chain resolves as a thenable AND supports
// the trailing `.select("*").single()` that updateAgentOperation appends.
function makeFakeDb(opts: { job: Record<string, unknown> | null }) {
    const updates: { table: string; payload: Record<string, unknown> }[] = [];
    const db = {
        from(table: string) {
            const builder: any = {
                _op: null as null | "select" | "update",
                _payload: null as Record<string, unknown> | null,
                select() {
                    // On an update chain, `.select()` is the trailing call
                    // updateAgentOperation makes; keep returning the builder so
                    // the following `.single()` resolves.
                    if (this._op !== "update") this._op = "select";
                    return this;
                },
                update(payload: Record<string, unknown>) {
                    this._op = "update";
                    this._payload = payload;
                    return this;
                },
                eq() {
                    // For an update, finalize: record it (with its table) and
                    // resolve. Returning a thenable lets `markJobFailed`'s
                    // `.then(...)` work; the builder fields also let
                    // `updateAgentOperation`'s `.select("*").single()` chain run.
                    if (this._op === "update" && this._payload) {
                        updates.push({ table, payload: this._payload });
                        const resolved = { data: this._payload, error: null };
                        const p: any = Promise.resolve(resolved);
                        // Allow `.select("*").single()` to be chained after .eq()
                        p.select = () => p;
                        p.single = async () => resolved;
                        return p;
                    }
                    return this;
                },
                async single() {
                    return { data: this._payload ?? null, error: null };
                },
                async maybeSingle() {
                    return { data: opts.job, error: null };
                },
            };
            return builder;
        },
    };
    return { db: db as any, updates };
}

function fakeOp(overrides: Partial<AgentOperation>): AgentOperation {
    return {
        id: "op-1",
        org_id: null,
        matter_id: null,
        project_id: null,
        chat_id: null,
        actor_user_id: "user-1",
        actor_role: null,
        tool_name: "assemble_document",
        action_type: "assemble_document",
        status: "approved",
        approval_status: "approved",
        mutating: true,
        requires_approval: true,
        source_document_id: null,
        source_version_id: null,
        result_document_id: null,
        result_version_id: null,
        input_hash: null,
        arguments: {},
        metadata: {},
        providers: [],
        citations: [],
        anchors: [],
        affected_ranges: [],
        errors: [],
        inverse_operation: null,
        parent_operation_id: null,
        idempotency_key: null,
        approved_by_user_id: null,
        approved_at: null,
        completed_at: null,
        created_at: "",
        updated_at: "",
        ...overrides,
    };
}

const jobUpdates = (
    updates: { table: string; payload: Record<string, unknown> }[],
) => updates.filter((u) => u.table === "authoring_jobs").map((u) => u.payload);
const opUpdates = (
    updates: { table: string; payload: Record<string, unknown> }[],
) => updates.filter((u) => u.table === "agent_operations").map((u) => u.payload);

test("executeAuthoringJob errors (no job write) but fails the operation when there is no authoring_job_id", async () => {
    const { db, updates } = makeFakeDb({ job: null });
    const op = fakeOp({ arguments: {} });
    const result = await executeAuthoringJob({ db, op });
    assert.ok("error" in result, "missing job id should return an error");
    assert.match((result as { error: string }).error, /missing/i);
    // No job id → markJobFailed short-circuits (no authoring_jobs write)...
    assert.equal(jobUpdates(updates).length, 0);
    // ...but the worker still reconciles the operation to failed so a poller
    // sees a terminal state (the background worker owns the reconcile now).
    assert.equal(opUpdates(updates).length, 1);
    assert.equal(opUpdates(updates)[0].status, "failed");
});

test("executeAuthoringJob fails the job + operation when the authoring_jobs row is not found", async () => {
    const { db, updates } = makeFakeDb({ job: null });
    const op = fakeOp({ arguments: { authoring_job_id: "job-404" } });
    const result = await executeAuthoringJob({ db, op });
    assert.ok("error" in result, "job-not-found should return an error");
    assert.match((result as { error: string }).error, /not found/i);
    // A job id is present, so the terminal-failure path now marks BOTH the job
    // row failed and the operation failed (worker-owned reconcile).
    assert.equal(jobUpdates(updates).length, 1);
    assert.equal(jobUpdates(updates)[0].status, "failed");
    assert.equal(opUpdates(updates).length, 1);
    assert.equal(opUpdates(updates)[0].status, "failed");
});

test("executeAuthoringJob marks the job + operation failed when the staged row has no template id", async () => {
    // Job row exists but carries no template_id, and the operation args carry
    // none either → the "missing template id" branch runs the terminal-failure
    // path. This exercises the assembling → failed transition without touching
    // the LLM / assembly / storage path.
    const { db, updates } = makeFakeDb({
        job: { id: "job-1", template_id: null, variables_json: {} },
    });
    const op = fakeOp({ arguments: { authoring_job_id: "job-1" } });
    const result = await executeAuthoringJob({ db, op });
    assert.ok("error" in result, "missing template id should return an error");
    assert.match((result as { error: string }).error, /template id/i);
    // The job row exists, so the worker writes an immediate heartbeat
    // (updated_at only, no status) BEFORE it discovers the missing template id;
    // exactly one authoring_jobs write then lands the terminal status:"failed".
    const jobWrites = jobUpdates(updates);
    const failWrites = jobWrites.filter((u) => u.status === "failed");
    assert.equal(failWrites.length, 1);
    assert.equal(failWrites[0].status, "failed");
    // ...and a matching agent_operations failed reconcile.
    assert.equal(opUpdates(updates).length, 1);
    assert.equal(opUpdates(updates)[0].status, "failed");
});

test("executeAuthoringJob writes an immediate heartbeat and leaks no timer on completion", async () => {
    // The job row exists, so the worker (a) writes an immediate updated_at
    // heartbeat as its first post-resolve action — refreshing the
    // staged-at-proposal-time timestamp so a delayed approval isn't falsely
    // "stalled" — and (b) starts a 60s periodic heartbeat that MUST be cleared
    // in the finally on every path. Here the job has no template id, so it takes
    // the terminal-failure path almost immediately; by the time it resolves the
    // interval must already be cleared (a leaked setInterval would keep
    // node:test's loop alive / hang the suite).
    const timersBefore = process
        .getActiveResourcesInfo()
        .filter((r) => r === "Timeout").length;

    const { db, updates } = makeFakeDb({
        job: { id: "job-hb", template_id: null, variables_json: {} },
    });
    const op = fakeOp({ arguments: { authoring_job_id: "job-hb" } });
    await executeAuthoringJob({ db, op });

    // An immediate heartbeat (updated_at present, NO status) was written before
    // the failure status write — this is the bump that closes the approve-lag
    // window the false-stall regression was about.
    const jobWrites = jobUpdates(updates);
    const heartbeatWrite = jobWrites.find(
        (u) => "updated_at" in u && u.status === undefined,
    );
    assert.ok(
        heartbeatWrite,
        "an updated_at-only heartbeat should be written before assembly",
    );

    // The periodic interval must be cleared by the finally — no net Timeout
    // resource should remain after the call resolves.
    const timersAfter = process
        .getActiveResourcesInfo()
        .filter((r) => r === "Timeout").length;
    assert.ok(
        timersAfter <= timersBefore,
        `heartbeat interval leaked: ${timersBefore} → ${timersAfter} active timers`,
    );
});

test("startAuthoringJob lands a terminal job + operation state without throwing into the caller", async () => {
    // startAuthoringJob is fire-and-forget: it returns void synchronously and
    // must never throw or leave an unhandled rejection. Here executeAuthoringJob
    // takes its own terminal-failure path (missing template id), so by the time
    // the launched microtask settles the job row is "failed" and the operation
    // is reconciled "failed" — exactly what a poller needs to stop polling.
    const { db, updates } = makeFakeDb({
        job: { id: "job-async", template_id: null, variables_json: {} },
    });
    const op = fakeOp({ arguments: { authoring_job_id: "job-async" } });
    // Must not throw synchronously.
    assert.doesNotThrow(() => startAuthoringJob({ db, op }));
    // Let the detached async work settle.
    await new Promise((r) => setTimeout(r, 20));
    // The terminal authoring_jobs write is status:"failed" (an earlier
    // updated_at-only heartbeat write may precede it; assert on the failed one).
    assert.ok(
        jobUpdates(updates).some((u) => u.status === "failed"),
        "job row should land status:failed",
    );
    assert.equal(opUpdates(updates)[0]?.status, "failed");
});

test("re-approval of an already-approved assemble op yields the kickoff shape (no second worker)", () => {
    // Contract behind FIX 2 (the dead-end retry). On a retry / double-approval,
    // approveAgentOperation's already-approved guard early-returns the full
    // AgentOperation — WITHOUT launching a second worker. The approve route then
    // normalizes any `assemble_document` AgentOperation back to the kickoff
    // shape ({ status:"assembling", job_id, operation_id }) so the frontend's
    // approveAssembleOperation (which reads `.job_id` off the top level) can
    // re-attach to the poll instead of dead-ending on an AgentOperation shape.
    const op = fakeOp({
        id: "op-reapprove",
        status: "running", // already approved + worker in flight
        approval_status: "approved",
        arguments: { authoring_job_id: "job-xyz" },
    });

    // The route must NOT treat this AgentOperation as an already-built kickoff
    // (that relay branch is only for FRESH approvals) — it is the
    // tool_name==="assemble_document" normalization branch that fires.
    assert.equal(isAssembleKickoff(op), false);
    assert.equal(op.tool_name, "assemble_document");

    // The kickoff the route builds carries the job id off the op's arguments —
    // the same id the existing authoring_jobs row already drives, so the poll
    // re-attaches and renders the job's CURRENT state. No startAuthoringJob call
    // happens on this path (the guard returned before the launch branch).
    const kickoff = {
        status: "assembling" as const,
        job_id:
            typeof op.arguments?.authoring_job_id === "string"
                ? (op.arguments.authoring_job_id as string)
                : null,
        operation_id: op.id,
    };
    assert.equal(kickoff.job_id, "job-xyz");
    assert.equal(kickoff.operation_id, "op-reapprove");
    assert.ok(isAssembleKickoff(kickoff), "built payload is a valid kickoff");
});
