import type { createServerSupabase } from "./supabase";
import { recordAuditEvent } from "./audit";

type Db = ReturnType<typeof createServerSupabase>;

export type MatterTaskStatus = "open" | "completed" | "cancelled";
export type MatterTaskRuleType =
  | "manual"
  | "email_sent"
  | "signature_completed"
  | "document_version_created"
  | "operation_succeeded";

export type MatterTask = {
  id: string;
  org_id: string;
  matter_id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MatterTaskStatus;
  assignee_user_id: string | null;
  document_id: string | null;
  document_version_id: string | null;
  email_message_id: string | null;
  signature_envelope_id: string | null;
  agent_operation_id: string | null;
  completion_rule: { type: MatterTaskRuleType };
  completion_evidence_type: string | null;
  completion_evidence_id: string | null;
  completion_evidence_at: string | null;
  due_at: string | null;
  completed_at: string | null;
  completed_by_user_id: string | null;
  reopened_at: string | null;
  revision: number;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

type Evidence = { type: MatterTaskRuleType; id: string; at: string };

function newerThanReopen(task: MatterTask, at: string | null): at is string {
  if (!at) return false;
  return !task.reopened_at || new Date(at).getTime() > new Date(task.reopened_at).getTime();
}

export async function listMatterTasks(db: Db, projectId: string): Promise<MatterTask[]> {
  const { data, error } = await db
    .from("matter_tasks")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as MatterTask[];
}

export async function evidenceForTask(db: Db, task: MatterTask): Promise<Evidence | null> {
  switch (task.completion_rule.type) {
    case "manual":
      return null;
    case "email_sent": {
      if (!task.email_message_id) return null;
      const { data } = await db
        .from("email_messages")
        .select("id, status, sent_at")
        .eq("id", task.email_message_id)
        .eq("project_id", task.project_id)
        .maybeSingle();
      return data?.status === "sent" && newerThanReopen(task, data.sent_at)
        ? { type: "email_sent", id: data.id as string, at: data.sent_at as string }
        : null;
    }
    case "signature_completed": {
      if (!task.signature_envelope_id) return null;
      const { data } = await db
        .from("signature_envelopes")
        .select("id, status, completed_at")
        .eq("id", task.signature_envelope_id)
        .eq("project_id", task.project_id)
        .maybeSingle();
      return data?.status === "completed" && newerThanReopen(task, data.completed_at)
        ? { type: "signature_completed", id: data.id as string, at: data.completed_at as string }
        : null;
    }
    case "document_version_created": {
      if (!task.document_version_id) return null;
      const { data } = await db
        .from("document_versions")
        .select("id, document_id, created_at")
        .eq("id", task.document_version_id)
        .maybeSingle();
      if (!data || !newerThanReopen(task, data.created_at as string)) return null;
      const { data: document } = await db
        .from("documents")
        .select("project_id")
        .eq("id", data.document_id)
        .eq("project_id", task.project_id)
        .maybeSingle();
      return document
        ? { type: "document_version_created", id: data.id as string, at: data.created_at as string }
        : null;
    }
    case "operation_succeeded": {
      if (!task.agent_operation_id) return null;
      const { data } = await db
        .from("agent_operations")
        .select("id, status, completed_at")
        .eq("id", task.agent_operation_id)
        .eq("project_id", task.project_id)
        .maybeSingle();
      return data?.status === "succeeded" && newerThanReopen(task, data.completed_at)
        ? { type: "operation_succeeded", id: data.id as string, at: data.completed_at as string }
        : null;
    }
  }
}

export async function reconcileProjectTasks(
  db: Db,
  projectId: string,
): Promise<number> {
  const { data, error } = await db
    .from("matter_tasks")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "open")
    .neq("completion_rule->>type", "manual");
  if (error) throw error;
  let completed = 0;
  for (const row of (data ?? []) as MatterTask[]) {
    const evidence = await evidenceForTask(db, row);
    if (!evidence) continue;
    const { data: updated } = await db
      .from("matter_tasks")
      .update({
        status: "completed",
        completed_at: evidence.at,
        completed_by_user_id: null,
        completion_evidence_type: evidence.type,
        completion_evidence_id: evidence.id,
        completion_evidence_at: evidence.at,
        revision: row.revision + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "open")
      .eq("revision", row.revision)
      .select("id")
      .maybeSingle();
    if (updated) {
      completed += 1;
      await recordAuditEvent(db, {
        orgId: row.org_id,
        matterId: row.matter_id,
        projectId: row.project_id,
        eventType: "task.auto_completed",
        targetType: "matter_task",
        targetId: row.id,
        metadata: {
          status: "completed",
          version_id:
            evidence.type === "document_version_created" ? evidence.id : null,
        },
      });
    }
  }
  return completed;
}

export function formatMatterTasksForPrompt(tasks: MatterTask[]): string[] {
  return tasks
    .filter((task) => task.status === "open")
    .slice(0, 20)
    .map((task) => {
      const due = task.due_at ? `; due ${task.due_at}` : "";
      return `- [open task ${task.id.slice(0, 8)}] ${task.title}${due}`;
    });
}
