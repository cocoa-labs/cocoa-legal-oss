// backend/src/lib/automation/extract/invoice.ts
//
// Structured extraction of vendor-invoice facts (vendor, invoice number,
// total due, currency, matter reference) from an invoice email + PDF.
// Mirrors claimCorrespondence.ts exactly: playbook guidance in the system
// prompt, the email framed as untrusted data, tool-free completeStructured,
// reply re-validated by parseInvoiceExtraction.

import {
    completeStructured,
    type PdfDocumentInput,
} from "../../llm/structured";
import type { UserApiKeys } from "../../llm/types";
import {
    INVOICE_EXTRACTION_SCHEMA,
    parseInvoiceExtraction,
    type InvoiceExtraction,
} from "../types";
import { GROUNDING_RULES, frameUntrustedEmail } from "./shared";

export interface ExtractInvoiceParams {
    email: {
        fromAddress: string | null;
        subject: string;
        bodyText: string;
    };
    documents: PdfDocumentInput[];
    /** pi.invoices.extraction_guidance (firm playbook — trusted). */
    guidance: string;
    model: string;
    apiKeys?: UserApiKeys;
    unprocessed?: { filename: string; reason: string }[];
    maxTokens?: number;
}

export async function extractInvoice(
    params: ExtractInvoiceParams,
    deps?: { completeStructuredFn?: typeof completeStructured },
): Promise<InvoiceExtraction> {
    const complete = deps?.completeStructuredFn ?? completeStructured;

    const systemPrompt = [
        "You extract structured invoice facts from vendor emails for a personal-injury law firm's expense-approval queue. Every expense is human-approved before anything is paid, so precision and honest confidence matter more than completeness.",
        "",
        params.guidance,
        "",
        GROUNDING_RULES,
        "",
        'amount_cents is the TOTAL DUE converted to integral cents (e.g. "$1,234.50" → 123450); amount_raw keeps the quoted text with its citation. currency is the ISO code (default "USD" when the invoice shows only $). Include a one-sentence summary of what the invoice bills for.',
    ].join("\n");

    const user = [
        "Extract the invoice facts from the email below and its attached PDF document(s).",
        "",
        frameUntrustedEmail({ ...params.email, unprocessed: params.unprocessed }),
    ].join("\n");

    const result = await complete({
        model: params.model,
        systemPrompt,
        user,
        documents: params.documents,
        schema: INVOICE_EXTRACTION_SCHEMA,
        schemaName: "invoice_extraction",
        maxTokens: params.maxTokens ?? 8192,
        apiKeys: params.apiKeys,
    });
    return parseInvoiceExtraction(result.value);
}
