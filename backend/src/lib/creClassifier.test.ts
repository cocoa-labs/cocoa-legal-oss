// backend/src/lib/creClassifier.test.ts
import assert from "node:assert/strict";
import { classifyCreDocumentType } from "./creClassifier";

// Lease true-positive (body text).
async function testLease() {
    assert.equal(
        classifyCreDocumentType(
            "THIS COMMERCIAL LEASE is made between Landlord and Tenant for the premises...",
            "office-deal.pdf",
        ),
        "commercial-lease",
    );
    // Filename-only signal also classifies.
    assert.equal(
        classifyCreDocumentType("", "Office-Lease-Agreement-2026.pdf"),
        "commercial-lease",
    );
}

// Estoppel must win over the lease language it quotes (specific-before-generic).
async function testEstoppelBeatsLease() {
    const text =
        "TENANT ESTOPPEL CERTIFICATE. The undersigned tenant certifies that the Lease " +
        "dated January 1 is in full force and effect and there are no defaults under the lease.";
    assert.equal(
        classifyCreDocumentType(text, "estoppel.pdf"),
        "estoppel-certificate",
    );
}

// PSA must win over a bare "agreement".
async function testPsaBeatsAgreement() {
    const text =
        "PURCHASE AND SALE AGREEMENT. This agreement of purchase and sale is entered into " +
        "by Seller and Buyer for the real property...";
    assert.equal(
        classifyCreDocumentType(text, "deal.pdf"),
        "purchase-and-sale-agreement",
    );
    // The "psa" short form (and filename signal) also classifies.
    assert.equal(
        classifyCreDocumentType("see the PSA for terms", "PSA-final.docx"),
        "purchase-and-sale-agreement",
    );
}

// Title commitment markers win over everything else in a deal package.
async function testTitleCommitment() {
    const text =
        "COMMITMENT FOR TITLE INSURANCE. Schedule B lists the following exceptions. " +
        "This also references the underlying lease and the purchase and sale agreement.";
    assert.equal(
        classifyCreDocumentType(text, "title.pdf"),
        "title-commitment",
    );
}

// SNDA true-positive.
async function testSnda() {
    const text =
        "SUBORDINATION, NON-DISTURBANCE AND ATTORNMENT AGREEMENT among Lender, Landlord, and Tenant.";
    assert.equal(classifyCreDocumentType(text, "snda.pdf"), "snda");
}

// Rent roll true-positive.
async function testRentRoll() {
    assert.equal(
        classifyCreDocumentType("Rent Roll as of Q1", "rent-roll.xlsx"),
        "rent-roll",
    );
}

// Non-CRE document → null (no false positives).
async function testNonCreReturnsNull() {
    assert.equal(
        classifyCreDocumentType(
            "Dear Hiring Manager, thank you for the opportunity to interview...",
            "cover-letter.docx",
        ),
        null,
    );
    // Empty inputs → null, never a throw.
    assert.equal(classifyCreDocumentType("", ""), null);
}

// Short-acronym substring guard: "psa" must match only on a word boundary, so
// filenames/bodies that merely contain "psa" inside an unrelated word must NOT
// classify as purchase-and-sale-agreement. (Shared matcher with the router.)
async function testPsaSubstringDoesNotMisclassify() {
    assert.equal(classifyCreDocumentType("", "gypsa_chart.pdf"), null);
    assert.equal(classifyCreDocumentType("", "topsail_report.pdf"), null);
    assert.equal(classifyCreDocumentType("", "lapsable_policy.pdf"), null);
    assert.equal(
        classifyCreDocumentType("the gypsam mineral deposit", "notes.pdf"),
        null,
    );
}

// Substring traps: the generic phrases that used to live in the rule table
// ("lease", bare "subordination", bare "purchase and sale") matched inside
// unrelated words and unrelated instruments. None of these are CRE documents.
async function testLexicalTrapsDoNotMisclassify() {
    // "lease" lives inside "please" and "release".
    assert.equal(
        classifyCreDocumentType(
            "Please find attached the release notes for Q3.",
            "notes.pdf",
        ),
        null,
    );
    // A subordinated LOAN is not an SNDA.
    assert.equal(classifyCreDocumentType("", "Subordinated_Loan.pdf"), null);
    // A share purchase (SPA) is not a real-property PSA.
    assert.equal(
        classifyCreDocumentType(
            "the purchase and sale of shares under the SPA",
            "",
        ),
        null,
    );
    // "lease-back" / "release" must not trip the lease rule.
    assert.equal(
        classifyCreDocumentType(
            "we lease-back nothing; release the funds",
            "",
        ),
        null,
    );
}

async function main() {
    await testLease();
    await testEstoppelBeatsLease();
    await testPsaBeatsAgreement();
    await testTitleCommitment();
    await testSnda();
    await testRentRoll();
    await testNonCreReturnsNull();
    await testPsaSubstringDoesNotMisclassify();
    await testLexicalTrapsDoNotMisclassify();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
