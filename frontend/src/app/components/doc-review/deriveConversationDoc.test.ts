// Run: npx tsx src/app/components/doc-review/deriveConversationDoc.test.ts
import assert from "node:assert/strict";
import { deriveConversationDoc } from "./deriveConversationDoc";

type Msg = Parameters<typeof deriveConversationDoc>[0][number];

const vc = (anchoredId: string | null, docs: VC["docs"]) => ({
    version_context: { anchored_document_id: anchoredId, docs },
});
type VC = NonNullable<Msg["version_context"]>;

// Latest anchored message wins, and its anchored doc's version is returned.
async function testLatestAnchoredWins() {
    const messages: Msg[] = [
        vc("d1", [
            { document_id: "d1", version_id: "v1", version_number: 1, displayed: true },
        ]),
        vc("d3", [
            { document_id: "d1", version_id: "v1", version_number: 1, displayed: false },
            { document_id: "d3", version_id: "v3", version_number: 2, displayed: true },
        ]),
    ];
    const out = deriveConversationDoc(messages, {
        anchor_document_id: "d9",
        anchor_version_id: "v9",
    });
    assert.deepEqual(out, {
        documentId: "d3",
        versionId: "v3",
        versionNumber: 2,
    });
}

// Messages with no version_context are skipped; an earlier anchored turn wins.
async function testSkipsNullContext() {
    const messages: Msg[] = [
        vc("d2", [
            { document_id: "d2", version_id: "v2", version_number: 5, displayed: true },
        ]),
        { version_context: undefined },
        { version_context: null },
    ];
    const out = deriveConversationDoc(messages, null);
    assert.equal(out?.documentId, "d2");
    assert.equal(out?.versionId, "v2");
    assert.equal(out?.versionNumber, 5);
}

// Falls back to the `displayed` entry when the anchored id isn't in docs.
async function testDisplayedFallback() {
    const messages: Msg[] = [
        vc("dX", [
            { document_id: "dA", version_id: "vA", version_number: 1, displayed: true },
        ]),
    ];
    const out = deriveConversationDoc(messages, null);
    // anchored id (dX) is what's returned, but version comes from displayed entry.
    assert.equal(out?.documentId, "dX");
    assert.equal(out?.versionId, "vA");
}

// The agent's doc focus (it read 03) wins over a stale user anchor (01) —
// this is the "stop snapping back to doc 01" fix.
async function testAgentFocusWinsOverStaleAnchor() {
    const messages: Msg[] = [
        vc("d01", [
            { document_id: "d01", version_id: "v1", version_number: 4, displayed: true },
        ]),
        {
            version_context: null,
            events: [{ type: "doc_read", filename: "03_LOI.docx", document_id: "d03" }],
        },
    ];
    const out = deriveConversationDoc(messages, null);
    assert.equal(out?.documentId, "d03");
}

// doc_edited / doc_created focus is used too.
async function testDocEditedFocus() {
    const messages: Msg[] = [
        {
            version_context: null,
            events: [
                { type: "doc_read", filename: "x", document_id: "d02" },
                {
                    type: "doc_edited",
                    filename: "05.docx",
                    document_id: "d05",
                    version_id: "v9",
                    download_url: "",
                    annotations: [],
                },
            ],
        },
    ];
    const out = deriveConversationDoc(messages, null);
    // Last doc-bearing event in the turn wins.
    assert.equal(out?.documentId, "d05");
}

// Chat fork anchor is used when no message carries a snapshot.
async function testChatAnchorFallback() {
    const messages: Msg[] = [
        { version_context: null },
        { version_context: undefined },
    ];
    const out = deriveConversationDoc(messages, {
        anchor_document_id: "dfork",
        anchor_version_id: "vfork",
    });
    assert.deepEqual(out, {
        documentId: "dfork",
        versionId: "vfork",
        versionNumber: null,
    });
}

// Null when neither a snapshot nor a chat anchor is available.
async function testNullWhenNothing() {
    assert.equal(deriveConversationDoc([], null), null);
    assert.equal(
        deriveConversationDoc([{ version_context: null }], {
            anchor_document_id: null,
            anchor_version_id: null,
        }),
        null,
    );
}

async function main() {
    await testLatestAnchoredWins();
    await testSkipsNullContext();
    await testDisplayedFallback();
    await testAgentFocusWinsOverStaleAnchor();
    await testDocEditedFocus();
    await testChatAnchorFallback();
    await testNullWhenNothing();
    console.log("deriveConversationDoc.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
