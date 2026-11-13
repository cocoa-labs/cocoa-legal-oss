/**
 * Authoritative project/document access.
 *
 * Project sharing used to be an email array on projects.shared_with. That
 * field is now compatibility-only: strict mode authorizes exclusively from
 * active matter memberships. `TENANCY_AUTH_MODE=shadow` is a temporary
 * migration aid that logs legacy/new mismatches while still enforcing the
 * membership decision. The compatibility column never grants access.
 */

import type { createServerSupabase } from "./supabase";
import { recordAuditEvent } from "./audit";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectRole =
  | "owner"
  | "admin"
  | "lawyer"
  | "editor"
  | "reviewer"
  | "viewer";

export type ProjectPermission =
  | "read"
  | "annotate"
  | "export"
  | "mutate"
  | "approve"
  | "tasks"
  | "admin"
  | "lifecycle";

const ROLE_WEIGHT: Record<ProjectRole, number> = {
  viewer: 1,
  reviewer: 2,
  lawyer: 3,
  editor: 3,
  admin: 4,
  owner: 5,
};

const PERMISSION_WEIGHT: Record<ProjectPermission, number> = {
  read: 1,
  annotate: 2,
  export: 2,
  mutate: 3,
  approve: 3,
  tasks: 2,
  admin: 4,
  lifecycle: 4,
};

export function projectRoleAllows(
  role: ProjectRole,
  permission: ProjectPermission,
): boolean {
  return ROLE_WEIGHT[role] >= PERMISSION_WEIGHT[permission];
}

function normalizeRole(value: unknown): ProjectRole | null {
  return value === "owner" ||
    value === "admin" ||
    value === "lawyer" ||
    value === "editor" ||
    value === "reviewer" ||
    value === "viewer"
    ? value
    : null;
}

type ProjectRow = {
  id: string;
  user_id: string;
  shared_with: string[] | null;
  name: string | null;
  cm_number: string | null;
  org_id: string | null;
  matter_id: string | null;
  lifecycle_status: string | null;
  deleted_at: string | null;
  legal_hold_until: string | null;
};

export type ProjectAccess =
  | {
      ok: true;
      isOwner: boolean;
      role: ProjectRole;
      project: ProjectRow;
    }
  | { ok: false; reason?: "not_found" | "not_member" | "insufficient_role" };

async function activeMatterRole(
  db: Db,
  matterId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<ProjectRole | null> {
  const { data: byUser } = await db
    .from("matter_memberships")
    .select("role, invitation_expires_at")
    .eq("matter_id", matterId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  const userRole = normalizeRole(byUser?.role);
  if (userRole) return userRole;

  const email = (userEmail ?? "").trim().toLowerCase();
  if (!email) return null;
  const { data: byEmail } = await db
    .from("matter_memberships")
    .select("role, invitation_expires_at")
    .eq("matter_id", matterId)
    .ilike("email", email)
    .eq("status", "active")
    .maybeSingle();
  return normalizeRole(byEmail?.role);
}

function legacyAllows(
  project: ProjectRow,
  userId: string,
  userEmail: string | null | undefined,
): boolean {
  if (project.user_id === userId) return true;
  const email = (userEmail ?? "").trim().toLowerCase();
  return Boolean(
    email &&
      Array.isArray(project.shared_with) &&
      project.shared_with.some((entry) => (entry ?? "").toLowerCase() === email),
  );
}

export async function checkProjectAccess(
  projectId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
  permission: ProjectPermission = "read",
): Promise<ProjectAccess> {
  const { data } = await db
    .from("projects")
    .select(
      "id, user_id, shared_with, name, cm_number, org_id, matter_id, lifecycle_status, deleted_at, legal_hold_until",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (!data) return { ok: false, reason: "not_found" };
  const project = data as ProjectRow;
  if (permission !== "lifecycle" && project.lifecycle_status !== "active") {
    return { ok: false, reason: "not_found" };
  }

  const role = project.matter_id
    ? await activeMatterRole(db, project.matter_id, userId, userEmail)
    : null;
  const strictAllowed = Boolean(role && projectRoleAllows(role, permission));

  if ((process.env.TENANCY_AUTH_MODE ?? "strict") === "shadow") {
    const legacyAllowed = legacyAllows(project, userId, userEmail);
    if (legacyAllowed !== strictAllowed) {
      console.warn("[tenancy-shadow] project authorization mismatch", {
        projectId,
        permission,
        legacyAllowed,
        membershipAllowed: strictAllowed,
      });
    }
  }

  if (!role) {
    await recordAuditEvent(db, { orgId: project.org_id, matterId: project.matter_id, projectId, actorUserId: userId, eventType: "authorization.denied", targetType: "project", targetId: projectId, outcome: "denied", metadata: { permission } });
    return { ok: false, reason: "not_member" };
  }
  if (!projectRoleAllows(role, permission)) {
    await recordAuditEvent(db, { orgId: project.org_id, matterId: project.matter_id, projectId, actorUserId: userId, actorRole: role, eventType: "authorization.denied", targetType: "project", targetId: projectId, outcome: "denied", metadata: { permission, role } });
    return { ok: false, reason: "insufficient_role" };
  }
  return { ok: true, isOwner: role === "owner", role, project };
}

export async function ensureDocAccess(
  doc: {
    id?: string;
    user_id: string;
    project_id: string | null;
    matter_id?: string | null;
    lifecycle_status?: string | null;
  },
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
  permission: ProjectPermission = "read",
  versionId?: string | null,
): Promise<{ ok: true; isOwner: boolean; role: ProjectRole } | { ok: false }> {
  let lifecycleStatus = doc.lifecycle_status;
  if (doc.id && lifecycleStatus === undefined) {
    const { data } = await db
      .from("documents")
      .select("lifecycle_status")
      .eq("id", doc.id)
      .maybeSingle();
    lifecycleStatus = data?.lifecycle_status ?? null;
  }
  if (permission !== "lifecycle" && lifecycleStatus !== "active") {
    return { ok: false };
  }
  if (doc.project_id) {
    const access = await checkProjectAccess(
      doc.project_id,
      userId,
      userEmail,
      db,
      permission,
    );
    return access.ok
      ? { ok: true, isOwner: access.isOwner, role: access.role }
      : { ok: false };
  }

  // An email grant covers the received immutable version only. It must not
  // reveal later private edits or grant access to the entire version history.
  if (permission === "read" && versionId && doc.id && doc.user_id !== userId) {
    const { data, error } = await db.from("inbound_email_attachments").select("id, email_id")
      .eq("document_id", doc.id).eq("version_id", versionId).in("status", ["ready", "partial"]);
    if (!error) {
      const { authorizedInboundAttachment } = await import("./email/inboundAttachments");
      for (const row of data ?? []) {
        if (await authorizedInboundAttachment(db, userId, row.email_id, row.id, userEmail))
          return { ok: true, isOwner: false, role: "viewer" };
      }
    }
  }

  // Standalone documents have no membership scope. Their creator is the only
  // principal with access; they are migrated into a matter when filed.
  return doc.user_id === userId
    ? { ok: true, isOwner: true, role: "owner" }
    : { ok: false };
}

export async function ensureReviewAccess(
  review: {
    user_id: string;
    project_id: string | null;
    shared_with?: string[] | null;
  },
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
  permission: ProjectPermission = "read",
): Promise<{ ok: true; isOwner: boolean; role: ProjectRole } | { ok: false }> {
  if (review.project_id) {
    const access = await checkProjectAccess(
      review.project_id,
      userId,
      userEmail,
      db,
      permission,
    );
    return access.ok
      ? { ok: true, isOwner: access.isOwner, role: access.role }
      : { ok: false };
  }
  return review.user_id === userId
    ? { ok: true, isOwner: true, role: "owner" }
    : { ok: false };
}

export async function filterAccessibleDocumentIds(
  documentIds: string[],
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<string[]> {
  if (documentIds.length === 0) return [];
  const { data: docs } = await db
    .from("documents")
    .select("id, user_id, project_id, matter_id")
    .in("id", documentIds)
    .eq("lifecycle_status", "active");
  const accessibleProjectIds = new Set(
    await listAccessibleProjectIds(userId, userEmail, db),
  );
  return ((docs ?? []) as {
    id: string;
    user_id: string;
    project_id: string | null;
  }[])
    .filter(
      (doc) =>
        (!doc.project_id && doc.user_id === userId) ||
        Boolean(doc.project_id && accessibleProjectIds.has(doc.project_id)),
    )
    .map((doc) => doc.id);
}

export async function listAccessibleProjectIds(
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<string[]> {
  const memberships: { matter_id: string }[] = [];
  const { data: byUser } = await db
    .from("matter_memberships")
    .select("matter_id")
    .eq("user_id", userId)
    .eq("status", "active");
  memberships.push(...((byUser ?? []) as { matter_id: string }[]));

  const email = (userEmail ?? "").trim().toLowerCase();
  if (email) {
    const { data: byEmail } = await db
      .from("matter_memberships")
      .select("matter_id")
      .ilike("email", email)
      .eq("status", "active");
    memberships.push(...((byEmail ?? []) as { matter_id: string }[]));
  }

  const matterIds = [...new Set(memberships.map((row) => row.matter_id))];
  if (matterIds.length === 0) return [];
  const { data: projects } = await db
    .from("projects")
    .select("id")
    .in("matter_id", matterIds)
    .eq("lifecycle_status", "active");
  return [...new Set(((projects ?? []) as { id: string }[]).map((row) => row.id))];
}

export async function listAccessibleOrganizationIds(
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<string[]> {
  const rows: { organization_id: string }[] = [];
  const { data: byUser } = await db
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active");
  rows.push(...((byUser ?? []) as { organization_id: string }[]));
  const email = (userEmail ?? "").trim().toLowerCase();
  if (email) {
    const { data: byEmail } = await db
      .from("organization_memberships")
      .select("organization_id")
      .ilike("email", email)
      .eq("status", "active");
    rows.push(...((byEmail ?? []) as { organization_id: string }[]));
  }
  return [...new Set(rows.map((row) => row.organization_id))];
}
