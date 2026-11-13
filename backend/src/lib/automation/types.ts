// backend/src/lib/automation/types.ts
//
// Shared types for the personal-injury email-automation pipeline: the
// automation_runs state machine (see migrations/023_pi_cases_automation.sql)
// and the two structured-extraction shapes the pipeline pulls out of inbound
// mail with completeStructured (lib/llm/structured.ts).
//
// The JSON Schema constants are handed to the model; the hand-rolled
// parseClaimExtraction / parseInvoiceExtraction validators re-check the reply
// before anything touches the database. That double layer is deliberate: the
// input is UNTRUSTED carrier-email / invoice content and the model must never
// be trusted to have honored the schema. The validators throw an Error whose
// message starts with a JSON-path (e.g. "$.claims[0].carrier.value: ...") on
// the first violation, clamp confidences into [0,1], and coerce a missing
// page to null — everything else is rejected, and unknown keys are dropped
// (the parsers build fresh objects).

/** Every status automation_runs.status may hold (DB check constraint). */
export const RUN_STATUSES = [
    "queued",
    "classifying",
    "extracting",
    "matching",
    "staging",
    "staged",
    "approved",
    "rejected",
    "failed",
    "triage",
    "skipped",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type WorkflowKind = "claim_correspondence" | "vendor_invoice";

/** One automation_runs row — a single inbound email's trip through the pipeline. */
export interface AutomationRun {
    id: string;
    user_id: string;
    email_id: string | null;
    workflow_kind: WorkflowKind | null;
    status: RunStatus;
    case_id: string | null;
    match_method: string | null;
    match_confidence: number | null;
    extracted: Record<string, unknown>;
    citations: unknown[];
    confidence: number | null;
    verification: Record<string, unknown>;
    proposal: Record<string, unknown>;
    ack_email_id: string | null;
    operation_ids: string[];
    error: string | null;
    retry_count: number;
    next_attempt_at: string | null;
    triage_reason: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * One extracted datum with its provenance: the verbatim quote it came from,
 * the PDF page (null when it came from the email body or the page is
 * unknown), and the model's own confidence.
 */
export interface ExtractedField {
    value: string;
    quote: string;
    page: number | null;
    source: "pdf" | "email_body";
    confidence: number;
}

/** Optional per-claim fields, in canonical order (also drives the citation
 * verifier's stable field enumeration in extract/verify.ts). */
export const CLAIM_OPTIONAL_FIELDS = [
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
] as const;

type ClaimOptionalField = (typeof CLAIM_OPTIONAL_FIELDS)[number];

export interface ClaimExtractionClaim {
    claim_number: ExtractedField;
    carrier: ExtractedField;
    policy_number?: ExtractedField;
    coverage_type?: ExtractedField;
    policy_limits_text?: ExtractedField;
    adjuster_name?: ExtractedField;
    adjuster_email?: ExtractedField;
    adjuster_phone?: ExtractedField;
    client_or_insured_name?: ExtractedField;
    date_of_loss?: ExtractedField;
    correspondence_type?: ExtractedField;
    requested_action?: ExtractedField;
}

export interface ClaimExtraction {
    claims: ClaimExtractionClaim[];
    summary: string;
}

export interface InvoiceExtraction {
    vendor: ExtractedField;
    invoice_number: ExtractedField;
    /** Integral cents computed by the model; amount_raw keeps the quoted text. */
    amount_cents: number;
    amount_raw: ExtractedField;
    currency: string;
    invoice_date?: ExtractedField;
    matter_reference?: ExtractedField;
    summary: string;
}

const EXTRACTED_FIELD_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        value: { type: "string" },
        quote: { type: "string" },
        page: { type: ["integer", "null"] },
        source: { type: "string", enum: ["pdf", "email_body"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["value", "quote", "page", "source", "confidence"],
    additionalProperties: false,
};

export const CLAIM_EXTRACTION_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        claims: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    claim_number: EXTRACTED_FIELD_SCHEMA,
                    carrier: EXTRACTED_FIELD_SCHEMA,
                    ...Object.fromEntries(
                        CLAIM_OPTIONAL_FIELDS.map((key) => [
                            key,
                            EXTRACTED_FIELD_SCHEMA,
                        ]),
                    ),
                },
                required: ["claim_number", "carrier"],
                additionalProperties: false,
            },
        },
        summary: { type: "string" },
    },
    required: ["claims", "summary"],
    additionalProperties: false,
};

export const INVOICE_EXTRACTION_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        vendor: EXTRACTED_FIELD_SCHEMA,
        invoice_number: EXTRACTED_FIELD_SCHEMA,
        amount_cents: { type: "integer" },
        amount_raw: EXTRACTED_FIELD_SCHEMA,
        currency: { type: "string" },
        invoice_date: EXTRACTED_FIELD_SCHEMA,
        matter_reference: EXTRACTED_FIELD_SCHEMA,
        summary: { type: "string" },
    },
    required: [
        "vendor",
        "invoice_number",
        "amount_cents",
        "amount_raw",
        "currency",
        "summary",
    ],
    additionalProperties: false,
};

function fail(path: string, expected: string): never {
    throw new Error(`${path}: expected ${expected}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseString(v: unknown, path: string): string {
    if (typeof v !== "string") fail(path, "a string");
    return v;
}

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
}

function parseExtractedField(v: unknown, path: string): ExtractedField {
    if (!isPlainObject(v)) fail(path, "an object");
    const value = parseString(v.value, `${path}.value`);
    const quote = parseString(v.quote, `${path}.quote`);
    const source = v.source;
    if (source !== "pdf" && source !== "email_body") {
        fail(`${path}.source`, `"pdf" or "email_body"`);
    }
    const confidence = v.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
        fail(`${path}.confidence`, "a number");
    }
    const rawPage = v.page;
    let page: number | null;
    if (rawPage === undefined || rawPage === null) {
        page = null;
    } else if (typeof rawPage === "number" && Number.isFinite(rawPage)) {
        page = rawPage;
    } else {
        fail(`${path}.page`, "a number or null");
    }
    return { value, quote, page, source, confidence: clamp01(confidence) };
}

export function parseClaimExtraction(v: unknown): ClaimExtraction {
    if (!isPlainObject(v)) fail("$", "an object");
    const rawClaims = v.claims;
    if (!Array.isArray(rawClaims)) fail("$.claims", "an array");
    const claims = rawClaims.map((item, i) => {
        const path = `$.claims[${i}]`;
        if (!isPlainObject(item)) fail(path, "an object");
        const claim: ClaimExtractionClaim = {
            claim_number: parseExtractedField(
                item.claim_number,
                `${path}.claim_number`,
            ),
            carrier: parseExtractedField(item.carrier, `${path}.carrier`),
        };
        for (const key of CLAIM_OPTIONAL_FIELDS) {
            const raw = item[key];
            // A null optional is treated as "not extracted", same as absent.
            if (raw === undefined || raw === null) continue;
            claim[key as ClaimOptionalField] = parseExtractedField(
                raw,
                `${path}.${key}`,
            );
        }
        return claim;
    });
    const summary = parseString(v.summary, "$.summary");
    return { claims, summary };
}

export function parseInvoiceExtraction(v: unknown): InvoiceExtraction {
    if (!isPlainObject(v)) fail("$", "an object");
    const vendor = parseExtractedField(v.vendor, "$.vendor");
    const invoiceNumber = parseExtractedField(
        v.invoice_number,
        "$.invoice_number",
    );
    const amountCents = v.amount_cents;
    if (typeof amountCents !== "number" || !Number.isInteger(amountCents)) {
        fail("$.amount_cents", "an integer");
    }
    const amountRaw = parseExtractedField(v.amount_raw, "$.amount_raw");
    const currency = parseString(v.currency, "$.currency");
    const summary = parseString(v.summary, "$.summary");
    const out: InvoiceExtraction = {
        vendor,
        invoice_number: invoiceNumber,
        amount_cents: amountCents,
        amount_raw: amountRaw,
        currency,
        summary,
    };
    // Null optionals are treated as "not extracted", same as absent.
    if (v.invoice_date !== undefined && v.invoice_date !== null) {
        out.invoice_date = parseExtractedField(v.invoice_date, "$.invoice_date");
    }
    if (v.matter_reference !== undefined && v.matter_reference !== null) {
        out.matter_reference = parseExtractedField(
            v.matter_reference,
            "$.matter_reference",
        );
    }
    return out;
}
