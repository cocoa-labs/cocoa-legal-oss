import type { createServerSupabase } from "./supabase";
import type { ProjectRole } from "./access";

type Db = ReturnType<typeof createServerSupabase>;

export class TenancyAuthorizationError extends Error {
  readonly status = 403;
  readonly code = "ORGANIZATION_ADMIN_REQUIRED";
}

export type ProjectMember = {
  id: string;
  user_id: string | null;
  email: string | null;
  display_name: string | null;
  role: ProjectRole;
  status: "active" | "invited" | "disabled";
  invitation_expires_at: string | null;
  accepted_at: string | null;
  is_current_user: boolean;
};

export async function createScopedProject(params: {
  db: Db;
  userId: string;
  userEmail?: string | null;
  name: string;
  cmNumber?: string | null;
}): Promise<Record<string, unknown>> {
  const { data: memberships } = await params.db
    .from("organization_memberships")
    .select("organization_id, role, created_at")
    .eq("user_id", params.userId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  let orgId = (memberships?.[0]?.organization_id as string | undefined) ?? null;
  if (
    orgId &&
    memberships?.[0]?.role !== "owner" &&
    memberships?.[0]?.role !== "admin"
  ) {
    throw new TenancyAuthorizationError(
      "Only an organization owner or admin can create a new matter.",
    );
  }
  if (!orgId) {
    const { data: org, error: orgError } = await params.db
      .from("organizations")
      .insert({
        name: "Cocoa Legal workspace",
        slug: `workspace-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
        created_by_user_id: params.userId,
      })
      .select("id")
      .single();
    if (orgError || !org) throw orgError ?? new Error("Failed to create organization");
    orgId = org.id as string;
    const { error: membershipError } = await params.db
      .from("organization_memberships")
      .insert({
        organization_id: orgId,
        user_id: params.userId,
        email: params.userEmail?.toLowerCase() ?? null,
        role: "owner",
        status: "active",
        accepted_at: new Date().toISOString(),
      });
    if (membershipError) throw membershipError;
    const { error: policyError } = await params.db
      .from("organization_beta_policies")
      .insert({ organization_id: orgId });
    if (policyError && policyError.code !== "23505") throw policyError;
  }

  const { data: project, error: projectError } = await params.db
    .from("projects")
    .insert({
      user_id: params.userId,
      name: params.name,
      cm_number: params.cmNumber ?? null,
      shared_with: [],
      org_id: orgId,
      lifecycle_status: "active",
    })
    .select("*")
    .single();
  if (projectError || !project) throw projectError ?? new Error("Failed to create project");

  try {
    const { data: matter, error: matterError } = await params.db
      .from("matters")
      .insert({
        organization_id: orgId,
        project_id: project.id,
        name: params.name,
        cm_number: params.cmNumber ?? null,
        created_by_user_id: params.userId,
      })
      .select("id")
      .single();
    if (matterError || !matter) throw matterError ?? new Error("Failed to create matter");

    const { error: ownerError } = await params.db.from("matter_memberships").insert({
      matter_id: matter.id,
      user_id: params.userId,
      email: params.userEmail?.toLowerCase() ?? null,
      role: "owner",
      status: "active",
      accepted_at: new Date().toISOString(),
    });
    if (ownerError) throw ownerError;

    const { data: scoped, error: updateError } = await params.db
      .from("projects")
      .update({ matter_id: matter.id, updated_at: new Date().toISOString() })
      .eq("id", project.id)
      .select("*")
      .single();
    if (updateError || !scoped) throw updateError ?? new Error("Failed to scope project");
    return scoped as Record<string, unknown>;
  } catch (error) {
    await params.db.from("projects").delete().eq("id", project.id);
    throw error;
  }
}

export async function listProjectMembers(
  db: Db,
  matterId: string,
  currentUserId: string,
): Promise<ProjectMember[]> {
  const { data, error } = await db
    .from("matter_memberships")
    .select(
      "id, user_id, email, role, status, invitation_expires_at, accepted_at, created_at",
    )
    .eq("matter_id", matterId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as Omit<ProjectMember, "display_name" | "is_current_user">[];
  const userIds = rows.flatMap((row) => (row.user_id ? [row.user_id] : []));
  const profileById = new Map<string, string | null>();
  if (userIds.length) {
    const { data: profiles } = await db
      .from("user_profiles")
      .select("user_id, display_name")
      .in("user_id", userIds);
    for (const profile of profiles ?? []) {
      profileById.set(
        profile.user_id as string,
        (profile.display_name as string | null) ?? null,
      );
    }
  }
  return rows.map((row) => ({
    ...row,
    role: row.role as ProjectRole,
    status: row.status as ProjectMember["status"],
    display_name: row.user_id ? profileById.get(row.user_id) ?? null : null,
    is_current_user: row.user_id === currentUserId,
  }));
}

export async function syncLegacySharedWith(
  db: Db,
  projectId: string,
  matterId: string,
): Promise<void> {
  const { data } = await db
    .from("matter_memberships")
    .select("email, role, status")
    .eq("matter_id", matterId)
    .in("status", ["active", "invited"]);
  const emails = [
    ...new Set(
      (data ?? [])
        .filter((row) => row.role !== "owner")
        .map((row) => String(row.email ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  await db
    .from("projects")
    .update({ shared_with: emails, updated_at: new Date().toISOString() })
    .eq("id", projectId);
}

/**
 * Disable organization-level access when a removed principal no longer has
 * any active matter membership in that organization. A membership in another
 * matter keeps organization-scoped workflows available.
 */
export async function disableOrphanedOrganizationMembership(
  db: Db,
  input: { orgId: string; userId?: string | null; email?: string | null },
): Promise<void> {
  const { data: matters } = await db
    .from("matters")
    .select("id")
    .eq("organization_id", input.orgId);
  const matterIds = (matters ?? []).map((matter) => String(matter.id));
  let activeCount = 0;
  if (matterIds.length > 0) {
    let query = db
      .from("matter_memberships")
      .select("id", { count: "exact", head: true })
      .in("matter_id", matterIds)
      .eq("status", "active");
    query = input.userId
      ? query.eq("user_id", input.userId)
      : query.ilike("email", String(input.email ?? "").trim().toLowerCase());
    const { count } = await query;
    activeCount = count ?? 0;
  }
  if (activeCount > 0) return;

  let update = db
    .from("organization_memberships")
    .update({ status: "disabled", updated_at: new Date().toISOString() })
    .eq("organization_id", input.orgId)
    .neq("role", "owner");
  update = input.userId
    ? update.eq("user_id", input.userId)
    : update.ilike("email", String(input.email ?? "").trim().toLowerCase());
  const { error } = await update;
  if (error) throw error;
}
