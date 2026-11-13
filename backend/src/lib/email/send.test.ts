// backend/src/lib/email/send.test.ts
//
// Hermetic tests for the pure send-side helpers (no DB / no network). The
// byte-loader is injected so expandAttachments can be exercised in isolation.
// Run with: npx tsx src/lib/email/send.test.ts
import assert from "node:assert/strict";

import { selectBrandMode, expandAttachments } from "./send";
import type { EmailAttachmentRef } from "./store";

function testBrandModeFullForNewEmail() {
    assert.equal(
        selectBrandMode({ in_reply_to: null, provider_thread_id: null }),
        "full",
    );
}

function testBrandModeLightForReply() {
    assert.equal(
        selectBrandMode({ in_reply_to: "<orig@x>", provider_thread_id: null }),
        "light",
    );
    assert.equal(
        selectBrandMode({ in_reply_to: null, provider_thread_id: "thread-1" }),
        "light",
    );
}

async function testExpandPlainAttachment() {
    let calls = 0;
    const refs: EmailAttachmentRef[] = [
        {
            document_id: "d1",
            version_id: "v1",
            filename: "transcript.pdf",
            content_type: "application/pdf",
        },
    ];
    const { attachments, inlineImages } = await expandAttachments(
        refs,
        async () => {
            calls++;
            return Buffer.from("pdf");
        },
    );
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].filename, "transcript.pdf");
    assert.equal(attachments[0].contentId, undefined, "plain ref has no cid");
    assert.equal(inlineImages.length, 0);
    assert.equal(calls, 1, "loads bytes once");
}

async function testExpandLegacyInlineRefAsOneAttachment() {
    let calls = 0;
    const refs: EmailAttachmentRef[] = [
        {
            document_id: "img",
            version_id: "v1",
            filename: "timeline.png",
            content_type: "image/png",
            inline: true,
            content_id: "tl-1",
        },
    ];
    const { attachments, inlineImages } = await expandAttachments(
        refs,
        async () => {
            calls++;
            return Buffer.from("png");
        },
    );
    assert.equal(
        attachments.length,
        1,
        "legacy inline metadata must not duplicate an outbound image",
    );
    assert.equal(attachments[0].contentId, undefined);
    assert.equal(attachments[0].contentType, "image/png");
    assert.equal(inlineImages.length, 0);
    assert.equal(calls, 1, "bytes loaded once");
}

async function testExpandSkipsUnavailableBytes() {
    const refs: EmailAttachmentRef[] = [
        { document_id: "gone", filename: "missing.pdf" },
    ];
    const { attachments } = await expandAttachments(refs, async () => null);
    assert.equal(
        attachments.length,
        0,
        "a ref whose bytes are unavailable is skipped",
    );
}

async function main() {
    testBrandModeFullForNewEmail();
    testBrandModeLightForReply();
    await testExpandPlainAttachment();
    await testExpandLegacyInlineRefAsOneAttachment();
    await testExpandSkipsUnavailableBytes();
    console.log("send.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
