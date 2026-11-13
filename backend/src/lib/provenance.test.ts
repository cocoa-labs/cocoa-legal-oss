// backend/src/lib/provenance.test.ts
import assert from "node:assert/strict";
import { resolveVersionProvenance } from "./provenance";

// Minimal chainable Supabase stub. Each builder method returns the same
// thenable, so `await db.from(t).select(...).in(...).not(...).order(...)`
// resolves to the canned { data, error } for that table.
function makeDb(byTable: Record<string, { data: unknown[]; error?: unknown }>) {
    function chain(table: string) {
        const res = byTable[table] ?? { data: [], error: null };
        const c: Record<string, unknown> = {
            select: () => c,
            in: () => c,
            eq: () => c,
            not: () => c,
            order: () => c,
            then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
                Promise.resolve({
                    data: res.data ?? [],
                    error: res.error ?? null,
                }).then(resolve, reject as never),
        };
        return c;
    }
    return { from: (t: string) => chain(t) } as never;
}

// Edits are the backbone: a version with a document_edits.chat_message_id
// resolves source="edit", chat_id from chat_messages, and (if an operation also
// targets it) the operation_id is attached.
async function testEditLinkWinsAndAttachesOperation() {
    const db = makeDb({
        document_edits: {
            data: [
                {
                    version_id: "vEdit",
                    chat_message_id: "mEdit",
                    created_at: "t1",
                },
            ],
        },
        document_highlight_sets: { data: [] },
        agent_operations: {
            data: [
                {
                    result_version_id: "vEdit",
                    chat_id: "cEditOp",
                    chat_message_id: null,
                    id: "op2",
                    created_at: "t1",
                },
            ],
        },
        chat_messages: { data: [{ id: "mEdit", chat_id: "cEdit" }] },
    });

    const map = await resolveVersionProvenance(db, ["vEdit"]);
    const p = map.get("vEdit");
    assert.ok(p);
    assert.equal(p!.source, "edit");
    assert.equal(p!.chat_message_id, "mEdit");
    assert.equal(p!.chat_id, "cEdit"); // resolved via chat_messages
    assert.equal(p!.operation_id, "op2"); // op on the same version is attached
}

// A version produced by an operation (no edit) resolves source="operation"
// using the operation's own chat_id / chat_message_id.
async function testOperationOnlyVersion() {
    const db = makeDb({
        document_edits: { data: [] },
        document_highlight_sets: { data: [] },
        agent_operations: {
            data: [
                {
                    result_version_id: "vOp",
                    chat_id: "cOp",
                    chat_message_id: "mOp",
                    id: "op1",
                    created_at: "t1",
                },
            ],
        },
        chat_messages: { data: [] },
    });

    const map = await resolveVersionProvenance(db, ["vOp"]);
    const p = map.get("vOp");
    assert.ok(p);
    assert.equal(p!.source, "operation");
    assert.equal(p!.chat_id, "cOp");
    assert.equal(p!.chat_message_id, "mOp");
    assert.equal(p!.operation_id, "op1");
}

// A highlight-set link (no edit, no op) resolves source="highlight".
async function testHighlightOnlyVersion() {
    const db = makeDb({
        document_edits: { data: [] },
        document_highlight_sets: {
            data: [
                {
                    version_id: "vHl",
                    chat_message_id: "mHl",
                    created_at: "t1",
                },
            ],
        },
        agent_operations: { data: [] },
        chat_messages: { data: [{ id: "mHl", chat_id: "cHl" }] },
    });

    const map = await resolveVersionProvenance(db, ["vHl"]);
    const p = map.get("vHl");
    assert.ok(p);
    assert.equal(p!.source, "highlight");
    assert.equal(p!.chat_id, "cHl");
}

// A version with no producing turn (e.g. an upload) resolves to no entry —
// never fabricated.
async function testNoProvenance() {
    const db = makeDb({
        document_edits: { data: [] },
        document_highlight_sets: { data: [] },
        agent_operations: { data: [] },
        chat_messages: { data: [] },
    });
    const map = await resolveVersionProvenance(db, ["vUpload"]);
    assert.equal(map.has("vUpload"), false);
}

// Empty input short-circuits to an empty map.
async function testEmptyInput() {
    const db = makeDb({});
    const map = await resolveVersionProvenance(db, []);
    assert.equal(map.size, 0);
}

async function main() {
    await testEditLinkWinsAndAttachesOperation();
    await testOperationOnlyVersion();
    await testHighlightOnlyVersion();
    await testNoProvenance();
    await testEmptyInput();
    console.log("provenance.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
