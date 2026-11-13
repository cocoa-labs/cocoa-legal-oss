import type { createServerSupabase } from "./supabase";
import type { ResolvedTemplate, TemplateSection } from "./templates";
import { resolveTemplate } from "./templates";
import { substitute, substituteVariables } from "./systemPrompt/substitute";
import { persistAuthoredDocx, type DocxSection } from "./docxAssembly";
import { renderDocumentWithRecovery } from "./documentGeneration/renderRecovery";
import { resolveFirmId, getEffectivePlaybookEntries, type PlaybookEntry } from "./playbooks";

export interface SectionProvenance {
  section_id: string;
  source: "substitution" | "llm" | "clause_library" | "verbatim_template";
  variables_used: string[];
  playbook_keys_used: string[];
}

type DraftSection = (
  section: TemplateSection,
  ctx: { variables: Record<string, unknown>; playbookEntries: Record<string, PlaybookEntry> },
) => Promise<string>;

/** Pure: turn a skeleton + variables into rendered DocxSections + provenance. */
export async function assembleSections(args: {
  skeleton: TemplateSection[];
  variables: Record<string, unknown>;
  playbookEntries: Record<string, PlaybookEntry>;
  draftSection: DraftSection;
}): Promise<{ sections: DocxSection[]; provenance: SectionProvenance[] }> {
  const sections: DocxSection[] = [];
  const provenance: SectionProvenance[] = [];
  for (const s of args.skeleton) {
    const hasBody = typeof s.body_md === "string" && s.body_md.trim().length > 0;
    let content: string;
    let source: SectionProvenance["source"];
    if (hasBody) {
      const afterPlaybook = substitute(s.body_md as string, args.playbookEntries);
      content = substituteVariables(afterPlaybook, args.variables);
      source = "substitution";
    } else {
      content = await args.draftSection(s, { variables: args.variables, playbookEntries: args.playbookEntries });
      source = "llm";
    }
    sections.push({ heading: s.heading, level: s.level, content, pageBreak: s.pageBreak });
    provenance.push({
      section_id: s.id,
      source,
      variables_used: s.variables_used ?? [],
      playbook_keys_used: [],
    });
  }
  return { sections, provenance };
}

export async function assembleFromTemplate(params: {
  db: ReturnType<typeof createServerSupabase>;
  userId: string;
  templateId: string;
  variables: Record<string, unknown>;
  projectId?: string | null;
  jurisdiction?: string | null;
  operationId?: string | null;
  draftSection: DraftSection;
  playbookKeys?: string[];
}): Promise<
  | { documentId: string; versionId: string; versionNumber: number; downloadUrl: string; filename: string; provenance: SectionProvenance[] }
  | { error: string }
> {
  const firmId = await resolveFirmId(params.userId);
  const resolved: ResolvedTemplate | null = await resolveTemplate(params.db, firmId, params.templateId);
  if (!resolved) return { error: `Template not found: ${params.templateId}` };
  const playbookEntries = params.playbookKeys?.length
    ? await getEffectivePlaybookEntries(params.db, firmId, params.playbookKeys)
    : {};
  const { sections, provenance } = await assembleSections({
    skeleton: resolved.version.skeleton,
    variables: params.variables,
    playbookEntries,
    draftSection: params.draftSection,
  });
  let rendered: Awaited<ReturnType<typeof renderDocumentWithRecovery>>;
  try {
    rendered = await renderDocumentWithRecovery({
      title: resolved.template.title,
      sections,
    });
  } catch (error) {
    return { error: String(error) };
  }
  const persisted = await persistAuthoredDocx({
    db: params.db,
    userId: params.userId,
    buffer: rendered.buffer,
    layoutQaReport: rendered.report,
    title: resolved.template.title,
    projectId: params.projectId ?? null,
    source: "authored",
    lineage: { derivationKind: "template_assembly", operationId: params.operationId ?? null },
  });
  if ("error" in persisted) return persisted;
  return {
    documentId: persisted.document_id,
    versionId: persisted.version_id,
    versionNumber: persisted.version_number,
    downloadUrl: persisted.download_url,
    filename: persisted.filename,
    provenance,
  };
}
