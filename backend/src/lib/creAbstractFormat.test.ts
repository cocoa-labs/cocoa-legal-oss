// backend/src/lib/creAbstractFormat.test.ts
import assert from "node:assert/strict";
import {
    cleanSummaryForDocx,
    firstCitationForDocx,
    CRE_DOCX_FLAG_LABEL,
} from "./creAbstractFormat";

// cleanSummaryForDocx strips inline page||quote citation markers.
async function testStripsCitationMarker() {
    assert.equal(
        cleanSummaryForDocx(
            "Base rent is $10,000/mo [[page:12||quote:Tenant shall pay $10,000]].",
        ),
        "Base rent is $10,000/mo .",
    );
}

// It strips the quote: prefix variant and bracket pill markers too.
async function testStripsPillAndQuoteVariant() {
    assert.equal(
        cleanSummaryForDocx("[[Yes]] — see [[page:3||quote:no defaults exist]]"),
        "Yes — see",
    );
    // Bare pill without page marker unwraps to its inner text.
    assert.equal(cleanSummaryForDocx("[[NNN]]"), "NNN");
}

// Multiple citations are all removed; whitespace collapses.
async function testStripsMultipleAndCollapses() {
    assert.equal(
        cleanSummaryForDocx(
            "A [[page:1||quote:foo]]   B [[page:2||quote:bar]]\t C",
        ),
        "A B C",
    );
}

// Empty / nullish inputs return an empty string.
async function testEmptyInputs() {
    assert.equal(cleanSummaryForDocx(undefined), "");
    assert.equal(cleanSummaryForDocx(null), "");
    assert.equal(cleanSummaryForDocx(""), "");
}

// A quote containing nested brackets is still consumed by the marker regex.
async function testNestedBracketsInQuote() {
    assert.equal(
        cleanSummaryForDocx(
            "See [[page:5||quote:clause [a] applies]] here",
        ),
        "See here",
    );
}

// firstCitationForDocx renders the first citation as `p. N — "quote"`.
async function testFirstCitationRendered() {
    assert.equal(
        firstCitationForDocx(
            "X [[page:7||quote:the demised premises]] Y [[page:9||quote:other]]",
        ),
        'p. 7 — "the demised premises"',
    );
}

// No citation → empty string.
async function testNoCitation() {
    assert.equal(firstCitationForDocx("just prose, no markers"), "");
    assert.equal(firstCitationForDocx(undefined), "");
}

// Flag labels map to the human-readable memo labels.
async function testFlagLabels() {
    assert.equal(CRE_DOCX_FLAG_LABEL.green, "Market");
    assert.equal(CRE_DOCX_FLAG_LABEL.yellow, "Review");
    assert.equal(CRE_DOCX_FLAG_LABEL.red, "Deal-breaker");
    assert.equal(CRE_DOCX_FLAG_LABEL.grey, "Not stated");
}

async function run() {
    await testStripsCitationMarker();
    await testStripsPillAndQuoteVariant();
    await testStripsMultipleAndCollapses();
    await testEmptyInputs();
    await testNestedBracketsInQuote();
    await testFirstCitationRendered();
    await testNoCitation();
    await testFlagLabels();
    console.log("creAbstractFormat.test.ts: all assertions passed");
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
