import assert from "node:assert/strict";
import { evidenceForTask, type MatterTask } from "./matterTasks";

function dbWithEmail(sentAt: string) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) chain[method] = (...args: unknown[]) => { calls.push({ method, args }); return chain; };
  chain.maybeSingle = () => Promise.resolve({ data: { id: "email-1", status: "sent", sent_at: sentAt }, error: null });
  return { db: { from: () => chain } as never, calls };
}

const task: MatterTask = {
  id: "task-1", org_id: "org-1", matter_id: "matter-1", project_id: "project-1", title: "Send V2", description: null, status: "open", assignee_user_id: null, document_id: null, document_version_id: null, email_message_id: "email-1", signature_envelope_id: null, agent_operation_id: null, completion_rule: { type: "email_sent" }, completion_evidence_type: null, completion_evidence_id: null, completion_evidence_at: null, due_at: null, completed_at: null, completed_by_user_id: null, reopened_at: "2026-08-06T03:00:00Z", revision: 2, created_by_user_id: "u1", created_at: "2026-08-06T01:00:00Z", updated_at: "2026-08-06T03:00:00Z",
};

async function main() {
 const old = dbWithEmail("2026-08-06T02:00:00Z");
 assert.equal(await evidenceForTask(old.db, task), null, "pre-reopen evidence must not complete a reopened task");
 const fresh = dbWithEmail("2026-08-06T04:00:00Z");
 assert.deepEqual(await evidenceForTask(fresh.db, task), { type: "email_sent", id: "email-1", at: "2026-08-06T04:00:00Z" });
 assert.ok(fresh.calls.some((call) => call.method === "eq" && call.args[0] === "id" && call.args[1] === "email-1"), "completion must query the exact linked evidence id");
 assert.ok(fresh.calls.some((call) => call.method === "eq" && call.args[0] === "project_id" && call.args[1] === "project-1"), "completion evidence must stay project scoped");
 console.log("matterTasks.test.ts: all passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
