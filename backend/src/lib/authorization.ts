import type { createServerSupabase } from "./supabase";
import { checkProjectAccess, ensureDocAccess } from "./access";
import type { ProjectPermission } from "./access";
import type { MatterRole } from "./operations";

type Db = ReturnType<typeof createServerSupabase>;

export type AuthorizationAction =
    | "operation:read"
    | "operation:approve"
    | "operation:undo"
    | "document:read"
    | "document:annotate"
    | "document:mutate"
    | "document:export"
    | "project:read"
    | "matter:admin";

export type AuthorizationResource = {
    orgId?: string | null;
    matterId?: string | null;
    projectId?: string | null;
    documentId?: string | null;
    actorUserId?: string | null;
};

export type AuthorizationResult =
    | { ok: true; role: MatterRole | "actor" }
    | { ok: false; reason: string };

const ROLE_WEIGHT: Record<MatterRole, number> = {
    viewer: 1,
    reviewer: 2,
    editor: 3,
    lawyer: 3,
    admin: 4,
    owner: 5,
};

const ACTION_MIN_WEIGHT: Record<AuthorizationAction, number> = {
    "operation:read": 1,
    "operation:approve": 3,
    "operation:undo": 3,
    "document:read": 1,
    "document:annotate": 2,
    "document:mutate": 3,
    "document:export": 2,
    "project:read": 1,
    "matter:admin": 4,
};

function normalizeRole(value: unknown): MatterRole | null {
    if (
        value === "owner" ||
        value === "admin" ||
        value === "lawyer" ||
        value === "editor" ||
        value === "reviewer" ||
        value === "viewer"
    ) {
        return value;
    }
    return null;
}

function roleAllows(role: MatterRole, action: AuthorizationAction): boolean {
    return ROLE_WEIGHT[role] >= ACTION_MIN_WEIGHT[action];
}

function projectPermissionFor(action: AuthorizationAction): ProjectPermission {
    if (action === "matter:admin") return "admin";
    if (action === "operation:approve" || action === "operation:undo")
        return "approve";
    if (action === "document:mutate") return "mutate";
    if (action === "document:annotate") return "annotate";
    if (action === "document:export") return "export";
    return "read";
}

async function activeMembershipRole(params: {
    db: Db;
    table: "matter_memberships" | "organization_memberships";
    scopeColumn: "matter_id" | "organization_id";
    scopeId: string;
    userId: string;
    userEmail?: string | null;
}): Promise<MatterRole | null> {
    const { data: userRow } = await params.db
        .from(params.table)
        .select("role")
        .eq(params.scopeColumn, params.scopeId)
        .eq("user_id", params.userId)
        .eq("status", "active")
        .maybeSingle();
    const userRole = normalizeRole(userRow?.role);
    if (userRole) return userRole;

    const email = (params.userEmail ?? "").trim();
    if (!email) return null;
    const { data: emailRow } = await params.db
        .from(params.table)
        .select("role")
        .eq(params.scopeColumn, params.scopeId)
        .ilike("email", email)
        .eq("status", "active")
        .maybeSingle();
    return normalizeRole(emailRow?.role);
}

async function loadDocumentScope(
    db: Db,
    documentId: string,
): Promise<{
    user_id: string;
    project_id: string | null;
    org_id?: string | null;
    matter_id?: string | null;
} | null> {
    const { data } = await db
        .from("documents")
        .select("user_id, project_id, org_id, matter_id")
        .eq("id", documentId)
        .maybeSingle();
    return (data ?? null) as {
        user_id: string;
        project_id: string | null;
        org_id?: string | null;
        matter_id?: string | null;
    } | null;
}

export async function authorize(params: {
    db: Db;
    userId: string;
    userEmail?: string | null;
    action: AuthorizationAction;
    resource: AuthorizationResource;
}): Promise<AuthorizationResult> {
    const resource = { ...params.resource };
    if (resource.documentId && (!resource.orgId || !resource.matterId)) {
        const doc = await loadDocumentScope(params.db, resource.documentId);
        if (!doc) return { ok: false, reason: "Document not found" };
        resource.projectId = resource.projectId ?? doc.project_id;
        resource.orgId = resource.orgId ?? doc.org_id ?? null;
        resource.matterId = resource.matterId ?? doc.matter_id ?? null;
    }

    if (resource.matterId) {
        const role = await activeMembershipRole({
            db: params.db,
            table: "matter_memberships",
            scopeColumn: "matter_id",
            scopeId: resource.matterId,
            userId: params.userId,
            userEmail: params.userEmail,
        });
        if (role && roleAllows(role, params.action)) return { ok: true, role };
        return {
            ok: false,
            reason: role
                ? "Matter role lacks permission"
                : "No active matter membership",
        };
    }

    if (resource.orgId) {
        const role = await activeMembershipRole({
            db: params.db,
            table: "organization_memberships",
            scopeColumn: "organization_id",
            scopeId: resource.orgId,
            userId: params.userId,
            userEmail: params.userEmail,
        });
        if (role && roleAllows(role, params.action)) return { ok: true, role };
        return {
            ok: false,
            reason: role
                ? "Organization role lacks permission"
                : "No active organization membership",
        };
    }

    if (
        params.action === "operation:read" &&
        resource.actorUserId === params.userId
    ) {
        return { ok: true, role: "actor" };
    }

    if (resource.documentId) {
        const doc = await loadDocumentScope(params.db, resource.documentId);
        if (!doc) return { ok: false, reason: "Document not found" };
        const access = await ensureDocAccess(
            doc,
            params.userId,
            params.userEmail,
            params.db,
            projectPermissionFor(params.action),
        );
        if (!access.ok) return { ok: false, reason: "No document access" };
        return {
            ok: true,
            role: access.role,
        };
    }

    if (resource.projectId) {
        const access = await checkProjectAccess(
            resource.projectId,
            params.userId,
            params.userEmail,
            params.db,
            projectPermissionFor(params.action),
        );
        if (!access.ok) return { ok: false, reason: "No project access" };
        return {
            ok: true,
            role: access.role,
        };
    }

    // An actor may approve their OWN operation when it carries no matter / org /
    // document / project scope — e.g. an email or signature draft created in a
    // general Assistant chat. (The dedicated /email/:id/approve and
    // /signatures/:id/approve routes use the same owner model.) Scoped operations
    // are handled by the branches above, which return first, so this grant is
    // limited to the orphan, owner-created case and never widens scoped access.
    if (
        params.action === "operation:approve" &&
        resource.actorUserId === params.userId
    ) {
        return { ok: true, role: "actor" };
    }

    return { ok: false, reason: "No authorizable resource scope" };
}
