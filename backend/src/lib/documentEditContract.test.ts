import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROJECT_EXTRA_TOOLS, resolveEditableDocument, type DocIndex, type DocStore } from "./chatTools";

test("duplicate filename without a selected handle returns candidates", () => {
    const store: DocStore = new Map([
        ["doc-0", { filename: "Parenting Plan.docx", file_type: "docx", storage_path: "a" }],
        ["doc-1", { filename: "Parenting Plan.docx", file_type: "docx", storage_path: "b" }],
    ]);
    const index: DocIndex = {
        "doc-0": { document_id: "uuid-a", filename: "Parenting Plan.docx", version_id: "a-v2", version_number: 2 },
        "doc-1": { document_id: "uuid-b", filename: "Parenting Plan.docx", version_id: "b-v2", version_number: 2 },
    };
    const result = resolveEditableDocument("Parenting Plan.docx", store, index);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, "AMBIGUOUS_DOCUMENT_NAME");
    assert.deepEqual(result.candidates.map((candidate) => candidate.document_id), ["uuid-a", "uuid-b"]);
});

test("displayed edit tool has no caller-controlled document id", () => {
    const tool = PROJECT_EXTRA_TOOLS.find((candidate) => candidate.function.name === "edit_displayed_document");
    assert.ok(tool);
    assert.equal("doc_id" in (tool.function.parameters.properties ?? {}), false);
});

test("migration enforces immutable CAS commits and ledger completion", () => {
    const sql = readFileSync("migrations/033_document_edit_commit.sql", "utf8");
    const bootstrap = readFileSync("schema.sql", "utf8");
    assert.match(sql, /duplicate_documents[\s\S]+row_number\(\)/i);
    assert.match(sql, /order by v\.created_at, v\.id/i);
    assert.match(sql, /unique index[\s\S]+document_id, version_number/i);
    assert.match(sql, /pg_advisory_xact_lock/i);
    assert.match(sql, /DOCUMENT_VERSION_CONFLICT/i);
    assert.match(sql, /parent_version_id[\s\S]+p_expected_version_id/i);
    assert.match(sql, /update public\.agent_operations[\s\S]+status = 'succeeded'/i);
    assert.doesNotMatch(
        sql,
        /update public\.document_versions[^;]+set[^;]*storage_path\s*=/i,
    );
    assert.match(bootstrap, /create or replace function public\.commit_document_edit/i);
    assert.match(bootstrap, /document_versions_document_number_unique/i);
});
