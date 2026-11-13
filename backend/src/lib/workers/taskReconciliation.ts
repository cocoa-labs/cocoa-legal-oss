import { createServerSupabase } from "../supabase";
import { reconcileProjectTasks } from "../matterTasks";
import { claimWorkerLease, workerInstanceId } from "./leases";

let timer: NodeJS.Timeout | null = null;

export async function reconcileMatterTasksOnce(): Promise<number> {
  const db = createServerSupabase();
  const ownerId = workerInstanceId();
  if (!(await claimWorkerLease(db, "matter-task-reconciliation", ownerId, 120))) return 0;
  const { data, error } = await db
    .from("matter_tasks")
    .select("project_id")
    .eq("status", "open")
    .neq("completion_rule->>type", "manual")
    .limit(500);
  if (error) throw error;
  const projectIds = [...new Set((data ?? []).map((row) => String(row.project_id)))];
  let completed = 0;
  for (const projectId of projectIds) completed += await reconcileProjectTasks(db, projectId);
  return completed;
}

export function startMatterTaskReconciliationWorker(): void {
  if (timer || (process.env.MATTER_TASK_WORKER_ENABLED ?? "true") === "false") return;
  const run = () => void reconcileMatterTasksOnce().catch((error) =>
    console.error("[matter-tasks] reconciliation failed", { error: error instanceof Error ? error.message : String(error) }),
  );
  run();
  timer = setInterval(run, 60_000);
  timer.unref();
}
