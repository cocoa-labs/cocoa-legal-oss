import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

const SAFE_METADATA_KEYS = new Set([
  "permission",
  "role",
  "previous_role",
  "status",
  "error_code",
  "version_id",
  "document_id",
  "membership_id",
  "rows_purged",
  "objects_purged",
  // Capability suggestion chips: which capability was proposed, the proposal
  // id the confirm/dismiss ties back to, the classifier's confidence and
  // which layer produced it ("llm" | "lexical"). `confidence` is a number and
  // survives safeMetadata unchanged.
  "capability_id",
  "proposal_id",
  "result_id",
  "confidence",
  "source",
]);

function safeMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      output[key] = typeof value === "string" ? value.slice(0, 200) : value;
    }
  }
  return output;
}

export async function recordAuditEvent(
  db: Db,
  event: {
    orgId?: string | null;
    matterId?: string | null;
    projectId?: string | null;
    actorUserId?: string | null;
    actorRole?: string | null;
    eventType: string;
    targetType?: string | null;
    targetId?: string | null;
    outcome?: "succeeded" | "denied" | "failed";
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await db.from("audit_events").insert({
      org_id: event.orgId ?? null,
      matter_id: event.matterId ?? null,
      project_id: event.projectId ?? null,
      actor_user_id: event.actorUserId ?? null,
      actor_role: event.actorRole ?? null,
      event_type: event.eventType.slice(0, 100),
      target_type: event.targetType?.slice(0, 80) ?? null,
      target_id: event.targetId?.slice(0, 200) ?? null,
      outcome: event.outcome ?? "succeeded",
      request_id: event.requestId?.slice(0, 200) ?? null,
      metadata: safeMetadata(event.metadata),
    });
    if (!error) return;
    // Audit failure is visible but does not turn a completed user mutation into
    // a retry that could duplicate it. Launch readiness separately verifies
    // that the table exists.
    console.error("[audit] failed to record event", {
      eventType: event.eventType,
      code: error.code,
    });
  } catch (error) {
    console.error("[audit] failed to record event", {
      eventType: event.eventType,
      code: error instanceof Error ? error.name : "AUDIT_UNAVAILABLE",
    });
  }
}
