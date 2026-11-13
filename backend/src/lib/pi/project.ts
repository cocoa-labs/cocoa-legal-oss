// backend/src/lib/pi/project.ts
//
// Case ↔ project linkage for the automation pipeline. Vendor-invoice runs
// file the invoice PDF into the case's project so the document surfaces in
// the normal project UI; a case that predates automation (CSV import) has
// no project yet, so ensureCaseProject creates one lazily.
//
// Concurrency: the "set project_id" write is CAS-guarded on project_id IS
// NULL — if a concurrent writer linked the case first, we adopt the
// winner's project instead of leaving an orphaned second project wired in.
// (A lost race can still leave the loser's freshly-inserted projects row
// unreferenced, which is harmless; the scheduler's serial run processing
// makes the race close to impossible in practice.)

import type { createServerSupabase } from "../supabase";
import type { PiCase } from "./store";

type Db = ReturnType<typeof createServerSupabase>;

/** Deterministic project name for an automation-filed PI case. */
export function caseProjectName(piCase: {
    client_name: string;
    case_number: string | null;
}): string {
    return `PI — ${piCase.client_name} — ${piCase.case_number ?? "unnumbered"}`;
}

/**
 * Return the case's project id, creating and linking a project when the
 * case has none. Follows the projects insert shape used by
 * routes/projects.ts (user_id, name, cm_number, shared_with).
 */
export async function ensureCaseProject(
    db: Db,
    piCase: Pick<PiCase, "id" | "user_id" | "project_id" | "client_name" | "case_number">,
): Promise<string> {
    if (piCase.project_id) return piCase.project_id;

    const { data: project, error: projectError } = await db
        .from("projects")
        .insert({
            user_id: piCase.user_id,
            name: caseProjectName(piCase),
            cm_number: null,
            shared_with: [],
        })
        .select("id")
        .single();
    if (projectError || !project) {
        throw projectError ?? new Error("ensureCaseProject: project insert returned no row");
    }
    const projectId = (project as { id: string }).id;

    // CAS: only link our new project while the case is still unlinked.
    const { data: linked, error: linkError } = await db
        .from("pi_cases")
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq("id", piCase.id)
        .is("project_id", null)
        .select("id")
        .maybeSingle();
    if (linkError) throw linkError;
    if (linked) return projectId;

    // Lost the race — someone linked a project meanwhile; use theirs.
    const { data: current, error: readError } = await db
        .from("pi_cases")
        .select("project_id")
        .eq("id", piCase.id)
        .single();
    if (readError) throw readError;
    const existing = (current as { project_id: string | null }).project_id;
    if (!existing) {
        throw new Error(
            "ensureCaseProject: case project link failed and no concurrent link exists",
        );
    }
    return existing;
}

/** Move a document into a project (used to file the invoice PDF). */
export async function setDocumentProject(
    db: Db,
    documentId: string,
    projectId: string,
): Promise<void> {
    const { error } = await db
        .from("documents")
        .update({ project_id: projectId })
        .eq("id", documentId);
    if (error) throw error;
}
