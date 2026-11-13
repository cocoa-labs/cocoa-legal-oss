/**
 * Tests for the MIME builder. Run with:
 *   npx tsx src/lib/connectors/email/mime.test.ts
 *
 * Lightweight: no test framework. Each check throws on failure and logs on
 * success. Exit code is non-zero if any assertion throws.
 */
import assert from "node:assert/strict";
import { buildRawMessage, base64url } from "./mime";

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

/** Decode the base64url RFC822 output back into a UTF-8 string for assertions. */
function decode(raw: string): string {
    return Buffer.from(raw, "base64url").toString("utf8");
}

console.log("mime.test.ts");

test("base64url has no +,/,= characters", () => {
    const encoded = base64url(Buffer.from([0xff, 0xff, 0xfe, 0xfa, 0x00]));
    assert.ok(!/[+/=]/.test(encoded), `unexpected url-unsafe char in ${encoded}`);
});

test("buildRawMessage produces decodable base64url", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "Hello",
        text: "Body text",
    });
    assert.ok(!/[+/=]/.test(raw), "raw should be url-safe base64");
    const decoded = decode(raw);
    assert.ok(decoded.length > 0, "decoded message should be non-empty");
});

test("headers include To and Subject", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com", "second@example.com"],
        subject: "Quarterly Review",
        text: "Body",
    });
    const decoded = decode(raw);
    assert.match(decoded, /^To: dest@example\.com, second@example\.com$/m);
    assert.match(decoded, /^Subject: Quarterly Review$/m);
    assert.match(decoded, /^From: agent@example\.com$/m);
});

test("multipart/mixed appears when an attachment is included", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "With attachment",
        text: "See attached",
        attachments: [
            {
                filename: "note.txt",
                contentType: "text/plain",
                content: Buffer.from("file contents", "utf8"),
            },
        ],
    });
    const decoded = decode(raw);
    assert.match(decoded, /Content-Type: multipart\/mixed; boundary="/);
    assert.match(decoded, /Content-Disposition: attachment; filename="note\.txt"/);
});

test("multipart/alternative appears when both text and html are provided", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "Both bodies",
        text: "plain version",
        html: "<p>html version</p>",
    });
    const decoded = decode(raw);
    assert.match(decoded, /Content-Type: multipart\/alternative; boundary="/);
    assert.match(decoded, /Content-Type: text\/plain/);
    assert.match(decoded, /Content-Type: text\/html/);
});

test("In-Reply-To and References headers present when inReplyTo set", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "Re: thread",
        text: "reply body",
        inReplyTo: "<orig-message-id@example.com>",
    });
    const decoded = decode(raw);
    assert.match(decoded, /^In-Reply-To: <orig-message-id@example\.com>$/m);
    assert.match(decoded, /^References: <orig-message-id@example\.com>$/m);
});

test("non-ASCII subject is RFC2047-encoded", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "Café déjà vu — 日本語",
        text: "body",
    });
    const decoded = decode(raw);
    // The raw subject must not appear verbatim; an encoded-word must.
    assert.ok(
        !decoded.includes("Café déjà vu — 日本語"),
        "non-ASCII subject should not appear unencoded",
    );
    assert.match(decoded, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
    // And it must round-trip back to the original text.
    const match = decoded.match(/^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/m);
    assert.ok(match, "encoded subject word should match");
    const roundTripped = Buffer.from(match[1], "base64").toString("utf8");
    assert.equal(roundTripped, "Café déjà vu — 日本語");
});

test("Reply-To header renders when replyTo is set", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "reply-to check",
        text: "body",
        replyTo: "adjuster@carrier.example",
    });
    const decoded = decode(raw);
    assert.match(decoded, /^Reply-To: adjuster@carrier\.example$/m);
});

test("Reply-To header is absent when replyTo is not set", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "no reply-to",
        text: "body",
    });
    const decoded = decode(raw);
    assert.ok(
        !/^Reply-To:/m.test(decoded),
        "Reply-To must not appear when unset",
    );
});

test("Reply-To header is absent when replyTo is blank", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "blank reply-to",
        text: "body",
        replyTo: "   ",
    });
    const decoded = decode(raw);
    assert.ok(
        !/^Reply-To:/m.test(decoded),
        "a whitespace-only replyTo must not emit a header",
    );
});

test("a Message-ID header is generated", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "id check",
        text: "body",
    });
    const decoded = decode(raw);
    assert.match(decoded, /^Message-ID: <[^>]+@example\.com>$/m);
});

// --- Inline images (multipart/related) -----------------------------------

/** PNG magic bytes — enough to stand in for real image content. */
const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("an inline image (contentId) emits multipart/related with Content-ID + inline disposition", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "inline image",
        text: "plain fallback",
        html: '<p>See <img src="cid:tl-1"></p>',
        attachments: [
            {
                filename: "timeline.png",
                contentType: "image/png",
                content: IMG,
                contentId: "tl-1",
            },
        ],
    });
    const decoded = decode(raw);
    assert.match(decoded, /Content-Type: multipart\/related; boundary="/);
    assert.match(decoded, /Content-ID: <tl-1>/);
    assert.match(
        decoded,
        /Content-Disposition: inline; filename="timeline\.png"/,
    );
    // A pure inline image with no file attachment must NOT wrap in mixed.
    assert.ok(
        !/Content-Type: multipart\/mixed/.test(decoded),
        "no file attachment → no multipart/mixed",
    );
});

test("inline image + file attachment nests mixed > related > alternative", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "inline + file",
        text: "plain fallback",
        html: '<p><img src="cid:tl-1"></p>',
        attachments: [
            {
                filename: "timeline.png",
                contentType: "image/png",
                content: IMG,
                contentId: "tl-1",
            },
            {
                filename: "transcript.pdf",
                contentType: "application/pdf",
                content: Buffer.from("%PDF-1.4", "utf8"),
            },
        ],
    });
    const decoded = decode(raw);
    assert.match(decoded, /Content-Type: multipart\/mixed; boundary="/);
    assert.match(decoded, /Content-Type: multipart\/related; boundary="/);
    assert.match(decoded, /Content-Type: multipart\/alternative; boundary="/);
    // The image is inline; the pdf is a normal downloadable attachment.
    assert.match(decoded, /Content-ID: <tl-1>/);
    assert.match(
        decoded,
        /Content-Disposition: inline; filename="timeline\.png"/,
    );
    assert.match(
        decoded,
        /Content-Disposition: attachment; filename="transcript\.pdf"/,
    );
});

test("html-only + inline image uses related over the html leaf (no alternative)", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "html only + inline",
        html: '<p><img src="cid:tl-1"></p>',
        attachments: [
            {
                filename: "timeline.png",
                contentType: "image/png",
                content: IMG,
                contentId: "tl-1",
            },
        ],
    });
    const decoded = decode(raw);
    assert.match(decoded, /Content-Type: multipart\/related; boundary="/);
    assert.match(decoded, /Content-Type: text\/html/);
    assert.ok(
        !/Content-Type: multipart\/alternative/.test(decoded),
        "no text part → no multipart/alternative",
    );
});

test("attachment without contentId does NOT emit multipart/related (backward compat)", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "plain attachment",
        text: "see attached",
        attachments: [
            {
                filename: "note.txt",
                contentType: "text/plain",
                content: Buffer.from("hello", "utf8"),
            },
        ],
    });
    const decoded = decode(raw);
    assert.ok(
        !/multipart\/related/.test(decoded),
        "a normal attachment must not introduce multipart/related",
    );
    assert.match(decoded, /Content-Type: multipart\/mixed; boundary="/);
    assert.match(decoded, /Content-Disposition: attachment; filename="note\.txt"/);
});

test("previewable image attachment carries one image part and UTF-8 filename metadata", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "image attachment",
        text: "see attached",
        attachments: [
            {
                filename: "Résumé image.png",
                contentType: "image/png",
                content: IMG,
            },
        ],
    });
    const decoded = decode(raw);
    assert.match(decoded, /Content-Type: image\/png;/);
    assert.match(decoded, /filename\*=UTF-8''R%C3%A9sum%C3%A9%20image\.png/);
    assert.equal(
        (decoded.match(/Content-Disposition: attachment;/g) ?? []).length,
        1,
        "exactly one downloadable image part",
    );
    assert.ok(!/multipart\/related/.test(decoded));
    assert.ok(!/Content-ID:/.test(decoded));
});

test("the wire Content-ID matches the cid referenced by the html body", () => {
    const cid = "timeline-abc";
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "cid agreement",
        text: "fallback",
        html: `<img src="cid:${cid}">`,
        attachments: [
            {
                filename: "t.png",
                contentType: "image/png",
                content: IMG,
                contentId: cid,
            },
        ],
    });
    const decoded = decode(raw);
    // The builder wraps the caller's cid in angle brackets on the wire…
    assert.match(decoded, new RegExp(`Content-ID: <${cid}>`));
    // …and the html leaf (itself base64-encoded) decodes back to a cid:
    // reference of the SAME id, WITHOUT brackets — that agreement is what lets
    // the recipient's client resolve the inline image.
    const htmlB64 = decoded.match(
        /Content-Type: text\/html[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/,
    );
    assert.ok(htmlB64, "html part should be present");
    const html = Buffer.from(
        htmlB64[1].replace(/\r\n/g, ""),
        "base64",
    ).toString("utf8");
    assert.match(html, new RegExp(`cid:${cid}`));
    assert.ok(!html.includes(`cid:<${cid}>`), "html cid must not carry brackets");
});

test("inline contentId with no html body degrades to a normal attachment", () => {
    const raw = buildRawMessage({
        from: "agent@example.com",
        to: ["dest@example.com"],
        subject: "inline but no html",
        text: "text only",
        attachments: [
            {
                filename: "timeline.png",
                contentType: "image/png",
                content: IMG,
                contentId: "tl-1",
            },
        ],
    });
    const decoded = decode(raw);
    assert.ok(
        !/multipart\/related/.test(decoded),
        "no html to reference the cid → no related part",
    );
    assert.match(
        decoded,
        /Content-Disposition: attachment; filename="timeline\.png"/,
    );
});

console.log("All mime tests passed.");
