// backend/src/lib/images/imageTools.test.ts
//
// runImageToolCall dispatches the two chat image tools. These tests inject the
// model/persist collaborators (so no OpenAI or DB is touched) and pin: a
// successful generate returns the document_id + an image_generated payload; a
// missing prompt/instruction is a soft tool error; an edit uses the model's
// explicit `source`, else the "Edit"-button editImageSource, else the latest
// chat image; and a no-image edit surfaces a readable error to the model.

import assert from "node:assert/strict";
import { runImageToolCall } from "./imageTools";
import type { ChatImageDeps } from "./generateChatImage";
import type { EditImageSource } from "./sourceImage";

const db = {} as never; // never touched — every collaborator is injected

function persistStub(documentId: string, filename: string): ChatImageDeps["persistFn"] {
    return (async () => ({ documentId, versionId: "v1", filename })) as ChatImageDeps["persistFn"];
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
    console.log("images/imageTools.test.ts");

    // 1. generate_image success → document_id + image_generated payload -------
    await test("generate_image returns the doc + an image_generated event", async () => {
        let genCalls = 0;
        const deps: ChatImageDeps = {
            getUserApiKeysFn: async () => ({}),
            generateImageFn: (async () => {
                genCalls += 1;
                return Buffer.from([1, 2, 3]);
            }) as ChatImageDeps["generateImageFn"],
            persistFn: persistStub("doc-gen", "A cat - image.png"),
        };
        const res = await runImageToolCall({
            name: "generate_image",
            args: { prompt: "A cat wearing a hat", orientation: "square" },
            db,
            userId: "u1",
            projectId: null,
            deps,
        });
        assert.equal(genCalls, 1);
        const tr = res.toolResult as { ok: boolean; document_id: string };
        assert.equal(tr.ok, true);
        assert.equal(tr.document_id, "doc-gen");
        assert.ok(res.imageGenerated);
        assert.equal(res.imageGenerated?.type, "image_generated");
        assert.equal(res.imageGenerated?.document_id, "doc-gen");
        assert.equal(res.imageGenerated?.kind, "generate");
        assert.equal(res.imageGenerated?.prompt, "A cat wearing a hat");
    });

    // 2. generate_image without a prompt is a soft error, no event -----------
    await test("generate_image with no prompt returns ok:false and no event", async () => {
        const res = await runImageToolCall({
            name: "generate_image",
            args: {},
            db,
            userId: "u1",
            deps: { generateImageFn: (async () => Buffer.from([1])) as ChatImageDeps["generateImageFn"] },
        });
        assert.equal((res.toolResult as { ok: boolean }).ok, false);
        assert.equal(res.imageGenerated, undefined);
    });

    // 3. edit_image uses the model's explicit source -------------------------
    await test("edit_image edits the model-provided source document", async () => {
        let seenRef: EditImageSource | null = null;
        const deps: ChatImageDeps = {
            getUserApiKeysFn: async () => ({}),
            loadSourceImageBytesFn: (async (p: { ref: EditImageSource }) => {
                seenRef = p.ref;
                return { bytes: Buffer.from([9]), mimeType: "image/png", filename: "s.png" };
            }) as ChatImageDeps["loadSourceImageBytesFn"],
            editImageFn: (async () => Buffer.from([4, 5])) as ChatImageDeps["editImageFn"],
            persistFn: persistStub("doc-edit", "edit.png"),
        };
        const res = await runImageToolCall({
            name: "edit_image",
            args: { instruction: "make it blue", source: { document_id: "src-doc" } },
            db,
            userId: "u1",
            chatId: "chat-1",
            deps,
        });
        assert.equal((res.toolResult as { ok: boolean }).ok, true);
        assert.equal((seenRef as EditImageSource | null)?.document_id, "src-doc");
        assert.equal(res.imageGenerated?.kind, "edit");
        assert.equal(res.imageGenerated?.document_id, "doc-edit");
    });

    // 4. edit_image falls back to the Edit-button editImageSource ------------
    await test("edit_image uses editImageSource when the model omits a source", async () => {
        let seenRef: EditImageSource | null = null;
        const deps: ChatImageDeps = {
            getUserApiKeysFn: async () => ({}),
            loadSourceImageBytesFn: (async (p: { ref: EditImageSource }) => {
                seenRef = p.ref;
                return { bytes: Buffer.from([9]), mimeType: "image/png", filename: "s.png" };
            }) as ChatImageDeps["loadSourceImageBytesFn"],
            editImageFn: (async () => Buffer.from([1])) as ChatImageDeps["editImageFn"],
            persistFn: persistStub("doc-edit2", "edit2.png"),
        };
        const res = await runImageToolCall({
            name: "edit_image",
            args: { instruction: "crop it" },
            db,
            userId: "u1",
            chatId: "chat-1",
            editImageSource: { document_id: "btn-doc", attachment_id: null },
            deps,
        });
        assert.equal((res.toolResult as { ok: boolean }).ok, true);
        assert.equal((seenRef as EditImageSource | null)?.document_id, "btn-doc");
    });

    // 5. edit_image with no source, no button, no chat image → soft error ----
    await test("edit_image with nothing to edit returns a readable error", async () => {
        const res = await runImageToolCall({
            name: "edit_image",
            args: { instruction: "brighten" },
            db,
            userId: "u1",
            chatId: null,
            deps: { getUserApiKeysFn: async () => ({}) },
        });
        const tr = res.toolResult as { ok: boolean; error?: string };
        assert.equal(tr.ok, false);
        assert.match(String(tr.error), /no image to edit|generate or attach/i);
        assert.equal(res.imageGenerated, undefined);
    });

    // 6. unknown tool name → soft error --------------------------------------
    await test("an unknown image tool name returns ok:false", async () => {
        const res = await runImageToolCall({
            name: "paint_image",
            args: {},
            db,
            userId: "u1",
        });
        assert.equal((res.toolResult as { ok: boolean }).ok, false);
    });

    console.log("images/imageTools.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
