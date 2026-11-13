// backend/src/lib/llm/structured.ts
//
// Provider-aware structured-output completion for the LLM layer. Callers
// (the email-automation pipeline extracting claim/invoice fields from
// carrier emails and PDF attachments) hand over an instruction, an optional
// set of native PDF documents, and a JSON Schema; they get back a parsed
// JSON value plus the raw model text.
//
// Two hard rules enforced here:
//   1. Nothing outside lib/llm touches provider SDKs — Claude requests go
//      through completeClaudeStructured (claude.ts); every other provider
//      goes through the shared completeText dispatch with the schema baked
//      into the prompt.
//   2. No LLM call made by this helper ever carries tools. The content being
//      extracted is UNTRUSTED (inbound email), so this module is a
//      prompt-injection boundary: the model can only emit JSON, never act.
//
// Import-cycle note: this module imports completeText from ./index, and
// ./index re-exports this module; claude.ts imports buildSchemaPrompt from
// here while this module imports completeClaudeStructured from claude.ts.
// Both cycles are benign because every cross-module reference is only
// dereferenced at call time, never during module evaluation.

import { extractJsonObject } from "../jsonExtract";
import { completeClaudeStructured } from "./claude";
import { completeText } from "./index";
import { providerForModel } from "./models";
import type { UserApiKeys } from "./types";

export interface PdfDocumentInput {
    /** Base64-encoded PDF bytes, with no `data:` URI prefix. */
    data: string;
    filename?: string;
}

export interface CompleteStructuredParams {
    model: string;
    systemPrompt?: string;
    /** Instruction text; untrusted content must be framed by the CALLER. */
    user: string;
    /** Native PDF input — Claude models only. */
    documents?: PdfDocumentInput[];
    /** JSON Schema for the expected object. */
    schema: Record<string, unknown>;
    schemaName?: string;
    /** Output-token cap. Defaults to 8192. */
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}

export interface CompleteStructuredResult {
    /** Parsed JSON (caller narrows/validates against the schema). */
    value: unknown;
    /** The raw model text the value was parsed from. */
    raw: string;
    /** true = schema-constrained decoding; false = prompt-and-parse. */
    usedNativeStructured: boolean;
}

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Append an unambiguous output contract to the caller's instruction text:
 * respond with ONLY a single JSON object conforming to the given JSON Schema
 * (pretty-printed inline), no markdown fences, no commentary. Used for every
 * provider without schema-constrained decoding, and by the Claude fallback.
 */
export function buildSchemaPrompt(
    user: string,
    schema: Record<string, unknown>,
): string {
    return [
        user,
        "",
        "Respond with ONLY a single JSON object conforming to the JSON Schema below.",
        "Do not wrap the JSON in markdown code fences. Do not include commentary,",
        "explanations, or any other text outside the JSON object.",
        "",
        "JSON Schema:",
        JSON.stringify(schema, null, 2),
    ].join("\n");
}

/**
 * Parse a model reply into a JSON value. Fast path is a bare JSON.parse of
 * the trimmed text; models asked for "ONLY JSON" still sometimes wrap the
 * payload in a ```json fence or prose, so the fallback slices the first
 * balanced object out via extractJsonObject. Unparseable output throws with
 * a prefix of the raw text so logs show what the model actually said.
 */
export function parseStructuredText(raw: string): unknown {
    const trimmed = (raw ?? "").trim();
    try {
        return JSON.parse(trimmed);
    } catch {
        // Not bare JSON — try the lenient extraction below.
    }
    try {
        return JSON.parse(extractJsonObject(trimmed));
    } catch {
        throw new Error(
            "LLM structured output is not parseable JSON. Output began: " +
                JSON.stringify(trimmed.slice(0, 160)),
        );
    }
}

/**
 * Complete a structured-output request against whichever provider serves the
 * model. Claude models use native structured outputs (with an internal
 * prompt-and-parse fallback); other providers always prompt-and-parse. The
 * `deps` parameter exists for tests only — production callers omit it.
 */
export async function completeStructured(
    params: CompleteStructuredParams,
    deps?: {
        completeTextFn?: typeof completeText;
        completeClaudeStructuredFn?: typeof completeClaudeStructured;
    },
): Promise<CompleteStructuredResult> {
    const provider = providerForModel(params.model);

    if (provider === "claude") {
        const complete =
            deps?.completeClaudeStructuredFn ?? completeClaudeStructured;
        const { raw, usedNativeStructured } = await complete({
            model: params.model,
            systemPrompt: params.systemPrompt,
            user: params.user,
            documents: params.documents,
            schema: params.schema,
            schemaName: params.schemaName,
            maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
            apiKeys: params.apiKeys,
        });
        return { value: parseStructuredText(raw), raw, usedNativeStructured };
    }

    // Non-Claude providers have no native PDF document input here — callers
    // pre-extract text before asking a Gemini/OpenAI model.
    if (params.documents?.length) {
        throw new Error("PDF document input requires a Claude model");
    }

    const complete = deps?.completeTextFn ?? completeText;
    const raw = await complete({
        model: params.model,
        systemPrompt: params.systemPrompt,
        user: buildSchemaPrompt(params.user, params.schema),
        maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        apiKeys: params.apiKeys,
    });
    return { value: parseStructuredText(raw), raw, usedNativeStructured: false };
}
