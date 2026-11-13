import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";
import {
  listMatterTasks,
  reconcileProjectTasks,
  type MatterTaskRuleType,
} from "../lib/matterTasks";
import { recordAuditEvent } from "../lib/audit";

export const projectTasksRouter = Router({ mergeParams: true });
projectTasksRouter.use(requireAuth);

const RULE_TYPES = new Set<MatterTaskRuleType>([
  "manual",
  "email_sent",
  "signature_completed",
  "document_version_created",
  "operation_succeeded",
]);

function requestId(res: { getHeader(name: string): unknown }): string {
  return String(res.getHeader("x-request-id") ?? "");
}

projectTasksRouter.get("/", async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = (req.params as { projectId: string }).projectId;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });
  await reconcileProjectTasks(db, projectId);
  res.json({ tasks: await listMatterTasks(db, projectId) });
});

projectTasksRouter.post("/", async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const projectId = (req.params as { projectId: string }).projectId;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok || !access.project.org_id || !access.project.matter_id)
    return void res.status(404).json({ detail: "Project not found" });

  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const rule = req.body.completion_rule?.type as MatterTaskRuleType | undefined;
  if (!title || title.length > 300)
    return void res.status(400).json({ code: "INVALID_TASK_TITLE", detail: "Task title must be between 1 and 300 characters." });
  if (!rule || !RULE_TYPES.has(rule))
    return void res.status(400).json({ code: "INVALID_TASK_RULE", detail: "Choose a supported completion rule." });

  const links = {
    document_id: typeof req.body.document_id === "string" ? req.body.document_id : null,
    document_version_id: typeof req.body.document_version_id === "string" ? req.body.document_version_id : null,
    email_message_id: typeof req.body.email_message_id === "string" ? req.body.email_message_id : null,
    signature_envelope_id: typeof req.body.signature_envelope_id === "string" ? req.body.signature_envelope_id : null,
    agent_operation_id: typeof req.body.agent_operation_id === "string" ? req.body.agent_operation_id : null,
  };
  const requiredLink: Partial<Record<MatterTaskRuleType, keyof typeof links>> = {
    email_sent: "email_message_id",
    signature_completed: "signature_envelope_id",
    document_version_created: "document_version_id",
    operation_succeeded: "agent_operation_id",
  };
  const required = requiredLink[rule];
  if (required && !links[required])
    return void res.status(400).json({ code: "TASK_EVIDENCE_TARGET_REQUIRED", detail: "This completion rule requires an exact evidence target." });

  const assigneeUserId = typeof req.body.assignee_user_id === "string" ? req.body.assignee_user_id : null;
  if (assigneeUserId) {
    const { data: assignee } = await db
      .from("matter_memberships")
      .select("id")
      .eq("matter_id", access.project.matter_id)
      .eq("user_id", assigneeUserId)
      .eq("status", "active")
      .maybeSingle();
    if (!assignee)
      return void res.status(400).json({ code: "TASK_ASSIGNEE_NOT_MEMBER", detail: "The task assignee must be an active project member." });
  }

  // Scope every supplied foreign key before inserting. A task must never be a
  // side channel for IDs from another tenant.
  const checks: PromiseLike<unknown>[] = [];
  if (links.document_id) checks.push(db.from("documents").select("id").eq("id", links.document_id).eq("project_id", projectId).maybeSingle());
  if (links.document_version_id) {
    const { data: version } = await db
      .from("document_versions")
      .select("id, document_id")
      .eq("id", links.document_version_id)
      .maybeSingle();
    const { data: parent } = version
      ? await db
          .from("documents")
          .select("id")
          .eq("id", version.document_id)
          .eq("project_id", projectId)
          .maybeSingle()
      : { data: null };
    if (!parent || (links.document_id && version?.document_id !== links.document_id))
      return void res.status(404).json({ code: "TASK_TARGET_NOT_FOUND", detail: "A linked task target was not found in this project." });
  }
  if (links.email_message_id) checks.push(db.from("email_messages").select("id").eq("id", links.email_message_id).eq("project_id", projectId).maybeSingle());
  if (links.signature_envelope_id) checks.push(db.from("signature_envelopes").select("id").eq("id", links.signature_envelope_id).eq("project_id", projectId).maybeSingle());
  if (links.agent_operation_id) checks.push(db.from("agent_operations").select("id").eq("id", links.agent_operation_id).eq("project_id", projectId).maybeSingle());
  const scoped = await Promise.all(checks);
  if (scoped.some((result) => !(result as { data?: unknown }).data))
    return void res.status(404).json({ code: "TASK_TARGET_NOT_FOUND", detail: "A linked task target was not found in this project." });

  const { data, error } = await db.from("matter_tasks").insert({
    org_id: access.project.org_id,
    matter_id: access.project.matter_id,
    project_id: projectId,
    title,
    description: typeof req.body.description === "string" ? req.body.description.trim().slice(0, 4000) : null,
    assignee_user_id: assigneeUserId,
    due_at: typeof req.body.due_at === "string" ? req.body.due_at : null,
    completion_rule: { type: rule },
    ...links,
    created_by_user_id: userId,
  }).select("*").single();
  if (error || !data) return void res.status(500).json({ code: "TASK_CREATE_FAILED", detail: "Could not create the task." });
  await reconcileProjectTasks(db, projectId);
  const { data: reconciled } = await db.from("matter_tasks").select("*").eq("id", data.id).single();
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "task.created", targetType: "matter_task", targetId: data.id, requestId: requestId(res) });
  res.status(201).json(reconciled ?? data);
});

projectTasksRouter.patch("/:taskId", async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, taskId } = req.params as { projectId: string; taskId: string };
  const expectedRevision = Number(req.body.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    return void res.status(400).json({ code: "EXPECTED_REVISION_REQUIRED", detail: "expected_revision is required." });
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "tasks");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });
  const { data: current } = await db.from("matter_tasks").select("*").eq("id", taskId).eq("project_id", projectId).maybeSingle();
  if (!current) return void res.status(404).json({ detail: "Task not found" });
  if (access.role === "reviewer") {
    if (current.assignee_user_id !== userId)
      return void res.status(403).json({ code: "TASK_NOT_ASSIGNED", detail: "Reviewers may update only tasks assigned to them." });
    const allowedKeys = new Set(["expected_revision", "status"]);
    if (Object.keys(req.body ?? {}).some((key) => !allowedKeys.has(key)) || req.body.status !== "completed")
      return void res.status(403).json({ code: "TASK_REVIEWER_MANUAL_ONLY", detail: "Reviewers may manually complete their assigned tasks but cannot edit task configuration." });
  }
  const updates: Record<string, unknown> = { revision: expectedRevision + 1, updated_at: new Date().toISOString() };
  if (typeof req.body.title === "string") {
    const nextTitle = req.body.title.trim().slice(0, 300);
    if (!nextTitle)
      return void res.status(400).json({ code: "INVALID_TASK_TITLE", detail: "Task title cannot be empty." });
    updates.title = nextTitle;
  }
  if (typeof req.body.description === "string" || req.body.description === null) updates.description = req.body.description;
  if (typeof req.body.assignee_user_id === "string") {
    const { data: assignee } = await db
      .from("matter_memberships")
      .select("id")
      .eq("matter_id", access.project.matter_id)
      .eq("user_id", req.body.assignee_user_id)
      .eq("status", "active")
      .maybeSingle();
    if (!assignee)
      return void res.status(400).json({ code: "TASK_ASSIGNEE_NOT_MEMBER", detail: "The task assignee must be an active project member." });
    updates.assignee_user_id = req.body.assignee_user_id;
  } else if (req.body.assignee_user_id === null) {
    updates.assignee_user_id = null;
  }
  if (typeof req.body.due_at === "string" || req.body.due_at === null) updates.due_at = req.body.due_at;
  if (req.body.status === "completed") {
    if (current.completion_rule?.type !== "manual")
      return void res.status(409).json({ code: "TASK_COMPLETION_EVIDENCE_REQUIRED", detail: "This task completes only from its exact linked evidence." });
    updates.status = "completed";
    updates.completed_at = new Date().toISOString();
    updates.completed_by_user_id = userId;
    updates.completion_evidence_type = "manual";
    updates.completion_evidence_id = null;
    updates.completion_evidence_at = updates.completed_at;
  }
  const { data, error } = await db.from("matter_tasks").update(updates).eq("id", taskId).eq("project_id", projectId).eq("revision", expectedRevision).select("*").maybeSingle();
  if (error) return void res.status(500).json({ code: "TASK_UPDATE_FAILED", detail: "Could not update the task." });
  if (!data) return void res.status(409).json({ code: "TASK_CONFLICT", detail: "The task changed in another session. Refresh and try again.", current_revision: current.revision });
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "task.updated", targetType: "matter_task", targetId: taskId, requestId: requestId(res) });
  res.json(data);
});

projectTasksRouter.post("/:taskId/reopen", async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, taskId } = req.params as { projectId: string; taskId: string };
  const expectedRevision = Number(req.body.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    return void res.status(400).json({ code: "EXPECTED_REVISION_REQUIRED", detail: "expected_revision is required." });
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "tasks");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });
  if (access.role === "reviewer") {
    const { data: task } = await db.from("matter_tasks").select("assignee_user_id").eq("id", taskId).eq("project_id", projectId).maybeSingle();
    if (task?.assignee_user_id !== userId)
      return void res.status(403).json({ code: "TASK_NOT_ASSIGNED", detail: "Reviewers may update only tasks assigned to them." });
  }
  const now = new Date().toISOString();
  const { data, error } = await db.from("matter_tasks").update({ status: "open", completed_at: null, completed_by_user_id: null, completion_evidence_type: null, completion_evidence_id: null, completion_evidence_at: null, reopened_at: now, revision: expectedRevision + 1, updated_at: now }).eq("id", taskId).eq("project_id", projectId).eq("revision", expectedRevision).select("*").maybeSingle();
  if (error) return void res.status(500).json({ code: "TASK_REOPEN_FAILED", detail: "Could not reopen the task." });
  if (!data) return void res.status(409).json({ code: "TASK_CONFLICT", detail: "The task changed in another session. Refresh and try again." });
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "task.reopened", targetType: "matter_task", targetId: taskId, requestId: requestId(res) });
  res.json(data);
});

projectTasksRouter.delete("/:taskId", async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, taskId } = req.params as { projectId: string; taskId: string };
  const expectedRevision = Number(req.body?.expected_revision ?? req.query.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    return void res.status(400).json({ code: "EXPECTED_REVISION_REQUIRED", detail: "expected_revision is required." });
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });
  const { data, error } = await db.from("matter_tasks").update({ status: "cancelled", revision: expectedRevision + 1, updated_at: new Date().toISOString() }).eq("id", taskId).eq("project_id", projectId).eq("revision", expectedRevision).select("id").maybeSingle();
  if (error) return void res.status(500).json({ code: "TASK_CANCEL_FAILED", detail: "Could not cancel the task." });
  if (!data) return void res.status(409).json({ code: "TASK_CONFLICT", detail: "The task changed in another session. Refresh and try again." });
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "task.cancelled", targetType: "matter_task", targetId: taskId, requestId: requestId(res) });
  res.status(204).send();
});
