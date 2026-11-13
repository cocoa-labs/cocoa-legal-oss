import os from "node:os";
import type { createServerSupabase } from "../supabase";

type Db = ReturnType<typeof createServerSupabase>;

export function workerInstanceId(): string {
  return `${os.hostname()}:${process.pid}:${process.env.DEPLOYMENT_ID ?? "local"}`;
}

export async function claimWorkerLease(
  db: Db,
  leaseKey: string,
  ownerId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("claim_worker_lease", {
    p_lease_key: leaseKey,
    p_owner_id: ownerId,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw error;
  return data === true;
}
