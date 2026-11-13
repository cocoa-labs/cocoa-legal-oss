import assert from "node:assert/strict";
import {
  checkProjectAccess,
  ensureDocAccess,
  ensureReviewAccess,
  projectRoleAllows,
  type ProjectPermission,
  type ProjectRole,
} from "./access";

assert.equal(projectRoleAllows("viewer", "read"), true);
assert.equal(projectRoleAllows("viewer", "export"), false);
assert.equal(projectRoleAllows("reviewer", "annotate"), true);
assert.equal(projectRoleAllows("reviewer", "mutate"), false);
assert.equal(projectRoleAllows("editor", "approve"), true);
assert.equal(projectRoleAllows("admin", "lifecycle"), true);
assert.equal(projectRoleAllows("owner", "admin"), true);

const roleMatrix: Record<ProjectRole, ProjectPermission[]> = {
  viewer: ["read"],
  reviewer: ["read", "annotate", "export", "tasks"],
  editor: ["read", "annotate", "export", "mutate", "approve", "tasks"],
  lawyer: ["read", "annotate", "export", "mutate", "approve", "tasks"],
  admin: ["read", "annotate", "export", "mutate", "approve", "tasks", "admin", "lifecycle"],
  owner: ["read", "annotate", "export", "mutate", "approve", "tasks", "admin", "lifecycle"],
};
const allPermissions: ProjectPermission[] = [
  "read", "annotate", "export", "mutate", "approve", "tasks", "admin", "lifecycle",
];
for (const [role, allowed] of Object.entries(roleMatrix) as [ProjectRole, ProjectPermission[]][]) {
  for (const permission of allPermissions) {
    assert.equal(
      projectRoleAllows(role, permission),
      allowed.includes(permission),
      `${role} ${permission} permission`,
    );
  }
}

function fakeDb(input: {
  project: Record<string, unknown> | null;
  membership: Record<string, unknown> | null;
}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "ilike", "limit"])
        chain[method] = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve({
          data:
            table === "projects"
              ? input.project
              : table === "matter_memberships"
                ? input.membership
                : null,
          error: null,
        });
      chain.insert = () => Promise.resolve({ error: null });
      return chain;
    },
  } as never;
}

async function main() {
  const before = process.env.TENANCY_AUTH_MODE;
  process.env.TENANCY_AUTH_MODE = "strict";
  try {
    const project = {
      id: "project-1",
      user_id: "owner-1",
      shared_with: ["legacy@example.com"],
      name: "Matter",
      cm_number: null,
      org_id: "org-1",
      matter_id: "matter-1",
      lifecycle_status: "active",
      deleted_at: null,
      legal_hold_until: null,
    };
    const legacyOnly = await checkProjectAccess(
      "project-1",
      "outsider",
      "legacy@example.com",
      fakeDb({ project, membership: null }),
    );
    assert.equal(legacyOnly.ok, false, "shared_with must never grant strict access");

    process.env.TENANCY_AUTH_MODE = "shadow";
    const shadowLegacyOnly = await checkProjectAccess(
      "project-1",
      "outsider",
      "legacy@example.com",
      fakeDb({ project, membership: null }),
    );
    assert.equal(
      shadowLegacyOnly.ok,
      false,
      "shadow comparison must never turn shared_with into an access grant",
    );
    process.env.TENANCY_AUTH_MODE = "strict";

    const viewerMutation = await checkProjectAccess(
      "project-1",
      "viewer-1",
      "viewer@example.com",
      fakeDb({ project, membership: { role: "viewer" } }),
      "mutate",
    );
    assert.equal(viewerMutation.ok, false, "viewer UUID guesses cannot mutate");

    const editorMutation = await checkProjectAccess(
      "project-1",
      "editor-1",
      "editor@example.com",
      fakeDb({ project, membership: { role: "editor" } }),
      "mutate",
    );
    assert.equal(editorMutation.ok, true);

    const creatorAfterRemovalDoc = await ensureDocAccess(
      {
        id: "document-1",
        user_id: "owner-1",
        project_id: "project-1",
        lifecycle_status: "active",
      },
      "owner-1",
      "owner@example.com",
      fakeDb({ project, membership: null }),
    );
    assert.equal(
      creatorAfterRemovalDoc.ok,
      false,
      "a creator loses linked document access immediately after removal",
    );
    const creatorAfterRemovalReview = await ensureReviewAccess(
      {
        user_id: "owner-1",
        project_id: "project-1",
      },
      "owner-1",
      "owner@example.com",
      fakeDb({ project, membership: null }),
    );
    assert.equal(
      creatorAfterRemovalReview.ok,
      false,
      "a creator loses linked review access immediately after removal",
    );

    const deleted = await checkProjectAccess(
      "project-1",
      "owner-1",
      "owner@example.com",
      fakeDb({
        project: { ...project, lifecycle_status: "deleted_pending_purge" },
        membership: { role: "owner" },
      }),
    );
    assert.equal(deleted.ok, false, "soft-deleted projects are hidden from normal reads");
  } finally {
    if (before === undefined) delete process.env.TENANCY_AUTH_MODE;
    else process.env.TENANCY_AUTH_MODE = before;
  }
  console.log("access.test.ts: all passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
