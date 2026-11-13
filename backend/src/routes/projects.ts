import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  insertDocumentVersionCompat,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey } from "../lib/storage";
import { convertedPdfKey } from "../lib/convert";
import { checkProjectAccess, listAccessibleProjectIds } from "../lib/access";
import { resolveVersionProvenance } from "../lib/provenance";
import { singleFileUpload } from "../lib/upload";
import { mimeForExtension } from "../lib/uploadTypes";
import { handleDocumentUpload } from "../lib/documentUpload";
import {
  getProjectActionState,
  getProjectDocumentActionState,
} from "../lib/documentActionState";
import {
  createScopedProject,
  disableOrphanedOrganizationMembership,
  listProjectMembers,
  syncLegacySharedWith,
  TenancyAuthorizationError,
} from "../lib/tenancy";
import { recordAuditEvent } from "../lib/audit";
import { betaModeEnabled, projectBetaPolicyView } from "../lib/betaPolicy";
import {
  ensureVersionExportable,
  ensureVersionPdfRenditionExportable,
} from "../lib/documentLayoutGate";
import { layoutQaHttpError } from "../lib/documentLayoutQa";

export const projectsRouter = Router();
const VISIBLE_VERSION_SOURCES = new Set([
  "upload",
  "user_upload",
  "assistant_edit",
  "assistant_highlight",
  "assistant_undo",
  "generated",
  "authored",
  "clean_final",
]);

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringMeta(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value ? value : null;
}

function normalizeDerivationKind(kind: string | null, source: string | null) {
  if (kind) return kind;
  if (source === "clean_final") return "clean_final";
  if (source === "generated") return "generated_docx";
  if (source === "user_upload") return "copied_document";
  return "derived_document";
}

function missingDocumentVersionColumn(error: unknown): string | null {
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  const patterns = [
    /'([^']+)' column of 'document_versions'/i,
    /column document_versions\.([a-zA-Z0-9_]+) does not exist/i,
    /column "([^"]+)" of relation "document_versions" does not exist/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchDocumentTreeVersionRows(
  db: ReturnType<typeof createServerSupabase>,
  docIds: string[],
) {
  if (docIds.length === 0) return [];

  const requiredColumns = [
    "id",
    "document_id",
    "version_number",
    "source",
    "created_at",
    "display_name",
  ];
  let optionalColumns = [
    "metadata",
    "created_by_user_id",
    "parent_version_id",
    "created_by_operation_id",
    "layout_qa_status",
    "layout_qa_report",
    "layout_qa_checked_at",
  ];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { data, error } = await db
      .from("document_versions")
      .select([...requiredColumns, ...optionalColumns].join(", "))
      .in("document_id", docIds)
      .order("created_at", { ascending: true });
    if (!error) return (data ?? []) as unknown as Record<string, unknown>[];

    const missing = missingDocumentVersionColumn(error);
    if (missing && optionalColumns.includes(missing)) {
      optionalColumns = optionalColumns.filter((column) => column !== missing);
      continue;
    }

    throw error;
  }

  return [];
}

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const db = createServerSupabase();

  const projectIds = await listAccessibleProjectIds(userId, userEmail, db);
  if (projectIds.length === 0) return void res.json([]);
  const { data: projectRows, error: projectsError } = await db
    .from("projects")
    .select("*")
    .in("id", projectIds)
    .eq("lifecycle_status", "active")
    .order("created_at", { ascending: false });
  if (projectsError)
    return void res.status(500).json({ detail: projectsError.message });
  const projects = projectRows ?? [];

  // Three batched queries instead of three count queries PER project — the
  // old 3N+2 pattern made a 20-project list issue 62 round-trips. Fetch only
  // project_id and group client-side. Counts stay exact up to the PostgREST
  // max-rows cap per query (the explicit limit below is a best-effort raise);
  // a query error degrades that count to 0, matching the old `count ?? 0`.
  const visibleProjectIds = projects.map((p) => p.id as string);
  const COUNT_ROW_CAP = 20000;
  const [docRows, chatRows, reviewRows] =
    visibleProjectIds.length > 0
      ? await Promise.all(
          (["documents", "chats", "tabular_reviews"] as const).map((table) =>
            db
              .from(table)
              .select("project_id")
              .in("project_id", visibleProjectIds)
              .limit(COUNT_ROW_CAP),
          ),
        )
      : [];
  const countByProject = (
    rows: { data: unknown; error: { message: string } | null } | undefined,
    label: string,
  ) => {
    if (rows?.error)
      console.warn(`[projects] ${label} count query failed:`, rows.error.message);
    const counts = new Map<string, number>();
    for (const row of (rows?.data ?? []) as { project_id: string | null }[]) {
      if (!row.project_id) continue;
      counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1);
    }
    return counts;
  };
  const docCounts = countByProject(docRows, "documents");
  const chatCounts = countByProject(chatRows, "chats");
  const reviewCounts = countByProject(reviewRows, "tabular_reviews");
  const matterIds = projects
    .map((project) => project.matter_id as string | null)
    .filter((matterId): matterId is string => Boolean(matterId));
  const [byUser, byEmail] = matterIds.length
    ? await Promise.all([
        db
          .from("matter_memberships")
          .select("matter_id, role")
          .in("matter_id", matterIds)
          .eq("user_id", userId)
          .eq("status", "active"),
        userEmail
          ? db
              .from("matter_memberships")
              .select("matter_id, role")
              .in("matter_id", matterIds)
              .ilike("email", userEmail.trim().toLowerCase())
              .eq("status", "active")
          : Promise.resolve({ data: [] }),
      ])
    : [{ data: [] }, { data: [] }];
  const roleByMatter = new Map<string, string>();
  for (const membership of [...(byEmail.data ?? []), ...(byUser.data ?? [])])
    roleByMatter.set(String(membership.matter_id), String(membership.role));

  res.json(
    projects.map((p) => {
      const role = roleByMatter.get(String(p.matter_id)) ?? "viewer";
      return {
        ...p,
        is_owner: role === "owner",
        current_user_role: role,
        document_count: docCounts.get(p.id) ?? 0,
        chat_count: chatCounts.get(p.id) ?? 0,
        review_count: reviewCounts.get(p.id) ?? 0,
      };
    }),
  );
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { name, cm_number } = req.body as {
    name: string;
    cm_number?: string;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });
  const db = createServerSupabase();
  try {
    const data = await createScopedProject({
      db,
      userId,
      userEmail,
      name: name.trim(),
      cmNumber: cm_number ?? null,
    });
    res.status(201).json({ ...data, is_owner: true, documents: [] });
  } catch (error) {
    const denied = error instanceof TenancyAuthorizationError;
    res.status(denied ? error.status : 500).json({
      code: denied ? error.code : "PROJECT_CREATE_FAILED",
      detail: error instanceof Error ? error.message : "Failed to create project",
    });
  }
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || project.lifecycle_status !== "active")
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).eq("lifecycle_status", "active").order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  res.json({
    ...project,
    is_owner: access.isOwner,
    current_user_role: access.role,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/document-tree
// Project-scoped document tree for the Doc Review workspace. It keeps
// document versions on their source document while grouping generated/copied
// companion documents under the document version they came from.
projectsRouter.get("/:projectId/document-tree", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db
      .from("documents")
      .select("*")
      .eq("project_id", projectId)
      .eq("lifecycle_status", "active")
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
  ]);

  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);

  const docIds = docsTyped.map((doc) => doc.id);
  const versionRows = await fetchDocumentTreeVersionRows(db, docIds);

  // Attach the producing conversation turn to each version (the "conversation
  // that led to this version"). Defensive: a provenance failure must never
  // break the tree, which is core Doc Review UI — degrade to no provenance.
  let provByVersion = new Map<string, unknown>();
  try {
    provByVersion = (await resolveVersionProvenance(
      db,
      versionRows.map((row) => String(row.id)),
    )) as Map<string, unknown>;
  } catch (err) {
    console.error("[document-tree] provenance resolution failed:", err);
  }
  for (const row of versionRows) {
    row.provenance = provByVersion.get(String(row.id)) ?? null;
  }

  const versionsByDocId = new Map<string, Record<string, unknown>[]>();
  for (const row of versionRows) {
    const documentId = String(row.document_id ?? "");
    const source = typeof row.source === "string" ? row.source : "";
    if (!documentId || !VISIBLE_VERSION_SOURCES.has(source)) continue;
    const list = versionsByDocId.get(documentId) ?? [];
    list.push(row);
    versionsByDocId.set(documentId, list);
  }

  const docById = new Map(docsTyped.map((doc) => [doc.id, doc]));
  const derivedBySourceDocId = new Map<string, unknown[]>();
  const derivedDocumentIds = new Set<string>();

  for (const doc of docsTyped) {
    const versions = versionsByDocId.get(doc.id) ?? [];
    const current =
      versions.find((version) => version.id === doc.current_version_id) ??
      versions[versions.length - 1] ??
      null;
    if (!current) continue;

    const metadata = toRecord(current.metadata);
    const sourceDocumentId = stringMeta(metadata, "source_document_id");
    if (
      !sourceDocumentId ||
      sourceDocumentId === doc.id ||
      !docById.has(sourceDocumentId)
    ) {
      continue;
    }

    const sourceVersionId =
      stringMeta(metadata, "source_version_id") ??
      (typeof current.parent_version_id === "string"
        ? current.parent_version_id
        : null);
    const operationId =
      stringMeta(metadata, "operation_id") ??
      (typeof current.created_by_operation_id === "string"
        ? current.created_by_operation_id
        : null);
    const derivationKind = normalizeDerivationKind(
      stringMeta(metadata, "derivation_kind"),
      typeof current.source === "string" ? current.source : null,
    );

    derivedDocumentIds.add(doc.id);
    const list = derivedBySourceDocId.get(sourceDocumentId) ?? [];
    list.push({
      document: doc,
      version: current,
      source_document_id: sourceDocumentId,
      source_version_id: sourceVersionId,
      derivation_kind: derivationKind,
      operation_id: operationId,
    });
    derivedBySourceDocId.set(sourceDocumentId, list);
  }

  res.json({
    project_id: projectId,
    folders: folderData ?? [],
    documents: docsTyped.map((doc) => ({
      document: doc,
      versions: versionsByDocId.get(doc.id) ?? [],
      derived_documents: derivedBySourceDocId.get(doc.id) ?? [],
      is_derived: derivedDocumentIds.has(doc.id),
    })),
  });
});

// GET /projects/:projectId/versions/:versionId/provenance
// The conversation turn + operations that produced a specific version. Powers
// the right-panel "Chain of custody" detail view in Doc Review.
projectsRouter.get(
  "/:projectId/versions/:versionId/provenance",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, versionId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data: version } = await db
      .from("document_versions")
      .select(
        "id, document_id, version_number, source, display_name, created_at",
      )
      .eq("id", versionId)
      .maybeSingle();
    if (!version)
      return void res.status(404).json({ detail: "Version not found" });

    // Confirm the version's document belongs to this project.
    const { data: ownerDoc } = await db
      .from("documents")
      .select("id, project_id, filename")
      .eq("id", version.document_id)
      .maybeSingle();
    if (!ownerDoc || ownerDoc.project_id !== projectId)
      return void res.status(404).json({ detail: "Version not found" });

    const provMap = await resolveVersionProvenance(db, [versionId]);
    const prov = provMap.get(versionId) ?? null;

    const { data: editRows } = await db
      .from("document_edits")
      .select("status")
      .eq("version_id", versionId);
    const edits = (editRows ?? []) as { status: string }[];
    const editsSummary = {
      count: edits.length,
      accepted: edits.filter((e) => e.status === "accepted").length,
      rejected: edits.filter((e) => e.status === "rejected").length,
      pending: edits.filter((e) => e.status === "pending").length,
    };

    const { data: operations } = await db
      .from("agent_operations")
      .select("id, tool_name, action_type, status, chat_id, created_at")
      .eq("result_version_id", versionId)
      .order("created_at", { ascending: true });

    let producingChat: { id: string; title: string | null } | null = null;
    if (prov?.chat_id) {
      const { data: chat } = await db
        .from("chats")
        .select("id, title")
        .eq("id", prov.chat_id)
        .maybeSingle();
      if (chat)
        producingChat = {
          id: chat.id as string,
          title: (chat.title as string | null) ?? null,
        };
    }

    // The producing turn: the user message + the assistant reply that
    // immediately followed it.
    let messages: unknown[] = [];
    if (prov?.chat_message_id) {
      const { data: userMsg } = await db
        .from("chat_messages")
        .select("id, role, content, created_at, chat_id")
        .eq("id", prov.chat_message_id)
        .maybeSingle();
      if (userMsg) {
        const { data: replies } = await db
          .from("chat_messages")
          .select("id, role, content, annotations, created_at")
          .eq("chat_id", userMsg.chat_id)
          .gt("created_at", userMsg.created_at as string)
          .order("created_at", { ascending: true })
          .limit(1);
        messages = [userMsg, ...(replies ?? [])];
      }
    }

    res.json({
      version,
      document: { id: ownerDoc.id, filename: ownerDoc.filename },
      provenance: prov,
      producing_chat: producingChat,
      messages,
      operations: operations ?? [],
      edits_summary: editsSummary,
    });
  },
);

// GET /projects/:projectId/version-graph
// The project's version × conversation graph for the dedicated History view:
// version nodes (with lineage + provenance), the conversation branches that
// forked off them, and the edges between. Defensive throughout — provenance or
// fork-column failures degrade rather than break the view.
projectsRouter.get(
  "/:projectId/version-graph",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const { data: docs } = await db
      .from("documents")
      .select("id, filename, current_version_id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    const docList = (docs ?? []) as {
      id: string;
      filename: string;
      current_version_id?: string | null;
    }[];
    const docIds = docList.map((d) => d.id);

    const versionRows = await fetchDocumentTreeVersionRows(db, docIds);
    let provByVersion = new Map<string, unknown>();
    try {
      provByVersion = (await resolveVersionProvenance(
        db,
        versionRows.map((r) => String(r.id)),
      )) as Map<string, unknown>;
    } catch (err) {
      console.error("[version-graph] provenance failed:", err);
    }

    const docName = new Map(docList.map((d) => [d.id, d.filename]));
    const currentVersionIds = new Set(
      docList
        .map((d) => d.current_version_id)
        .filter((v): v is string => typeof v === "string"),
    );
    const versionNodes = versionRows
      .filter((r) => VISIBLE_VERSION_SOURCES.has(String(r.source ?? "")))
      .map((r) => ({
        id: String(r.id),
        document_id: String(r.document_id ?? ""),
        filename: docName.get(String(r.document_id ?? "")) ?? null,
        version_number: (r.version_number as number | null) ?? null,
        source: String(r.source ?? ""),
        created_at: r.created_at ?? null,
        parent_version_id: (r.parent_version_id as string | null) ?? null,
        is_current: currentVersionIds.has(String(r.id)),
        provenance: provByVersion.get(String(r.id)) ?? null,
      }));
    const versionIds = new Set(versionNodes.map((n) => n.id));

    // Conversation branches in this project (resilient to an unapplied 017).
    let forkRows: Record<string, unknown>[] = [];
    {
      const { data, error } = await db
        .from("chats")
        .select(
          "id, title, fork_label, parent_chat_id, root_chat_id, forked_from_message_id, anchor_version_id, branch_tip_version_id, created_at",
        )
        .eq("project_id", projectId)
        .not("parent_chat_id", "is", null);
      if (!error) forkRows = (data ?? []) as Record<string, unknown>[];
    }
    const forkNodes = forkRows.map((c) => ({
      chat_id: String(c.id),
      title: (c.title as string | null) ?? null,
      fork_label: (c.fork_label as string | null) ?? null,
      parent_chat_id: (c.parent_chat_id as string | null) ?? null,
      root_chat_id: (c.root_chat_id as string | null) ?? null,
      forked_from_message_id:
        (c.forked_from_message_id as string | null) ?? null,
      anchor_version_id: (c.anchor_version_id as string | null) ?? null,
      branch_tip_version_id:
        (c.branch_tip_version_id as string | null) ?? null,
      created_at: c.created_at ?? null,
    }));

    const edges: { from: string; to: string; kind: "lineage" | "fork" }[] = [];
    for (const n of versionNodes) {
      if (n.parent_version_id && versionIds.has(n.parent_version_id))
        edges.push({
          from: n.parent_version_id,
          to: n.id,
          kind: "lineage",
        });
    }
    for (const f of forkNodes) {
      if (
        f.anchor_version_id &&
        f.branch_tip_version_id &&
        f.anchor_version_id !== f.branch_tip_version_id &&
        versionIds.has(f.anchor_version_id) &&
        versionIds.has(f.branch_tip_version_id)
      )
        edges.push({
          from: f.anchor_version_id,
          to: f.branch_tip_version_id,
          kind: "fork",
        });
    }

    res.json({
      project_id: projectId,
      version_nodes: versionNodes,
      fork_nodes: forkNodes,
      edges,
    });
  },
);

async function projectMembersHandler(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok || !access.project.matter_id)
    return void res.status(404).json({ detail: "Project not found" });
  try {
    const members = await listProjectMembers(
      db,
      access.project.matter_id,
      userId,
    );
    res.json({
      current_user_role: access.role,
      can_manage: access.role === "owner" || access.role === "admin",
      members,
    });
  } catch {
    res.status(500).json({
      code: "PROJECT_MEMBERS_UNAVAILABLE",
      detail: "Project members are temporarily unavailable.",
    });
  }
}

projectsRouter.get("/:projectId/members", requireAuth, projectMembersHandler);
// One-release alias for older clients. The response is membership-based and
// no longer reconstructs access from projects.shared_with.
projectsRouter.get("/:projectId/people", requireAuth, projectMembersHandler);

projectsRouter.get("/:projectId/beta-policy", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  const access = await checkProjectAccess(req.params.projectId, userId, userEmail, db);
  if (!access.ok || !access.project.org_id)
    return void res.status(404).json({ detail: "Project not found" });
  // Outside beta mode there is no policy to show or accept.
  if (!betaModeEnabled()) return void res.json(projectBetaPolicyView(null, false));
  const { data, error } = await db
    .from("organization_beta_policies")
    .select("data_policy_accepted_at, allowed_recipient_emails, allowed_recipient_domains, signatures_nonbinding")
    .eq("organization_id", access.project.org_id)
    .maybeSingle();
  if (error) return void res.status(500).json({ code: "BETA_POLICY_UNAVAILABLE", detail: "The beta policy is temporarily unavailable." });
  res.json(projectBetaPolicyView(data, true));
});

projectsRouter.patch("/:projectId/beta-policy", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  if (
    req.body.accept_data_policy === true &&
    req.body.policy_acknowledged !== true
  ) {
    return void res.status(400).json({
      code: "BETA_POLICY_ACKNOWLEDGEMENT_REQUIRED",
      detail: "Confirm that you understand the controlled-beta data restrictions.",
    });
  }
  const db = createServerSupabase();
  const access = await checkProjectAccess(req.params.projectId, userId, userEmail, db, "admin");
  if (!access.ok || !access.project.org_id)
    return void res.status(404).json({ detail: "Project not found" });
  const normalize = (value: unknown, kind: "email" | "domain") =>
    Array.isArray(value)
      ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase().replace(kind === "domain" ? /^@/ : /$^/, "")).filter(Boolean))].slice(0, 200)
      : undefined;
  const emails = normalize(req.body.allowed_recipient_emails, "email");
  const domains = normalize(req.body.allowed_recipient_domains, "domain");
  if (emails?.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || domains?.some((domain) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)))
    return void res.status(400).json({ code: "INVALID_BETA_ALLOWLIST", detail: "The calendar/signature participant list contains an invalid address or domain." });
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (emails) updates.allowed_recipient_emails = emails;
  if (domains) updates.allowed_recipient_domains = domains;
  if (req.body.accept_data_policy === true) {
    updates.data_policy_accepted_at = new Date().toISOString();
    updates.data_policy_accepted_by_user_id = userId;
  }
  const { data, error } = await db
    .from("organization_beta_policies")
    .upsert({ organization_id: access.project.org_id, ...updates }, { onConflict: "organization_id" })
    .select("data_policy_accepted_at, allowed_recipient_emails, allowed_recipient_domains, signatures_nonbinding")
    .single();
  if (error || !data) return void res.status(500).json({ code: "BETA_POLICY_UPDATE_FAILED", detail: "Could not update the beta policy." });
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId: req.params.projectId, actorUserId: userId, actorRole: access.role, eventType: "beta_policy.updated", targetType: "organization", targetId: access.project.org_id, requestId: String(res.getHeader("x-request-id") ?? "") });
  res.json(projectBetaPolicyView(data, betaModeEnabled()));
});

projectsRouter.post("/:projectId/invitations", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const role = typeof req.body.role === "string" ? req.body.role : "editor";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return void res.status(400).json({ code: "INVALID_MEMBER_EMAIL", detail: "Enter a valid email address." });
  if (!["admin", "lawyer", "editor", "reviewer", "viewer"].includes(role))
    return void res.status(400).json({ code: "INVALID_MEMBER_ROLE", detail: "Choose a valid project role." });
  if (email === userEmail?.toLowerCase())
    return void res.status(400).json({ code: "CANNOT_INVITE_SELF", detail: "You cannot invite yourself." });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "admin");
  if (!access.ok || !access.project.matter_id)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db.rpc("invite_project_member", {
    p_project_id: projectId,
    p_email: email,
    p_role: role,
    p_invited_by_user_id: userId,
  });
  if (error) return void res.status(500).json({ code: "MEMBER_INVITE_FAILED", detail: "Could not create the invitation." });
  const result = Array.isArray(data) ? data[0] : data;
  await syncLegacySharedWith(db, projectId, access.project.matter_id);

  let delivery: "not_needed" | "sent" | "failed" = result?.member_user_id ? "not_needed" : "sent";
  if (!result?.member_user_id) {
    const { error: inviteError } = await db.auth.admin.inviteUserByEmail(email, {
      redirectTo: process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL.replace(/\/$/, "")}/login` : undefined,
    });
    if (inviteError) delivery = "failed";
  }
  await recordAuditEvent(db, {
    orgId: access.project.org_id,
    matterId: access.project.matter_id,
    projectId,
    actorUserId: userId,
    actorRole: access.role,
    eventType: "project.member_invited",
    targetType: "matter_membership",
    targetId: result?.membership_id ?? null,
    requestId: String(res.getHeader("x-request-id") ?? ""),
    metadata: { role, membership_id: result?.membership_id ?? null },
  });
  res.status(201).json({ membership_id: result?.membership_id, status: result?.membership_status, invite_delivery: delivery });
});

projectsRouter.patch("/:projectId/members/:membershipId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, membershipId } = req.params;
  const role = typeof req.body.role === "string" ? req.body.role : "";
  if (!["admin", "lawyer", "editor", "reviewer", "viewer"].includes(role))
    return void res.status(400).json({ code: "INVALID_MEMBER_ROLE", detail: "Choose a valid project role." });
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "admin");
  if (!access.ok || !access.project.matter_id)
    return void res.status(404).json({ detail: "Project not found" });
  const { data: member } = await db.from("matter_memberships").select("id, role, user_id, email").eq("id", membershipId).eq("matter_id", access.project.matter_id).maybeSingle();
  if (!member || member.role === "owner")
    return void res.status(409).json({ code: "OWNER_ROLE_IMMUTABLE", detail: "The project owner role cannot be changed." });
  const { data: updated, error } = await db.from("matter_memberships").update({ role, updated_at: new Date().toISOString() }).eq("id", membershipId).select("*").single();
  if (error || !updated) return void res.status(404).json({ detail: "Member not found" });
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "project.member_role_changed", targetType: "matter_membership", targetId: membershipId, requestId: String(res.getHeader("x-request-id") ?? ""), metadata: { role, previous_role: member.role, membership_id: membershipId } });
  res.json(updated);
});

projectsRouter.delete("/:projectId/members/:membershipId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, membershipId } = req.params;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "admin");
  if (!access.ok || !access.project.matter_id)
    return void res.status(404).json({ detail: "Project not found" });
  const { data: member } = await db.from("matter_memberships").select("id, role, user_id, email").eq("id", membershipId).eq("matter_id", access.project.matter_id).maybeSingle();
  if (!member || member.role === "owner" || member.user_id === userId)
    return void res.status(409).json({ code: "OWNER_ACCESS_REQUIRED", detail: "The project owner cannot be removed." });
  const { error } = await db.from("matter_memberships").update({ status: "disabled", updated_at: new Date().toISOString() }).eq("id", membershipId);
  if (error) return void res.status(500).json({ code: "MEMBER_DISABLE_FAILED", detail: "Could not remove the member." });
  if (access.project.org_id) {
    try {
      await disableOrphanedOrganizationMembership(db, {
        orgId: access.project.org_id,
        userId: member.user_id,
        email: member.email,
      });
    } catch {
      await db
        .from("matter_memberships")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", membershipId);
      return void res.status(500).json({
        code: "MEMBER_DISABLE_FAILED",
        detail: "Member access could not be removed safely.",
      });
    }
  }
  await syncLegacySharedWith(db, projectId, access.project.matter_id);
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "project.member_disabled", targetType: "matter_membership", targetId: membershipId, requestId: String(res.getHeader("x-request-id") ?? ""), metadata: { membership_id: membershipId } });
  res.status(204).send();
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.cm_number != null) updates.cm_number = req.body.cm_number;
  if (Array.isArray(req.body.shared_with)) {
    return void res.status(400).json({
      code: "MEMBERSHIP_API_REQUIRED",
      detail: "Use the role-aware project member endpoints to change access.",
    });
  }

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "admin");
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).eq("lifecycle_status", "active").order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "lifecycle");
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (access.project.legal_hold_until && new Date(access.project.legal_hold_until).getTime() > Date.now())
    return void res.status(409).json({ code: "LEGAL_HOLD_ACTIVE", detail: "This project cannot be deleted while a legal hold is active." });
  if (access.project.matter_id) {
    const { data: matter } = await db.from("matters").select("lifecycle_status").eq("id", access.project.matter_id).maybeSingle();
    if (matter?.lifecycle_status === "legal_hold")
      return void res.status(409).json({ code: "LEGAL_HOLD_ACTIVE", detail: "This matter cannot be deleted while a legal hold is active." });
  }
  const { data: heldDocuments } = await db
    .from("documents")
    .select("id")
    .eq("project_id", projectId)
    .gt("legal_hold_until", new Date().toISOString())
    .limit(1);
  if ((heldDocuments?.length ?? 0) > 0)
    return void res.status(409).json({
      code: "LEGAL_HOLD_ACTIVE",
      detail: "This project contains a document under legal hold and cannot be deleted.",
    });
  const deletedAt = new Date().toISOString();
  const retentionUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from("projects").update({
    lifecycle_status: "deleted_pending_purge",
    deleted_at: deletedAt,
    retention_until: retentionUntil,
    updated_at: deletedAt,
  }).eq("id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  await db.from("matters").update({
    lifecycle_status: "deleted_pending_purge",
    retention_until: retentionUntil,
    updated_at: deletedAt,
  }).eq("id", access.project.matter_id);
  await db.from("documents").update({
    lifecycle_status: "deleted_pending_purge",
    deleted_at: deletedAt,
    retention_until: retentionUntil,
    updated_at: deletedAt,
  }).eq("project_id", projectId).eq("lifecycle_status", "active");
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "project.deleted", targetType: "project", targetId: projectId, requestId: String(res.getHeader("x-request-id") ?? "") });
  res.status(204).send();
});

projectsRouter.post("/:projectId/restore", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();
  // Deleted projects are intentionally omitted by list APIs but their active
  // membership remains available for this recovery-only authorization.
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "lifecycle");
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  if (access.project.lifecycle_status !== "deleted_pending_purge")
    return void res.status(409).json({ code: "PROJECT_NOT_DELETED", detail: "This project is not awaiting purge." });
  const { error } = await db.from("projects").update({ lifecycle_status: "active", deleted_at: null, retention_until: null, updated_at: new Date().toISOString() }).eq("id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  await db.from("matters").update({ lifecycle_status: "active", retention_until: null, updated_at: new Date().toISOString() }).eq("id", access.project.matter_id);
  await db.from("documents").update({ lifecycle_status: "active", deleted_at: null, retention_until: null, updated_at: new Date().toISOString() }).eq("project_id", projectId).eq("lifecycle_status", "deleted_pending_purge").eq("deleted_at", access.project.deleted_at);
  await recordAuditEvent(db, { orgId: access.project.org_id, matterId: access.project.matter_id, projectId, actorUserId: userId, actorRole: access.role, eventType: "project.restored", targetType: "project", targetId: projectId, requestId: String(res.getHeader("x-request-id") ?? "") });
  res.json({ id: projectId, lifecycle_status: "active" });
});

// GET /projects/:projectId/document-action-state
projectsRouter.get(
  "/:projectId/document-action-state",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });
    try {
      const documents = await getProjectDocumentActionState(db, projectId);
      res.json({ project_id: projectId, generated_at: new Date().toISOString(), documents });
    } catch {
      res.status(500).json({
        code: "DOCUMENT_ACTION_STATE_UNAVAILABLE",
        detail: "Document delivery and signature state is temporarily unavailable.",
      });
    }
  },
);

// Consolidated matter poll. The cursor is also the weak ETag: unchanged polls
// return 304 and transfer no repeated document/task payload.
projectsRouter.get("/:projectId/action-state", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });
  try {
    const state = await getProjectActionState(db, projectId);
    const etag = `W/\"${state.cursor}\"`;
    res.setHeader("etag", etag);
    if (req.headers["if-none-match"] === etag || req.query.cursor === state.cursor)
      return void res.status(304).send();
    res.json({
      project_id: projectId,
      generated_at: new Date().toISOString(),
      ...state,
    });
  } catch {
    res.status(500).json({
      code: "PROJECT_ACTION_STATE_UNAVAILABLE",
      detail: "Matter workflow state is temporarily unavailable.",
    });
  }
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .eq("lifecycle_status", "active")
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      const { data: updated, error } = await db
        .from("documents")
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          filename: doc.filename,
          file_type: doc.file_type,
          size_bytes: doc.size_bytes,
          page_count: doc.page_count,
          structure_tree: doc.structure_tree,
          status: doc.status,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
      if (doc.current_version_id) {
        let verifiedSource;
        try {
          verifiedSource = await ensureVersionExportable({
            db,
            documentId,
            versionId: doc.current_version_id as string,
            fileType: doc.file_type as string,
          });
        } catch (qaError) {
          await db.from("documents").delete().eq("id", copy.id);
          return void res.status(422).json({
            code:
              qaError && typeof qaError === "object" && "code" in qaError
                ? String(qaError.code)
                : "DOCUMENT_QA_UNAVAILABLE",
            detail:
              qaError instanceof Error
                ? qaError.message
                : "The source document could not be verified for copying.",
          });
        }
        const { data: srcV } = await db
          .from("document_versions")
          .select(
            "storage_path, pdf_storage_path, version_number, display_name, source, layout_qa_status, layout_qa_report, layout_qa_checked_at",
          )
          .eq("id", doc.current_version_id)
          .single();
        if (srcV?.storage_path) {
          let verifiedPdfBytes: Buffer | null = null;
          if (
            srcV.pdf_storage_path &&
            srcV.pdf_storage_path !== srcV.storage_path
          ) {
            try {
              verifiedPdfBytes = (
                await ensureVersionPdfRenditionExportable({
                  db,
                  documentId,
                  versionId: doc.current_version_id as string,
                  fileType: doc.file_type as string,
                })
              ).bytes;
            } catch (qaError) {
              const qa = layoutQaHttpError(qaError);
              await db.from("documents").delete().eq("id", copy.id);
              return void res.status(qa?.status ?? 503).json({
                code: qa?.code ?? "DOCUMENT_QA_UNAVAILABLE",
                detail:
                  qa?.detail ??
                  "The source PDF rendition could not be verified for copying.",
              });
            }
          }
          const srcBytes = await downloadFile(srcV.storage_path);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id as string, doc.filename);
          // Derive content-type from the source doc's actual file_type
          // so Tier 2 copies (xlsx, pptx, csv, etc.) get their canonical
          // MIME, not the DOCX one. Falls back to octet-stream only if
          // file_type is unknown — should never happen post-upload.
          const contentType =
            mimeForExtension(doc.file_type as string) ??
            "application/octet-stream";
          await uploadFile(newKey, srcBytes, contentType);

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (srcV.pdf_storage_path) {
            if (srcV.pdf_storage_path === srcV.storage_path) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = verifiedPdfBytes;
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id as string);
                await uploadFile(
                  newPdfKey,
                  pdfBytes.buffer.slice(
                    pdfBytes.byteOffset,
                    pdfBytes.byteOffset + pdfBytes.byteLength,
                  ) as ArrayBuffer,
                  "application/pdf",
                );
                newPdfPath = newPdfKey;
              }
            }
          }

          try {
            const newV = await insertDocumentVersionCompat({
              db,
              fallbackSource: "user_upload",
              errorMessage: "Failed to record copied document version.",
              values: {
                document_id: copy.id,
                storage_path: newKey,
                pdf_storage_path: newPdfPath,
                source: (srcV.source as string | null) ?? "upload",
                version_number: srcV.version_number ?? 1,
                display_name: srcV.display_name ?? doc.filename,
                layout_qa_status:
                  verifiedSource.status === "passed" ? "passed" : "source",
                layout_qa_report: verifiedSource.report,
                layout_qa_checked_at:
                  verifiedSource.report?.checked_at ?? null,
              },
            });
            copyVersionRowId = newV.id;
          } catch (err) {
            console.error("[projects/copy] version insert failed", err);
          }
          if (copyVersionRowId) {
            await db
              .from("documents")
              .update({ current_version_id: copyVersionRowId })
              .eq("id", copy.id);
          }
        }
      }
      return void res.status(201).json(copy);
    }
  },
);

// PATCH /projects/:projectId/documents/:documentId — rename a project document
projectsRouter.patch("/:projectId/documents/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, current_version_id")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });

  const filename = normalizeDocumentFilename(req.body?.filename, doc.filename as string);
  if (!filename)
    return void res.status(400).json({ detail: "filename is required" });

  const { data: updated, error } = await db
    .from("documents")
    .update({ filename, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("project_id", projectId)
    .select("*")
    .single();
  if (error || !updated)
    return void res.status(404).json({ detail: "Document not found" });

  if (doc.current_version_id) {
    await db
      .from("document_versions")
      .update({ display_name: filename })
      .eq("id", doc.current_version_id)
      .eq("document_id", documentId);
  }

  res.json(updated);
});

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, db);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data, error } = await db
    .from("chats")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  if (!name?.trim()) return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) updates.name = body.name.trim();
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      const parent = await loadProjectFolder(db, projectId, body.parent_folder_id);
      if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });

      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        const p = await loadProjectFolder(db, projectId, cur);
        if (!p) return void res.status(404).json({ detail: "Parent folder not found" });
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
});

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const folder = await loadProjectFolder(db, projectId, folderId);
  if (!folder) return void res.status(404).json({ detail: "Folder not found" });

  // Move direct documents to root before cascade-deleting subfolders
  await db.from("documents").update({ folder_id: null }).eq("folder_id", folderId).eq("project_id", projectId);

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db, "mutate");
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  if (folder_id) {
    const folder = await loadProjectFolder(db, projectId, folder_id);
    if (!folder) return void res.status(404).json({ detail: "Folder not found" });
  }

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
});

async function loadProjectFolder(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  folderId: string,
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("id", folderId)
    .eq("project_id", projectId)
    .maybeSingle();
  return (data as { id: string; parent_folder_id: string | null } | null) ?? null;
}
