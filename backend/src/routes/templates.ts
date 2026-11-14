import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    DEFAULT_SHARED_FIRM_ID,
    listTemplates,
    resolveTemplate,
    createTemplateVersion,
    validateTemplateShape,
    type TemplateSection,
    type TemplateVariable,
    type ClauseSlot,
} from "../lib/templates";
import { resolveFirmId } from "../lib/playbooks";
import {
    generateTemplateDraft,
    extractAuthoredText,
    startAuthoringJob,
    renderPlaybookGrounding,
} from "../lib/authoringExecute";
import { getEffectivePlaybookEntries } from "../lib/playbooks";
import { CRE_PLAYBOOK_KEYS } from "../lib/legalCapabilities/creProfiles";
import { validateVariables } from "../lib/systemPrompt/substitute";
import { checkProjectAccess, ensureDocAccess } from "../lib/access";
import { getUserApiKeys } from "../lib/userSettings";
import { slugify } from "../lib/chatTools";
import { buildDownloadUrl } from "../lib/downloadTokens";
import { createAgentOperation } from "../lib/operations";

export const templatesRouter = Router();

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;
function asyncRoute(handler: AsyncRoute) {
    return (req: Request, res: Response, next: NextFunction) => {
        void handler(req, res).catch(next);
    };
}

templatesRouter.use(requireAuth);

// How long an assembling/qa job may go without an `updated_at` bump before a
// poller treats it as stalled (its worker likely died on a process restart).
// The frontend stops polling and surfaces an error on `stalled: true`.
const STALL_MS = 5 * 60 * 1000;

// GET /templates/jobs/:jobId — poll a background assembly job's status + result.
//
// MUST be registered BEFORE the `/:id` param routes below: Express matches in
// registration order, and although `/jobs/:jobId` is a two-segment path that
// would not actually be captured by the single-segment `GET /:id`, declaring it
// first keeps it safe against any future `GET /:id/:sub` route and follows the
// documented ordering. Matter jobs require current membership; standalone jobs
// remain creator-only. Missing and unauthorized jobs both return 404.
templatesRouter.get(
    "/jobs/:jobId",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        const userEmail = res.locals.userEmail as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const db = createServerSupabase();
            const { data: job } = await db
                .from("authoring_jobs")
                .select(
                    "id, user_id, project_id, status, qa_status, qa_findings_json, result_document_id, result_version_id, updated_at",
                )
                .eq("id", req.params.jobId)
                .maybeSingle();
            const canRead = job?.project_id
                ? (
                      await checkProjectAccess(
                          String(job.project_id),
                          userId,
                          userEmail,
                          db,
                      )
                  ).ok
                : job?.user_id === userId;
            if (!job || !canRead) {
                return res.status(404).json({ detail: "Job not found" });
            }

            const status = String(
                (job as { status?: unknown }).status ?? "assembling",
            );
            const qaStatus =
                (job as { qa_status?: unknown }).qa_status ?? "pending";
            const qaFindings = Array.isArray(
                (job as { qa_findings_json?: unknown }).qa_findings_json,
            )
                ? ((job as { qa_findings_json?: unknown[] })
                      .qa_findings_json as unknown[])
                : [];
            const resultDocumentId =
                typeof (job as { result_document_id?: unknown })
                    .result_document_id === "string"
                    ? ((job as { result_document_id?: string })
                          .result_document_id as string)
                    : null;
            const resultVersionId =
                typeof (job as { result_version_id?: unknown })
                    .result_version_id === "string"
                    ? ((job as { result_version_id?: string })
                          .result_version_id as string)
                    : null;
            const updatedAt = String(
                (job as { updated_at?: unknown }).updated_at ?? "",
            );

            // Build the downloadable result only once the job is ready and it
            // carries a document. We rebuild the (non-expiring, signed)
            // download_url from the result version's storage_path + the
            // document's filename via buildDownloadUrl — the same helper the
            // edit/highlight routes use — rather than persisting a URL.
            let result: {
                document_id: string;
                version_id: string;
                filename: string;
                download_url: string;
            } | null = null;
            if (status === "ready" && resultDocumentId) {
                const [{ data: docRow }, { data: versionRow }] =
                    await Promise.all([
                        db
                            .from("documents")
                            .select("filename")
                            .eq("id", resultDocumentId)
                            .maybeSingle(),
                        resultVersionId
                            ? db
                                  .from("document_versions")
                                  .select("storage_path")
                                  .eq("id", resultVersionId)
                                  .maybeSingle()
                            : Promise.resolve({ data: null }),
                    ]);
                const filename = String(
                    (docRow as { filename?: unknown } | null)?.filename ??
                        "document.docx",
                );
                const storagePath = String(
                    (versionRow as { storage_path?: unknown } | null)
                        ?.storage_path ?? "",
                );
                result = {
                    document_id: resultDocumentId,
                    version_id: resultVersionId ?? "",
                    filename,
                    download_url: buildDownloadUrl(storagePath, filename),
                };
            }

            // Surface a failure reason if the worker stashed one in
            // qa_findings_json (markJobFailed writes a single { guardrail:
            // "error" } finding) so the poller can show a useful message.
            let error: string | null = null;
            if (status === "failed") {
                const errFinding = qaFindings.find(
                    (f): f is { message?: unknown } =>
                        !!f &&
                        typeof f === "object" &&
                        (f as { guardrail?: unknown }).guardrail === "error",
                );
                error =
                    errFinding && typeof errFinding.message === "string"
                        ? errFinding.message
                        : "Assembly failed.";
            }

            // A job stuck in a non-terminal phase whose updated_at is older than
            // STALL_MS has almost certainly lost its worker (process restart).
            // Signal the frontend to stop polling and show an error.
            const parsedUpdatedAt = Date.parse(updatedAt);
            const stalled =
                (status === "assembling" || status === "qa") &&
                Number.isFinite(parsedUpdatedAt) &&
                Date.now() - parsedUpdatedAt > STALL_MS;

            return res.json({
                job_id: String((job as { id: unknown }).id),
                status,
                qa_status: qaStatus,
                qa_findings: qaFindings,
                result,
                error,
                stalled,
            });
        } catch (err) {
            console.error("[templates] job status failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to load job status" });
        }
    }),
);

// GET /templates — list the caller's firm templates (firm rows overlaid on the
// Cocoa Legal default-shared rows). Optional ?doc_type= filter.
templatesRouter.get(
    "/",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const db = createServerSupabase();
            const firmId = await resolveFirmId(userId);
            const templates = await listTemplates(db, firmId, {
                docType: req.query.doc_type as string | undefined,
            });
            return res.json({ templates });
        } catch (err) {
            console.error("[templates] list failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to list templates" });
        }
    }),
);

// GET /templates/:id — resolve a template (by slug or uuid) + its current version.
templatesRouter.get(
    "/:id",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const db = createServerSupabase();
            const firmId = await resolveFirmId(userId);
            const resolved = await resolveTemplate(db, firmId, req.params.id);
            if (!resolved) {
                return res.status(404).json({ detail: "Template not found" });
            }
            return res.json({
                template: resolved.template,
                version: resolved.version,
            });
        } catch (err) {
            console.error("[templates] get failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to load template" });
        }
    }),
);

// GET /templates/:id/schema — variable schema + clause slots that drive the
// dynamic intake wizard. Resolves through firm → default-shared like the others.
templatesRouter.get(
    "/:id/schema",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const db = createServerSupabase();
            const firmId = await resolveFirmId(userId);
            const resolved = await resolveTemplate(db, firmId, req.params.id);
            if (!resolved) {
                return res.status(404).json({ detail: "Template not found" });
            }
            return res.json({
                variableSchema: resolved.version.variableSchema,
                clauseSlots: resolved.version.clauseSlots,
            });
        } catch (err) {
            console.error("[templates] schema failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to load template schema" });
        }
    }),
);

// POST /templates — create a firm-authored template (new row or a new version
// of an existing firm slug). Structurally validated before persisting.
templatesRouter.post(
    "/",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const body = (req.body as Record<string, unknown>) ?? {};
            const slug = body.slug;
            const title = body.title;
            const docType = body.docType;
            const skeleton = body.skeleton;
            const variableSchema = body.variableSchema;
            const clauseSlots = body.clauseSlots;

            if (typeof slug !== "string" || !slug.trim()) {
                return res.status(400).json({ detail: "slug is required" });
            }
            if (typeof title !== "string" || !title.trim()) {
                return res.status(400).json({ detail: "title is required" });
            }
            if (typeof docType !== "string" || !docType.trim()) {
                return res.status(400).json({ detail: "docType is required" });
            }
            if (!Array.isArray(skeleton)) {
                return res
                    .status(400)
                    .json({ detail: "skeleton must be an array" });
            }
            if (!Array.isArray(variableSchema)) {
                return res
                    .status(400)
                    .json({ detail: "variableSchema must be an array" });
            }
            if (clauseSlots !== undefined && !Array.isArray(clauseSlots)) {
                return res
                    .status(400)
                    .json({ detail: "clauseSlots must be an array" });
            }
            if (body.jurisdiction !== undefined && body.jurisdiction !== null && typeof body.jurisdiction !== "string") {
                return res
                    .status(400)
                    .json({ detail: "jurisdiction must be a string" });
            }
            if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
                return res
                    .status(400)
                    .json({ detail: "description must be a string" });
            }

            const slots = (clauseSlots ?? []) as ClauseSlot[];
            const check = validateTemplateShape(
                skeleton as TemplateSection[],
                variableSchema as TemplateVariable[],
                slots,
            );
            if (!check.ok) {
                return res
                    .status(400)
                    .json({ detail: "Invalid template", errors: check.errors });
            }

            const db = createServerSupabase();
            const firmId = await resolveFirmId(userId);
            const result = await createTemplateVersion(db, {
                firmId,
                slug,
                title,
                docType,
                jurisdiction: (body.jurisdiction as string | null | undefined) ?? null,
                description: (body.description as string | null | undefined) ?? null,
                skeleton: skeleton as TemplateSection[],
                variableSchema: variableSchema as TemplateVariable[],
                clauseSlots: slots,
                sourceKind: "firm_parameterized",
                userId,
            });
            return res.json({
                template_id: result.templateId,
                version_id: result.versionId,
                version_number: result.versionNumber,
            });
        } catch (err) {
            console.error("[templates] create failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to create template" });
        }
    }),
);

// DELETE /templates/:id — soft delete (archive) the firm's OWN template row.
// Never archives a Cocoa Legal default-shared row: if the id resolves to a
// default-shared template, return 403. The .eq("firm_id", firmId) on the update
// is a second guard so a shared row can never be touched even if it slipped past.
templatesRouter.delete(
    "/:id",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const db = createServerSupabase();
            const firmId = await resolveFirmId(userId);
            const resolved = await resolveTemplate(db, firmId, req.params.id);
            if (!resolved) {
                return res.status(404).json({ detail: "Template not found" });
            }
            if (resolved.template.firm_id === DEFAULT_SHARED_FIRM_ID) {
                return res
                    .status(403)
                    .json({ detail: "Cannot delete a shared default template" });
            }
            const { error } = await db
                .from("document_templates")
                .update({
                    status: "archived",
                    updated_at: new Date().toISOString(),
                })
                .eq("id", resolved.template.id)
                .eq("firm_id", firmId);
            if (error) {
                throw new Error(
                    `Failed to archive document_templates: ${error.message}`,
                );
            }
            return res.json({ ok: true });
        } catch (err) {
            console.error("[templates] delete failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to delete template" });
        }
    }),
);

// ---------------------------------------------------------------------------
// Task 15b: AI template generation + the wizard's direct (no-approval) assemble.
//   POST /templates/generate      — AI template generation (JSON response)
//   POST /templates/:id/assemble  — kick off a detached background assembly job
//   GET  /templates/jobs/:jobId   — poll an assembly job's status + result
// Same auth + { detail } error conventions as the CRUD endpoints above.
// ---------------------------------------------------------------------------

// POST /templates/generate — generate a parameterized template with the LLM
// (shared core: generateTemplateDraft, also used by the chat generate_template
// dispatch), structurally validate it, persist a first version, and return the
// schema the wizard needs. JSON in / JSON out (no streaming): generation is a
// single completion. An explicit user submit IS the authoring act, so there is
// no approval gate here.
templatesRouter.post(
    "/generate",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });
        try {
            const body = (req.body as Record<string, unknown>) ?? {};
            const docType = typeof body.doc_type === "string" ? body.doc_type : "";
            const title =
                typeof body.title === "string" && body.title.trim()
                    ? body.title.trim()
                    : "";
            if (!docType.trim()) {
                return res.status(400).json({ detail: "doc_type is required" });
            }
            if (!title) {
                return res.status(400).json({ detail: "title is required" });
            }
            const description =
                typeof body.description === "string" ? body.description : "";
            const jurisdiction =
                typeof body.jurisdiction === "string" && body.jurisdiction
                    ? body.jurisdiction
                    : null;
            const sampleDocumentId =
                typeof body.sample_document_id === "string" &&
                body.sample_document_id
                    ? body.sample_document_id
                    : null;
            const model =
                typeof body.model === "string" && body.model
                    ? body.model
                    : undefined;

            const db = createServerSupabase();
            const firmId = await resolveFirmId(userId);
            const apiKeys = await getUserApiKeys(userId, db);

            // Best-effort: resolve a referenced sample document to its body text
            // so the generator can parameterize it. A failure here is non-fatal
            // (null sample → generate from the description alone).
            let sampleText: string | null = null;
            if (sampleDocumentId) {
                // IDOR guard: sample_document_id comes straight from the body and
                // is read byte-for-byte by extractAuthoredText (loadActiveVersion
                // → downloadFile) with no ownership check. Verify the caller can
                // access the document BEFORE extracting, or a foreign UUID would
                // exfiltrate another firm's document into the generation prompt.
                // 404 (not 403) to avoid leaking document existence, mirroring the
                // checkProjectAccess pattern used by /:id/assemble.
                const { data: docRow } = await db
                    .from("documents")
                    .select("id, user_id, project_id")
                    .eq("id", sampleDocumentId)
                    .maybeSingle();
                const userEmail = res.locals.userEmail as string | undefined;
                const access = docRow
                    ? await ensureDocAccess(
                          docRow as {
                              user_id: string;
                              project_id: string | null;
                          },
                          userId,
                          userEmail,
                          db,
                      )
                    : { ok: false as const };
                if (!access.ok) {
                    return res
                        .status(404)
                        .json({ detail: "Sample document not found" });
                }
                try {
                    const extracted = await extractAuthoredText(
                        db,
                        sampleDocumentId,
                    );
                    sampleText = extracted && extracted.trim() ? extracted : null;
                } catch (err) {
                    console.warn(
                        "[templates] generate: sample extract failed",
                        err,
                    );
                    sampleText = null;
                }
            }

            // Firm-effective CRE standard positions, rendered to the compact
            // grounding string generateTemplateDraft expects (same renderer the
            // chat dispatch uses). Best-effort: never block generation on it.
            let playbookGrounding = "";
            try {
                const entries = await getEffectivePlaybookEntries(db, firmId, [
                    ...CRE_PLAYBOOK_KEYS,
                ]);
                playbookGrounding = renderPlaybookGrounding(
                    entries,
                    CRE_PLAYBOOK_KEYS,
                );
            } catch {
                playbookGrounding = "";
            }

            const draft = await generateTemplateDraft({
                docType,
                title,
                description,
                sampleText,
                jurisdiction,
                playbookGrounding,
                model,
                apiKeys,
            });
            if ("error" in draft) {
                // Bad JSON / failed structural validation → 422 (the request was
                // well-formed; the model's output was not usable).
                return res.status(422).json({ detail: draft.error });
            }

            const created = await createTemplateVersion(db, {
                firmId,
                slug: slugify(title),
                title,
                docType,
                jurisdiction,
                description,
                skeleton: draft.skeleton,
                variableSchema: draft.variableSchema,
                clauseSlots: draft.clauseSlots,
                generationNotes: draft.generationNotes,
                sourceKind: sampleDocumentId
                    ? "firm_parameterized"
                    : "ai_generated",
                sourceDocumentId: sampleDocumentId,
                userId,
            });

            return res.json({
                template_id: created.templateId,
                version_id: created.versionId,
                version_number: created.versionNumber,
                title,
                variableSchema: draft.variableSchema,
                skeleton: draft.skeleton,
            });
        } catch (err) {
            console.error("[templates] generate failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to generate template" });
        }
    }),
);

// POST /templates/:id/assemble — the intake wizard's direct draft. Unlike the
// chat `assemble_document` tool (which STAGES a pending_approval operation), the
// wizard's explicit submit IS the approval, so this assembles with NO approval
// gate. It no longer runs the heavy work inline / over SSE — that risked a
// proxy/LB idle-timeout on the ~50-90s draft+QA and orphaned the work on client
// disconnect. Instead it validates + stages the job and operation, kicks off the
// DETACHED background worker (startAuthoringJob), and returns the job id
// immediately as JSON. The frontend polls GET /templates/jobs/:job_id for the
// terminal state + result.
templatesRouter.post(
    "/:id/assemble",
    asyncRoute(async (req, res) => {
        const userId = res.locals.userId as string | undefined;
        if (!userId) return res.status(401).json({ detail: "unauthorized" });

        const db = createServerSupabase();
        const body = (req.body as Record<string, unknown>) ?? {};
        const variables =
            body.variables &&
            typeof body.variables === "object" &&
            !Array.isArray(body.variables)
                ? (body.variables as Record<string, unknown>)
                : {};
        const projectId =
            typeof body.project_id === "string" && body.project_id
                ? body.project_id
                : null;
        const chatId =
            typeof body.chat_id === "string" && body.chat_id
                ? body.chat_id
                : null;
        const model =
            typeof body.model === "string" && body.model
                ? body.model
                : undefined;
        const jurisdiction =
            typeof body.jurisdiction === "string" && body.jurisdiction
                ? body.jurisdiction
                : null;

        // --- Validation + access checks (plain JSON responses) --------------
        let firmId: string;
        let resolved: Awaited<ReturnType<typeof resolveTemplate>>;
        try {
            firmId = await resolveFirmId(userId);
            resolved = await resolveTemplate(db, firmId, req.params.id);
        } catch (err) {
            console.error("[templates] assemble: resolve failed", err);
            return res
                .status(500)
                .json({ detail: "Failed to load template" });
        }
        if (!resolved) {
            return res.status(404).json({ detail: "Template not found" });
        }
        const v = validateVariables(resolved.version.variableSchema, variables);
        if (!v.ok) {
            return res
                .status(400)
                .json({ detail: "Invalid variables", errors: v.errors });
        }
        // IDOR guard: project_id comes straight from the body and is threaded
        // into the assembled documents row (executeAuthoringJob →
        // persistAuthoredDocx), so an unverified id lets a caller plant a doc
        // in another user's project. 404 (not 403) to avoid leaking project
        // existence, matching the sibling project-writing routes.
        if (projectId) {
            const userEmail = res.locals.userEmail as string | undefined;
            const access = await checkProjectAccess(
                projectId,
                userId,
                userEmail,
                db,
                "mutate",
            );
            if (!access.ok)
                return res.status(404).json({ detail: "Project not found" });
        }
        // IDOR guard: a matter chat must belong to the same authorized matter;
        // standalone chats remain creator-only.
        if (chatId) {
            const { data: chatRow } = await db
                .from("chats")
                .select("id, user_id, project_id")
                .eq("id", chatId)
                .maybeSingle();
            const canLink = projectId
                ? chatRow?.project_id === projectId
                : chatRow?.project_id == null && chatRow?.user_id === userId;
            if (!chatRow || !canLink) {
                return res.status(404).json({ detail: "Chat not found" });
            }
        }

        // --- Stage the job + operation, then kick off the background worker --
        try {
            const apiKeys = await getUserApiKeys(userId, db);

            // Stage the authoring_jobs row (status assembling / qa pending),
            // mirroring the chat dispatch's insert shape.
            const { data: jobRow, error: jobErr } = await db
                .from("authoring_jobs")
                .insert({
                    template_id: resolved.template.id,
                    template_version_id: resolved.version.id,
                    user_id: userId,
                    project_id: projectId,
                    chat_id: chatId,
                    variables_json: variables,
                    status: "assembling",
                    qa_status: "pending",
                })
                .select("id")
                .single();
            if (jobErr || !jobRow) {
                return res.status(500).json({
                    detail: `Failed to stage the assembly job${
                        jobErr?.message ? `: ${jobErr.message}` : "."
                    }`,
                });
            }
            const authoringJobId = jobRow.id as string;

            // Create the operation already-running (no approval gate): the
            // wizard submit is the approval. The background worker
            // (executeAuthoringJob) reads its job id off this operation and
            // owns the terminal reconcile (job ready|failed + op
            // succeeded|failed).
            const op = await createAgentOperation({
                db,
                userId,
                projectId,
                chatId,
                toolName: "assemble_document",
                actionType: "assemble_document",
                mutating: true,
                requiresApproval: false,
                arguments: {
                    template_id: req.params.id,
                    variables,
                    jurisdiction,
                    authoring_job_id: authoringJobId,
                },
            });

            // Backfill the operation id onto the job (parity with the chat path).
            await db
                .from("authoring_jobs")
                .update({
                    agent_operation_id: op?.id ?? null,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", authoringJobId);

            // If the operation could not be created (e.g. the agent_operations
            // schema is unapplied in a dev env), we cannot run the worker, which
            // reads its job id off the operation. Mark the job failed and 500.
            if (!op) {
                await db
                    .from("authoring_jobs")
                    .update({
                        status: "failed",
                        updated_at: new Date().toISOString(),
                    })
                    .eq("id", authoringJobId);
                return res.status(500).json({
                    detail: "Could not create the assembly operation.",
                });
            }

            // Fire-and-forget the detached worker and return immediately. The
            // client polls GET /templates/jobs/:job_id for the result.
            startAuthoringJob({ db, op, model, apiKeys });

            return res.status(200).json({
                job_id: authoringJobId,
                operation_id: op.id,
                status: "assembling",
            });
        } catch (err) {
            console.error("[templates] assemble failed", err);
            const detail =
                err instanceof Error && err.message
                    ? err.message
                    : "Failed to assemble document";
            return res.status(500).json({ detail });
        }
    }),
);

templatesRouter.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(err);
        console.error("[templates] unhandled route error", err);
        res.status(500).json({ detail: "Failed to process template request" });
    },
);
