import { createServerSupabase } from "../supabase";
import { getEmail } from "./store";
import {
  reconcileEmailAttachments,
  type InboundAttachment,
} from "./inboundAttachments";

let timer: NodeJS.Timeout | undefined;
let running = false;
export async function processDueEmailAttachments(db = createServerSupabase()) {
  const { data, error } = await db
    .from("inbound_email_attachments")
    .select("*")
    .eq("retryable", true)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(20);
  if (error) throw error;
  const visited = new Set<string>();
  for (const row of (data ?? []) as InboundAttachment[]) {
    if (visited.has(row.email_id)) continue;
    visited.add(row.email_id);
    const email = await getEmail(db, row.email_id);
    if (email) await reconcileEmailAttachments(db, email);
  }
}
export function startEmailAttachmentWorker() {
  if (timer || process.env.EMAIL_ATTACHMENT_WORKER_ENABLED === "false") return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processDueEmailAttachments();
    } catch {
      console.warn("[email-attachments] retry sweep unavailable");
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  void tick();
}
