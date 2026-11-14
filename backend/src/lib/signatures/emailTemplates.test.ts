// backend/src/lib/signatures/emailTemplates.test.ts
import assert from "node:assert/strict";

import {
    signRequestEmail,
    completionEmail,
    completionReadyEmail,
    escapeHtml,
} from "./emailTemplates";

function testEscapeHtml() {
    assert.equal(
        escapeHtml(`<a b="c">&'`),
        "&lt;a b=&quot;c&quot;&gt;&amp;&#39;",
    );
}

function testSignRequestHasLinkAndButton() {
    const link = "http://localhost:3003/sign/abc123";
    const { html, text } = signRequestEmail({
        subject: "Please sign: Deal.docx",
        message: "Hi there",
        link,
        nonbinding: false,
    });
    assert.ok(html.includes(link), "html contains the signing link");
    assert.ok(/Review &amp; Sign/.test(html), "html has the Review & Sign button");
    assert.ok(html.includes("Cocoa Legal"), "html has the wordmark");
    assert.ok(html.includes("Electronic signature request sent with Cocoa Legal"), "html has the e-sign footer");
    assert.doesNotMatch(html, /\bESIGN\b|\bUETA\b|\bcompliant\b/i, "no legal-compliance claim");
    assert.ok(text.includes(link), "plain text contains the link");
    assert.ok(text.includes("Hi there"), "plain text contains the message");
}

function testSignRequestEscapesUserFields() {
    const { html } = signRequestEmail({
        subject: "<img src=x onerror=alert(1)>",
        message: '"></a><script>bad()</script>',
        link: "http://x/sign/t",
        nonbinding: false,
    });
    assert.ok(!html.includes("<script>bad"), "raw <script> must not appear");
    assert.ok(html.includes("&lt;script&gt;bad"), "message is HTML-escaped");
    assert.ok(!/<img src=x/.test(html), "raw subject tag must not appear");
    assert.ok(html.includes("&lt;img"), "subject is HTML-escaped");
}

function testCompletionEscapesDocName() {
    const { html, text } = completionEmail({
        documentName: "Deal & Co <Final>.docx",
        nonbinding: false,
    });
    assert.ok(
        html.includes("Deal &amp; Co &lt;Final&gt;.docx"),
        "document name is HTML-escaped in html",
    );
    assert.ok(
        text.includes("Deal & Co <Final>.docx"),
        "plain text keeps the raw document name",
    );
    assert.ok(/fully executed/i.test(html), "completion html mentions executed");
}

// Signature wording follows beta mode in email too: every e-sign email says
// "nonbinding test signature" in beta mode and carries no such label outside it.
function testEmailsFollowBetaMode() {
    const link = "http://localhost:3003/sign/abc123";
    const beta = [
        signRequestEmail({ subject: "Deal.docx", message: "", link, nonbinding: true }),
        completionEmail({ documentName: "Deal.docx", nonbinding: true }),
        completionReadyEmail({ documentName: "Deal.docx", link, nonbinding: true }),
    ];
    for (const email of beta) {
        assert.match(email.html, /nonbinding test signature/i, "beta html says nonbinding");
        assert.match(email.text, /nonbinding test signature/i, "beta text says nonbinding");
        assert.doesNotMatch(email.html, /\bESIGN\b|\bUETA\b|legally binding|compliant/i);
    }
    const neutral = [
        signRequestEmail({ subject: "Deal.docx", message: "", link, nonbinding: false }),
        completionEmail({ documentName: "Deal.docx", nonbinding: false }),
        completionReadyEmail({ documentName: "Deal.docx", link, nonbinding: false }),
    ];
    for (const email of neutral) {
        assert.doesNotMatch(
            `${email.html} ${email.text}`,
            /nonbinding|not for legal execution|controlled beta/i,
            "neutral wording outside beta mode",
        );
    }
}

async function main() {
    testEscapeHtml();
    testSignRequestHasLinkAndButton();
    testSignRequestEscapesUserFields();
    testCompletionEscapesDocName();
    testEmailsFollowBetaMode();
    console.log("emailTemplates.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
