// backend/src/lib/templates.ts
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

/** Same seed firm as playbooks — Cocoa Legal-shipped defaults every firm inherits. */
export const DEFAULT_SHARED_FIRM_ID = "default-shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VARIABLE_TYPES = [
  "party", "date", "money", "jurisdiction", "enum",
  "text", "multiline", "number", "boolean", "duration",
] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export interface TemplateVariable {
  name: string;
  label: string;
  type: VariableType;
  required: boolean;
  group?: string;
  enum_options?: string[];
  default?: unknown;
  validation?: { min?: number; max?: number; pattern?: string };
  help?: string;
  dependsOn?: { name: string; equals: unknown };
}
export interface TemplateSection {
  id: string;
  heading?: string;
  level?: number;
  body_md?: string;
  clause_slot_key?: string;
  optional?: boolean;
  condition?: string;
  repeat_over?: string;
  variables_used?: string[];
  pageBreak?: boolean;
}
export interface ClauseSlot {
  key: string;
  title: string;
  default_clause_key?: string;
  condition?: string;
  choices?: { clause_key: string; label: string }[];
}
export interface ResolvedTemplate {
  template: {
    id: string; firm_id: string; slug: string; title: string;
    doc_type: string; practice: string; jurisdiction: string | null;
    description: string | null; source_kind: string; status: string;
    current_version_id: string | null;
  };
  version: {
    id: string; version_number: number;
    skeleton: TemplateSection[];
    variableSchema: TemplateVariable[];
    clauseSlots: ClauseSlot[];
    generationNotes: string;
  };
}

/**
 * Deterministic structural validation run BEFORE persisting any template
 * (AI-generated or firm-authored). Catches the failure modes that would
 * otherwise surface as broken assembly: duplicate section ids, dangling
 * clause-slot references, unknown variable types, and sections referencing
 * variables that aren't declared in the schema.
 */
export function validateTemplateShape(
  skeleton: TemplateSection[],
  variableSchema: TemplateVariable[],
  clauseSlots: ClauseSlot[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(skeleton) || skeleton.length === 0) {
    errors.push("skeleton must be a non-empty array");
  }
  const seenIds = new Set<string>();
  const varNames = new Set(variableSchema.map((v) => v.name));
  const slotKeys = new Set(clauseSlots.map((s) => s.key));

  for (const v of variableSchema) {
    if (!v.name) errors.push("variable missing name");
    if (!VARIABLE_TYPES.includes(v.type)) {
      errors.push(`variable "${v.name}" has unknown type "${v.type}"`);
    }
    if (v.type === "enum" && (!v.enum_options || v.enum_options.length === 0)) {
      errors.push(`enum variable "${v.name}" must declare enum_options`);
    }
  }
  for (const s of Array.isArray(skeleton) ? skeleton : []) {
    if (!s.id) errors.push("section missing id");
    else if (seenIds.has(s.id)) errors.push(`duplicate section id "${s.id}"`);
    else seenIds.add(s.id);
    for (const used of s.variables_used ?? []) {
      if (!varNames.has(used)) {
        errors.push(`section "${s.id}" uses undeclared variable "${used}"`);
      }
    }
    if (s.clause_slot_key && !slotKeys.has(s.clause_slot_key)) {
      errors.push(`section "${s.id}" references unknown clause slot "${s.clause_slot_key}"`);
    }
    // Scan the section body for embedded `{{var.NAME}}` / `{{var:NAME}}` tokens
    // (the two forms `substituteVariables` accepts). A body token that was
    // never added to the variable schema would otherwise pass validation,
    // never be collected by the wizard, and silently blank at assembly. Does
    // NOT match `{{cocoa-sign:N}}` or `{{playbook:key}}` — only `{{var.*}}`.
    const body = typeof s.body_md === "string" ? s.body_md : "";
    for (const m of body.matchAll(/\{\{var[:.]([^}\s]+)\}\}/g)) {
      if (!varNames.has(m[1])) {
        errors.push(`section "${s.id}" body references undeclared variable "${m[1]}"`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// resolveFirmId lives in playbooks.ts (single source of truth) — importers
// that used to pull it from here now import from ./playbooks.

function mapTemplateRow(row: any): ResolvedTemplate["template"] {
  return {
    id: row.id, firm_id: row.firm_id, slug: row.slug, title: row.title,
    doc_type: row.doc_type, practice: row.practice, jurisdiction: row.jurisdiction ?? null,
    description: row.description ?? null, source_kind: row.source_kind,
    status: row.status, current_version_id: row.current_version_id ?? null,
  };
}

async function loadTemplateRow(db: Db, firmId: string, slugOrId: string): Promise<any | null> {
  // Try by slug for the firm, then by slug for default-shared, then by id.
  for (const fid of firmId === DEFAULT_SHARED_FIRM_ID ? [DEFAULT_SHARED_FIRM_ID] : [firmId, DEFAULT_SHARED_FIRM_ID]) {
    const bySlug = await db.from("document_templates").select("*").eq("firm_id", fid).eq("slug", slugOrId).maybeSingle();
    if (bySlug.error) throw new Error(`Failed to read document_templates: ${bySlug.error.message}`);
    if (bySlug.data) return bySlug.data;
  }
  // Only attempt an id lookup when slugOrId is actually a uuid — otherwise an
  // unknown slug would hit the uuid column and Postgres throws 22P02 instead of
  // letting us return null (which callers treat as "not found").
  if (!UUID_RE.test(slugOrId)) return null;
  // Firm-scope the id lookup too. These tables carry no RLS policy, so this app
  // code is the only gate; an unscoped `.eq("id", …)` would resolve ANY firm's
  // template by UUID (cross-firm IDOR). Constrain to the caller's firm OR the
  // shared defaults so a foreign UUID resolves to null (not-found).
  const firmIds = firmId === DEFAULT_SHARED_FIRM_ID ? [DEFAULT_SHARED_FIRM_ID] : [firmId, DEFAULT_SHARED_FIRM_ID];
  const byId = await db.from("document_templates").select("*").eq("id", slugOrId).in("firm_id", firmIds).maybeSingle();
  if (byId.error) throw new Error(`Failed to read document_templates: ${byId.error.message}`);
  return byId.data ?? null;
}

export async function resolveTemplate(db: Db, firmId: string, slugOrId: string): Promise<ResolvedTemplate | null> {
  const tmpl = await loadTemplateRow(db, firmId, slugOrId);
  if (!tmpl) return null;
  const versionId = tmpl.current_version_id;
  if (!versionId) return null;
  const { data: ver, error } = await db.from("template_versions").select("*").eq("id", versionId).maybeSingle();
  if (error) throw new Error(`Failed to read template_versions: ${error.message}`);
  if (!ver) return null;
  return {
    template: mapTemplateRow(tmpl),
    version: {
      id: ver.id, version_number: ver.version_number,
      skeleton: (ver.skeleton_json ?? []) as TemplateSection[],
      variableSchema: (ver.variable_schema_json ?? []) as TemplateVariable[],
      clauseSlots: (ver.clause_slots_json ?? []) as ClauseSlot[],
      generationNotes: ver.generation_notes_md ?? "",
    },
  };
}

export async function listTemplates(db: Db, firmId: string, opts?: { docType?: string }): Promise<ResolvedTemplate["template"][]> {
  // Firm rows + default-shared rows, firm overriding default by slug.
  // Exclude soft-deleted (archived) rows so a DELETEd template never reappears
  // in the list (uses the covering (firm_id, doc_type, status) index).
  const firmIds = firmId === DEFAULT_SHARED_FIRM_ID ? [DEFAULT_SHARED_FIRM_ID] : [firmId, DEFAULT_SHARED_FIRM_ID];
  const { data, error } = await db.from("document_templates").select("*").in("firm_id", firmIds).neq("status", "archived");
  if (error) throw new Error(`Failed to list document_templates: ${error.message}`);
  const rows = ((data as any[]) ?? []).filter((r) => !opts?.docType || r.doc_type === opts.docType);
  const bySlug = new Map<string, any>();
  for (const r of rows) {
    const existing = bySlug.get(r.slug);
    if (!existing || (r.firm_id !== DEFAULT_SHARED_FIRM_ID && existing.firm_id === DEFAULT_SHARED_FIRM_ID)) {
      bySlug.set(r.slug, r);
    }
  }
  return [...bySlug.values()].map(mapTemplateRow);
}

/**
 * True when a template_versions insert failed because it collided with the
 * UNIQUE(template_id, version_number) index — Postgres unique_violation (23505),
 * the named constraint, or a generic "duplicate key"/"unique" message. Used to
 * decide whether createTemplateVersion should re-read the max and retry.
 */
function isVersionNumberConflict(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "23505") return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("template_versions_tmpl_vnum_unique") ||
    msg.includes("duplicate key") ||
    msg.includes("unique")
  );
}

export async function createTemplateVersion(
  db: Db,
  args: {
    firmId: string; slug: string; title: string; docType: string; practice?: string;
    jurisdiction?: string | null; description?: string | null;
    skeleton: TemplateSection[]; variableSchema: TemplateVariable[]; clauseSlots: ClauseSlot[];
    generationNotes?: string; sourceKind: string; sourceDocumentId?: string | null;
    operationId?: string | null; userId: string;
  },
): Promise<{ templateId: string; versionId: string; versionNumber: number }> {
  // get-or-create the template row
  const existing = await db.from("document_templates").select("*")
    .eq("firm_id", args.firmId).eq("slug", args.slug).maybeSingle();
  if (existing.error) throw new Error(`Failed to read document_templates: ${existing.error.message}`);
  let templateId: string;
  if (existing.data) {
    templateId = (existing.data as any).id;
  } else {
    const ins = await db.from("document_templates").insert({
      firm_id: args.firmId, slug: args.slug, title: args.title, doc_type: args.docType,
      practice: args.practice ?? "Real Estate", jurisdiction: args.jurisdiction ?? null,
      description: args.description ?? null, source_kind: args.sourceKind,
      source_document_id: args.sourceDocumentId ?? null, created_by_user_id: args.userId,
    }).select("id").single();
    if (ins.error || !ins.data) throw new Error(`Failed to create document_templates: ${ins.error?.message ?? "unknown"}`);
    templateId = (ins.data as any).id;
  }
  // next version number — read max → insert, retrying on a unique-violation.
  // version_number carries a UNIQUE(template_id, version_number) index, so two
  // concurrent (or double-clicked) generate calls for the same firm+slug can
  // both compute the same max+1 and race the insert. Without this loop the
  // loser surfaces as an uncaught 500. On a unique-violation we re-read the
  // current max and retry with max+1; any other error rethrows immediately.
  const MAX_ATTEMPTS = 3;
  let versionId = "";
  let nextNum = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const last = await db.from("template_versions").select("version_number")
      .eq("template_id", templateId).order("version_number", { ascending: false }).limit(1).maybeSingle();
    if (last.error) throw new Error(`Failed to read template_versions: ${last.error.message}`);
    nextNum = last.data ? ((last.data as any).version_number as number) + 1 : 1;
    const verIns = await db.from("template_versions").insert({
      template_id: templateId, version_number: nextNum,
      skeleton_json: args.skeleton, variable_schema_json: args.variableSchema,
      clause_slots_json: args.clauseSlots, generation_notes_md: args.generationNotes ?? "",
      created_by_operation_id: args.operationId ?? null, created_by_user_id: args.userId,
    }).select("id").single();
    if (!verIns.error && verIns.data) {
      versionId = (verIns.data as any).id as string;
      break;
    }
    if (verIns.error && isVersionNumberConflict(verIns.error) && attempt < MAX_ATTEMPTS - 1) {
      continue; // another writer took this number; re-read max and retry.
    }
    throw new Error(`Failed to create template_versions: ${verIns.error?.message ?? "unknown"}`);
  }
  if (!versionId) {
    throw new Error(`Failed to create template_versions: version_number conflict after ${MAX_ATTEMPTS} attempts`);
  }
  // Point the template at the new version AND reset status to 'active'. The
  // status reset matters on the get-or-create path: re-creating a previously
  // archived slug (same firm + slug) un-archives it here rather than leaving a
  // soft-deleted row that listTemplates would keep hiding. For a freshly
  // inserted row the column already defaults to 'active', so this is a no-op.
  await db.from("document_templates").update({ current_version_id: versionId, status: "active", updated_at: new Date().toISOString() }).eq("id", templateId);
  return { templateId, versionId, versionNumber: nextNum };
}
