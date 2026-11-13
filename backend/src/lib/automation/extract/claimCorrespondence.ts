// backend/src/lib/automation/extract/claimCorrespondence.ts
//
// Structured extraction of claim facts (claim numbers, carrier, policy,
// adjuster, client, date of loss, …) from a carrier email + its PDF
// attachments. One tool-free completeStructured call: the playbook's
// pi.claims.extraction_guidance is inlined into the SYSTEM prompt (trusted,
// firm-authored), the email rides in the USER content framed as untrusted
// data, and PDFs go in as native document inputs. The reply is re-validated
// by parseClaimExtraction before anything downstream sees it.

import {
    completeStructured,
    type PdfDocumentInput,
} from "../../llm/structured";
import type { UserApiKeys } from "../../llm/types";
import {
    CLAIM_EXTRACTION_SCHEMA,
    parseClaimExtraction,
    type ClaimExtraction,
} from "../types";
import { GROUNDING_RULES, frameUntrustedEmail } from "./shared";

export interface ExtractClaimsParams {
    email: {
        fromAddress: string | null;
        subject: string;
        bodyText: string;
    };
    documents: PdfDocumentInput[];
    /** pi.claims.extraction_guidance (firm playbook — trusted). */
    guidance: string;
    model: string;
    apiKeys?: UserApiKeys;
    /** Attachments the model is not shown (from loadRunDocuments). */
    unprocessed?: { filename: string; reason: string }[];
    maxTokens?: number;
}

export async function extractClaims(
    params: ExtractClaimsParams,
    deps?: { completeStructuredFn?: typeof completeStructured },
): Promise<ClaimExtraction> {
    const complete = deps?.completeStructuredFn ?? completeStructured;

    const systemPrompt = [
        "You extract structured claim facts from insurance-carrier correspondence for a personal-injury law firm's human review queue. Nothing you output is acted on without attorney approval, so precision and honest confidence matter more than completeness.",
        "",
        params.guidance,
        "",
        GROUNDING_RULES,
        "",
        "A single letter may reference MULTIPLE claims (one per coverage or claimant): emit one claims[] entry per claim number. Include a one-paragraph neutral summary of what the correspondence says and asks for.",
    ].join("\n");

    const user = [
        "Extract the claim facts from the email below and its attached PDF document(s).",
        "",
        frameUntrustedEmail({ ...params.email, unprocessed: params.unprocessed }),
    ].join("\n");

    const result = await complete({
        model: params.model,
        systemPrompt,
        user,
        documents: params.documents,
        schema: CLAIM_EXTRACTION_SCHEMA,
        schemaName: "claim_extraction",
        maxTokens: params.maxTokens ?? 8192,
        apiKeys: params.apiKeys,
    });
    return parseClaimExtraction(result.value);
}
