// backend/src/lib/versionContext.test.ts
import assert from "node:assert/strict";
import { buildVersionContext } from "./chatTools";

// No displayed doc and no open docs → null (legacy turns stay null rather than
// fabricating a snapshot).
async function testEmptyReturnsNull() {
    assert.equal(buildVersionContext(undefined, undefined), null);
    assert.equal(buildVersionContext(null, []), null);
}

// open_docs only: each tab becomes an entry; an explicit displayed flag is kept.
async function testFromOpenDocsOnly() {
    const vc = buildVersionContext(null, [
        { document_id: "d1", version_id: "v1", version_number: 1 },
        {
            document_id: "d2",
            version_id: "v2",
            version_number: 2,
            displayed: true,
        },
    ]);
    assert.ok(vc);
    assert.equal(vc!.anchored_document_id, null);
    assert.equal(vc!.docs.length, 2);
    assert.equal(vc!.docs[0].displayed, false);
    assert.equal(vc!.docs[1].displayed, true);
    assert.equal(vc!.docs[1].version_id, "v2");
}

// displayedDoc marks the matching open tab as displayed and sets the anchor.
async function testDisplayedDocFlagsAnchor() {
    const vc = buildVersionContext(
        { document_id: "d2", version_id: "v2", version_number: 2 },
        [
            { document_id: "d1", version_id: "v1", version_number: 1 },
            { document_id: "d2", version_id: "v2", version_number: 2 },
        ],
    );
    assert.ok(vc);
    assert.equal(vc!.anchored_document_id, "d2");
    const d2 = vc!.docs.find((d) => d.document_id === "d2");
    assert.equal(d2!.displayed, true);
    const d1 = vc!.docs.find((d) => d.document_id === "d1");
    assert.equal(d1!.displayed, false);
}

// displayedDoc not present in open_docs is appended as a displayed entry.
async function testDisplayedDocAppendedWhenMissing() {
    const vc = buildVersionContext(
        { document_id: "d9", version_id: "v9", version_number: 9 },
        [{ document_id: "d1", version_id: "v1", version_number: 1 }],
    );
    assert.ok(vc);
    assert.equal(vc!.docs.length, 2);
    const d9 = vc!.docs.find((d) => d.document_id === "d9");
    assert.ok(d9);
    assert.equal(d9!.displayed, true);
    assert.equal(d9!.version_id, "v9");
}

// Malformed entries (no document_id) are dropped; null versions are preserved.
async function testFiltersMalformedAndPreservesNullVersion() {
    const vc = buildVersionContext(null, [
        { document_id: "d1", version_id: null, version_number: null },
        // @ts-expect-error intentionally malformed
        { version_id: "vx" },
    ]);
    assert.ok(vc);
    assert.equal(vc!.docs.length, 1);
    assert.equal(vc!.docs[0].document_id, "d1");
    assert.equal(vc!.docs[0].version_id, null);
}

// A displayed doc with only an id still yields a snapshot (version null).
async function testDisplayedDocOnly() {
    const vc = buildVersionContext({ document_id: "d1" }, undefined);
    assert.ok(vc);
    assert.equal(vc!.anchored_document_id, "d1");
    assert.equal(vc!.docs.length, 1);
    assert.equal(vc!.docs[0].displayed, true);
    assert.equal(vc!.docs[0].version_id, null);
}

async function main() {
    await testEmptyReturnsNull();
    await testFromOpenDocsOnly();
    await testDisplayedDocFlagsAnchor();
    await testDisplayedDocAppendedWhenMissing();
    await testFiltersMalformedAndPreservesNullVersion();
    await testDisplayedDocOnly();
    console.log("versionContext.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
