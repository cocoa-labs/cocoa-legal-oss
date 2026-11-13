// backend/src/lib/automation/types.test.ts
//
// The extraction validators are the trust boundary between LLM output and the
// automation pipeline: completeStructured returns unknown JSON extracted from
// UNTRUSTED carrier-email / invoice content, and parseClaimExtraction /
// parseInvoiceExtraction are what turn it into typed values the pipeline may
// act on — the model must never be trusted to have honored the schema. Pure
// functions: no network, no database.
import assert from "node:assert/strict";
import {
    CLAIM_EXTRACTION_SCHEMA,
    INVOICE_EXTRACTION_SCHEMA,
    parseClaimExtraction,
    parseInvoiceExtraction,
} from "./types";

function field(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        value: "CLM-2210",
        quote: "Claim Number: CLM-2210",
        page: 1,
        source: "pdf",
        confidence: 0.97,
        ...overrides,
    };
}

function validClaim(): Record<string, unknown> {
    return {
        claims: [
            {
                claim_number: field(),
                carrier: field({
                    value: "Acme Mutual",
                    quote: "Acme Mutual Insurance Co.",
                }),
            },
        ],
        summary: "Acknowledgement of claim CLM-2210.",
    };
}

function validInvoice(): Record<string, unknown> {
    return {
        vendor: field({ value: "Example Imaging Center", source: "email_body" }),
        invoice_number: field({ value: "INV-77" }),
        amount_cents: 125050,
        amount_raw: field({ value: "$1,250.50" }),
        currency: "USD",
        summary: "Radiology invoice for MRI of 2026-03-02.",
    };
}

function testClaimAcceptsValidFixture() {
    const input = validClaim();
    (input.claims as Record<string, unknown>[])[0].policy_number = field({
        value: "POL-991",
        confidence: 0.5,
    });
    const parsed = parseClaimExtraction(input);
    assert.equal(parsed.summary, "Acknowledgement of claim CLM-2210.");
    assert.equal(parsed.claims.length, 1);
    assert.equal(parsed.claims[0].claim_number.value, "CLM-2210");
    assert.equal(parsed.claims[0].claim_number.page, 1);
    assert.equal(parsed.claims[0].carrier.value, "Acme Mutual");
    assert.equal(parsed.claims[0].policy_number?.value, "POL-991");
    assert.equal(parsed.claims[0].policy_number?.confidence, 0.5);
    assert.ok(
        !("coverage_type" in parsed.claims[0]),
        "absent optional fields stay absent",
    );
}

function testClaimRejectsNonObjectRoot() {
    assert.throws(() => parseClaimExtraction("nope"), /\$: expected an object/);
    assert.throws(() => parseClaimExtraction(null), /\$: expected an object/);
    assert.throws(() => parseClaimExtraction([1]), /\$: expected an object/);
}

function testClaimRejectsMissingOrBadClaims() {
    assert.throws(
        () => parseClaimExtraction({ summary: "x" }),
        /\$\.claims: expected an array/,
    );
    assert.throws(
        () => parseClaimExtraction({ claims: "many", summary: "x" }),
        /\$\.claims: expected an array/,
    );
    assert.throws(
        () => parseClaimExtraction({ claims: [42], summary: "x" }),
        /\$\.claims\[0\]: expected an object/,
    );
}

function testClaimRejectsBadFieldTypesWithPath() {
    const input = validClaim();
    (
        (input.claims as Record<string, unknown>[])[0]
            .claim_number as Record<string, unknown>
    ).value = 42;
    assert.throws(
        () => parseClaimExtraction(input),
        /\$\.claims\[0\]\.claim_number\.value: expected a string/,
    );

    const badSource = validClaim();
    (badSource.claims as Record<string, unknown>[])[0].carrier = field({
        source: "webpage",
    });
    assert.throws(
        () => parseClaimExtraction(badSource),
        /\$\.claims\[0\]\.carrier\.source: expected "pdf" or "email_body"/,
    );

    const badConfidence = validClaim();
    (badConfidence.claims as Record<string, unknown>[])[0].claim_number =
        field({ confidence: "high" });
    assert.throws(
        () => parseClaimExtraction(badConfidence),
        /\$\.claims\[0\]\.claim_number\.confidence: expected a number/,
    );
}

function testClaimRejectsMissingSummary() {
    assert.throws(
        () => parseClaimExtraction({ claims: [] }),
        /\$\.summary: expected a string/,
    );
}

function testClaimConfidenceClamped() {
    const input = validClaim();
    (input.claims as Record<string, unknown>[])[0].claim_number = field({
        confidence: 1.7,
    });
    (input.claims as Record<string, unknown>[])[0].carrier = field({
        confidence: -0.5,
    });
    const parsed = parseClaimExtraction(input);
    assert.equal(parsed.claims[0].claim_number.confidence, 1);
    assert.equal(parsed.claims[0].carrier.confidence, 0);
}

function testClaimPageCoercion() {
    const absent = field();
    delete absent.page;
    const input = validClaim();
    (input.claims as Record<string, unknown>[])[0].claim_number = absent;
    (input.claims as Record<string, unknown>[])[0].carrier = field({
        page: null,
    });
    const parsed = parseClaimExtraction(input);
    assert.equal(parsed.claims[0].claim_number.page, null, "absent → null");
    assert.equal(parsed.claims[0].carrier.page, null, "null stays null");

    const badPage = validClaim();
    (badPage.claims as Record<string, unknown>[])[0].claim_number = field({
        page: "3",
    });
    assert.throws(
        () => parseClaimExtraction(badPage),
        /\$\.claims\[0\]\.claim_number\.page: expected a number or null/,
    );
}

function testClaimOptionalNullTreatedAsAbsent() {
    const input = validClaim();
    (input.claims as Record<string, unknown>[])[0].policy_number = null;
    const parsed = parseClaimExtraction(input);
    assert.ok(!("policy_number" in parsed.claims[0]));
}

function testClaimUnknownKeysDropped() {
    const input = validClaim();
    input.extra = "surprise";
    (input.claims as Record<string, unknown>[])[0].bogus = 1;
    const parsed = parseClaimExtraction(input) as unknown as Record<
        string,
        unknown
    >;
    assert.ok(!("extra" in parsed), "unknown root keys are not carried over");
    assert.ok(
        !("bogus" in (parsed.claims as Record<string, unknown>[])[0]),
        "unknown claim keys are not carried over",
    );
}

function testInvoiceAcceptsValidFixture() {
    const parsed = parseInvoiceExtraction(validInvoice());
    assert.equal(parsed.vendor.value, "Example Imaging Center");
    assert.equal(parsed.vendor.source, "email_body");
    assert.equal(parsed.invoice_number.value, "INV-77");
    assert.equal(parsed.amount_cents, 125050);
    assert.equal(parsed.amount_raw.value, "$1,250.50");
    assert.equal(parsed.currency, "USD");
    assert.ok(!("invoice_date" in parsed), "absent optionals stay absent");

    const withDate = validInvoice();
    withDate.invoice_date = field({ value: "2026-03-02" });
    assert.equal(
        parseInvoiceExtraction(withDate).invoice_date?.value,
        "2026-03-02",
    );

    const nullDate = validInvoice();
    nullDate.invoice_date = null;
    assert.ok(!("invoice_date" in parseInvoiceExtraction(nullDate)));
}

function testInvoiceRejectsBadAmountCents() {
    const missing = validInvoice();
    delete missing.amount_cents;
    assert.throws(
        () => parseInvoiceExtraction(missing),
        /\$\.amount_cents: expected an integer/,
    );

    const fractional = validInvoice();
    fractional.amount_cents = 1250.5;
    assert.throws(
        () => parseInvoiceExtraction(fractional),
        /\$\.amount_cents: expected an integer/,
    );

    const stringy = validInvoice();
    stringy.amount_cents = "125050";
    assert.throws(
        () => parseInvoiceExtraction(stringy),
        /\$\.amount_cents: expected an integer/,
    );
}

function testInvoiceRejectsMissingRequired() {
    const noVendor = validInvoice();
    delete noVendor.vendor;
    assert.throws(
        () => parseInvoiceExtraction(noVendor),
        /\$\.vendor: expected an object/,
    );

    const noRaw = validInvoice();
    delete noRaw.amount_raw;
    assert.throws(
        () => parseInvoiceExtraction(noRaw),
        /\$\.amount_raw: expected an object/,
    );

    const noCurrency = validInvoice();
    delete noCurrency.currency;
    assert.throws(
        () => parseInvoiceExtraction(noCurrency),
        /\$\.currency: expected a string/,
    );

    const noSummary = validInvoice();
    delete noSummary.summary;
    assert.throws(
        () => parseInvoiceExtraction(noSummary),
        /\$\.summary: expected a string/,
    );
}

function testInvoiceClampsNestedConfidence() {
    const input = validInvoice();
    input.amount_raw = field({ value: "$5", confidence: 2 });
    assert.equal(parseInvoiceExtraction(input).amount_raw.confidence, 1);
}

// The JSON Schema constants are what completeStructured hands the model, so
// their strictness (additionalProperties, required lists, confidence bounds)
// must match what the validators enforce.
function testSchemaShapes() {
    const claim = CLAIM_EXTRACTION_SCHEMA as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
    >;
    assert.equal(claim.additionalProperties as unknown, false);
    assert.deepEqual(claim.required as unknown, ["claims", "summary"]);
    const item = claim.properties.claims.items as Record<
        string,
        Record<string, Record<string, unknown>>
    >;
    assert.equal(item.additionalProperties as unknown, false);
    assert.deepEqual(item.required as unknown, ["claim_number", "carrier"]);

    const fieldSchema = item.properties.claim_number as Record<
        string,
        Record<string, Record<string, unknown>>
    >;
    assert.deepEqual(fieldSchema.required as unknown, [
        "value",
        "quote",
        "page",
        "source",
        "confidence",
    ]);
    assert.equal(fieldSchema.additionalProperties as unknown, false);
    assert.equal(fieldSchema.properties.confidence.minimum, 0);
    assert.equal(fieldSchema.properties.confidence.maximum, 1);
    assert.deepEqual(fieldSchema.properties.source.enum, [
        "pdf",
        "email_body",
    ]);

    // Every optional claim field is the same ExtractedField shape.
    for (const key of [
        "policy_number",
        "coverage_type",
        "policy_limits_text",
        "adjuster_name",
        "adjuster_email",
        "adjuster_phone",
        "client_or_insured_name",
        "date_of_loss",
        "correspondence_type",
        "requested_action",
    ]) {
        assert.deepEqual(
            item.properties[key],
            fieldSchema,
            `claims.items.${key} is an ExtractedField`,
        );
    }

    const invoice = INVOICE_EXTRACTION_SCHEMA as Record<
        string,
        Record<string, Record<string, unknown>>
    >;
    assert.equal(invoice.additionalProperties as unknown, false);
    assert.deepEqual(invoice.required as unknown, [
        "vendor",
        "invoice_number",
        "amount_cents",
        "amount_raw",
        "currency",
        "summary",
    ]);
    assert.equal(invoice.properties.amount_cents.type, "integer");
    assert.deepEqual(invoice.properties.vendor, fieldSchema);
    assert.deepEqual(invoice.properties.invoice_date, fieldSchema);
}

function main() {
    testClaimAcceptsValidFixture();
    testClaimRejectsNonObjectRoot();
    testClaimRejectsMissingOrBadClaims();
    testClaimRejectsBadFieldTypesWithPath();
    testClaimRejectsMissingSummary();
    testClaimConfidenceClamped();
    testClaimPageCoercion();
    testClaimOptionalNullTreatedAsAbsent();
    testClaimUnknownKeysDropped();
    testInvoiceAcceptsValidFixture();
    testInvoiceRejectsBadAmountCents();
    testInvoiceRejectsMissingRequired();
    testInvoiceClampsNestedConfidence();
    testSchemaShapes();
    console.log("automation/types.test.ts: all passed");
}

main();
