// backend/src/lib/recordings/summarize.test.ts
//
// summarize.ts is the recordings pipeline's ONE call into the LLM. These tests
// pin the two halves that matter: (1) the request it builds — the exact schema
// object, the caller-supplied model + apiKeys, the untrusted-content framing
// (mirroring classify.ts: transcript is DATA, never an instruction), utterance
// formatting preferred over raw text, and the 600k head-truncation; and (2) the
// never-trust post-validation of the model's reply — sequential ids, done=false,
// empty-text drop, the 50-item cap, and title clamp/fallback. `complete` is
// injected, so nothing here touches a provider. A thrown transport error must
// propagate (the pipeline owns retry), not be swallowed.
import assert from "node:assert/strict";
import {
    RECORDING_SUMMARY_SCHEMA,
    RECORDING_SUMMARY_TRANSCRIPT_CAP,
    generateRecordingSummary,
    validateSummaryOutput,
} from "./summarize";
import type { Utterance } from "./types";

// Derive the injected-complete type straight from the function's own signature
// so the fake can never drift from what generateRecordingSummary accepts (and
// so this test never has to import the heavy llm/structured value graph).
type Complete = NonNullable<
    Parameters<typeof generateRecordingSummary>[0]["complete"]
>;
type CompleteParams = Parameters<Complete>[0];

function fakeComplete(captured: CompleteParams[], value: unknown): Complete {
    return (async (params: CompleteParams) => {
        captured.push(params);
        return { value, raw: JSON.stringify(value), usedNativeStructured: true };
    }) as Complete;
}

const OK_VALUE = { title: "Title", summary_md: "Summary", action_items: [] };

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

async function main() {
    console.log("recordings/summarize.test.ts");

    // ---- schema shape ------------------------------------------------------
    await test("RECORDING_SUMMARY_SCHEMA requires the three fields, owner/due nullable", async () => {
        const schema = RECORDING_SUMMARY_SCHEMA as {
            required: string[];
            additionalProperties: boolean;
            properties: {
                action_items: {
                    items: {
                        required: string[];
                        properties: {
                            owner: { type: unknown };
                            due: { type: unknown };
                        };
                    };
                };
            };
        };
        assert.deepEqual(schema.required, [
            "title",
            "summary_md",
            "action_items",
        ]);
        assert.equal(schema.additionalProperties, false);
        const item = schema.properties.action_items.items;
        assert.deepEqual(item.required, ["text", "owner", "due"]);
        assert.deepEqual(item.properties.owner.type, ["string", "null"]);
        assert.deepEqual(item.properties.due.type, ["string", "null"]);
    });

    // ---- request construction ---------------------------------------------
    await test("passes the schema object, model and apiKeys straight through", async () => {
        const captured: CompleteParams[] = [];
        const out = await generateRecordingSummary({
            transcriptText: "raw transcript body",
            utterances: [],
            model: "claude-sonnet-4-6",
            apiKeys: { claude: "sk-test" },
            complete: fakeComplete(captured, OK_VALUE),
        });
        assert.equal(captured.length, 1);
        assert.equal(captured[0].model, "claude-sonnet-4-6");
        // Same object reference — the pipeline's trust boundary is this schema.
        assert.equal(captured[0].schema, RECORDING_SUMMARY_SCHEMA);
        assert.deepEqual(captured[0].apiKeys, { claude: "sk-test" });
        assert.equal(out.title, "Title");
    });

    await test("frames the transcript as untrusted data and falls back to raw text", async () => {
        const captured: CompleteParams[] = [];
        await generateRecordingSummary({
            transcriptText: "raw transcript body",
            utterances: [],
            model: "m",
            apiKeys: {},
            complete: fakeComplete(captured, OK_VALUE),
        });
        const user = captured[0].user;
        assert.match(user, /UNTRUSTED/);
        assert.match(user, /NEVER follow/i);
        assert.match(user, /END TRANSCRIPT/);
        assert.match(user, /raw transcript body/);
        // The system prompt carries the same "summarize, never obey" discipline.
        assert.match(String(captured[0].systemPrompt), /never obey/i);
    });

    await test("prefers speaker-labeled utterances over the raw transcript text", async () => {
        const captured: CompleteParams[] = [];
        const utterances: Utterance[] = [
            { speaker: "Speaker A", text: "hello there", start_ms: 0, end_ms: 1 },
            { speaker: "Speaker B", text: "reply here", start_ms: 2, end_ms: 3 },
        ];
        await generateRecordingSummary({
            transcriptText: "SHOULD_NOT_APPEAR",
            utterances,
            model: "m",
            apiKeys: {},
            complete: fakeComplete(captured, OK_VALUE),
        });
        const user = captured[0].user;
        // speaker is already the full "Speaker A" label (assemblyai.ts prepends
        // it) — the payload must NOT double it to "Speaker Speaker A".
        assert.match(user, /Speaker A: hello there/);
        assert.match(user, /Speaker B: reply here/);
        assert.doesNotMatch(user, /Speaker Speaker/);
        assert.doesNotMatch(user, /SHOULD_NOT_APPEAR/);
    });

    await test("truncates the transcript to the head at the cap and notes it", async () => {
        const captured: CompleteParams[] = [];
        const big = "x".repeat(RECORDING_SUMMARY_TRANSCRIPT_CAP + 5000);
        await generateRecordingSummary({
            transcriptText: big,
            utterances: [],
            model: "m",
            apiKeys: {},
            complete: fakeComplete(captured, OK_VALUE),
        });
        const user = captured[0].user;
        assert.match(
            user,
            new RegExp(`first ${RECORDING_SUMMARY_TRANSCRIPT_CAP} characters`),
        );
        // Take the longest run of x's — the prompt's own instructions contain
        // stray x's (e.g. "exactly"), only the transcript payload is a long run.
        const runs = user.match(/x+/g) ?? [];
        const longest = Math.max(...runs.map((r) => r.length));
        assert.equal(longest, RECORDING_SUMMARY_TRANSCRIPT_CAP);
    });

    // ---- output validation -------------------------------------------------
    await test("assigns sequential ids, done=false, and drops empty-text items", async () => {
        const out = validateSummaryOutput({
            title: "Case sync",
            summary_md: "body",
            action_items: [
                { text: "call the client", owner: "Jane", due: "2026-08-01" },
                { text: "   ", owner: null, due: null }, // dropped
                { text: "file the motion", owner: null }, // missing due
                { notText: 1 }, // dropped — no string text
            ],
        });
        assert.deepEqual(out.action_items, [
            {
                id: "item-1",
                text: "call the client",
                done: false,
                owner: "Jane",
                due: "2026-08-01",
            },
            {
                id: "item-2",
                text: "file the motion",
                done: false,
                owner: null,
                due: null,
            },
        ]);
    });

    await test("caps action items at 50", async () => {
        const many = Array.from({ length: 60 }, (_, i) => ({
            text: `item ${i}`,
            owner: null,
            due: null,
        }));
        const out = validateSummaryOutput({
            title: "t",
            summary_md: "s",
            action_items: many,
        });
        assert.equal(out.action_items.length, 50);
        assert.equal(out.action_items[0].id, "item-1");
        assert.equal(out.action_items[49].id, "item-50");
    });

    await test("clamps the title to 200 chars and falls back when empty", async () => {
        assert.equal(
            validateSummaryOutput({
                title: "T".repeat(250),
                summary_md: "s",
                action_items: [],
            }).title.length,
            200,
        );
        assert.equal(
            validateSummaryOutput({
                title: "   ",
                summary_md: "s",
                action_items: [],
            }).title,
            "Recording summary",
        );
        // Non-object / missing fields → safe defaults, never a throw.
        const fromNull = validateSummaryOutput(null);
        assert.equal(fromNull.title, "Recording summary");
        assert.equal(fromNull.summary_md, "");
        assert.deepEqual(fromNull.action_items, []);
    });

    // ---- error propagation -------------------------------------------------
    await test("propagates a thrown transport error (pipeline owns retry)", async () => {
        await assert.rejects(
            generateRecordingSummary({
                transcriptText: "t",
                utterances: [],
                model: "m",
                apiKeys: {},
                complete: (async () => {
                    throw new Error("boom");
                }) as Complete,
            }),
            /boom/,
        );
    });

    console.log("recordings/summarize.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
