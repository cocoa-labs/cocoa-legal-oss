import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { extractDocumentMarkdown } from "../lib/documentExtraction";
import { hasFullFeatureSet } from "../lib/uploadTypes";
import {
    runLLMStream,
    buildToolset,
    TABULAR_TOOLS,
    generateDocx,
    type ChatMessage,
    type TabularCellStore,
} from "../lib/chatTools";
import {
    CRE_DOCX_FLAG_LABEL,
    cleanSummaryForDocx,
    firstCitationForDocx,
} from "../lib/creAbstractFormat";
import {
    truncateForExtraction,
    truncationAdvisory,
    TRUNCATION_SYSTEM_SUFFIX,
    emptyExtractionReason,
} from "../lib/creReliability";
import {
    completeText,
    providerForModel,
    streamChatWithTools,
    type Provider,
    type UserApiKeys,
} from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { parseCurrentChatMessage } from "../lib/chatMessages";
import {
    conversationContextSize,
    loadConversationContext,
} from "../lib/conversationContext";
import { queueConversationSummary } from "../lib/conversationSummary/worker";
import {
    checkProjectAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
} from "../lib/access";
import { resolveFirmId, getEffectivePlaybookEntries } from "../lib/playbooks";
import { resolveAuthUsers } from "../lib/userLookup";
import { envInt, mapWithConcurrency } from "../lib/concurrency";
import {
    substitute,
    extractPlaybookKeys,
} from "../lib/systemPrompt/substitute";
import { defaultRepresentedPartyForColumns } from "../lib/legalCapabilities/creProfiles";
import { recordAuditEvent } from "../lib/audit";
import { listProjectMembers } from "../lib/tenancy";
import { assistantResponseIntegrity } from "../lib/assistantResponseIntegrity";

function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

export const tabularRouter = Router();

function providerLabel(provider: Provider): string {
    if (provider === "claude") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    if (provider === "openrouter") return "OpenRouter";
    return "Gemini";
}

function missingModelApiKey(model: string, apiKeys: UserApiKeys) {
    const provider = providerForModel(model);
    if (apiKeys[provider]?.trim()) return null;
    return {
        provider,
        model,
        detail: `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    };
}

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    // Optional ?project_id= scopes results to a single project. Project-page
    // callers pass it; the global tabular-reviews page omits it. We still
    // enforce access via listAccessibleProjectIds so a stranger can't request
    // an arbitrary project_id.
    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    // Visible reviews = user's own + reviews in any accessible project.
    const projectIds = await listAccessibleProjectIds(userId, userEmail, db);

    if (projectIdFilter && !projectIds.includes(projectIdFilter)) {
        // No access to that project — also covers "project doesn't exist".
        return void res.json([]);
    }

    let ownQuery = db
        .from("tabular_reviews")
        .select("*")
        .eq("user_id", userId)
        .is("project_id", null)
        .order("created_at", { ascending: false });
    if (projectIdFilter) ownQuery = ownQuery.eq("project_id", projectIdFilter);

    const sharedProjectIds = projectIdFilter ? [projectIdFilter] : projectIds;
    // Membership-authorized sources to merge:
    //  - own:           reviews this user created
    //  - sharedProj:    reviews in a project the user has access to
    // Standalone reviews are owner-only. The legacy shared_with column is
    // response compatibility data and never grants access.
    const [
        { data: own, error: ownErr },
        { data: shared, error: sharedErr },
        { data: sharedDirect, error: sharedDirectErr },
    ] = await Promise.all([
        ownQuery,
        sharedProjectIds.length > 0
            ? db
                  .from("tabular_reviews")
                  .select("*")
                  .in("project_id", sharedProjectIds)
                  .order("created_at", { ascending: false })
            : Promise.resolve({
                  data: [] as Record<string, unknown>[],
                  error: null,
              }),
        Promise.resolve({
            data: [] as Record<string, unknown>[],
            error: null,
        }),
    ]);
    if (ownErr) return void res.status(500).json({ detail: ownErr.message });
    // Don't fail the whole list when an auxiliary share query errors — most
    // commonly the tabular_reviews.shared_with column hasn't been migrated
    // yet. Log and continue so the user still sees their own reviews.
    if (sharedErr)
        console.warn(
            "[tabular] shared-by-project query failed:",
            sharedErr.message,
        );
    const seen = new Set<string>();
    const reviews: Record<string, unknown>[] = [];
    for (const r of [
        ...(own ?? []),
        ...(shared ?? []),
        ...(sharedDirect ?? []),
    ]) {
        const id = (r as { id: string }).id;
        if (seen.has(id)) continue;
        seen.add(id);
        reviews.push(r as Record<string, unknown>);
    }

    // Fetch distinct document counts per review
    const reviewIds = reviews.map((r) => (r as { id: string }).id);
    let docCounts: Record<string, number> = {};
    const reviewsWithExplicitDocs = new Set<string>();
    for (const review of reviews) {
        const id = (review as { id: string }).id;
        if (Array.isArray(review.document_ids)) {
            const explicitDocIds = review.document_ids;
            reviewsWithExplicitDocs.add(id);
            docCounts[id] = new Set(explicitDocIds).size;
        }
    }
    if (reviewIds.length > 0) {
        const { data: cells } = await db
            .from("tabular_cells")
            .select("review_id, document_id")
            .in("review_id", reviewIds);
        if (cells) {
            const seen = new Set<string>();
            for (const cell of cells) {
                const key = `${cell.review_id}:${cell.document_id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    if (!reviewsWithExplicitDocs.has(cell.review_id)) {
                        docCounts[cell.review_id] =
                            (docCounts[cell.review_id] ?? 0) + 1;
                    }
                }
            }
        }
    }

    res.json(
        reviews.map((r) => {
            const id = (r as { id: string }).id;
            return { ...r, document_count: docCounts[id] ?? 0 };
        }),
    );
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const {
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        represented_party,
    } = req.body as {
        title?: string;
        document_ids: string[];
        columns_config: { index: number; name: string; prompt: string }[];
        workflow_id?: string;
        project_id?: string;
        represented_party?: string | null;
    };

    const db = createServerSupabase();
    let orgId: string | null = null;
    let matterId: string | null = null;
    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
            "mutate",
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
        orgId = access.project.org_id;
        matterId = access.project.matter_id;
    } else {
        const { data: membership } = await db
            .from("organization_memberships")
            .select("organization_id")
            .eq("user_id", userId)
            .eq("status", "active")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
        orgId = membership?.organization_id ?? null;
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(document_ids, userId, userEmail, db)
        : [];
    if (project_id && allowedDocumentIds.length > 0) {
        const { data: projectDocs } = await db
            .from("documents")
            .select("id")
            .eq("project_id", project_id)
            .in("id", allowedDocumentIds);
        const projectDocumentIds = new Set(
            (projectDocs ?? []).map((row) => String(row.id)),
        );
        if (allowedDocumentIds.some((id) => !projectDocumentIds.has(id)))
            return void res.status(400).json({
                code: "REVIEW_DOCUMENT_SCOPE_MISMATCH",
                detail: "Every review document must belong to the selected project.",
            });
    }
    // Normalize the represented side: trim and persist null when blank so a
    // non-CRE review (no control shown) stays null, unaffected.
    const normalizedRepresentedParty =
        typeof represented_party === "string" && represented_party.trim()
            ? represented_party.trim()
            : null;

    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            columns_config,
            document_ids: allowedDocumentIds,
            project_id: project_id ?? null,
            org_id: orgId,
            matter_id: matterId,
            workflow_id: workflow_id ?? null,
            represented_party: normalizedRepresentedParty,
        })
        .select("*")
        .single();
    if (error || !review)
        return void res
            .status(500)
            .json({ detail: error?.message ?? "Failed to create review" });

    const cells = allowedDocumentIds.flatMap((docId) =>
        columns_config.map((col) => ({
            review_id: review.id,
            document_id: docId,
            column_index: col.index,
            status: "pending",
        })),
    );
    if (cells.length) await db.from("tabular_cells").insert(cells);

    res.status(201).json(review);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId);
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cellDocIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    const hasExplicitDocIds = Array.isArray(review.document_ids);
    const explicitDocIds = hasExplicitDocIds
        ? (review.document_ids as string[])
        : [];
    const docIds = hasExplicitDocIds ? explicitDocIds : cellDocIds;
    const docsResult =
        docIds.length > 0
            ? await db.from("documents").select("*").in("id", docIds)
            : { data: [] as Record<string, unknown>[] };

    res.json({
        review: { ...review, is_owner: access.isOwner },
        cells: (cells ?? []).map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        documents: docsResult.data ?? [],
    });
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    if (review.project_id) {
        const projectAccess = await checkProjectAccess(
            review.project_id as string,
            userId,
            userEmail,
            db,
        );
        if (!projectAccess.ok || !projectAccess.project.matter_id)
            return void res.status(404).json({ detail: "Review not found" });
        const members = await listProjectMembers(
            db,
            projectAccess.project.matter_id,
            userId,
        );
        return void res.json({
            current_user_role: projectAccess.role,
            can_manage:
                projectAccess.role === "owner" ||
                projectAccess.role === "admin",
            members,
        });
    }

    // Standalone reviews are private to their creator. They can be shared only
    // after being filed into a membership-scoped matter.
    const resolved = await resolveAuthUsers(db, {
        userIds: [review.user_id as string],
    }).catch(() => ({ userById: new Map() }));
    const owner = resolved.userById.get(review.user_id as string);
    res.json({
        can_manage: false,
        owner: {
            user_id: review.user_id,
            email: owner?.email ?? null,
            display_name: null,
        },
        members: [],
    });
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    if (req.body.columns_config != null)
        updates.columns_config = req.body.columns_config;
    if (req.body.project_id !== undefined)
        updates.project_id = req.body.project_id;
    if (Array.isArray(req.body.shared_with)) {
        return void res.status(400).json({
            code: "MEMBERSHIP_API_REQUIRED",
            detail: "File the review in a project and use role-aware project memberships to grant access.",
        });
    }
    updates.updated_at = new Date().toISOString();

    const db = createServerSupabase();
    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void res.status(500).json({
            detail: updateError?.message ?? "Failed to update review",
        });

    let persistedDocumentIds: string[] | undefined;
    if (
        Array.isArray(req.body.columns_config) ||
        Array.isArray(req.body.document_ids)
    ) {
        const { data: existingCells } = await db
            .from("tabular_cells")
            .select("document_id,column_index")
            .eq("review_id", reviewId);
        const existingKeys = new Set(
            (existingCells ?? []).map(
                (cell) => `${cell.document_id}:${cell.column_index}`,
            ),
        );

        let documentIds: string[];

        if (Array.isArray(req.body.document_ids)) {
            // document_ids is the new source of truth — delete removed docs' cells
            const requestedDocIds = req.body.document_ids as string[];
            const existingDocIds = (existingCells ?? []).map(
                (cell) => cell.document_id,
            );
            const existingDocIdSet = new Set(existingDocIds);
            const newDocCandidates = requestedDocIds.filter(
                (id) => !existingDocIdSet.has(id),
            );
            const newDocAllowed = await filterAccessibleDocumentIds(
                newDocCandidates,
                userId,
                userEmail,
                db,
            );
            const newDocAllowedSet = new Set(newDocAllowed);
            const newDocIds = requestedDocIds.filter(
                (id) => existingDocIdSet.has(id) || newDocAllowedSet.has(id),
            );
            const removedDocIds = existingDocIds.filter(
                (id) => !newDocIds.includes(id),
            );

            if (removedDocIds.length > 0) {
                const { error: deleteError } = await db
                    .from("tabular_cells")
                    .delete()
                    .eq("review_id", reviewId)
                    .in("document_id", removedDocIds);
                if (deleteError)
                    return void res
                        .status(500)
                        .json({ detail: deleteError.message });
            }

            documentIds = newDocIds;
        } else {
            // No document change — derive from existing cells
            documentIds = [
                ...new Set(
                    (existingCells ?? []).map((cell) => cell.document_id),
                ),
            ];
        }

        if (Array.isArray(req.body.document_ids)) {
            persistedDocumentIds = documentIds;
            const { error: documentIdsError } = await db
                .from("tabular_reviews")
                .update({
                    document_ids: documentIds,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", reviewId);
            if (documentIdsError)
                return void res.status(500).json({
                    detail: documentIdsError.message,
                });
        }

        const activeColumns = Array.isArray(req.body.columns_config)
            ? req.body.columns_config
            : (updatedReview.columns_config ?? []);
        const newCells = documentIds.flatMap((documentId) =>
            activeColumns
                .filter(
                    (column: { index: number }) =>
                        !existingKeys.has(`${documentId}:${column.index}`),
                )
                .map((column: { index: number }) => ({
                    review_id: reviewId,
                    document_id: documentId,
                    column_index: column.index,
                    status: "pending",
                })),
        );

        if (newCells.length > 0) {
            const { error: insertError } = await db
                .from("tabular_cells")
                .insert(newCells);
            if (insertError)
                return void res
                    .status(500)
                    .json({ detail: insertError.message });
        }
    }

    res.json({
        ...updatedReview,
        ...(persistedDocumentIds ? { document_ids: persistedDocumentIds } : {}),
    });
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .maybeSingle();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
        "lifecycle",
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    const { error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given document_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { document_ids } = req.body as { document_ids?: string[] };

    if (!Array.isArray(document_ids) || document_ids.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids is required" });

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { error } = await db
        .from("tabular_cells")
        .update({ content: null, status: "pending" })
        .eq("review_id", reviewId)
        .in("document_id", document_ids);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_id, column_index } = req.body as {
            document_id: string;
            column_index: number;
        };

        if (!document_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "document_id and column_index are required" });

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(
            review,
            userId,
            userEmail,
            db,
            "mutate",
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const column = (
            review.columns_config as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        // Steering: inline the firm's playbook into any {{playbook:key}}
        // placeholders AND the represented side into any {{representedParty}}
        // placeholder in this column's prompt before extraction. No-op when
        // the prompt has neither placeholder. The represented side comes from
        // the review's persisted `represented_party`, falling back to a
        // sensible default by doc type. queryTabularCell stays pure.
        const cellPlaybookKeys = extractPlaybookKeys(column.prompt);
        const cellHasRepresentedParty = column.prompt.includes(
            "{{representedParty}}",
        );
        if (cellPlaybookKeys.length > 0 || cellHasRepresentedParty) {
            const resolvedPlaybook =
                cellPlaybookKeys.length > 0
                    ? await getEffectivePlaybookEntries(
                          db,
                          await resolveFirmId(userId),
                          cellPlaybookKeys,
                      )
                    : {};
            const representedParty =
                (review.represented_party as string | null) ??
                defaultRepresentedPartyForColumns(
                    review.columns_config as { name: string }[] | null,
                );
            column.prompt = substitute(
                column.prompt,
                resolvedPlaybook,
                representedParty,
            );
        }

        const docAllowed = await filterAccessibleDocumentIds(
            [document_id],
            userId,
            userEmail,
            db,
        );
        if (docAllowed.length === 0)
            return void res.status(404).json({ detail: "Document not found" });
        const { data: doc } = await db
            .from("documents")
            .select("id, filename, file_type")
            .eq("id", document_id)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docActive = await loadActiveVersion(document_id, db);

        const { tabular_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const missingKey = missingModelApiKey(tabular_model, api_keys);
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }

        await db
            .from("tabular_cells")
            .update({ status: "generating", content: null })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        let markdown = "";
        if (docActive) {
            // Tier 2 docs (xlsx, pptx, csv, md, html, etc.) extract from
            // their PDF rendition — otherwise mammoth throws on non-DOCX
            // bytes and the LLM gets an empty document → confidently
            // hallucinated answers. extractDocumentMarkdown enforces the
            // routing. Tier 1 (pdf/docx/doc) reads rawBuf, so only fetch
            // the rendition when it will actually be used.
            const needsRendition = !hasFullFeatureSet(doc.file_type as string);
            const [rawBuf, pdfBuf] = await Promise.all([
                downloadFile(docActive.storage_path),
                needsRendition && docActive.pdf_storage_path
                    ? downloadFile(docActive.pdf_storage_path)
                    : Promise.resolve(null),
            ]);
            if (rawBuf) {
                try {
                    markdown = await extractDocumentMarkdown({
                        fileType: doc.file_type as string,
                        rawBuf,
                        pdfRenditionBuf: pdfBuf,
                    });
                } catch (err) {
                    console.error(
                        `[regenerate-cell] extraction error doc=${document_id}`,
                        err,
                    );
                }
            }
        }

        const extractionFailed = !markdown;

        const result = await queryTabularCell(
            tabular_model,
            doc.filename as string,
            markdown,
            column.prompt,
            column.format,
            column.tags,
            api_keys,
        );

        if (!result) {
            await db
                .from("tabular_cells")
                .update({ status: "error" })
                .eq("review_id", reviewId)
                .eq("document_id", document_id)
                .eq("column_index", column_index);
            return void res.status(500).json({ detail: "Generation failed" });
        }

        // When document extraction returned empty (Tier 2 with no PDF
        // rendition, conversion failure, etc.), still surface the LLM's
        // answer but flag the cell as error so the user knows the
        // answer was produced WITHOUT document grounding. Prevents the
        // silent-hallucinated-answer failure mode flagged in code
        // review.
        if (extractionFailed) {
            const flagged = {
                ...result,
                flag: "red",
                reasoning: emptyExtractionReason(doc.file_type as string),
            };
            await db
                .from("tabular_cells")
                .update({
                    content: JSON.stringify(flagged),
                    status: "error",
                })
                .eq("review_id", reviewId)
                .eq("document_id", document_id)
                .eq("column_index", column_index);
            res.json(flagged);
            return;
        }

        await db
            .from("tabular_cells")
            .update({ content: JSON.stringify(result), status: "done" })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        res.json(result);
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
        "mutate",
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[] = review.columns_config ?? [];
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    // Steering: inline the firm's playbook into any {{playbook:key}}
    // placeholders AND the represented side into any {{representedParty}}
    // placeholder in the column prompts BEFORE extraction. Firm override
    // wins for playbook keys, falling back to the default-shared seed; the
    // represented side comes from the review's persisted `represented_party`
    // (set at configure time), falling back to a sensible default by doc
    // type so the placeholder never leaks literally. Resolves to a no-op
    // when no column references either placeholder (today's non-CRE prod).
    // The downstream queryTabularAllColumns stays pure — it receives prompts
    // that are already fully substituted.
    const playbookKeys = extractPlaybookKeys(columns.map((c) => c.prompt));
    const hasRepresentedParty = columns.some((c) =>
        c.prompt.includes("{{representedParty}}"),
    );
    if (playbookKeys.length > 0 || hasRepresentedParty) {
        const resolvedPlaybook =
            playbookKeys.length > 0
                ? await getEffectivePlaybookEntries(
                      db,
                      await resolveFirmId(userId),
                      playbookKeys,
                  )
                : {};
        const representedParty =
            (review.represented_party as string | null) ??
            defaultRepresentedPartyForColumns(columns);
        for (const col of columns) {
            col.prompt = substitute(
                col.prompt,
                resolvedPlaybook,
                representedParty,
            );
        }
    }

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cellMap = new Map<string, Record<string, unknown>>();
    for (const cell of cells ?? [])
        cellMap.set(`${cell.document_id}:${cell.column_index}`, cell);

    const docIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    const allowedDocIds = new Set(
        await filterAccessibleDocumentIds(docIds, userId, userEmail, db),
    );
    let docs: Record<string, unknown>[] = [];
    if (docIds.length > 0) {
        const filteredIds = docIds.filter((id) => allowedDocIds.has(id));
        const { data } =
            filteredIds.length > 0
                ? await db
                      .from("documents")
                      .select("id, filename, file_type, page_count")
                      .in("id", filteredIds)
                : { data: [] as Record<string, unknown>[] };
        docs = data ?? [];
    } else if (review.project_id) {
        const { data } = await db
            .from("documents")
            .select("id, filename, file_type, page_count")
            .eq("project_id", review.project_id)
            .order("created_at", { ascending: true });
        docs = data ?? [];
    }

    const { tabular_model, api_keys } = await getUserModelSettings(userId, db);
    const missingKey = missingModelApiKey(tabular_model, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    try {
        // Pace the per-document pipelines (storage download + extract + LLM
        // stream). The old unbounded Promise.all launched every document at
        // once — a 50-doc review meant 50 concurrent downloads and 50 open
        // LLM streams from a single request. Per-cell semantics and SSE
        // event shapes are unchanged; only scheduling differs.
        await mapWithConcurrency(
            docs,
            envInt("TABULAR_GENERATE_CONCURRENCY", 4),
            async (doc) => {
                const docId = doc.id as string;
                const filename = doc.filename as string;
                let markdown = "";

                const active = await loadActiveVersion(docId, db);
                if (active) {
                    // Tier 2 docs extract from their PDF rendition. See
                    // extractDocumentMarkdown for routing. Tier 1 reads
                    // rawBuf, so only fetch the rendition when used.
                    const needsRendition = !hasFullFeatureSet(
                        doc.file_type as string,
                    );
                    const [rawBuf, pdfBuf] = await Promise.all([
                        downloadFile(active.storage_path),
                        needsRendition && active.pdf_storage_path
                            ? downloadFile(active.pdf_storage_path)
                            : Promise.resolve(null),
                    ]);
                    if (rawBuf) {
                        try {
                            markdown = await extractDocumentMarkdown({
                                fileType: doc.file_type as string,
                                rawBuf,
                                pdfRenditionBuf: pdfBuf,
                            });
                        } catch (err) {
                            console.error(
                                `[tabular/generate] extraction error doc=${docId}`,
                                err,
                            );
                        }
                    }
                }
                const extractionFailed = !markdown;

                // Filter to only columns that need processing
                const columnsToProcess = columns.filter((col) => {
                    const cell = cellMap.get(`${docId}:${col.index}`);
                    return !(cell?.status === "done" && cell?.content);
                });
                if (columnsToProcess.length === 0) return;

                // Mark all as generating upfront
                for (const col of columnsToProcess) {
                    write(
                        `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "generating" })}\n\n`,
                    );
                    const existingCell = cellMap.get(`${docId}:${col.index}`);
                    if (existingCell) {
                        await db
                            .from("tabular_cells")
                            .update({ status: "generating", content: null })
                            .eq("id", existingCell.id);
                    } else {
                        await db.from("tabular_cells").insert({
                            review_id: reviewId,
                            document_id: docId,
                            column_index: col.index,
                            status: "generating",
                        });
                    }
                }

                // Single LLM call for all columns, streaming one JSON line per column
                const receivedColumns = new Set<number>();
                try {
                    await queryTabularAllColumns(
                        tabular_model,
                        filename,
                        markdown,
                        columnsToProcess,
                        async (columnIndex, result) => {
                            receivedColumns.add(columnIndex);
                            // Per the extraction-failure handling in the
                            // regenerate-cell endpoint: when document
                            // extraction returned empty markdown, the LLM
                            // still ran but the cell is flagged red and
                            // marked status=error so the user can see the
                            // answer is ungrounded.
                            const persisted = extractionFailed
                                ? {
                                      ...result,
                                      flag: "red",
                                      reasoning: emptyExtractionReason(
                                          doc.file_type as string,
                                      ),
                                  }
                                : result;
                            const status = extractionFailed ? "error" : "done";
                            await db
                                .from("tabular_cells")
                                .update({
                                    content: JSON.stringify(persisted),
                                    status,
                                })
                                .eq("review_id", reviewId)
                                .eq("document_id", docId)
                                .eq("column_index", columnIndex);
                            write(
                                `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: columnIndex, content: persisted, status })}\n\n`,
                            );
                        },
                        api_keys,
                    );
                } catch (err) {
                    console.error(
                        `[tabular/generate] queryTabularAllColumns error doc=${docId}`,
                        err,
                    );
                }

                // Mark any columns the LLM didn't return as error
                for (const col of columnsToProcess) {
                    if (!receivedColumns.has(col.index)) {
                        await db
                            .from("tabular_cells")
                            .update({ status: "error" })
                            .eq("review_id", reviewId)
                            .eq("document_id", docId)
                            .eq("column_index", col.index);
                        write(
                            `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "error" })}\n\n`,
                        );
                    }
                }
            },
        );

        write("data: [DONE]\n\n");
    } catch (err) {
        console.error("[tabular/generate] stream error", err);
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\ndata: [DONE]\n\n`,
            );
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    // Verify access (owner or shared-project member).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select("id, title, created_at, updated_at, user_id")
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const db = createServerSupabase();
        // Owner-only delete — sibling collaborators shouldn't be able to wipe
        // each other's threads.
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void res.status(500).json({ detail: error.message });
        res.status(204).send();
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, review_id")
            .eq("id", chatId)
            .single();
        if (chatError || !chat || chat.review_id !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages } = await db
            .from("tabular_review_chat_messages")
            .select(
                "id, role, content, annotations, generation_status, finish_reason, created_at",
            )
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json(messages ?? []);
    },
);

// ---------------------------------------------------------------------------
// Tabular citation parsing
// ---------------------------------------------------------------------------

type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}

// ---------------------------------------------------------------------------
// Build messages for tabular chat
// ---------------------------------------------------------------------------

function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
    conversationSummary?: string | null,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    let systemContent = `You are Quill, the AI legal colleague inside Coco Legal. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    if (conversationSummary) {
        systemContent += `\n\nOLDER CONVERSATION MEMORY:\n${conversationSummary}`;
    }

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chat — agentic streaming
// ---------------------------------------------------------------------------

// POST /tabular-review/:reviewId/chat
tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessage = parseCurrentChatMessage(body.message, body.messages);
    if (!parsedMessage.ok) {
        return void res.status(400).json({ detail: parsedMessage.detail });
    }
    const lastUser = parsedMessage.message;
    const {
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
    } = body as {
        chat_id?: string;
        review_title?: string;
        project_name?: string;
    };

    const db = createServerSupabase();
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
        "annotate",
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Fetch all cells and documents for this review
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);

    const docIds = [
        ...new Set((cells ?? []).map((c: any) => c.document_id as string)),
    ];
    let docs: { id: string; filename: string }[] = [];
    if (docIds.length > 0) {
        const { data } = await db
            .from("documents")
            .select("id, filename")
            .in("id", docIds)
            .order("created_at", { ascending: true });
        docs = (data ?? []) as { id: string; filename: string }[];
    }

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: docs,
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.document_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    const { tabular_model, api_keys } = await getUserModelSettings(userId, db);
    const missingKey = missingModelApiKey(tabular_model, api_keys);
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        // Either chat owner OR any project member of the parent review can
        // continue the chat. We've already verified review access above.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.review_id === reviewId;
        if (!canUse || !existing) {
            return void res.status(404).json({ detail: "Chat not found" });
        }
        chatTitle = existing.title;
    }

    if (!chatId) {
        const { data: newChat, error: createChatError } = await db
            .from("tabular_review_chats")
            .insert({ review_id: reviewId, user_id: userId })
            .select("id, title")
            .single();
        if (createChatError || !newChat) {
            return void res.status(500).json({
                code: "persistence_error",
                detail: "Failed to create the saved tabular conversation",
            });
        }
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    if (!chatId) {
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to resolve the saved tabular conversation",
        });
    }

    const conversationContext = await loadConversationContext({
        db,
        surface: "tabular",
        chatId,
    }).catch((error) => {
        console.error("[conversation-context] load failed", {
            surface: "tabular",
            chatId,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    });
    if (!conversationContext) {
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to load the saved conversation",
        });
    }
    if (conversationContext.unsummarizedOverflowEpisodeCount > 0) {
        await queueConversationSummary({
            db,
            surface: "tabular",
            chatId,
            completedEpisodeCount: conversationContext.episodes.filter(
                (episode) => episode.completed,
            ).length,
        }).catch((error) => {
            console.error("[conversation-summary] lazy backfill queue failed", {
                chatId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    const messages: ChatMessage[] = [...conversationContext.messages, lastUser];
    const isFirstExchange = !conversationContext.episodes.some(
        (episode) => episode.user,
    );

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
        conversationContext.summaryText,
    );

    const contextCapacity = conversationContextSize({
        model: tabular_model,
        apiMessages,
        tools: buildToolset(TABULAR_TOOLS),
        outputReserveTokens: 32_000,
    });
    console.info("[conversation-context] capacity", {
        surface: "tabular",
        chatId,
        model: tabular_model,
        estimatedInputTokens: contextCapacity.estimatedInputTokens,
        maximumInputTokens: contextCapacity.maximumInputTokens,
        fits: contextCapacity.ok,
    });
    if (!contextCapacity.ok) {
        return void res.status(422).json({
            code: "conversation_context_too_large",
            detail: "This saved conversation's guaranteed 50-episode context does not fit the selected model. Choose a model with a larger context window; no conversation history was truncated.",
            estimated_input_tokens: contextCapacity.estimatedInputTokens,
            maximum_input_tokens: contextCapacity.maximumInputTokens,
        });
    }

    const { error: userInsertError } = await db
        .from("tabular_review_chat_messages")
        .insert({ chat_id: chatId, role: "user", content: lastUser.content });
    if (userInsertError) {
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to record message",
        });
    }
    const { data: assistantRow, error: assistantInsertError } = await db
        .from("tabular_review_chat_messages")
        .insert({
            chat_id: chatId,
            role: "assistant",
            content: null,
            model_id: tabular_model,
            generation_status: "streaming",
            generation_updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();
    if (assistantInsertError || !assistantRow) {
        return void res.status(500).json({
            code: "persistence_error",
            detail: "Failed to create the durable assistant response",
        });
    }
    const assistantMessageId = String(assistantRow.id);
    const abortController = new AbortController();
    let streamFinished = false;
    req.once("aborted", () => abortController.abort());
    res.once("close", () => {
        if (!streamFinished) abortController.abort();
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (line: string) => res.write(line);

    if (chatId) {
        write(
            `data: ${JSON.stringify({
                type: "chat_id",
                chatId,
                assistant_message_id: assistantMessageId,
                requested_model_id: tabular_model,
            })}\n\n`,
        );
    }

    try {
        const {
            fullText,
            events,
            finishReason,
            usage,
            iterations,
            modelId,
            citations,
            durationMs,
        } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            userEmail,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: tabular_model,
            apiKeys: api_keys,
            chatId,
            assistantMessageId,
            conversationSurface: "tabular",
            signal: abortController.signal,
            deferTerminalEvents: true,
            onCheckpoint: async (checkpointEvents) => {
                const { error } = await db
                    .from("tabular_review_chat_messages")
                    .update({
                        content: checkpointEvents.length
                            ? checkpointEvents
                            : null,
                        generation_updated_at: new Date().toISOString(),
                    })
                    .eq("id", assistantMessageId);
                if (error) throw error;
            },
            // Tabular chat intentionally remains a bounded one-shot path;
            // durable legal-document drafting uses provider-aware maxima.
            maxOutputTokens: 32_000,
        });

        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            const { error: assistantUpdateError } = await db
                .from("tabular_review_chat_messages")
                .update({
                    content: events.length ? events : null,
                    annotations: annotations.length ? annotations : null,
                    model_id: modelId,
                    generation_status:
                        finishReason === "completed"
                            ? "completed"
                            : finishReason === "cancelled"
                              ? "cancelled"
                              : finishReason === "refused"
                                ? "refused"
                                : finishReason === "error"
                                  ? "failed"
                                  : "incomplete",
                    finish_reason: finishReason,
                    generation_usage_json: { ...usage, iterations },
                    generation_updated_at: new Date().toISOString(),
                })
                .eq("id", assistantMessageId);
            if (assistantUpdateError) {
                throw new Error(
                    `PERSISTENCE_ERROR: ${assistantUpdateError.message}`,
                );
            }
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const { title_model } = await getUserModelSettings(userId, db);
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                api_keys,
            );
            if (title) {
                await db
                    .from("tabular_review_chats")
                    .update({ title })
                    .eq("id", chatId);
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }

        await queueConversationSummary({
            db,
            surface: "tabular",
            chatId,
            completedEpisodeCount:
                conversationContext.episodes.filter(
                    (episode) => episode.completed,
                ).length + 1,
        }).catch((error) => {
            console.error("[conversation-summary] queue failed", {
                chatId,
                error: error instanceof Error ? error.message : String(error),
            });
        });

        const integrity = assistantResponseIntegrity(events);
        write(`data: ${JSON.stringify({ type: "citations", citations })}\n\n`);
        write(
            `data: ${JSON.stringify({
                type: "generation_finish",
                finish_reason: finishReason,
                usage,
                iterations,
                duration_ms: durationMs,
                assistant_message_id: assistantMessageId,
                requested_model_id: tabular_model,
                final_model_id: modelId,
                visible_text_utf8_bytes: integrity.visibleTextUtf8Bytes,
                visible_text_sha256: integrity.visibleTextSha256,
            })}\n\n`,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        console.error("[tabular/chat] error", err);
        const cancelled = abortController.signal.aborted;
        const { error: terminalStatusError } = await db
            .from("tabular_review_chat_messages")
            .update({
                generation_status: cancelled ? "cancelled" : "failed",
                finish_reason: cancelled ? "cancelled" : "error",
                generation_updated_at: new Date().toISOString(),
            })
            .eq("id", assistantMessageId);
        try {
            const message = terminalStatusError
                ? `PERSISTENCE_ERROR: ${terminalStatusError.message}`
                : err instanceof Error
                  ? err.message
                  : String(err);
            if (message.startsWith("PERSISTENCE_ERROR:")) {
                write(
                    `data: ${JSON.stringify({
                        type: "persistence_error",
                        code: "persistence_error",
                        message:
                            "The response could not be saved, so it was not marked complete.",
                    })}\n\n`,
                );
            } else {
                write(
                    `data: ${JSON.stringify({ type: "error", message })}\n\n`,
                );
            }
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});

function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

// Prefix the deterministic truncation advisory onto a cell's reasoning when
// its source was cut at the extraction limit. Mirrors the empty-extraction
// guard's mechanism (augmenting the same `reasoning` field) so it surfaces
// in the result card and the XLSX export. No-op when not truncated, so
// in-limit documents are byte-for-byte unchanged.
function withTruncationAdvisory(
    reasoning: string,
    truncation: { truncated: boolean; droppedChars: number },
): string {
    if (!truncation.truncated) return reasoning;
    const advisory = truncationAdvisory(truncation.droppedChars);
    return reasoning ? `${advisory}\n\n${reasoning}` : advisory;
}

async function queryTabularCell(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: import("../lib/llm").UserApiKeys,
) {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    // Hard-cap the document text and surface the cut: when truncated, the
    // model is told to flag possibly-incomplete late-document answers, and
    // the advisory is prefixed onto this cell's reasoning below.
    const doc = truncateForExtraction(documentText);
    const systemPrompt = doc.truncated
        ? `${EXTRACTION_SYSTEM}${TRUNCATION_SYSTEM_SUFFIX}`
        : EXTRACTION_SYSTEM;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt,
            user: `Document: ${filename}\n\n${doc.text}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        console.error("[queryTabularCell] completion failed", err);
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: withTruncationAdvisory(
                String(parsed.reasoning ?? ""),
                doc,
            ),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: withTruncationAdvisory("", doc),
              }
            : null;
    }
}

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

function buildTabularContext(
    columns: any[],
    docs: any[],
    cells: any[],
): string {
    const lines: string[] = [
        "# Tabular Review Context\n",
        "Columns (0-based index):",
    ];
    columns.forEach((col: any, i: number) =>
        lines.push(`- COL:${i} → "${col.name}"`),
    );
    lines.push("", "Documents (0-based row index):");
    docs.forEach((doc: any, i: number) =>
        lines.push(`- ROW:${i} → "${doc.filename}"`),
    );
    lines.push("", "## Table Data\n");
    lines.push(`| Document | ${columns.map((c: any) => c.name).join(" | ")} |`);
    lines.push(`|---|${columns.map(() => "---").join("|")}|`);
    docs.forEach((doc: any, rowIdx: number) => {
        const rowCells = columns.map((col: any, colPos: number) => {
            const cell = cells.find(
                (c: any) =>
                    c.document_id === doc.id && c.column_index === col.index,
            ) as any;
            if (
                !cell ||
                cell.status === "pending" ||
                cell.status === "generating"
            ) {
                return `(pending) [[COL:${colPos}||ROW:${rowIdx}]]`;
            }
            if (cell.status === "error") {
                return `(error) [[COL:${colPos}||ROW:${rowIdx}]]`;
            }
            const content = parseCellContent(cell.content);
            const summary = content?.summary?.trim() || "(not yet generated)";
            const truncated =
                summary.length > 400 ? summary.slice(0, 400) + "…" : summary;
            return `${truncated} [[COL:${colPos}||ROW:${rowIdx}]]`;
        });
        lines.push(
            `| ROW:${rowIdx} ${doc.filename} | ${rowCells.join(" | ")} |`,
        );
    });
    return lines.join("\n");
}

type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

async function queryTabularAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    // Hard-cap the document text and surface the cut: when truncated, the
    // model is told to flag possibly-incomplete late-document answers, and
    // the advisory is prefixed onto each column's reasoning below.
    const doc = truncateForExtraction(documentText);
    const systemPrompt = doc.truncated
        ? `${SYSTEM}${TRUNCATION_SYSTEM_SUFFIX}`
        : SYSTEM;

    const USER = `Document: ${filename}\n\n${doc.text}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: withTruncationAdvisory(
                    String(parsed.reasoning ?? ""),
                    doc,
                ),
            });
        } catch {
            // malformed line — skip
        }
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        console.error("[queryTabularAllColumns] stream failed", err);
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
}

// extractPdfMarkdown and extractDocxMarkdown moved to
// backend/src/lib/documentExtraction.ts so all extraction lives in one
// module. Tier 2 file_types are routed via the PDF rendition there.

// ── CRE lease-abstract DOCX memo export ──────────────────────────────────────
//
// Deterministic server-side export: load the review's columns_config +
// tabular_cells, assemble sections (a per-category heading + a summary table
// of Term | Value | Flag | Citation, landscape) and reuse the existing
// generateDocx pipeline from chatTools so the result persists as a first-class
// `documents` row and returns a download handle. Preferred over agent-driven
// generation so the CRE result-card button works directly. Access is enforced
// by ensureReviewAccess, mirroring the other review routes. The marker-stripping
// + citation helpers live in lib/creAbstractFormat (unit-tested separately).

// POST /tabular-review/:reviewId/export-docx
tabularRouter.post("/:reviewId/export-docx", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const { reviewId } = req.params;

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
        "export",
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
    }[] = [
        ...((review.columns_config ?? []) as { index: number; name: string }[]),
    ].sort((a, b) => a.index - b.index);
    if (columns.length === 0)
        return void res
            .status(400)
            .json({ detail: "Review has no columns to export" });

    const { data: cellRows } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cells = cellRows ?? [];

    // Single-asset abstract: build the table from the first (representative)
    // document's cells; fall back to any cell for a column.
    const primaryDocId = (review.document_ids as string[] | null)?.[0];
    const cellFor = (columnIndex: number) => {
        const scoped = cells.filter(
            (c) =>
                c.column_index === columnIndex &&
                (!primaryDocId || c.document_id === primaryDocId),
        );
        if (scoped.length > 0) return scoped[0];
        return cells.find((c) => c.column_index === columnIndex);
    };

    const rows: string[][] = columns.map((col) => {
        const cell = cellFor(col.index);
        const content = parseCellContent(cell?.content);
        const summary = content?.summary;
        const flag = content?.flag;
        return [
            col.name,
            cleanSummaryForDocx(summary) || "—",
            flag ? (CRE_DOCX_FLAG_LABEL[flag] ?? flag) : "",
            firstCitationForDocx(summary),
        ];
    });

    const sections = [
        {
            heading: "Lease Abstract",
            content:
                `Generated from review "${review.title ?? "Untitled Review"}". ` +
                `Flags: Deal-breaker (red), Review (yellow), Market (green).`,
        },
        {
            heading: "Summary of Terms",
            table: {
                headers: ["Term", "Value", "Flag", "Citation"],
                rows,
            },
        },
    ];

    const baseTitle = review.title || "Lease Abstract";

    try {
        const result = await generateDocx(
            `${baseTitle} — Lease Abstract`,
            sections,
            userId,
            db,
            {
                landscape: true,
                projectId: (review.project_id as string | null) ?? null,
            },
        );
        await recordAuditEvent(db, {
            orgId: review.org_id as string | null,
            matterId: review.matter_id as string | null,
            projectId: review.project_id as string | null,
            actorUserId: userId,
            actorRole: access.role,
            eventType: "review.exported",
            targetType: "tabular_review",
            targetId: reviewId,
            requestId: String(res.getHeader("x-request-id") ?? ""),
        });
        return void res.json(result);
    } catch (err) {
        console.error("[tabular] export-docx failed", err);
        return void res
            .status(500)
            .json({ detail: "Failed to generate document" });
    }
});
