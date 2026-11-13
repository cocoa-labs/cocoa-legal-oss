import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DocumentSourceLoadError,
    loadDocumentGenerationContext,
} from "./sourceContext";
import { extractDocumentText } from "../documentExtraction";
import { executeDocumentGenerationJob } from "./worker";
import { fixtureDb, savedItem, savedJob } from "./testFixtures";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

test("source loading uses the version's document relationship and preserves pinned historical bytes and order", async () => {
    const fixture = fixtureDb((query) => {
        assert.equal(query.table, "document_versions");
        assert.equal(query.operation, "select");
        assert.deepEqual(query.filters, { id: ["historical", "second"] });
        assert.match(
            query.columns!,
            /documents!document_versions_document_id_fkey\(filename,\s*file_type\)/,
        );
        return {
            // Deliberately reverse the response and include a document whose
            // current version is not the historical version pinned by this job.
            data: [
                {
                    id: "second",
                    document_id: "doc-2",
                    storage_path: "second.pdf",
                    pdf_storage_path: null,
                    documents: [{ filename: "Second.pdf", file_type: "pdf" }],
                },
                {
                    id: "historical",
                    document_id: "doc-1",
                    storage_path: "historical.docx",
                    pdf_storage_path: "historical.pdf",
                    documents: {
                        filename: "First.docx",
                        file_type: "docx",
                        current_version_id: "newer-version",
                    },
                },
            ],
            error: null,
        };
    });
    const downloads: string[] = [];
    const context = await loadDocumentGenerationContext(
        fixture.db,
        ["historical", "second"],
        { summary: "Prepare the two requested documents." },
        {
            downloadFile: async (key) => {
                downloads.push(key);
                return bytes(key);
            },
            extractDocumentText: async (input) => {
                if (input.fileType === "docx") {
                    assert.equal(
                        new TextDecoder().decode(input.pdfRenditionBuf!),
                        "historical.pdf",
                    );
                }
                return new TextDecoder().decode(input.rawBuf);
            },
        },
    );
    assert.deepEqual(downloads, [
        "historical.docx",
        "historical.pdf",
        "second.pdf",
    ]);
    assert.equal(
        context,
        "SAVED JOB BRIEF:\nPrepare the two requested documents.\n\n---\n\nSOURCE: First.docx\nhistorical.docx\n\n---\n\nSOURCE: Second.pdf\nsecond.pdf",
    );
    assert.equal(fixture.calls.length, 1);
});

test("a generated PNG without a PDF rendition retains the saved drafting brief", async (t) => {
    t.mock.method(console, "warn", () => {});
    const fixture = fixtureDb(() => ({
        data: [
            {
                id: "generated-image",
                storage_path: "infographic.png",
                pdf_storage_path: null,
                documents: { filename: "Infographic.png", file_type: "png" },
            },
        ],
        error: null,
    }));
    const context = await loadDocumentGenerationContext(
        fixture.db,
        ["generated-image"],
        {
            summary:
                "Questionnaire and comment letter: retain the saved facts and requested topics.",
        },
        {
            downloadFile: async () => bytes("synthetic image"),
            extractDocumentText,
        },
    );
    assert.equal(
        context,
        "SAVED JOB BRIEF:\nQuestionnaire and comment letter: retain the saved facts and requested topics.",
    );
    assert.doesNotMatch(context, /SOURCE:|synthetic image/);
});

test("brief-only jobs do not query sources and source read exceptions are safely classified", async () => {
    const noSources = fixtureDb(() => {
        throw new Error("Unexpected query");
    });
    assert.equal(
        await loadDocumentGenerationContext(noSources.db, [], {
            summary: "Saved request",
        }),
        "SAVED JOB BRIEF:\nSaved request",
    );
    const cause = new Error("private-storage-path and secret-provider-token");
    const broken = fixtureDb(() => {
        throw cause;
    });
    await assert.rejects(
        () => loadDocumentGenerationContext(broken.db, ["source"], {}),
        (error: unknown) => {
            assert.ok(error instanceof DocumentSourceLoadError);
            assert.equal(error.code, "DOCUMENT_SOURCE_LOAD_FAILED");
            assert.equal(error.cause, cause);
            assert.doesNotMatch(
                error.message,
                /private-storage|secret-provider/,
            );
            return true;
        },
    );
    assert.equal(
        new DocumentSourceLoadError(cause, "secret-provider-token")
            .databaseCode,
        null,
    );
});

test("source query failures stop both model routes before generation and log only the database code", async (t) => {
    let networkCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        networkCalls++;
        throw new Error("No model or storage call is expected");
    });
    const errors: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
    t.mock.method(console, "info", () => {});

    for (const model_id of ["claude-sonnet-5", "anthropic/claude-fable-5.1"]) {
        const job = savedJob({ model_id, total_items: 1 });
        const item = savedItem({
            status: "queued",
            source_versions_json: ["source-version"],
            outline_json: null,
            draft_sections_json: null,
        });
        const fixture = fixtureDb((query) => {
            if (query.table === "user_api_keys")
                return { data: [], error: null };
            if (query.table === "documents") return { data: null, error: null };
            if (query.table === "document_versions")
                return {
                    data: null,
                    error: {
                        code: "PGRST201",
                        message: "private-source-text secret-provider-token",
                    },
                };
            if (query.table === "document_generation_items") {
                if (query.operation === "update")
                    Object.assign(item, query.values);
                return {
                    data: query.single
                        ? { id: item.id }
                        : [structuredClone(item)],
                    error: null,
                };
            }
            if (query.table === "document_generation_jobs") {
                if (query.operation === "update")
                    Object.assign(job, query.values);
                return { data: { ...job }, error: null };
            }
            throw new Error(`Unexpected query: ${query.table}`);
        });
        await executeDocumentGenerationJob(job, fixture.db);
        assert.equal(job.status, "failed");
        assert.equal(item.status, "failed");
        assert.equal(item.failure_stage, "planning");
        assert.equal(item.failure_code, "DOCUMENT_SOURCE_LOAD_FAILED");
        assert.equal(item.outline_json, null);
        assert.equal(item.draft_sections_json, null);
        assert.match(item.error!, /source files.*request is saved/);
        assert.doesNotMatch(
            item.error!,
            /private-source|secret-provider|PGRST/,
        );
    }
    assert.equal(networkCalls, 0);
    assert.equal(errors.length, 2);
    assert.match(JSON.stringify(errors), /"sourceErrorCode":"PGRST201"/);
    assert.doesNotMatch(
        JSON.stringify(errors),
        /private-source|secret-provider/,
    );
});
