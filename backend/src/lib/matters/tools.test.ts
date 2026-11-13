// backend/src/lib/matters/tools.test.ts
//
// The two load-bearing properties of the matter lookup tools:
//
//   1. list_matters never escapes the caller's access scope. Every query is
//      pinned to the ids listAccessibleProjectIds returned, the user-typed
//      search term is stripped of PostgREST or() delimiters before it reaches
//      the filter string, and scope is derived only from active matter
//      memberships (never projects.shared_with).
//
//   2. get_matter_documents registers the matter's documents into the LIVE
//      per-turn docStore/docIndex. That registration is the whole point — it
//      is what makes read_document / fetch_documents / find_in_document work
//      on matter documents with no new read tool. New handles take the first
//      free doc-N; a document already in this turn's context keeps the slug it
//      already has instead of getting a duplicate.
//
// Scripted, call-recording Supabase stub (the pi/store.test.ts variant, plus
// `.filter` — listAccessibleProjectIds uses .filter("shared_with","cs",…) and
// a stub missing it throws confusingly). No live database, no chatTools import.
import assert from "node:assert/strict";
import {
    runMatterToolCall,
    type MatterDocIndex,
    type MatterDocStore,
    type ProjectDocContextLoader,
} from "./tools";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown },
    ) => {
        const c: Record<string, unknown> = {};
        const record =
            (method: string) =>
            (...args: unknown[]) => {
                log.calls.push({ method, args });
                return c;
            };
        for (const m of [
            "insert",
            "update",
            "upsert",
            "delete",
            "select",
            "eq",
            "neq",
            "in",
            "is",
            "or",
            "not",
            "ilike",
            "filter",
            "contains",
            "lt",
            "lte",
            "gt",
            "gte",
            "order",
            "limit",
            "range",
        ]) {
            c[m] = record(m);
        }
        const resolved = {
            data: result.data ?? null,
            error: result.error ?? null,
        };
        c.single = () => Promise.resolve(resolved);
        c.maybeSingle = () => Promise.resolve(resolved);
        c.then = (resolve: (v: unknown) => void) => resolve(resolved);
        return c;
    };
    const db = {
        from: (table: string) => {
            const log: ChainLog = { table, calls: [] };
            chains.push(log);
            return makeChain(log, script[next++] ?? {});
        },
    } as never;
    return { db, chains };
}

function callsOf(chain: ChainLog, method: string) {
    return chain.calls.filter((c) => c.method === method);
}

function allCallsOf(chains: ChainLog[], method: string) {
    return chains.flatMap((chain) => callsOf(chain, method));
}

type DocRow = {
    doc_id: string;
    filename: string;
    file_type: string;
    folder_path: string | null;
    status: string;
    version_number: number | null;
};

/**
 * A canned stand-in for chatTools.buildProjectDocContext. Records its calls so
 * the access-denied test can prove it was never reached.
 */
function makeLoader(docs: {
    document_id: string;
    filename: string;
    file_type: string;
    storage_path: string;
    version_id?: string | null;
    version_number?: number | null;
    folder_path?: string;
}[]) {
    const calls: { projectId: string; userId: string }[] = [];
    const loader: ProjectDocContextLoader = async (projectId, userId) => {
        calls.push({ projectId, userId });
        // The real loader labels from ITS OWN doc-0 upward, which is exactly
        // the collision the handler has to re-key around.
        const docIndex: MatterDocIndex = {};
        const docStore: MatterDocStore = new Map();
        const folderPaths = new Map<string, string>();
        docs.forEach((doc, i) => {
            const label = `doc-${i}`;
            docIndex[label] = {
                document_id: doc.document_id,
                filename: doc.filename,
                version_id: doc.version_id ?? null,
                version_number: doc.version_number ?? null,
            };
            docStore.set(label, {
                storage_path: doc.storage_path,
                file_type: doc.file_type,
                filename: doc.filename,
            });
            if (doc.folder_path) folderPaths.set(label, doc.folder_path);
        });
        return { docIndex, docStore, folderPaths };
    };
    return { loader, calls };
}

async function main(): Promise<void> {
    console.log("matters/tools.test.ts");

    // 1. list_matters: scoping, sanitization, ordering, clamping, counts ------
    await test("list_matters scopes to accessible ids, sanitizes the term, clamps the limit and groups doc counts", async () => {
        const { db, chains } = makeDb([
            { data: [{ matter_id: "m1" }, { matter_id: "m2" }] },
            { data: [{ matter_id: "m3" }] },
            { data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] },
            {
                data: [
                    {
                        id: "p1",
                        name: "Doe/Roe Divorce",
                        cm_number: "2026-001",
                        updated_at: "2026-08-01T00:00:00Z",
                        user_id: "u1",
                    },
                    {
                        id: "p3",
                        name: "Sample Street Lease",
                        cm_number: null,
                        updated_at: "2026-07-01T00:00:00Z",
                        user_id: "u2",
                    },
                ],
            },
            {
                data: [
                    { project_id: "p1" },
                    { project_id: "p1" },
                    { project_id: "p1" },
                    { project_id: "p3" },
                    { project_id: null }, // orphan row must not crash or count
                ],
            },
        ]);

        const res = await runMatterToolCall({
            name: "list_matters",
            // The `,` and `()` here are PostgREST or() delimiters — if they
            // survive into the filter string the whole query is corrupted.
            args: { query: "Doe, Roe (Divorce)", limit: 500 },
            db,
            userId: "u1",
            userEmail: "u1@example.com",
        });

        const search = chains[3];
        assert.equal(search.table, "projects");
        // Scoped to exactly the ids listAccessibleProjectIds returned.
        assert.deepEqual(callsOf(search, "in")[0].args, [
            "id",
            ["p1", "p2", "p3"],
        ]);
        // Sanitized match filter: the delimiters are gone, so the only comma
        // left is the one joining the two ilike conditions.
        const orArg = String(callsOf(search, "or")[0].args[0]);
        assert.equal(
            orArg,
            "name.ilike.%Doe  Roe  Divorce%,cm_number.ilike.%Doe  Roe  Divorce%",
        );
        assert.equal(orArg.split(",").length, 2);
        assert.ok(!orArg.includes("(") && !orArg.includes(")"));
        // Ordering + limit clamping (500 → the 50 ceiling).
        assert.deepEqual(callsOf(search, "order")[0].args, [
            "updated_at",
            { ascending: false },
        ]);
        assert.deepEqual(callsOf(search, "limit")[0].args, [50]);

        // One batched count query, grouped client-side.
        const counts = chains[4];
        assert.equal(counts.table, "documents");
        assert.deepEqual(callsOf(counts, "in")[0].args, [
            "project_id",
            ["p1", "p3"],
        ]);

        const out = res.toolResult as {
            ok: boolean;
            count: number;
            matters: {
                matter_id: string;
                name: string;
                cm_number: string | null;
                document_count: number;
                updated_at: string | null;
                is_shared: boolean;
            }[];
        };
        assert.equal(out.ok, true);
        assert.equal(out.count, 2);
        assert.deepEqual(out.matters[0], {
            matter_id: "p1",
            name: "Doe/Roe Divorce",
            cm_number: "2026-001",
            document_count: 3,
            updated_at: "2026-08-01T00:00:00Z",
            is_shared: false,
        });
        assert.equal(out.matters[1].document_count, 1);
        // p3 is owned by u2 and reached via shared_with → flagged as shared.
        assert.equal(out.matters[1].is_shared, true);

        // The search must be visible in the transcript.
        assert.equal(res.matterSearch?.type, "matter_search");
        assert.equal(res.matterSearch?.count, 2);
        assert.equal(res.matterSearch?.query, "Doe, Roe (Divorce)");
        assert.deepEqual(res.matterSearch?.matters, [
            { matter_id: "p1", name: "Doe/Roe Divorce" },
            { matter_id: "p3", name: "Sample Street Lease" },
        ]);
    });

    // 2. Access scoping: no userEmail → no shared lookup at all ---------------
    await test("list_matters without a userEmail never issues the shared_with lookup", async () => {
        const { db, chains } = makeDb([
            { data: [{ matter_id: "m1" }] },
            { data: [{ id: "p1" }] },
            {
                data: [
                    {
                        id: "p1",
                        name: "Owned Matter",
                        cm_number: null,
                        updated_at: "2026-08-01T00:00:00Z",
                        user_id: "u1",
                    },
                ],
            },
            { data: [] },
        ]);

        const res = await runMatterToolCall({
            name: "list_matters",
            args: {},
            db,
            userId: "u1",
            // no userEmail — service contexts degrade to owner-only
        });

        // The shared-projects branch is the only .filter("shared_with", …)
        // call in the path; it must not have been issued.
        assert.deepEqual(allCallsOf(chains, "filter"), []);
        assert.equal(chains.length, 4);
        // …and the scope query is pinned to the owner-only id set.
        assert.deepEqual(callsOf(chains[2], "in")[0].args, ["id", ["p1"]]);

        const out = res.toolResult as {
            ok: boolean;
            count: number;
            matters: { matter_id: string; is_shared: boolean }[];
        };
        assert.equal(out.ok, true);
        assert.equal(out.count, 1);
        assert.deepEqual(
            out.matters.map((m) => m.matter_id),
            ["p1"],
        );
        assert.ok(out.matters.every((m) => !m.is_shared));
    });

    // 3. Empty results carry guidance ----------------------------------------
    await test("list_matters with no matches returns count 0 plus retry guidance", async () => {
        const { db, chains } = makeDb([
            { data: [{ matter_id: "m1" }] },
            { data: [] },
            { data: [{ id: "p1" }] },
            { data: [] }, // no matter matched the term
        ]);

        const res = await runMatterToolCall({
            name: "list_matters",
            args: { query: "zzz-nonexistent" },
            db,
            userId: "u1",
            userEmail: "u1@example.com",
        });

        // No rows → no count query is issued at all.
        assert.equal(chains.length, 4);
        const out = res.toolResult as {
            ok: boolean;
            count: number;
            matters: unknown[];
            message: string;
        };
        assert.equal(out.ok, true);
        assert.equal(out.count, 0);
        assert.deepEqual(out.matters, []);
        assert.match(out.message, /shorter/i);
        assert.match(out.message, /no query/i);
        assert.equal(res.matterSearch?.count, 0);
    });

    // 3b. Wildcards must narrow, never widen ---------------------------------
    await test("list_matters strips ilike wildcards and refuses a wildcard-only query instead of listing everything", async () => {
        // (a) `*` and `%` are ilike wildcards (PostgREST treats `*` as an
        // alias for `%`). A query made only of them used to sanitize to a
        // non-empty term and match every matter the user can reach — a search
        // silently turning into "list everything".
        for (const wildcard of ["*", "%", " ( %* ) "]) {
            const { db, chains } = makeDb([]);
            const res = await runMatterToolCall({
                name: "list_matters",
                args: { query: wildcard },
                db,
                userId: "u1",
                userEmail: "u1@example.com",
            });
            const out = res.toolResult as {
                ok: boolean;
                count: number;
                matters: unknown[];
                message: string;
            };
            assert.equal(out.ok, true, `query ${JSON.stringify(wildcard)}`);
            assert.equal(out.count, 0, `query ${JSON.stringify(wildcard)}`);
            assert.deepEqual(out.matters, []);
            assert.match(out.message, /wildcard/i);
            // A search that cannot narrow must not run at all.
            assert.deepEqual(
                chains,
                [],
                `query ${JSON.stringify(wildcard)} still issued queries`,
            );
            assert.equal(res.matterSearch?.count, 0);
            assert.equal(res.matterSearch?.query, wildcard.trim());
        }

        // (b) Wildcards embedded in a real term are stripped, not passed
        // through into the ilike pattern.
        const { db, chains } = makeDb([
            { data: [{ matter_id: "m1" }] },
            { data: [] },
            { data: [{ id: "p1" }] },
            {
                data: [
                    {
                        id: "p1",
                        name: "Roe Divorce",
                        cm_number: null,
                        updated_at: "2026-08-01T00:00:00Z",
                        user_id: "u1",
                    },
                ],
            },
            { data: [] },
        ]);
        await runMatterToolCall({
            name: "list_matters",
            args: { query: "%Roe*" },
            db,
            userId: "u1",
            userEmail: "u1@example.com",
        });
        const orArg = String(callsOf(chains[3], "or")[0].args[0]);
        assert.equal(orArg, "name.ilike.%Roe%,cm_number.ilike.%Roe%");
        // Exactly the four `%` we wrap the term in ourselves — none survived
        // from the user's text.
        assert.equal((orArg.match(/%/g) ?? []).length, 4);
        assert.ok(!orArg.includes("*"));
    });

    // 4. get_matter_documents happy path: live slug registration --------------
    await test("get_matter_documents registers handles in the live docStore/docIndex and reuses an overlapping slug", async () => {
        // ONE projects read: the access check's own row carries the matter's
        // name/number, so there is no second read of the same row. Then one
        // `documents` count — the matter's FILED total, counted the same way
        // list_matters counts it so the two tools can't report different
        // numbers for the same matter.
        const { db, chains } = makeDb([
            {
                data: {
                    id: "m1",
                    user_id: "u1",
                    shared_with: null,
                    matter_id: "matter-1",
                    lifecycle_status: "active",
                    name: "Doe/Roe Divorce",
                    cm_number: "2026-001",
                },
            },
            { data: { role: "owner" } },
            // 4 filed, but the loader below can only resolve 3 of them.
            { data: [{ id: "d1" }, { id: "d2" }, { id: "d3" }, { id: "d4" }] },
        ]);

        // THIS turn's live context, already holding an unrelated attachment
        // (doc-0) and one document that ALSO lives in the matter (doc-1 → d3).
        const docIndex: MatterDocIndex = {
            "doc-0": {
                document_id: "other-doc",
                filename: "Attached.pdf",
                version_id: "v9",
                version_number: 9,
            },
            "doc-1": {
                document_id: "d3",
                filename: "Financials.pdf",
                version_id: "v-anchored",
                version_number: 4,
            },
        };
        const docStore: MatterDocStore = new Map([
            [
                "doc-0",
                {
                    storage_path: "live/attached.pdf",
                    file_type: "pdf",
                    filename: "Attached.pdf",
                },
            ],
            [
                "doc-1",
                {
                    storage_path: "live/financials-anchored.pdf",
                    file_type: "pdf",
                    filename: "Financials.pdf",
                },
            ],
        ]);

        const { loader, calls } = makeLoader([
            {
                document_id: "d1",
                filename: "Petition.docx",
                file_type: "docx",
                storage_path: "matter/petition.docx",
                version_id: "v1",
                version_number: 1,
                folder_path: "Pleadings",
            },
            {
                document_id: "d2",
                filename: "Settlement Memo.docx",
                file_type: "docx",
                storage_path: "matter/memo.docx",
                version_id: "v2",
                version_number: 2,
            },
            {
                document_id: "d3",
                filename: "Financials.pdf",
                file_type: "pdf",
                storage_path: "matter/financials.pdf",
                version_id: "v3",
                version_number: 3,
                folder_path: "Discovery / Financials",
            },
        ]);

        const res = await runMatterToolCall({
            name: "get_matter_documents",
            args: { matter_id: "m1" },
            db,
            userId: "u1",
            userEmail: "u1@example.com",
            docIndex,
            docStore,
            loadProjectDocContext: loader,
        });

        assert.deepEqual(calls, [{ projectId: "m1", userId: "u1" }]);
        // Exactly one `projects` round-trip plus the filed-document count.
        assert.deepEqual(
            chains.map((c) => c.table),
            ["projects", "matter_memberships", "documents"],
        );
        // The count is scoped to this matter, like routes/projects.ts.
        assert.deepEqual(callsOf(chains[2], "eq"), [
            { method: "eq", args: ["project_id", "m1"] },
        ]);

        const out = res.toolResult as {
            ok: boolean;
            matter_id: string;
            matter_name: string;
            cm_number: string | null;
            document_count: number;
            readable_count: number;
            truncated: boolean;
            documents: DocRow[];
            message: string;
        };
        assert.equal(out.ok, true);
        assert.equal(out.matter_name, "Doe/Roe Divorce");
        assert.equal(out.cm_number, "2026-001");
        // document_count is what the matter HOLDS (list_matters' number);
        // readable_count is what this call could actually open. The two used
        // to be conflated, so Quill could say "4 documents" and read 3.
        assert.equal(out.document_count, 4);
        assert.equal(out.readable_count, 3);
        assert.equal(out.truncated, false);
        // The message has to make the gap explainable rather than leaving the
        // model to contradict itself.
        assert.match(out.message, /3 of 4/);

        // New handles take the first free doc-N (doc-0/doc-1 are taken).
        assert.deepEqual(out.documents[0], {
            doc_id: "doc-2",
            filename: "Petition.docx",
            file_type: "docx",
            folder_path: "Pleadings",
            status: "ready",
            version_number: 1,
        });
        assert.equal(out.documents[1].doc_id, "doc-3");
        assert.equal(out.documents[1].folder_path, null);
        // d3 is already in this turn's context → it keeps its existing slug
        // rather than getting a duplicate handle.
        assert.equal(out.documents[2].doc_id, "doc-1");
        assert.equal(out.documents[2].folder_path, "Discovery / Financials");
        assert.equal(out.documents[2].file_type, "pdf");

        // The registration is the point: every returned handle resolves in the
        // LIVE docStore, which is what read_document / fetch_documents read.
        for (const doc of out.documents) {
            assert.ok(
                docStore.has(doc.doc_id),
                `live docStore is missing ${doc.doc_id}`,
            );
            assert.equal(docIndex[doc.doc_id].filename, doc.filename);
        }
        assert.equal(docStore.get("doc-2")?.storage_path, "matter/petition.docx");
        assert.equal(docIndex["doc-2"].document_id, "d1");
        assert.equal(docIndex["doc-2"].version_id, "v1");
        // Reuse must not clobber the pre-existing (possibly version-anchored)
        // entry.
        assert.equal(
            docStore.get("doc-1")?.storage_path,
            "live/financials-anchored.pdf",
        );
        assert.equal(docIndex["doc-1"].version_number, 4);
        // The unrelated attachment is untouched.
        assert.equal(docIndex["doc-0"].document_id, "other-doc");
        assert.deepEqual(Object.keys(docIndex).sort(), [
            "doc-0",
            "doc-1",
            "doc-2",
            "doc-3",
        ]);

        // The handles must be advertised as single-response only.
        assert.match(out.message, /current response only/i);
        assert.equal(res.matterDocumentsLoaded?.type, "matter_documents_loaded");
        assert.equal(res.matterDocumentsLoaded?.matter_id, "m1");
        assert.equal(
            res.matterDocumentsLoaded?.matter_name,
            "Doe/Roe Divorce",
        );
        assert.equal(res.matterDocumentsLoaded?.document_count, 4);
        assert.equal(res.matterDocumentsLoaded?.readable_count, 3);
        assert.equal(res.matterDocumentsLoaded?.truncated, false);
    });

    // 5. Access denied: identical refusal, loader never reached ---------------
    await test("get_matter_documents denies access without leaking existence and never loads documents", async () => {
        const { loader, calls } = makeLoader([
            {
                document_id: "d1",
                filename: "Secret.docx",
                file_type: "docx",
                storage_path: "matter/secret.docx",
            },
        ]);

        // (a) the id does not exist at all
        const missing = makeDb([{ data: null }]);
        // No script entry beyond the access check: nothing past it may run.
        const docIndexA: MatterDocIndex = {};
        const docStoreA: MatterDocStore = new Map();
        const resMissing = await runMatterToolCall({
            name: "get_matter_documents",
            args: { matter_id: "does-not-exist" },
            db: missing.db,
            userId: "u1",
            userEmail: "u1@example.com",
            docIndex: docIndexA,
            docStore: docStoreA,
            loadProjectDocContext: loader,
        });

        // (b) the id exists but belongs to someone else and is not shared
        const forbidden = makeDb([
            {
                data: {
                    id: "m2",
                    user_id: "someone-else",
                    shared_with: ["other@example.com"],
                    matter_id: "matter-2",
                    lifecycle_status: "active",
                },
            },
            { data: null },
            { data: null },
        ]);
        const docIndexB: MatterDocIndex = {};
        const docStoreB: MatterDocStore = new Map();
        const resForbidden = await runMatterToolCall({
            name: "get_matter_documents",
            args: { matter_id: "m2" },
            db: forbidden.db,
            userId: "u1",
            userEmail: "u1@example.com",
            docIndex: docIndexB,
            docStore: docStoreB,
            loadProjectDocContext: loader,
        });

        const a = resMissing.toolResult as { ok: boolean; error: string };
        const b = resForbidden.toolResult as { ok: boolean; error: string };
        assert.equal(a.ok, false);
        assert.equal(b.ok, false);
        // Identical text: the caller cannot tell "no such matter" from "not
        // yours" and so cannot probe which ids exist.
        assert.equal(a.error, b.error);
        assert.match(a.error, /list_matters/);
        // Nothing was loaded and nothing was registered — and the refusal
        // costs exactly one `projects` read, never a peek at `documents`.
        assert.deepEqual(calls, []);
        assert.deepEqual(
            missing.chains.map((c) => c.table),
            ["projects"],
        );
        assert.deepEqual(
            forbidden.chains.map((c) => c.table),
            ["projects", "matter_memberships", "matter_memberships", "audit_events"],
        );
        assert.equal(resMissing.matterDocumentsLoaded, undefined);
        assert.equal(resForbidden.matterDocumentsLoaded, undefined);
        assert.deepEqual(Object.keys(docIndexA), []);
        assert.deepEqual(Object.keys(docIndexB), []);
        assert.equal(docStoreA.size, 0);
        assert.equal(docStoreB.size, 0);
    });

    // 6. Listing cap ---------------------------------------------------------
    await test("get_matter_documents caps the listing and flags truncation", async () => {
        const TOTAL = 65;
        const { db } = makeDb([
            {
                data: {
                    id: "m1",
                    user_id: "u1",
                    shared_with: null,
                    matter_id: "matter-1",
                    lifecycle_status: "active",
                    name: "Mega Matter",
                    cm_number: null,
                },
            },
            { data: { role: "owner" } },
            {
                data: Array.from({ length: TOTAL }, (_, i) => ({ id: `d${i}` })),
            },
        ]);

        const { loader } = makeLoader(
            Array.from({ length: TOTAL }, (_, i) => ({
                document_id: `d${i}`,
                filename: `File ${i}.pdf`,
                file_type: "pdf",
                storage_path: `matter/file-${i}.pdf`,
                version_number: 1,
            })),
        );

        const docIndex: MatterDocIndex = {};
        const docStore: MatterDocStore = new Map();
        const res = await runMatterToolCall({
            name: "get_matter_documents",
            args: { matter_id: "m1" },
            db,
            userId: "u1",
            userEmail: "u1@example.com",
            docIndex,
            docStore,
            loadProjectDocContext: loader,
        });

        const out = res.toolResult as {
            ok: boolean;
            document_count: number;
            readable_count: number;
            truncated: boolean;
            documents: DocRow[];
            message: string;
        };
        assert.equal(out.ok, true);
        assert.equal(out.document_count, TOTAL);
        assert.equal(out.documents.length, 60);
        assert.equal(out.readable_count, 60);
        assert.equal(out.truncated, true);
        assert.match(out.message, /truncated/i);
        assert.match(out.message, new RegExp(String(TOTAL)));
        assert.match(out.message, /60 of 65/);
        // Only the listed documents are registered — the cap must bound the
        // live maps too, not just the tool result.
        assert.equal(docStore.size, 60);
        assert.equal(Object.keys(docIndex).length, 60);
        assert.equal(out.documents[0].doc_id, "doc-0");
        assert.equal(out.documents[59].doc_id, "doc-59");
        assert.equal(res.matterDocumentsLoaded?.truncated, true);
        assert.equal(res.matterDocumentsLoaded?.document_count, TOTAL);
        assert.equal(res.matterDocumentsLoaded?.readable_count, 60);
    });

    // 6b. The filed-count query is best-effort ------------------------------
    await test("a failed filed-document count degrades to the readable count instead of a wrong total", async () => {
        const { db } = makeDb([
            {
                data: {
                    id: "m1",
                    user_id: "u1",
                    shared_with: null,
                    matter_id: "matter-1",
                    lifecycle_status: "active",
                    name: "Counted Matter",
                    cm_number: null,
                },
            },
            { data: { role: "owner" } },
            { error: { message: "count exploded" } },
        ]);
        const { loader } = makeLoader([
            {
                document_id: "d1",
                filename: "Only.docx",
                file_type: "docx",
                storage_path: "matter/only.docx",
            },
        ]);
        const docIndex: MatterDocIndex = {};
        const docStore: MatterDocStore = new Map();
        const res = await runMatterToolCall({
            name: "get_matter_documents",
            args: { matter_id: "m1" },
            db,
            userId: "u1",
            userEmail: "u1@example.com",
            docIndex,
            docStore,
            loadProjectDocContext: loader,
        });
        const out = res.toolResult as {
            ok: boolean;
            document_count: number;
            readable_count: number;
            message: string;
        };
        // The lookup still succeeds; it just reports what it actually read
        // rather than inventing a total it could not confirm.
        assert.equal(out.ok, true);
        assert.equal(out.readable_count, 1);
        assert.equal(out.document_count, 1);
        assert.doesNotMatch(out.message, /in total/);
    });

    // 7. Soft failures -------------------------------------------------------
    await test("a missing matter_id, an unknown tool name and a thrown query all degrade to ok:false", async () => {
        const { db } = makeDb([]);
        const noId = await runMatterToolCall({
            name: "get_matter_documents",
            args: {},
            db,
            userId: "u1",
        });
        assert.equal((noId.toolResult as { ok: boolean }).ok, false);

        const unknown = await runMatterToolCall({
            name: "find_matter",
            args: {},
            db,
            userId: "u1",
        });
        assert.equal((unknown.toolResult as { ok: boolean }).ok, false);

        // A handler must never throw out of the tool loop — that would kill
        // the whole turn instead of one tool call.
        const exploding = {
            from: () => {
                throw new Error("connection reset");
            },
        } as never;
        const thrown = await runMatterToolCall({
            name: "list_matters",
            args: {},
            db: exploding,
            userId: "u1",
        });
        const tr = thrown.toolResult as { ok: boolean; error: string };
        assert.equal(tr.ok, false);
        assert.match(tr.error, /connection reset/);
    });

    console.log("matters/tools.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
