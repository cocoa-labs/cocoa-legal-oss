import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { completeText } from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { runLegalSearch, type LegalSearchResult } from "../lib/legalSearch";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  org_id?: string | null;
  matter_id?: string | null;
  is_system: boolean;
  [key: string]: unknown;
};

type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      allowEdit: boolean;
      isOwner: boolean;
      canManage: boolean;
    }
  | null;

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

type WorkflowType = "assistant" | "tabular";

type GeneratedColumn = {
  index: number;
  name: string;
  prompt: string;
  format?: string;
  tags?: string[];
};

type WorkflowGenerationPayload = {
  title?: string;
  type?: string;
  practice?: string | null;
  goal?: string;
  jurisdiction?: string | null;
  document_type?: string | null;
  target_output?: string | null;
  use_legal_research?: boolean;
};

type WorkflowGenerationResult = {
  prompt_md?: string;
  columns_config?: GeneratedColumn[];
  summary: string;
  warnings: string[];
  sources: Pick<
    LegalSearchResult,
    "title" | "url" | "provider" | "sourceType" | "confidence"
  >[];
};

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

function stripJsonFence(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseGeneratedJson(raw: string): Partial<WorkflowGenerationResult> {
  const parsed = JSON.parse(stripJsonFence(raw)) as Partial<WorkflowGenerationResult>;
  return parsed;
}

function normalizeGeneratedColumns(value: unknown): GeneratedColumn[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((column, index): GeneratedColumn | null => {
      if (!column || typeof column !== "object" || Array.isArray(column)) {
        return null;
      }
      const row = column as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
      if (!name || !prompt) return null;
      const tags = Array.isArray(row.tags)
        ? row.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined;
      return {
        index,
        name,
        prompt,
        format: typeof row.format === "string" ? row.format : "text",
        ...(tags?.length ? { tags } : {}),
      };
    })
    .filter((column): column is GeneratedColumn => column !== null)
    .slice(0, 18);
}

function fallbackAssistantPrompt(input: {
  title: string;
  practice: string | null;
  goal: string;
  jurisdiction: string | null;
  documentType: string | null;
  targetOutput: string | null;
}): string {
  const practice = input.practice ? ` for ${input.practice}` : "";
  const jurisdiction = input.jurisdiction
    ? `\n- Jurisdiction: ${input.jurisdiction}`
    : "";
  const documentType = input.documentType
    ? `\n- Document type: ${input.documentType}`
    : "";
  const targetOutput = input.targetOutput
    ? `\n- Target output: ${input.targetOutput}`
    : "";
  return `## ${input.title}\n\nUse this workflow${practice} to complete the user's requested legal analysis.\n\n### Objective\n${input.goal}\n${jurisdiction}${documentType}${targetOutput}\n\n### Instructions\n- Identify the relevant documents and read them before making factual claims.\n- Extract the provisions, dates, parties, thresholds, exceptions, and cross-references that matter to the objective.\n- Cite document evidence for each material conclusion.\n- Flag unusual, missing, inconsistent, or non-market provisions.\n- If current law or external authority is needed, use legal research and identify the source.\n- End with recommended next steps and any open questions for counsel.`;
}

function fallbackTabularColumns(input: {
  practice: string | null;
  goal: string;
  documentType?: string | null;
}): GeneratedColumn[] {
  const haystack = `${input.goal} ${input.documentType ?? ""}`.toLowerCase();
  const realEstate =
    input.practice?.toLowerCase().includes("real estate") ||
    haystack.includes("lease") ||
    haystack.includes("estoppel") ||
    haystack.includes("snda") ||
    haystack.includes("purchase and sale") ||
    haystack.includes("psa") ||
    haystack.includes("cam") ||
    haystack.includes("rent roll");
  const finance =
    !realEstate &&
    (input.practice?.toLowerCase().includes("finance") ||
      input.goal.toLowerCase().includes("credit") ||
      input.goal.toLowerCase().includes("facility"));
  // Real-Estate deterministic fallback: a <=18-col subset of the US lease
  // abstraction (see US_COMMERCIAL_LEASE_COLUMNS in
  // backend/src/lib/legalCapabilities/creProfiles.ts).
  const base = realEstate
    ? [
        ["Landlord", "Identify the landlord / lessor, including legal entity name and entity type.", "text"],
        ["Tenant", "Identify the tenant / lessee, including legal entity name and entity type.", "text"],
        ["Premises & RSF", "State the rentable square footage (RSF) of the demised premises as a number.", "number"],
        ["Lease Type", "Classify the lease structure as NNN, Gross, or MG based on how operating expenses, taxes, and insurance are allocated.", "tag"],
        ["Commencement / Expiration", "State the lease commencement date and the scheduled expiration date of the initial term.", "text"],
        ["Base Rent", "The initial base / minimum rent. State the amount, the period (per month or per year), and any rate per RSF.", "monetary_amount"],
        ["Rent Escalations", "Summarize how base rent escalates over the term — fixed bumps, dollar steps, CPI indexing, or to-FMV resets — with rate/step and frequency.", "text"],
        ["CAM / Operating Expenses", "Summarize the operating-expense / CAM structure: pass-through method, gross-up, base-year stop, and any cap on controllable CAM.", "text"],
        ["Renewal Options", "List each renewal / extension option: number, length, notice window, and how renewal rent is set (fixed, escalated, or FMV).", "bulleted_list"],
        ["Assignment & Subletting", "Summarize the assignment and subletting provisions: consent standard, recapture, profit-sharing, and permitted-transfer carve-outs.", "text"],
        ["SNDA Required", "Does the lease require delivery of an SNDA or condition subordination on non-disturbance? Answer Yes if an SNDA / non-disturbance right is provided for.", "yes_no"],
        ["Estoppel Required", "Does the lease obligate the tenant (or landlord) to deliver an estoppel certificate on request? Answer Yes if an estoppel obligation exists.", "yes_no"],
        ["Permitted / Exclusive Use", "State the permitted-use clause and any exclusive-use rights granted to the tenant, including scope and carve-outs.", "text"],
        ["Governing Law", "The governing-law / choice-of-law jurisdiction stated in the lease (typically the state where the property is located).", "text"],
      ]
    : finance
    ? [
        ["Borrower", "Identify each borrower, including legal name and jurisdiction if stated.", "bulleted_list"],
        ["Facility Amount", "Extract the total commitment amount, currency, and any tranche-level breakdown.", "monetary_amount"],
        ["Maturity Date", "Identify the maturity date for each facility or tranche.", "date"],
        ["Financial Covenants", "Extract financial covenants, testing frequency, thresholds, and cure rights.", "bulleted_list"],
        ["Events of Default", "Identify events of default, grace periods, materiality qualifiers, and cross-default triggers.", "bulleted_list"],
        ["Security", "Summarize security granted or required, including asset classes and obligors.", "bulleted_list"],
        ["Change of Control", "Summarize change-of-control triggers, consequences, notice, consent, or mandatory prepayment requirements.", "text"],
        ["Governing Law", "Identify the governing law and forum or dispute resolution mechanism.", "text"],
      ]
    : [
        ["Parties", "Identify all parties and their roles under the document.", "bulleted_list"],
        ["Effective Date", "Extract the execution date, effective date, or commencement date.", "date"],
        ["Term", "Summarize the term, expiry, renewal, and extension mechanics.", "text"],
        ["Key Obligations", "Extract the principal obligations of each party.", "bulleted_list"],
        ["Consent Rights", "Identify consents, approvals, vetoes, or notice requirements.", "text"],
        ["Termination", "Summarize termination rights, cure periods, and consequences of termination.", "text"],
        ["Liability / Remedies", "Extract liability caps, exclusions, indemnities, liquidated damages, and remedies.", "text"],
        ["Governing Law", "Identify governing law and dispute resolution provisions.", "text"],
      ];
  return base.map(([name, prompt, format], index) => ({
    index,
    name,
    prompt,
    format,
  }));
}

async function maybeSearchForWorkflow(input: {
  title: string;
  type: WorkflowType;
  practice: string | null;
  goal: string;
  jurisdiction: string | null;
  documentType: string | null;
  useLegalResearch: boolean;
}): Promise<{
  context: string;
  warnings: string[];
  sources: WorkflowGenerationResult["sources"];
}> {
  if (!input.useLegalResearch) return { context: "", warnings: [], sources: [] };

  const search = await runLegalSearch({
    query: [
      input.jurisdiction,
      input.practice,
      input.documentType,
      input.goal,
      "legal workflow checklist extraction drafting market practice",
    ]
      .filter(Boolean)
      .join(" "),
    mode: "authority",
    maxResults: 5,
  });
  const sources = search.results.slice(0, 5).map((result) => ({
    title: result.title,
    url: result.url,
    provider: result.provider,
    sourceType: result.sourceType,
    confidence: result.confidence,
  }));
  const context = search.results
    .slice(0, 5)
    .map((result, index) => {
      const body =
        result.markdown?.slice(0, 900) ??
        result.highlights?.join(" ") ??
        result.snippet ??
        "";
      return `[${index + 1}] ${result.title}\n${result.url}\n${body}`;
    })
    .join("\n\n");
  return {
    context,
    warnings: search.warnings,
    sources,
  };
}

function buildWorkflowGenerationPrompt(input: {
  title: string;
  type: WorkflowType;
  practice: string | null;
  goal: string;
  jurisdiction: string | null;
  documentType: string | null;
  targetOutput: string | null;
  searchContext: string;
}): string {
  const shared = `Workflow title: ${input.title}
Type: ${input.type}
Practice: ${input.practice ?? "Not specified"}
Goal/use case: ${input.goal}
Jurisdiction: ${input.jurisdiction ?? "Not specified"}
Document type: ${input.documentType ?? "Not specified"}
Target output: ${input.targetOutput ?? "Not specified"}

Research context:
${input.searchContext || "No external research context provided."}`;

  if (input.type === "assistant") {
    return `${shared}

Create a production-ready Cocoa Legal assistant workflow prompt for lawyers. Return only JSON:
{
  "prompt_md": "markdown workflow prompt",
  "summary": "one sentence summary",
  "warnings": ["short warning if any"]
}

The markdown prompt must be specific, reusable, citation-aware, and should tell the assistant when to read documents, when to use legal_search, and what final output structure to produce.`;
  }

  const realEstate =
    input.practice?.toLowerCase().includes("real estate") ||
    [input.goal, input.documentType ?? ""]
      .join(" ")
      .toLowerCase()
      .match(/lease|estoppel|snda|purchase and sale|psa|cam|rent roll/) != null;
  const realEstateGuidance = realEstate
    ? `\n\nThis is a U.S. commercial real estate matter. Favor CRE lease-abstraction fields where relevant: landlord, tenant, premises & RSF, lease type (NNN/Gross/MG), commencement and expiration dates, base rent and rent escalations, CAM / operating expenses (caps, gross-up), renewal options, assignment & subletting, SNDA required, estoppel required, permitted/exclusive use, and governing law. Use monetary_amount for rent and allowances, date for lease dates, number for RSF, percentage for pro-rata share, yes_no for SNDA/estoppel-required, tag for lease type, and bulleted_list for option lists.`
    : "";

  return `${shared}

Create a production-ready tabular legal review workflow. Return only JSON:
{
  "columns_config": [
    {"name": "Column name", "prompt": "Extraction prompt", "format": "text|bulleted_list|number|percentage|monetary_amount|currency|yes_no|date|tag", "tags": ["optional"]}
  ],
  "summary": "one sentence summary",
  "warnings": ["short warning if any"]
}

Create 6 to 12 columns. Each prompt must focus only on what to extract from each legal document; do not include output JSON instructions or citation syntax.${realEstateGuidance}`;
}

async function loadSharerNames(
  db: Db,
  sharerIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(sharerIds.filter(Boolean))];
  const names = new Map<string, string>();
  if (uniqueIds.length === 0) return names;

  try {
    const { data: profiles, error } = await db
      .from("user_profiles")
      .select("user_id, display_name")
      .in("user_id", uniqueIds);

    if (error) {
      console.warn("[workflows] failed to load sharer profiles", error);
    } else {
      for (const profile of profiles ?? []) {
        if (profile.user_id && profile.display_name) {
          names.set(profile.user_id, profile.display_name);
        }
      }
    }
  } catch (err) {
    console.warn("[workflows] sharer profile lookup threw", err);
  }

  const missingIds = uniqueIds.filter((id) => !names.has(id));
  const results = await Promise.allSettled(
    missingIds.map(async (id) => {
      const { data, error } = await db.auth.admin.getUserById(id);
      if (error) throw error;
      return { id, email: data.user?.email ?? null };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value.email) {
      names.set(result.value.id, result.value.email);
    } else if (result.status === "rejected") {
      console.warn("[workflows] failed to load sharer email", result.reason);
    }
  }

  return names;
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const workflowRecord = workflow as WorkflowRecord;
  if (!workflowRecord.org_id) {
    return workflowRecord.user_id === userId
      ? { workflow: workflowRecord, allowEdit: true, isOwner: true, canManage: true }
      : null;
  }
  let membershipQuery = db
    .from("organization_memberships")
    .select("role")
    .eq("organization_id", workflowRecord.org_id)
    .eq("status", "active");
  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  membershipQuery = normalizedUserEmail
    ? membershipQuery.or(`user_id.eq.${userId},email.ilike.${normalizedUserEmail}`)
    : membershipQuery.eq("user_id", userId);
  const { data: membership } = await membershipQuery.limit(1).maybeSingle();
  if (!membership) return null;
  const role = String(membership.role);
  return {
    workflow: workflowRecord,
    allowEdit: ["owner", "admin", "lawyer", "editor"].includes(role),
    isOwner: role === "owner",
    canManage: ["owner", "admin"].includes(role),
  };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type } = req.query as { type?: string };
  const db = createServerSupabase();

  // Own workflows
  let ownQuery = db
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .eq("is_system", false)
    .order("created_at", { ascending: false });
  if (type) ownQuery = ownQuery.eq("type", type);
  const { data: own, error: ownErr } = await ownQuery;
  if (ownErr) return void res.status(500).json({ detail: ownErr.message });

  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const { data: memberships } = await db
    .from("organization_memberships")
    .select("organization_id, role, user_id, email")
    .eq("status", "active")
    .or(`user_id.eq.${userId},email.ilike.${normalizedUserEmail}`);
  const orgRoles = new Map((memberships ?? []).map((membership) => [String(membership.organization_id), String(membership.role)]));
  const orgIds = [...orgRoles.keys()];
  let sharedWorkflows: Record<string, unknown>[] = [];
  if (orgIds.length > 0) {
    let sharedQuery = db.from("workflows").select("*").in("org_id", orgIds).neq("user_id", userId).eq("is_system", false);
    if (type) sharedQuery = sharedQuery.eq("type", type);
    const { data: wfs } = await sharedQuery;
    sharedWorkflows = (wfs ?? []).map((workflow) => {
      const role = orgRoles.get(String(workflow.org_id)) ?? "viewer";
      return withWorkflowAccess(workflow, { allowEdit: ["owner", "admin", "lawyer", "editor"].includes(role), isOwner: false });
    });
  }

  const ownWithFlag = (own ?? [])
    .filter((workflow) => !workflow.org_id || orgRoles.has(String(workflow.org_id)))
    .map((workflow) => {
      const role = workflow.org_id
        ? orgRoles.get(String(workflow.org_id)) ?? "viewer"
        : "owner";
      return withWorkflowAccess(workflow, {
        allowEdit: ["owner", "admin", "lawyer", "editor"].includes(role),
        isOwner: role === "owner",
      });
    });
  res.json([...ownWithFlag, ...sharedWorkflows]);
}));

// POST /workflows/generate
workflowsRouter.post("/generate", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const body = req.body as WorkflowGenerationPayload;
  const title = body.title?.trim() ?? "";
  const type = body.type === "tabular" ? "tabular" : body.type === "assistant" ? "assistant" : null;
  const goal = body.goal?.trim() ?? "";
  if (!title) return void res.status(400).json({ detail: "title is required" });
  if (!type) return void res.status(400).json({ detail: "type must be 'assistant' or 'tabular'" });
  if (!goal) return void res.status(400).json({ detail: "goal is required" });

  const practice = body.practice?.trim() || null;
  const jurisdiction = body.jurisdiction?.trim() || null;
  const documentType = body.document_type?.trim() || null;
  const targetOutput = body.target_output?.trim() || null;
  const useLegalResearch = !!body.use_legal_research;

  const search = await maybeSearchForWorkflow({
    title,
    type,
    practice,
    goal,
    jurisdiction,
    documentType,
    useLegalResearch,
  });
  const warnings = [...search.warnings];

  try {
    const { title_model, api_keys } = await getUserModelSettings(userId);
    const raw = await completeText({
      model: title_model,
      systemPrompt:
        "You generate high-quality legal AI workflow templates for lawyers. Return only valid JSON matching the requested schema. Be precise, practical, citation-aware, and avoid placeholder language.",
      user: buildWorkflowGenerationPrompt({
        title,
        type,
        practice,
        goal,
        jurisdiction,
        documentType,
        targetOutput,
        searchContext: search.context,
      }),
      maxTokens: type === "assistant" ? 2500 : 3500,
      apiKeys: api_keys,
    });
    const parsed = parseGeneratedJson(raw);
    const generatedWarnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];

    if (type === "assistant") {
      const prompt = typeof parsed.prompt_md === "string" ? parsed.prompt_md.trim() : "";
      if (!prompt) throw new Error("Generated assistant workflow had no prompt");
      const result: WorkflowGenerationResult = {
        prompt_md: prompt,
        summary:
          typeof parsed.summary === "string" && parsed.summary.trim()
            ? parsed.summary.trim()
            : "Generated assistant workflow prompt.",
        warnings: [...warnings, ...generatedWarnings],
        sources: search.sources,
      };
      return void res.json(result);
    }

    const columns = normalizeGeneratedColumns(parsed.columns_config);
    if (columns.length === 0) throw new Error("Generated tabular workflow had no columns");
    const result: WorkflowGenerationResult = {
      columns_config: columns,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : "Generated tabular extraction workflow.",
      warnings: [...warnings, ...generatedWarnings],
      sources: search.sources,
    };
    return void res.json(result);
  } catch (err) {
    warnings.push(
      `Generation fell back to a local template: ${err instanceof Error ? err.message : String(err)}`,
    );
    const result: WorkflowGenerationResult =
      type === "assistant"
        ? {
            prompt_md: fallbackAssistantPrompt({
              title,
              practice,
              goal,
              jurisdiction,
              documentType,
              targetOutput,
            }),
            summary: "Generated fallback assistant workflow prompt.",
            warnings,
            sources: search.sources,
          }
        : {
            columns_config: fallbackTabularColumns({ practice, goal, documentType }),
            summary: "Generated fallback tabular extraction workflow.",
            warnings,
            sources: search.sources,
          };
    return void res.json(result);
  }
}));

// POST /workflows
workflowsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { title, type, prompt_md, columns_config, practice } = req.body as {
    title: string;
    type: string;
    prompt_md?: string;
    columns_config?: unknown;
    practice?: string | null;
  };
  if (!title?.trim())
    return void res.status(400).json({ detail: "title is required" });
  if (!["assistant", "tabular"].includes(type))
    return void res
      .status(400)
      .json({ detail: "type must be 'assistant' or 'tabular'" });

  const db = createServerSupabase();
  const { data: membership } = await db
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data, error } = await db
    .from("workflows")
    .insert({
      user_id: userId,
      org_id: membership?.organization_id ?? null,
      title: title.trim(),
      type,
      prompt_md: prompt_md ?? null,
      columns_config: columns_config ?? null,
      practice: practice ?? null,
      is_system: false,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
}));

async function handleWorkflowUpdate(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.title != null) updates.title = req.body.title;
  if (req.body.prompt_md != null) updates.prompt_md = req.body.prompt_md;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if ("practice" in req.body) updates.practice = req.body.practice ?? null;

  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .eq("is_system", false)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(data, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || !access.canManage)
    return void res.status(404).json({ detail: "Workflow not found" });
  const { error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .eq("is_system", false);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
}));

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json((data ?? []).map((r) => r.workflow_id));
}));

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .upsert({ user_id: userId, workflow_id }, { onConflict: "user_id,workflow_id" });
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
}));

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
}));

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.json(
    withWorkflowAccess(access.workflow, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}));

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, asyncRoute(async (req, res) => {
  res.status(410).json({ code: "MEMBERSHIP_API_REQUIRED", detail: "Workflow access is inherited from organization and matter memberships." });
}));

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, asyncRoute(async (req, res) => {
  res.status(410).json({ code: "MEMBERSHIP_API_REQUIRED", detail: "Workflow access is inherited from organization and matter memberships." });
}));

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, asyncRoute(async (req, res) => {
  res.status(410).json({ code: "MEMBERSHIP_API_REQUIRED", detail: "Invite the person to a project with the role-aware membership API." });
}));

workflowsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[workflows] unhandled route error", err);
    res.status(500).json({ detail: "Failed to process workflow request" });
  },
);
