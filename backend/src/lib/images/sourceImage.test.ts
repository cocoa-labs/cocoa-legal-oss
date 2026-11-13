// backend/src/lib/images/sourceImage.test.ts
//
// resolveLatestChatImage finds the most recent image in a chat so "edit that
// image" (typed, no explicit source) targets the right one. These tests pin:
// an assistant image_generated event wins when newest; an uploaded user image
// wins when newest; older rows are scanned when the newest has no image; and no
// image anywhere yields null. Rows arrive newest-first (the query orders desc).

import assert from "node:assert/strict";
import { resolveLatestChatImage } from "./sourceImage";

// Minimal chainable Supabase stub: every builder method returns a thenable that
// resolves to the canned { data } for chat_messages (mirrors the shared stub in
// enrichWithPriorEvents.test.ts).
function makeDb(rows: unknown[]) {
    const c: Record<string, unknown> = {
        select: () => c,
        eq: () => c,
        order: () => c,
        limit: () => c,
        then: (resolve: (v: unknown) => unknown, reject?: unknown) =>
            Promise.resolve({ data: rows, error: null }).then(
                resolve,
                reject as never,
            ),
    };
    return { from: () => c } as never;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

async function main() {
    console.log("images/sourceImage.test.ts");

    await test("returns the newest assistant-generated image document", async () => {
        const db = makeDb([
            {
                role: "assistant",
                content: [
                    { type: "content", text: "here you go" },
                    { type: "image_generated", document_id: "doc-new" },
                ],
                files: null,
            },
            {
                role: "user",
                content: "make a logo",
                files: [{ kind: "image", attachment_id: "att-old" }],
            },
        ]);
        const ref = await resolveLatestChatImage({ db, chatId: "c1", userId: "u1" });
        assert.deepEqual(ref, { document_id: "doc-new" });
    });

    await test("returns the newest uploaded user image", async () => {
        const db = makeDb([
            {
                role: "user",
                content: "edit this",
                files: [{ kind: "image", attachment_id: "att-new" }],
            },
            {
                role: "assistant",
                content: [{ type: "image_generated", document_id: "doc-old" }],
                files: null,
            },
        ]);
        const ref = await resolveLatestChatImage({ db, chatId: "c1", userId: "u1" });
        assert.deepEqual(ref, { attachment_id: "att-new" });
    });

    await test("skips non-image rows to find the most recent image", async () => {
        const db = makeDb([
            { role: "assistant", content: [{ type: "content", text: "no image" }], files: null },
            { role: "user", content: "hi", files: [{ kind: "document", document_id: "d" }] },
            {
                role: "assistant",
                content: [{ type: "image_generated", document_id: "doc-found" }],
                files: null,
            },
        ]);
        const ref = await resolveLatestChatImage({ db, chatId: "c1", userId: "u1" });
        assert.deepEqual(ref, { document_id: "doc-found" });
    });

    await test("returns null when the chat has no image", async () => {
        const db = makeDb([
            { role: "user", content: "hello", files: null },
            { role: "assistant", content: [{ type: "content", text: "hi" }], files: null },
        ]);
        const ref = await resolveLatestChatImage({ db, chatId: "c1", userId: "u1" });
        assert.equal(ref, null);
    });

    await test("returns null for an empty chat", async () => {
        const db = makeDb([]);
        const ref = await resolveLatestChatImage({ db, chatId: "c1", userId: "u1" });
        assert.equal(ref, null);
    });

    console.log("images/sourceImage.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
