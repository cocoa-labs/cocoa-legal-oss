// backend/src/lib/email/branding.test.ts
//
// Run with: npx tsx src/lib/email/branding.test.ts
import assert from "node:assert/strict";

import {
    renderMarkdownToHtml,
    renderBrandedEmail,
    shell,
    BRAND_SENTINEL,
    DEFAULT_EMAIL_FOOTER,
} from "./branding";

async function testMarkdownRenders() {
    const html = await renderMarkdownToHtml("# Title\n\n- one\n- two\n\n**bold**");
    assert.match(html, /<h1[^>]*>Title<\/h1>/, "renders headings");
    assert.match(html, /<li>one<\/li>/, "renders list items");
    assert.match(html, /<strong>bold<\/strong>/, "renders bold");
}

async function testMarkdownStripsScript() {
    const html = await renderMarkdownToHtml("hi\n\n<script>evil()</script>");
    assert.ok(!/<script/i.test(html), "script tag stripped");
    assert.ok(!html.includes("evil()"), "script content stripped");
}

async function testFullBrandingHasWordmarkFooterSentinel() {
    const { text, html } = await renderBrandedEmail({
        bodyText: "Hello **world**",
        mode: "full",
    });
    assert.ok(html.includes("Coco Legal"), "full has the wordmark");
    assert.ok(html.includes(DEFAULT_EMAIL_FOOTER), "full has the default footer");
    assert.ok(html.includes(BRAND_SENTINEL), "full carries the brand sentinel");
    assert.equal(text, "Hello **world**", "text is the untouched bodyText");
    assert.match(html, /<strong>world<\/strong>/, "markdown body rendered in html");
}

async function testLightBrandingNoPageChrome() {
    const { html } = await renderBrandedEmail({
        bodyText: "quick reply",
        mode: "light",
    });
    assert.ok(!html.includes("<!doctype html>"), "light has no full page chrome");
    assert.ok(/Quill/.test(html), "light carries the Quill sign-off");
    assert.ok(html.includes(DEFAULT_EMAIL_FOOTER), "light still carries the footer");
}

async function testInlineImageInjected() {
    const { html } = await renderBrandedEmail({
        bodyText: "see below",
        mode: "full",
        inlineImages: [{ contentId: "tl-1", alt: "Timeline" }],
    });
    assert.ok(html.includes('src="cid:tl-1"'), "inline image references the cid");
    assert.ok(html.includes('alt="Timeline"'), "inline image has alt text");
}

async function testModelBodyHtmlSanitizedIntoCard() {
    const { html } = await renderBrandedEmail({
        bodyText: "fallback",
        bodyHtml: "<p>Hi</p><script>evil()</script>",
        mode: "full",
    });
    assert.ok(html.includes("<p>Hi</p>"), "model html fragment preserved");
    assert.ok(!html.includes("evil()"), "script stripped from model html");
    assert.ok(html.includes("Coco Legal"), "model html is wrapped in the shell");
}

async function testSentinelIdempotency() {
    const pre = await renderBrandedEmail({ bodyText: "x", mode: "full" });
    // Feeding already-branded html back in must NOT double-wrap.
    const again = await renderBrandedEmail({
        bodyText: "x",
        bodyHtml: pre.html,
        mode: "full",
    });
    assert.equal(
        again.html,
        pre.html,
        "already-branded html passes through unchanged",
    );
    const count = again.html.split(BRAND_SENTINEL).length - 1;
    assert.equal(count, 1, "exactly one brand sentinel (no double-wrap)");
}

async function testFooterOverride() {
    const { html } = await renderBrandedEmail({
        bodyText: "x",
        mode: "full",
        footerHtml: "Custom footer XYZ",
    });
    assert.ok(html.includes("Custom footer XYZ"), "custom footer used");
    assert.ok(!html.includes(DEFAULT_EMAIL_FOOTER), "default footer replaced");
}

function testShellFullVsLight() {
    const full = shell("<p>hi</p>", { mode: "full" });
    const light = shell("<p>hi</p>", { mode: "light" });
    assert.ok(full.includes("<!doctype html>"), "full has page chrome");
    assert.ok(!light.includes("<!doctype html>"), "light has no page chrome");
    assert.ok(full.includes(BRAND_SENTINEL) && light.includes(BRAND_SENTINEL));
}

async function main() {
    await testMarkdownRenders();
    await testMarkdownStripsScript();
    await testFullBrandingHasWordmarkFooterSentinel();
    await testLightBrandingNoPageChrome();
    await testInlineImageInjected();
    await testModelBodyHtmlSanitizedIntoCard();
    await testSentinelIdempotency();
    await testFooterOverride();
    testShellFullVsLight();
    assert.ok(!/reviewed by a member of the firm/i.test(DEFAULT_EMAIL_FOOTER), "footer makes no review claim");
    console.log("branding.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
