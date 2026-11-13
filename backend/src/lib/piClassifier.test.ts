// backend/src/lib/piClassifier.test.ts
import assert from "node:assert/strict";
import { classifyPiDocumentType } from "./piClassifier";
import { classifyCreDocumentType } from "./creClassifier";

// Declaration page true-positive (body text).
async function testDeclarationPage() {
    assert.equal(
        classifyPiDocumentType(
            "AUTO POLICY DECLARATIONS PAGE. Named insured: John Smith. " +
                "Bodily Injury Liability $25,000 each person / $50,000 each accident.",
            "policy.pdf",
        ),
        "declaration-page",
    );
    // Filename-only signal also classifies (separators normalize to spaces).
    assert.equal(
        classifyPiDocumentType("", "ExampleMutual_Dec_Page_Smith.pdf"),
        "declaration-page",
    );
}

// A policy-limits demand references the dec page it requests, so the demand
// rule must win over the declaration-page rule (specific-before-generic).
async function testDemandBeatsDeclarationPage() {
    const text =
        "POLICY LIMIT DEMAND. This is a time limited demand for the bodily injury " +
        "policy limits. Please provide a certified copy of the declaration page " +
        "within 30 days.";
    assert.equal(
        classifyPiDocumentType(text, "demand.pdf"),
        "policy-limits-demand",
    );
}

// Vendor invoices: records vendors, legal funding, and the generic invoice.
async function testVendorInvoice() {
    assert.equal(
        classifyPiDocumentType(
            "ChartExample Invoice INV-004512. Amount due: $89.50 for medical records.",
            "records.pdf",
        ),
        "vendor-invoice",
    );
    assert.equal(
        classifyPiDocumentType("", "SampleRecords_Invoice_88213.pdf"),
        "vendor-invoice",
    );
    assert.equal(
        classifyPiDocumentType(
            "ECF Legal Funding — funding advance statement for the Smith matter.",
            "ecf.pdf",
        ),
        "vendor-invoice",
    );
    // Generic invoice with no claim-correspondence language still classifies.
    assert.equal(
        classifyPiDocumentType(
            "INVOICE #100. Amount due: $450.00 for services rendered.",
            "acme_invoice.pdf",
        ),
        "vendor-invoice",
    );
}

// Letter of representation / adjuster mail → the generic correspondence bucket.
async function testInsuranceCorrespondence() {
    assert.equal(
        classifyPiDocumentType(
            "LETTER OF REPRESENTATION. We represent the claimant regarding " +
                "claim number 17-4432-08 arising from the collision.",
            "lor.pdf",
        ),
        "insurance-correspondence",
    );
    // An adjuster letter that merely MENTIONS invoices is correspondence, not
    // a vendor invoice: the correspondence rule outranks the bare-"invoice"
    // fallback rule.
    assert.equal(
        classifyPiDocumentType(
            "RE: Claim Number 22-88-19. Our adjuster requests copies of the " +
                "medical invoices for the treatment to date.",
            "carrier-letter.pdf",
        ),
        "insurance-correspondence",
    );
}

// Non-PI document → null (no false positives). Empty inputs → null.
async function testNonPiReturnsNull() {
    assert.equal(
        classifyPiDocumentType(
            "Dear Hiring Manager, thank you for the opportunity to interview...",
            "cover-letter.docx",
        ),
        null,
    );
    assert.equal(classifyPiDocumentType("", ""), null);
}

// Short-acronym boundary guard: "uim" must match only as a whole token, so
// filenames/bodies containing it inside an unrelated word must NOT classify.
async function testUimSubstringDoesNotMisclassify() {
    assert.equal(classifyPiDocumentType("", "sampleton_notes.pdf"), null);
    assert.equal(
        classifyPiDocumentType("the sampleton settlement conference notes", "notes.pdf"),
        null,
    );
    // Whole-token "uim" does classify.
    assert.equal(
        classifyPiDocumentType("tender of the UIM claim", "uim-tender.pdf"),
        "insurance-correspondence",
    );
}

// Hook-order regression: documentUpload.ts computes
// `classifyCreDocumentType(...) ?? classifyPiDocumentType(...)` — the CRE
// classifier must keep winning for CRE documents, including a document that
// carries BOTH vocabularies. This pins the composition the upload hook uses.
async function testCreClassifierStillWinsFirst() {
    const leaseText =
        "THIS COMMERCIAL LEASE is made between Landlord and Tenant for the premises...";
    assert.equal(classifyCreDocumentType(leaseText, "office-deal.pdf"), "commercial-lease");
    assert.equal(classifyPiDocumentType(leaseText, "office-deal.pdf"), null);
    assert.equal(
        classifyCreDocumentType(leaseText, "office-deal.pdf") ??
            classifyPiDocumentType(leaseText, "office-deal.pdf"),
        "commercial-lease",
    );

    // Mixed vocabulary: an estoppel that mentions a claim number must still
    // classify as the CRE type because the CRE classifier runs first.
    const mixed =
        "TENANT ESTOPPEL CERTIFICATE. The undersigned certifies the Lease is in " +
        "full force. Reference: insurer claim number 99-1234.";
    assert.equal(
        classifyCreDocumentType(mixed, "estoppel.pdf") ??
            classifyPiDocumentType(mixed, "estoppel.pdf"),
        "estoppel-certificate",
    );

    // And a pure PI document falls through CRE (null) to the PI classifier.
    const decPage = "AUTO POLICY DECLARATIONS PAGE. Bodily Injury $25,000/$50,000.";
    assert.equal(classifyCreDocumentType(decPage, "dec-page.pdf"), null);
    assert.equal(
        classifyCreDocumentType(decPage, "dec-page.pdf") ??
            classifyPiDocumentType(decPage, "dec-page.pdf"),
        "declaration-page",
    );
}

async function main() {
    await testDeclarationPage();
    await testDemandBeatsDeclarationPage();
    await testVendorInvoice();
    await testInsuranceCorrespondence();
    await testNonPiReturnsNull();
    await testUimSubstringDoesNotMisclassify();
    await testCreClassifierStillWinsFirst();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
