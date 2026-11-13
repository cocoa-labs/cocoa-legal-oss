// backend/src/lib/automation/enqueue.ts
//
// The seam between inbound-email ingestion and the automation pipeline.
// Task 4a: every COLD inbound email (one with no agent-initiated thread link)
// gets an automation_runs row, exactly once — enqueueRun leans on the unique
// email_id index for the dedupe. Task 4b's pipeline consumes those rows; its
// classifier marks non-PI mail `skipped`, so enqueueing everything cold is
// deliberate. Keep this module tiny — it is the extension point 4b builds on.

import type { createServerSupabase } from "../supabase";
import { automationEnabled } from "./env";
import { enqueueRun } from "./runsStore";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Enqueue an automation run for a cold inbound email when automation is
 * enabled. Callers MUST treat this as best-effort (fire-and-forget with a
 * catch): ingest must never fail because enqueue failed — in particular,
 * automation_runs not existing yet (migration 023 unapplied) surfaces here
 * as a rejection the caller swallows.
 */
export async function maybeEnqueueAutomation(
    db: Db,
    email: { id: string; userId: string },
    env: NodeJS.ProcessEnv = process.env,
): Promise<{ enqueued: boolean }> {
    if (!automationEnabled(env)) return { enqueued: false };
    const result = await enqueueRun(db, {
        emailId: email.id,
        userId: email.userId,
    });
    return { enqueued: result.created };
}
