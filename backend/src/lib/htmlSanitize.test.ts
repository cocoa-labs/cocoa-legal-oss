import assert from "node:assert/strict";
import { sanitizeHtmlForConversion } from "./htmlSanitize";

async function testStripsScript() {
    const dirty = `<p>hello</p><script>alert(1)</script>`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(!clean.includes("<script"), `script tag survived: ${clean}`);
    assert.ok(!clean.includes("alert"), `script body survived: ${clean}`);
    assert.ok(clean.includes("hello"), `body content lost: ${clean}`);
}

async function testStripsIframe() {
    const dirty = `<p>before</p><iframe src="https://attacker/x"></iframe><p>after</p>`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(!clean.includes("<iframe"), `iframe survived: ${clean}`);
    assert.ok(!clean.includes("attacker"), `iframe src survived: ${clean}`);
    assert.ok(clean.includes("before"));
    assert.ok(clean.includes("after"));
}

async function testStripsExternalImgSrc() {
    const dirty = `<img src="http://example.com/x.png"><img src="https://attacker/y.png">`;
    const clean = sanitizeHtmlForConversion(dirty);
    // The <img> tag itself can remain (renders as broken placeholder)
    // but the external URL must be gone.
    assert.ok(!clean.includes("example.com"), `external src survived: ${clean}`);
    assert.ok(!clean.includes("attacker"), `external src survived: ${clean}`);
    assert.ok(!clean.includes("http"), `http URL leaked: ${clean}`);
}

async function testAllowsDataImg() {
    const dirty = `<img src="data:image/png;base64,iVBORw0KG">`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(clean.includes("data:image/png"), `data img stripped: ${clean}`);
}

async function testStripsCloudMetadataSrc() {
    // The classic SSRF target — must be stripped even though it's "http"
    const dirty = `<img src="http://169.254.169.254/latest/meta-data/iam">`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(
        !clean.includes("169.254.169.254"),
        `metadata URL survived: ${clean}`,
    );
}

async function testStripsLinkAndStyle() {
    const dirty = `<link rel="stylesheet" href="https://attacker/x.css"><style>body{background:url(http://attacker)}</style><p>kept</p>`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(!clean.includes("<link"), `link tag survived`);
    assert.ok(!clean.includes("<style"), `style tag survived`);
    assert.ok(!clean.includes("attacker"), `style/link payload survived`);
    assert.ok(clean.includes("kept"));
}

async function testStripsEventHandlers() {
    const dirty = `<a href="https://ok" onclick="alert(1)">link</a>`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(!clean.includes("onclick"), `onclick survived: ${clean}`);
    assert.ok(!clean.includes("alert"), `alert survived: ${clean}`);
    assert.ok(clean.includes("href=\"https://ok\""), `safe href lost: ${clean}`);
}

async function testStripsJavascriptHref() {
    const dirty = `<a href="javascript:alert(1)">x</a>`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(!clean.includes("javascript:"), `javascript URL survived: ${clean}`);
    assert.ok(!clean.includes("alert"));
}

async function testProtocolRelativeStripped() {
    const dirty = `<a href="//attacker/x">x</a>`;
    const clean = sanitizeHtmlForConversion(dirty);
    assert.ok(!clean.includes("//attacker"), `protocol-relative survived: ${clean}`);
}

async function testStyleClosingTagDoesntEscape() {
    // The classic template-breakage case: even though we strip <style>,
    // confirm a stray "</style>" in regular text doesn't leak.
    const dirty = `<p>How to close: </style></p>`;
    const clean = sanitizeHtmlForConversion(dirty);
    // sanitize-html should treat the </style> as an unbalanced tag and
    // either escape it or drop it. Either way, the rendered output must
    // not contain a literal "</style>" that could break a wrapper.
    assert.ok(
        !clean.includes("</style>"),
        `literal </style> survived: ${clean}`,
    );
}

async function testKeepsLegitimateMarkup() {
    const dirty = `
        <h1>Title</h1>
        <p>A paragraph with <strong>bold</strong> and <em>italic</em>.</p>
        <ul><li>one</li><li>two</li></ul>
        <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
        <a href="https://example.org">link</a>
        <pre><code>const x = 1;</code></pre>
    `;
    const clean = sanitizeHtmlForConversion(dirty);
    for (const expected of [
        "<h1>",
        "<strong>",
        "<em>",
        "<ul>",
        "<li>",
        "<table>",
        "<th>",
        "<a href=\"https://example.org\"",
        "<pre>",
        "<code>",
    ]) {
        assert.ok(
            clean.includes(expected),
            `expected ${expected} stripped from clean output`,
        );
    }
}

async function main() {
    await testStripsScript();
    await testStripsIframe();
    await testStripsExternalImgSrc();
    await testAllowsDataImg();
    await testStripsCloudMetadataSrc();
    await testStripsLinkAndStyle();
    await testStripsEventHandlers();
    await testStripsJavascriptHref();
    await testProtocolRelativeStripped();
    await testStyleClosingTagDoesntEscape();
    await testKeepsLegitimateMarkup();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
