import assert from "node:assert/strict";
import { insertDocumentVersionCompat } from "./documentVersions";

function makeVersionDb(
    responses: {
        data: { id: string } | null;
        error: unknown;
    }[],
) {
    const attempts: Record<string, unknown>[] = [];
    const db = {
        from(table: string) {
            assert.equal(table, "document_versions");
            return {
                insert(value: Record<string, unknown>) {
                    attempts.push({ ...value });
                    return {
                        select(selection: string) {
                            assert.equal(selection, "id");
                            return {
                                async single() {
                                    const next = responses.shift();
                                    assert.ok(next);
                                    return next;
                                },
                            };
                        },
                    };
                },
            };
        },
    };

    return { db, attempts };
}

async function testRetriesWithoutMissingVersionColumn() {
    const { db, attempts } = makeVersionDb([
        {
            data: null,
            error: {
                code: "PGRST204",
                message:
                    "Could not find the 'created_by_user_id' column of 'document_versions' in the schema cache",
            },
        },
        { data: { id: "version-1" }, error: null },
    ]);

    const result = await insertDocumentVersionCompat({
        db: db as never,
        values: {
            document_id: "document-1",
            storage_path: "documents/document-1/edits/edit.docx",
            source: "assistant_edit",
            version_number: 2,
            created_by_user_id: "user-1",
        },
    });

    assert.deepEqual(result, { id: "version-1" });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].created_by_user_id, "user-1");
    assert.equal(Object.hasOwn(attempts[1], "created_by_user_id"), false);
}

async function testFallbackSourceOnLegacyCheckConstraint() {
    const { db, attempts } = makeVersionDb([
        {
            data: null,
            error: {
                code: "23514",
                message:
                    'new row for relation "document_versions" violates check constraint "document_versions_source_check"',
            },
        },
        { data: { id: "version-2" }, error: null },
    ]);

    const result = await insertDocumentVersionCompat({
        db: db as never,
        fallbackSource: "user_upload",
        values: {
            document_id: "document-2",
            storage_path: "documents/document-2/source.docx",
            source: "upload",
            version_number: 1,
        },
    });

    assert.deepEqual(result, { id: "version-2" });
    assert.equal(attempts[0].source, "upload");
    assert.equal(attempts[1].source, "user_upload");
}

async function testCleanFinalFallsBackToGeneratedSource() {
    const { db, attempts } = makeVersionDb([
        {
            data: null,
            error: {
                code: "23514",
                message:
                    'new row for relation "document_versions" violates check constraint "document_versions_source_check"',
            },
        },
        { data: { id: "version-3" }, error: null },
    ]);

    const result = await insertDocumentVersionCompat({
        db: db as never,
        fallbackSource: "generated",
        values: {
            document_id: "document-3",
            storage_path: "documents/document-3/clean.docx",
            source: "clean_final",
            version_number: 1,
            metadata: { scope: "document_body_w_ins_w_del" },
        },
    });

    assert.deepEqual(result, { id: "version-3" });
    assert.equal(attempts[0].source, "clean_final");
    assert.equal(attempts[1].source, "generated");
    assert.deepEqual(attempts[1].metadata, {
        scope: "document_body_w_ins_w_del",
    });
}

async function main() {
    await testRetriesWithoutMissingVersionColumn();
    await testFallbackSourceOnLegacyCheckConstraint();
    await testCleanFinalFallsBackToGeneratedSource();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
