import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DisplayedDocumentResolutionError,
    resolveDisplayedDocument,
} from "./displayedDocument";

function fakeDb(input: {
    documents: Record<string, Record<string, unknown>>;
    versions: Record<string, Record<string, unknown>>;
}) {
    return {
        from(table: string) {
            const filters = new Map<string, unknown>();
            const builder = {
                select() { return builder; },
                eq(column: string, value: unknown) { filters.set(column, value); return builder; },
                async maybeSingle() {
                    const id = String(filters.get("id") ?? "");
                    const row = table === "documents" ? input.documents[id] : input.versions[id];
                    if (row && filters.has("project_id") && row.project_id !== filters.get("project_id"))
                        return { data: null, error: null };
                    return { data: row ?? null, error: null };
                },
                async single() {
                    const id = String(filters.get("id") ?? "");
                    const row = table === "documents" ? input.documents[id] : input.versions[id];
                    return { data: row ?? null, error: row ? null : new Error("not found") };
                },
            };
            return builder;
        },
    } as never;
}

const document = {
    id: "doc-2", project_id: "matter-a", filename: "Parenting Plan.docx",
    file_type: "docx", status: "ready", current_version_id: "doc-2-v3",
    updated_at: "2026-08-06T00:00:00.000Z",
};
const versions = {
    "doc-2-v2": { id: "doc-2-v2", document_id: "doc-2", storage_path: "fixtures/doc-2-v2.docx", pdf_storage_path: null, version_number: 2, display_name: "Parenting Plan.docx", source: "assistant_edit", created_at: "2026-08-05T02:00:00.000Z" },
    "doc-2-v3": { id: "doc-2-v3", document_id: "doc-2", storage_path: "fixtures/doc-2-v3.docx", pdf_storage_path: null, version_number: 3, display_name: "Parenting Plan.docx", source: "assistant_edit", created_at: "2026-08-06T01:00:00.000Z" },
    "foreign-version": { id: "foreign-version", document_id: "doc-1", storage_path: "fixtures/foreign.docx", version_number: 9, display_name: "Parenting Plan.docx", source: "upload" },
};

test("server resolves UUID/version and ignores spoofed label hints", async () => {
    const resolved = await resolveDisplayedDocument({
        db: fakeDb({ documents: { "doc-2": document }, versions }),
        projectId: "matter-a",
        input: { document_id: "doc-2", version_id: "doc-2-v2", filename: "Secret.docx", version_number: 999 },
    });
    assert.equal(resolved?.document_id, "doc-2");
    assert.equal(resolved?.version_id, "doc-2-v2");
    assert.equal(resolved?.filename, "Parenting Plan.docx");
    assert.equal(resolved?.version_number, 2);
    assert.equal(resolved?.modified_at, "2026-08-05T02:00:00.000Z");
    assert.equal(resolved?.is_current, false);
});

test("foreign project document is rejected before tool context", async () => {
    await assert.rejects(
        resolveDisplayedDocument({ db: fakeDb({ documents: { "doc-2": document }, versions }), projectId: "matter-b", input: { document_id: "doc-2", version_id: "doc-2-v2" } }),
        (error: unknown) => error instanceof DisplayedDocumentResolutionError && error.code === "DISPLAYED_DOCUMENT_UNAVAILABLE",
    );
});

test("mismatched document/version pair is rejected", async () => {
    await assert.rejects(
        resolveDisplayedDocument({ db: fakeDb({ documents: { "doc-2": document }, versions }), projectId: "matter-a", input: { document_id: "doc-2", version_id: "foreign-version" } }),
        (error: unknown) => error instanceof DisplayedDocumentResolutionError && error.code === "DISPLAYED_VERSION_UNAVAILABLE",
    );
});
