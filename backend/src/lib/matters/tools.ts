// backend/src/lib/matters/tools.ts
//
// Matter lookup for the assistant. "Matters" in the UI are rows in the
// `projects` table — the firm's client files — and until now NO llm tool in
// any chat context could read that table. Main chat ships no project tools,
// and `search_cases` only searches the personal-injury registry (`pi_cases`),
// so "what documents do I need to finish the divorce documents?" asked from
// the main chat came back empty even though the matter and its documents
// exist. (The vestigial `matters` table from the old tenancy scaffolding is
// never queried; `projects` is the real thing.)
//
// Two tools close the gap:
//   list_matters          — find the matter, scoped to active authoritative
//                           matter membership by user id or normalized email.
//   get_matter_documents  — list one matter's documents AND register them into
//                           the LIVE per-turn docStore / docIndex, so every
//                           returned `doc_id` is immediately readable by the
//                           existing read_document / find_in_document /
//                           fetch_documents tools. That registration is the
//                           whole trick — no new read tool is needed.
//
// Both are offered in the MAIN chat only (see chatTools.buildToolset). A
// matter chat is shared with the colleagues on the file and already reaches
// its own documents, so cross-matter reach there would leak one client's file
// into another client's thread rather than help.
//
// This module deliberately imports NOTHING from chatTools.ts. The dependency
// edge runs chatTools → satellite tool modules (calendar/tools, images/
// imageTools, recordings/*), never the reverse, so an import back would close
// a runtime cycle. `buildProjectDocContext` is therefore INJECTED by the
// chatTools dispatch site as `loadProjectDocContext`, the same way
// runCalendarToolCall takes an injected connector. The two doc-context types
// below are structural mirrors of chatTools' `DocIndex` / `DocStore` for the
// same reason; TypeScript checks them against the real ones at the dispatch
// site, so drift fails the build rather than passing silently.

import type { OpenAIToolSchema } from "../llm/types";
import type { createServerSupabase } from "../supabase";
import { checkProjectAccess, listAccessibleProjectIds } from "../access";

type Db = ReturnType<typeof createServerSupabase>;

/** Structural mirror of chatTools' `DocIndex`. */
export type MatterDocIndex = Record<
    string,
    {
        document_id: string;
        filename: string;
        version_id?: string | null;
        version_number?: number | null;
    }
>;

/** Structural mirror of chatTools' `DocStore`. */
export type MatterDocStore = Map<
    string,
    { storage_path: string; file_type: string; filename: string }
>;

/**
 * Injected shape of `chatTools.buildProjectDocContext`. It owns the documents
 * query, the folder-path resolution and the active-version storage paths;
 * `folderPaths` is keyed by ITS OWN local `doc-N` label, not by the live
 * per-turn slug, so the handler maps local label → live slug before reading it.
 */
export type ProjectDocContextLoader = (
    projectId: string,
    userId: string,
    db: Db,
) => Promise<{
    docIndex: MatterDocIndex;
    docStore: MatterDocStore;
    folderPaths: Map<string, string>;
}>;

/** Emitted by `list_matters` so the lookup is visible in the transcript. */
export type MatterSearchEvent = {
    type: "matter_search";
    /** The search term, or null when the model listed everything. */
    query: string | null;
    count: number;
    /** A few matched names so the card can say what was found. */
    matters: { matter_id: string; name: string }[];
};

/**
 * Emitted by `get_matter_documents`. Also read back by
 * `enrichWithPriorEvents`, which uses it to tell a later turn that the doc-N
 * handles from this call have expired and must be re-fetched.
 */
export type MatterDocumentsLoadedEvent = {
    type: "matter_documents_loaded";
    matter_id: string;
    matter_name: string;
    /**
     * EVERY document filed in the matter — the same number `list_matters`
     * reports and the same number the app's matter list shows. Not all of them
     * are necessarily readable; see `readable_count`.
     */
    document_count: number;
    /**
     * How many of them came back as live doc-N handles on this call. Lower
     * than `document_count` when documents are still processing, failed
     * extraction, or fell past the listing cap. Optional only for events
     * persisted before the field existed.
     */
    readable_count?: number;
    /** True when the matter's readable documents exceeded the listing cap. */
    truncated: boolean;
};

export const MATTER_TOOL_NAMES: ReadonlySet<string> = new Set([
    "list_matters",
    "get_matter_documents",
]);

/** Default / maximum rows `list_matters` returns. */
const DEFAULT_MATTER_LIMIT = 20;
const MAX_MATTER_LIMIT = 50;

/**
 * Ceiling on documents listed per `get_matter_documents` call, so a
 * 200-document matter can't flood the model's context in one tool result.
 */
const MATTER_DOC_LIST_CAP = 60;

/** Matched names carried on the SSE event (the card only needs a taste). */
const EVENT_NAME_SAMPLE = 5;

/** Matches routes/projects.ts — counts stay exact to the PostgREST row cap. */
const COUNT_ROW_CAP = 20000;

/**
 * How many documents are filed in one matter, counted the SAME way
 * `list_matters` and the app's matter list count them: every `documents` row,
 * no status filter.
 *
 * `get_matter_documents` needs it because the two tools would otherwise report
 * different numbers for the same matter — list_matters says "6 documents"
 * (what the sidebar shows) while get_matter_documents can only hand back the
 * ones that are ready AND have resolvable bytes, so it might load 4. Quoting
 * both without saying which is which is how Quill ends up contradicting
 * itself. Returns null when the count can't be read, so the caller reports
 * only what it actually loaded rather than a wrong total.
 */
async function countFiledDocuments(
    db: Db,
    matterId: string,
): Promise<number | null> {
    const { data, error } = await db
        .from("documents")
        .select("id")
        .eq("project_id", matterId)
        .limit(COUNT_ROW_CAP);
    if (error) {
        console.warn(
            "[matters] filed-document count failed:",
            (error as { message?: string }).message ?? error,
        );
        return null;
    }
    return (data ?? []).length;
}

export const MATTER_TOOLS: OpenAIToolSchema[] = [
    {
        type: "function",
        function: {
            name: "list_matters",
            description:
                "Find the firm's MATTERS (also called client files, engagements, or client matters). A matter is one client engagement — a divorce, a lease, a purchase agreement, a contract negotiation, a litigation file — and it is the folder that HOLDS that client's documents. Use this tool whenever the user names or alludes to a client, matter, engagement, counterparty, opposing party, or case caption ('the Doe divorce', 'the Roe file', 'the Sample Street lease'), or asks what documents something has, what is missing, or what still needs to be filled out — ESPECIALLY when those documents are NOT already listed in the AVAILABLE DOCUMENTS section of your context. If AVAILABLE DOCUMENTS is empty or does not contain what the user is talking about, the documents almost certainly live in a matter, and this is how you find it. Returns each matter's matter_id, name, cm_number (matter number), document_count, last-updated time, and whether it is shared with you rather than owned by you. document_count is every document FILED in the matter (the number the app shows); some of them may not be readable yet, so do not promise the user you have read that many until get_matter_documents tells you how many actually came back. Pass the matter_id to get_matter_documents to see and read that matter's documents. This is NOT search_cases: search_cases only searches the personal-injury case registry (intake, status, insurance policies, expenses) and will never find documents or any non-PI engagement, so a matter-name search there returns zero results.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Optional text to match against the matter name and matter number (case-insensitive, partial matches work). Prefer a short distinctive fragment — one surname or one keyword ('Roe', 'divorce', 'Sample Street') — over a full case caption. Omit entirely to list all matters you can access.",
                    },
                    limit: {
                        type: "integer",
                        description:
                            "Maximum matters to return (default 20, max 50). Most recently updated first.",
                    },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_matter_documents",
            description:
                "List every document filed in one matter (client file), and make those documents readable to you right now. Pass the matter_id from list_matters. Returns each document's doc_id, filename, file_type, folder_path within the matter, status, and version_number. After this call you can pass any returned doc_id STRAIGHT to read_document, fetch_documents, or find_in_document — no other lookup step is needed. It also returns document_count (every document filed in the matter — the same number list_matters gives) and readable_count (how many of them came back as usable handles here); when those differ, tell the user 'N of M', never the larger number as if you had read them all. Use this to answer 'what documents are in the X matter', 'what's missing from X', 'what do I still need to finish X', or before drafting/reviewing anything filed under a matter. IMPORTANT: the doc_id handles are valid for the CURRENT response ONLY. In any later turn you must call get_matter_documents again to get fresh handles — never reuse a doc_id you were given in an earlier response.",
            parameters: {
                type: "object",
                properties: {
                    matter_id: {
                        type: "string",
                        description:
                            "The matter's id, from list_matters. This is the matter_id field, not the matter name and not a case_id from search_cases.",
                    },
                },
                required: ["matter_id"],
            },
        },
    },
];

function str(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampLimit(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return DEFAULT_MATTER_LIMIT;
    }
    return Math.min(Math.max(Math.trunc(raw), 1), MAX_MATTER_LIMIT);
}

/**
 * Strip the characters that would let a user-typed term change the SHAPE of
 * the filter instead of narrowing it:
 *
 *   `,` `(` `)` — PostgREST `or()` delimiters. `,` separates conditions and
 *   `()` groups them, so an unescaped one silently corrupts the query. (Same
 *   guard as `listCases` in pi/store.ts.)
 *
 *   `%` `*` — `ilike` wildcards (PostgREST accepts `*` as an alias for `%`).
 *   The term is interpolated between two `%` of our own, so a term of "%" or
 *   "*" turns a search into "match everything" — the caller's access scope
 *   still holds, but a query is meant to narrow, never to widen.
 */
function sanitizeMatchTerm(raw: string): string {
    return raw.replace(/[,()%*]/g, " ").trim();
}

/**
 * A query made entirely of delimiters/wildcards sanitizes to nothing. Silently
 * dropping the filter would list every accessible matter — exactly the
 * widening the sanitizer exists to prevent — so say so instead.
 */
const WILDCARD_ONLY_GUIDANCE =
    "That search term has nothing to match on — it is only punctuation or wildcards, and wildcards like * and % are not supported here (they are not a way to list everything). Call list_matters again with a real name fragment, or with no query at all to see every matter you can access.";

/**
 * Zero results are a dead end unless the model is told how to retry, and the
 * usual cause is an over-long search term matched against a free-text name.
 */
function noMatchGuidance(hadQuery: boolean): string {
    return hadQuery
        ? "No matters matched that search. Matter names are free text, so try a SHORTER, more distinctive fragment (one surname or one keyword — 'Roe' rather than a full case caption), or call list_matters again with no query at all to see every matter you can access."
        : "No matters came back. Nothing further to try here — tell the user you couldn't find any matters rather than guessing at names.";
}

const ACCESS_DENIED =
    "No matter with that id is available to you. Call list_matters to find the right matter_id — pass the matter_id field exactly as returned, not a matter name and not a case_id from search_cases.";

/**
 * Execute one matter tool call.
 *
 * `get_matter_documents` mutates the caller's live `docIndex` / `docStore` in
 * place: that registration is what makes the returned handles work with the
 * existing document read tools inside the same turn.
 *
 * Both handlers catch their own errors and return a structured `ok:false`
 * rather than throwing — an exception here would kill the whole turn.
 */
export async function runMatterToolCall(params: {
    name: string;
    args: Record<string, unknown>;
    db: Db;
    userId: string;
    /**
     * The signed-in user's email. Used to resolve authoritative email-only
     * memberships; absent in service contexts, where access remains user-id
     * scoped.
     */
    userEmail?: string | null;
    /** THIS turn's live doc index — mutated by get_matter_documents. */
    docIndex?: MatterDocIndex;
    /** THIS turn's live doc store — mutated by get_matter_documents. */
    docStore?: MatterDocStore;
    /** Injected `chatTools.buildProjectDocContext` (see the module header). */
    loadProjectDocContext?: ProjectDocContextLoader;
}): Promise<{
    toolResult: Record<string, unknown>;
    matterSearch?: MatterSearchEvent;
    matterDocumentsLoaded?: MatterDocumentsLoadedEvent;
}> {
    const { name, args, db, userId, userEmail } = params;

    try {
        if (name === "list_matters") {
            const limit = clampLimit(args.limit);
            const rawQuery = str(args, "query");

            // Resolve the match term BEFORE any query: if a supplied term
            // sanitizes away to nothing there is no narrowing filter left to
            // run, and falling through would list everything.
            const term = rawQuery ? sanitizeMatchTerm(rawQuery) : "";
            if (rawQuery && !term) {
                return {
                    toolResult: {
                        ok: true,
                        count: 0,
                        matters: [],
                        message: WILDCARD_ONLY_GUIDANCE,
                    },
                    matterSearch: {
                        type: "matter_search",
                        query: rawQuery,
                        count: 0,
                        matters: [],
                    },
                };
            }

            const accessibleIds = await listAccessibleProjectIds(
                userId,
                userEmail,
                db,
            );
            if (accessibleIds.length === 0) {
                return {
                    toolResult: {
                        ok: true,
                        count: 0,
                        matters: [],
                        message:
                            "You don't have access to any matters yet, so there is nothing to search. Say so plainly instead of retrying with a different term.",
                    },
                    matterSearch: {
                        type: "matter_search",
                        query: rawQuery ?? null,
                        count: 0,
                        matters: [],
                    },
                };
            }

            let builder = db
                .from("projects")
                .select("id, name, cm_number, updated_at, user_id")
                .in("id", accessibleIds)
                .order("updated_at", { ascending: false })
                .limit(limit);
            if (term) {
                builder = builder.or(
                    `name.ilike.%${term}%,cm_number.ilike.%${term}%`,
                );
            }
            const { data, error } = await builder;
            if (error) {
                return {
                    toolResult: {
                        ok: false,
                        error: `Failed to look up matters: ${error.message}`,
                    },
                };
            }

            const rows = (data ?? []) as unknown as {
                id: string;
                name: string | null;
                cm_number: string | null;
                updated_at: string | null;
                user_id: string;
            }[];

            // One batched count query grouped client-side, not one count per
            // matter (routes/projects.ts uses the same shape). Counts every
            // document filed in the matter, matching the number shown in the
            // app's matter list; a query error degrades the count to 0 rather
            // than failing the lookup. `get_matter_documents` reports the same
            // total (countFiledDocuments) so the two tools never disagree
            // about how many documents a matter holds.
            const docCounts = new Map<string, number>();
            if (rows.length > 0) {
                const { data: docRows, error: docError } = await db
                    .from("documents")
                    .select("project_id")
                    .in(
                        "project_id",
                        rows.map((r) => r.id),
                    )
                    .limit(COUNT_ROW_CAP);
                if (docError) {
                    console.warn(
                        "[matters] document count query failed:",
                        docError.message,
                    );
                }
                for (const row of (docRows ?? []) as {
                    project_id: string | null;
                }[]) {
                    if (!row.project_id) continue;
                    docCounts.set(
                        row.project_id,
                        (docCounts.get(row.project_id) ?? 0) + 1,
                    );
                }
            }

            const matters = rows.map((row) => ({
                matter_id: row.id,
                name: row.name ?? "(untitled matter)",
                cm_number: row.cm_number ?? null,
                document_count: docCounts.get(row.id) ?? 0,
                updated_at: row.updated_at ?? null,
                is_shared: row.user_id !== userId,
            }));

            return {
                toolResult: {
                    ok: true,
                    count: matters.length,
                    matters,
                    message:
                        matters.length === 0
                            ? noMatchGuidance(Boolean(rawQuery))
                            : "Call get_matter_documents with a matter_id to list and read that matter's documents.",
                },
                matterSearch: {
                    type: "matter_search",
                    query: rawQuery ?? null,
                    count: matters.length,
                    matters: matters
                        .slice(0, EVENT_NAME_SAMPLE)
                        .map((m) => ({ matter_id: m.matter_id, name: m.name })),
                },
            };
        }

        if (name === "get_matter_documents") {
            const matterId = str(args, "matter_id");
            if (!matterId) {
                return {
                    toolResult: {
                        ok: false,
                        error: "get_matter_documents requires a matter_id (from list_matters).",
                    },
                };
            }

            // Access first, and identically for "no such matter" and "not
            // yours" — the caller must not be able to probe which ids exist.
            const access = await checkProjectAccess(
                matterId,
                userId,
                userEmail,
                db,
            );
            if (!access.ok) {
                return { toolResult: { ok: false, error: ACCESS_DENIED } };
            }

            const loadProjectDocContext = params.loadProjectDocContext;
            const docIndex = params.docIndex;
            const docStore = params.docStore;
            if (!loadProjectDocContext || !docIndex || !docStore) {
                return {
                    toolResult: {
                        ok: false,
                        error: "Matter documents can't be opened in this context.",
                    },
                };
            }

            // The matter's display fields come back on the access check's own
            // row read — no second query for the row we just fetched.
            const matterName = access.project.name ?? "(untitled matter)";
            const cmNumber = access.project.cm_number ?? null;

            // How many documents the matter HOLDS — the list_matters /
            // sidebar number. The loader below only surfaces the readable
            // ones, so without this the two tools report different totals for
            // the same matter and the model contradicts itself.
            const filedTotal = await countFiledDocuments(db, matterId);

            const {
                docIndex: sourceIndex,
                docStore: sourceStore,
                folderPaths,
            } = await loadProjectDocContext(matterId, userId, db);

            // The loader labels documents from its own doc-0 upward, which
            // collides with THIS turn's live slugs, so re-key everything
            // against the live maps.
            const sourceLabels = Object.keys(sourceIndex);
            const readyTotal = sourceLabels.length;
            const listedLabels = sourceLabels.slice(0, MATTER_DOC_LIST_CAP);
            const truncated = readyTotal > listedLabels.length;

            // A document already in this turn's context keeps the slug it
            // already has — allocating a second handle for the same
            // document_id would let the model cite one document two ways, and
            // would clobber an anchored (pinned-version) entry.
            const slugByDocumentId = new Map<string, string>();
            for (const [slug, info] of Object.entries(docIndex)) {
                if (info.document_id) slugByDocumentId.set(info.document_id, slug);
            }

            const documents: Record<string, unknown>[] = [];
            for (const sourceLabel of listedLabels) {
                const info = sourceIndex[sourceLabel];
                const stored = sourceStore.get(sourceLabel);
                // No storage path → the loader couldn't resolve bytes for it,
                // so a handle would resolve to a read failure. Skip it.
                if (!info || !stored) continue;

                let slug = slugByDocumentId.get(info.document_id);
                if (!slug) {
                    // First free doc-N against BOTH live maps, same pattern as
                    // create_clean_document / generate_docx. Slugs written
                    // below are visible to the next iteration's scan.
                    let i = 0;
                    while (
                        docIndex[`doc-${i}`] !== undefined ||
                        docStore.has(`doc-${i}`)
                    ) {
                        i++;
                    }
                    slug = `doc-${i}`;
                    docIndex[slug] = {
                        document_id: info.document_id,
                        filename: info.filename,
                        version_id: info.version_id ?? null,
                        version_number: info.version_number ?? null,
                    };
                    docStore.set(slug, {
                        storage_path: stored.storage_path,
                        file_type: stored.file_type,
                        filename: stored.filename,
                    });
                    slugByDocumentId.set(info.document_id, slug);
                }

                documents.push({
                    doc_id: slug,
                    filename: info.filename,
                    file_type: stored.file_type,
                    folder_path: folderPaths.get(sourceLabel) ?? null,
                    // The loader only surfaces status='ready' documents, so
                    // anything it returns is ready by construction.
                    status: "ready",
                    version_number: info.version_number ?? null,
                });
            }

            // `document_count` (what the matter HOLDS) and `readable_count`
            // (what this call could actually open) are different numbers, and
            // the model has to be able to explain the gap instead of quoting
            // list_matters' "6 documents" and then reading 4 without comment.
            const readableCount = documents.length;
            const filedCount = filedTotal ?? readableCount;
            const unreadable = Math.max(filedCount - readableCount, 0);
            const docWord = (n: number) => (n === 1 ? "document" : "documents");

            const parts = [
                readableCount === 0
                    ? `The matter "${matterName}" has no readable documents filed in it yet.`
                    : `Loaded ${readableCount} ${docWord(
                          readableCount,
                      )} from the matter "${matterName}".`,
            ];
            if (truncated) {
                parts.push(
                    `Only the first ${readableCount} are listed here — the listing is capped at ${MATTER_DOC_LIST_CAP} and is truncated, so say so if the answer might depend on the rest.`,
                );
            }
            if (unreadable > 0) {
                parts.push(
                    `The matter holds ${filedCount} ${docWord(
                        filedCount,
                    )} in total and ${readableCount} ${
                        readableCount === 1 ? "is" : "are"
                    } readable here${
                        truncated
                            ? ""
                            : ` — the other ${unreadable} ${
                                  unreadable === 1 ? "is" : "are"
                              } filed but not readable right now (still processing, or no extractable file)`
                    }. If you give the user a count, say ${readableCount} of ${filedCount}; never report ${filedCount} as though you had read them all.`,
                );
            }
            if (readableCount > 0) {
                parts.push(
                    "Each doc_id below is a live handle: pass it straight to read_document, fetch_documents, or find_in_document in THIS response.",
                    "These doc_id handles are valid for the CURRENT response only. In any later turn, call get_matter_documents again with this matter_id to get fresh handles — never reuse a doc_id from an earlier response.",
                );
            }

            return {
                toolResult: {
                    ok: true,
                    matter_id: matterId,
                    matter_name: matterName,
                    cm_number: cmNumber,
                    // Every document filed in the matter — the SAME count
                    // list_matters and the app's matter list report.
                    document_count: filedCount,
                    // How many of them you can actually read from this call.
                    readable_count: readableCount,
                    truncated,
                    documents,
                    message: parts.join(" "),
                },
                matterDocumentsLoaded: {
                    type: "matter_documents_loaded",
                    matter_id: matterId,
                    matter_name: matterName,
                    document_count: filedCount,
                    readable_count: readableCount,
                    truncated,
                },
            };
        }

        return {
            toolResult: { ok: false, error: `Unknown matter tool: ${name}` },
        };
    } catch (err) {
        return {
            toolResult: {
                ok: false,
                error: `Matter lookup failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            },
        };
    }
}
