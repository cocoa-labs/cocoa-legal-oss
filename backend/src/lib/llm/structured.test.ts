// backend/src/lib/llm/structured.test.ts
//
// completeStructured is the schema-validated JSON extraction entry point the
// email-automation pipeline will call with UNTRUSTED carrier-email content.
// These tests cover the pure pieces without any network: the schema-prompt
// builder, the lenient raw-text parser, the provider dispatch (Claude vs
// prompt-and-parse fallback), and the PDF-requires-Claude guard. Both LLM
// completion functions are injected, so no test ever constructs a client.
import assert from "node:assert/strict";
import {
    buildSchemaPrompt,
    parseStructuredText,
    completeStructured,
} from "./structured";
import type { completeText } from "./index";
import type { completeClaudeStructured } from "./claude";

const SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        claim_number: { type: "string" },
        total: { type: "number" },
    },
    required: ["claim_number"],
    additionalProperties: false,
};

async function main() {
    // buildSchemaPrompt keeps the caller's instruction text, embeds the
    // pretty-printed schema, and pins the ONLY-JSON output contract.
    {
        const prompt = buildSchemaPrompt("Extract the claim fields.", SCHEMA);
        assert.ok(
            prompt.startsWith("Extract the claim fields."),
            "user instruction leads the prompt",
        );
        assert.ok(
            prompt.includes(JSON.stringify(SCHEMA, null, 2)),
            "schema is embedded pretty-printed",
        );
        assert.match(prompt, /ONLY a single JSON object/i);
        assert.match(prompt, /code fences/i);
        assert.match(prompt, /commentary/i);
    }

    // parseStructuredText: clean JSON object parses on the fast path.
    {
        const value = parseStructuredText(
            ' {"claim_number": "CLM-2210", "total": 1250.5} ',
        );
        assert.deepEqual(value, { claim_number: "CLM-2210", total: 1250.5 });
    }

    // parseStructuredText: a ```json fence is stripped by the fallback.
    {
        const value = parseStructuredText(
            '```json\n{"claim_number": "CLM-2210"}\n```',
        );
        assert.deepEqual(value, { claim_number: "CLM-2210" });
    }

    // parseStructuredText: JSON embedded in prose is sliced out.
    {
        const value = parseStructuredText(
            "Sure — here is the extracted object:\n\n" +
                '{"claim_number": "CLM-2210", "total": 1250.5}\n\n' +
                "Let me know if you need anything else.",
        );
        assert.deepEqual(value, { claim_number: "CLM-2210", total: 1250.5 });
    }

    // parseStructuredText: unparseable input throws, and the error carries a
    // prefix of the raw text so logs show what the model actually said.
    {
        assert.throws(
            () =>
                parseStructuredText(
                    "I could not find any structured data in the message.",
                ),
            /I could not find any structured/,
        );
    }

    // completeStructured, non-Claude model: dispatches to completeTextFn with
    // the schema baked into the prompt, parses the fenced reply, and reports
    // usedNativeStructured === false.
    {
        const calls: Parameters<typeof completeText>[0][] = [];
        const result = await completeStructured(
            {
                model: "gpt-5.4-mini",
                systemPrompt: "You are an extraction engine.",
                user: "Extract the claim fields.",
                schema: SCHEMA,
            },
            {
                completeTextFn: async (params) => {
                    calls.push(params);
                    return '```json\n{"claim_number": "CLM-2210"}\n```';
                },
            },
        );
        assert.deepEqual(result.value, { claim_number: "CLM-2210" });
        assert.equal(result.usedNativeStructured, false);
        assert.equal(result.raw, '```json\n{"claim_number": "CLM-2210"}\n```');
        assert.equal(calls.length, 1, "completeTextFn was called once");
        const captured = calls[0];
        assert.equal(captured.model, "gpt-5.4-mini");
        assert.equal(captured.systemPrompt, "You are an extraction engine.");
        assert.ok(
            captured.user.includes(JSON.stringify(SCHEMA, null, 2)),
            "prompt passed to completeTextFn contains the schema",
        );
        assert.equal(captured.maxTokens, 8192, "default maxTokens applied");
    }

    // completeStructured: PDF documents on a non-Claude model must throw
    // before any provider call (callers pre-extract text for non-Claude).
    {
        let called = false;
        await assert.rejects(
            completeStructured(
                {
                    model: "gemini-3-flash-preview",
                    user: "Extract the invoice fields.",
                    schema: SCHEMA,
                    documents: [{ data: "JVBERi0=" }],
                },
                {
                    completeTextFn: async () => {
                        called = true;
                        return "{}";
                    },
                },
            ),
            /PDF document input requires a Claude model/,
        );
        assert.equal(called, false, "no provider call is made");
    }

    // completeStructured, Claude model: delegates to completeClaudeStructuredFn
    // (documents, schema, and untouched user text pass through) and preserves
    // the native-structured flag while parsing the raw text.
    {
        const calls: Parameters<typeof completeClaudeStructured>[0][] = [];
        const result = await completeStructured(
            {
                model: "claude-sonnet-4-6",
                user: "Extract the claim fields.",
                schema: SCHEMA,
                documents: [{ data: "JVBERi0=", filename: "invoice.pdf" }],
                maxTokens: 2048,
            },
            {
                completeClaudeStructuredFn: async (params) => {
                    calls.push(params);
                    return { raw: '{"a":1}', usedNativeStructured: true };
                },
            },
        );
        assert.equal((result.value as { a: number }).a, 1);
        assert.equal(result.usedNativeStructured, true);
        assert.equal(result.raw, '{"a":1}');
        assert.equal(
            calls.length,
            1,
            "completeClaudeStructuredFn was called once",
        );
        const captured = calls[0];
        assert.equal(
            captured.user,
            "Extract the claim fields.",
            "user text is passed through unchanged on the Claude path",
        );
        assert.deepEqual(captured.schema, SCHEMA);
        assert.deepEqual(captured.documents, [
            { data: "JVBERi0=", filename: "invoice.pdf" },
        ]);
        assert.equal(captured.maxTokens, 2048);
    }

    // completeStructured, Claude model: a false flag from the fallback inside
    // completeClaudeStructured is propagated, not overwritten.
    {
        const result = await completeStructured(
            {
                model: "claude-sonnet-4-6",
                user: "Extract the claim fields.",
                schema: SCHEMA,
            },
            {
                completeClaudeStructuredFn: async () => ({
                    raw: '{"claim_number": "CLM-1"}',
                    usedNativeStructured: false,
                }),
            },
        );
        assert.equal(result.usedNativeStructured, false);
        assert.deepEqual(result.value, { claim_number: "CLM-1" });
    }

    console.log("structured.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
