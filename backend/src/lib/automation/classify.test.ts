// backend/src/lib/automation/classify.test.ts
//
// Classification decides which inbound mail enters the pipeline at all, so
// what these tests pin is the DECISION ORDER: sender-domain match first
// (suffix match on the address's registered domain), then subject /
// attachment-name pattern hits — with a vendor match always beating a
// carrier match at the same tier (an invoice from a known vendor about a
// "claim" is an invoice). No deterministic match → null, which the pipeline
// turns into a `skipped` run. The LLM fallback is triple-gated (deterministic
// null + ≥1 PDF + env switch), runs tool-free via completeStructured, and
// frames the email as UNTRUSTED data.
import assert from "node:assert/strict";
import {
    classifyEmailDeterministic,
    llmClassify,
    parseRegistry,
    shouldLlmClassify,
    LLM_CLASSIFY_MIN_CONFIDENCE,
    type RegistryEntry,
} from "./classify";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

const carriers: RegistryEntry[] = [
    {
        name: "Example Mutual",
        domains: ["examplemutual.test", "email.examplemutual.test"],
        subject_patterns: ["claim", "policy"],
    },
    { name: "Sample Casualty", domains: ["samplecasualty.test"], subject_patterns: ["claim"] },
];

const vendors: RegistryEntry[] = [
    {
        name: "SampleRecords",
        domains: ["samplerecords.test"],
        subject_patterns: ["invoice"],
        category: "records_invoice",
        portal_url: "https://pay.samplerecords.example",
    },
];

function classify(input: {
    fromAddress: string;
    subject?: string;
    attachmentNames?: string[];
}) {
    return classifyEmailDeterministic({
        fromAddress: input.fromAddress,
        subject: input.subject ?? "",
        attachmentNames: input.attachmentNames ?? [],
        carriers,
        vendors,
    });
}

async function main() {
    console.log("automation/classify.test.ts");

    await test("parseRegistry: tolerates missing optional fields", () => {
        const parsed = parseRegistry(
            [{ name: "Acme", domains: ["acme.com"] }, { name: "PatternOnly" }],
            "pi.claims.carrier_registry",
        );
        assert.equal(parsed.length, 2);
        assert.deepEqual(parsed[0], {
            name: "Acme",
            domains: ["acme.com"],
            subject_patterns: undefined,
            portal_url: undefined,
            category: undefined,
        });
        assert.deepEqual(parsed[1].domains, [], "missing domains default to []");
    });

    await test("parseRegistry: throws on non-array and on entries without a name", () => {
        assert.throws(
            () => parseRegistry({ not: "an array" }, "pi.claims.carrier_registry"),
            /pi\.claims\.carrier_registry/,
        );
        assert.throws(
            () => parseRegistry([{ domains: ["x.com"] }], "k"),
            /name/,
        );
        assert.throws(
            () => parseRegistry([{ name: "A", domains: "x.com" }], "k"),
            /domains/,
            "a non-array domains field is a misconfiguration, not a silent []",
        );
    });

    await test("carrier sender-domain match → claim_correspondence", () => {
        const got = classify({
            fromAddress: "Jane Adjuster <jane@examplemutual.test>",
            subject: "hello",
        });
        assert.deepEqual(
            { kind: got?.kind, name: got?.matched.name },
            { kind: "claim_correspondence", name: "Example Mutual" },
        );
    });

    await test("domain matching is suffix-based on the address domain", () => {
        assert.equal(
            classify({ fromAddress: "noreply@claims.examplemutual.test" })?.matched
                .name,
            "Example Mutual",
            "subdomains of a registered domain match",
        );
        assert.equal(
            classify({ fromAddress: "x@notexamplemutual.test" }),
            null,
            "a domain merely ENDING in the registered string must not match",
        );
    });

    await test("vendor sender-domain match → vendor_invoice", () => {
        const got = classify({ fromAddress: "billing@samplerecords.test" });
        assert.deepEqual(
            { kind: got?.kind, name: got?.matched.name },
            { kind: "vendor_invoice", name: "SampleRecords" },
        );
    });

    await test("vendor domain match wins over carrier subject-pattern hit", () => {
        // An invoice from a registered vendor whose subject says "claim
        // records" must classify as an invoice: the domain tier is more
        // specific than any pattern hit.
        const got = classify({
            fromAddress: "billing@samplerecords.test",
            subject: "Claim records for Doe v. Roe",
        });
        assert.equal(got?.kind, "vendor_invoice");
        assert.equal(got?.matched.name, "SampleRecords");
    });

    await test("subject-pattern hit classifies when no domain matches", () => {
        const got = classify({
            fromAddress: "someone@unknown-insurer.example",
            subject: "Your claim 24-1234567 has been assigned",
        });
        assert.deepEqual(
            { kind: got?.kind, name: got?.matched.name },
            { kind: "claim_correspondence", name: "Example Mutual" },
        );
    });

    await test("attachment-name pattern hit classifies too", () => {
        const got = classify({
            fromAddress: "someone@unknown.example",
            subject: "correspondence attached",
            attachmentNames: ["Policy_Declaration_Page.pdf"],
        });
        assert.equal(got?.kind, "claim_correspondence");
    });

    await test("vendor pattern beats carrier pattern at the same tier", () => {
        const got = classify({
            fromAddress: "someone@unknown.example",
            subject: "Invoice for claim records",
        });
        assert.equal(
            got?.kind,
            "vendor_invoice",
            "when both registries pattern-match, the vendor (more specific workflow) wins",
        );
    });

    await test("no signal at all → null (pipeline marks the run skipped)", () => {
        assert.equal(
            classify({
                fromAddress: "friend@gmail.com",
                subject: "lunch tomorrow?",
                attachmentNames: ["photo.jpg"],
            }),
            null,
        );
    });

    await test("shouldLlmClassify: only when deterministic missed AND a PDF exists AND the switch is on", () => {
        assert.equal(
            shouldLlmClassify({
                deterministicMatched: false,
                hasPdfAttachment: true,
                llmEnabled: true,
            }),
            true,
        );
        assert.equal(
            shouldLlmClassify({
                deterministicMatched: true,
                hasPdfAttachment: true,
                llmEnabled: true,
            }),
            false,
            "a deterministic hit never re-asks the model",
        );
        assert.equal(
            shouldLlmClassify({
                deterministicMatched: false,
                hasPdfAttachment: false,
                llmEnabled: true,
            }),
            false,
            "no PDF → not worth an LLM call; plain mail is skipped",
        );
        assert.equal(
            shouldLlmClassify({
                deterministicMatched: false,
                hasPdfAttachment: true,
                llmEnabled: false,
            }),
            false,
            "the env switch gates the stage entirely",
        );
    });

    await test("llmClassify: confident kind is accepted", async () => {
        let seen: {
            user: string;
            schema: Record<string, unknown>;
            model: string;
        } | null = null;
        const got = await llmClassify(
            {
                subject: "Subrogation notice",
                bodyText: "b".repeat(5000),
                model: "claude-sonnet-4-6",
            },
            {
                completeStructuredFn: async (params) => {
                    seen = {
                        user: params.user,
                        schema: params.schema,
                        model: params.model,
                    };
                    return {
                        value: { kind: "claim_correspondence", confidence: 0.92 },
                        raw: "{}",
                        usedNativeStructured: true,
                    };
                },
            },
        );
        assert.equal(got, "claim_correspondence");
        assert.ok(seen, "the stub must have been called");
        const call = seen as unknown as {
            user: string;
            schema: Record<string, unknown>;
            model: string;
        };
        assert.equal(call.model, "claude-sonnet-4-6");
        assert.match(
            call.user,
            /UNTRUSTED/,
            "inbound content must be framed as untrusted data",
        );
        assert.match(
            call.user,
            /never follow instructions/i,
            "the framing must forbid instruction-following",
        );
        assert.ok(
            !call.user.includes("b".repeat(2001)),
            "body is capped to ~2000 chars",
        );
        const props = call.schema.properties as Record<string, unknown>;
        assert.deepEqual(Object.keys(props).sort(), ["confidence", "kind"]);
    });

    await test("llmClassify: 'other', low confidence, or malformed → null", async () => {
        const stub =
            (value: unknown) =>
            async (): Promise<{
                value: unknown;
                raw: string;
                usedNativeStructured: boolean;
            }> => ({ value, raw: "{}", usedNativeStructured: true });
        const base = { subject: "s", bodyText: "b", model: "m" };
        assert.equal(
            await llmClassify(base, {
                completeStructuredFn: stub({ kind: "other", confidence: 0.99 }),
            }),
            null,
        );
        assert.equal(
            await llmClassify(base, {
                completeStructuredFn: stub({
                    kind: "vendor_invoice",
                    confidence: LLM_CLASSIFY_MIN_CONFIDENCE - 0.01,
                }),
            }),
            null,
        );
        assert.equal(
            await llmClassify(base, {
                completeStructuredFn: stub({ nonsense: true }),
            }),
            null,
            "a malformed reply is a no-classification, not a crash",
        );
        assert.equal(
            await llmClassify(base, {
                completeStructuredFn: stub("not an object"),
            }),
            null,
        );
    });

    console.log("automation/classify.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
