// backend/src/lib/automation/pipeline.test.ts
//
// The pipeline is a resumable state machine over automation_runs; these
// tests pin the pieces that make it safe to re-enter and impossible to
// crash-loop: the nextStep decision table (derived from persisted fields,
// so a crashed run resumes at the right step), exponential backoff with a
// 30-minute cap, the retry→failed boundary at automationMaxRetries, the
// heartbeat lifecycle (updated_at bumps during long LLM steps, always
// cleared), playbook-misconfiguration → triage (never a crash loop),
// threshold-gated triage routing, and processDueRuns' strictly SEQUENTIAL
// run processing (the store's concurrency assumption). All I/O is injected
// — no database, no LLM.
import assert from "node:assert/strict";
import {
    backoffDelayMs,
    nextStep,
    processDueRuns,
    processRun,
    withHeartbeat,
    type ProcessRunDeps,
} from "./pipeline";
import { resolvePlaybookConfig, type PlaybookConfig } from "./playbookConfig";
import type { PlaybookEntry } from "../playbooks";
import type {
    AutomationRun,
    ClaimExtraction,
    ExtractedField,
    RunStatus,
} from "./types";
import type { EmailMessage } from "../email/store";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok — ${name}`))
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

const fakeDb = { __tag: "fake-db" } as never;

function makeRun(partial: Partial<AutomationRun>): AutomationRun {
    return {
        id: "run-1",
        user_id: "user-1",
        email_id: "email-1",
        workflow_kind: null,
        status: "queued",
        case_id: null,
        match_method: null,
        match_confidence: null,
        extracted: {},
        citations: [],
        confidence: null,
        verification: {},
        proposal: {},
        ack_email_id: null,
        operation_ids: [],
        error: null,
        retry_count: 0,
        next_attempt_at: null,
        triage_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: "2026-07-16T00:00:00Z",
        updated_at: "2026-07-16T00:00:00Z",
        ...partial,
    };
}

function makeEmail(partial: Partial<EmailMessage>): EmailMessage {
    return {
        id: "email-1",
        user_id: "user-1",
        org_id: null,
        project_id: null,
        chat_id: null,
        agent_operation_id: null,
        direction: "inbound",
        status: "received",
        from_address: "Jane Adjuster <jane@examplemutual.test>",
        to_addresses: ["legal@firm.example"],
        cc_addresses: [],
        bcc_addresses: [],
        subject: "Claim 24-1 acknowledgement",
        body_text: "Claim No. 24-1 with Example Mutual Insurance for Jane Doe.",
        body_html: null,
        attachments: [],
        signature_envelope_id: null,
        provider_message_id: "prov-1",
        provider_thread_id: "thread-1",
        in_reply_to: null,
        reply_to_address: null,
        error: null,
        approved_by: null,
        approved_at: null,
        sent_at: null,
        received_at: null,
        created_at: "2026-07-16T00:00:00Z",
        updated_at: "2026-07-16T00:00:00Z",
        ...partial,
    };
}

function field(
    value: string,
    quote: string,
    confidence = 0.9,
): ExtractedField {
    return { value, quote, page: null, source: "email_body", confidence };
}

function claimExtraction(): ClaimExtraction {
    return {
        claims: [
            {
                claim_number: field("24-1", "Claim No. 24-1"),
                carrier: field("Example Mutual", "Example Mutual Insurance"),
            },
        ],
        summary: "Acknowledgement of claim 24-1.",
    };
}

const config: PlaybookConfig = {
    carriers: [
        {
            name: "Example Mutual",
            domains: ["examplemutual.test"],
            subject_patterns: ["claim"],
        },
    ],
    vendors: [{ name: "SampleRecords", domains: ["samplerecords.test"] }],
    claimsGuidance: "guidance",
    invoiceGuidance: "guidance",
    ackTemplate: "Ack {{claim_number}}",
    signatureBlock: "Firm",
    replyTo: "",
    thresholds: {
        extractionMin: 0.75,
        fieldMin: 0.7,
        matchAuto: 0.95,
        matchConfirm: 0.8,
    },
    matchingMinScore: 0.5,
    expenseFlagAboveUsd: 2500,
};

/** In-memory run store: applies updateRun/claimRunStep semantics. */
interface RunStore {
    run: AutomationRun;
    claims: string[];
    getRunFn: NonNullable<ProcessRunDeps["getRunFn"]>;
    claimRunStepFn: NonNullable<ProcessRunDeps["claimRunStepFn"]>;
    updateRunFn: NonNullable<ProcessRunDeps["updateRunFn"]>;
}

function makeRunStore(run: AutomationRun): RunStore {
    const claims: string[] = [];
    const store: RunStore = {
        run,
        claims,
        getRunFn: async () => ({ ...store.run }),
        claimRunStepFn: (async (
            _db: never,
            _runId: string,
            from: RunStatus,
            to: RunStatus,
        ) => {
            claims.push(`${from}->${to}`);
            if (store.run.status !== from) return false;
            store.run = { ...store.run, status: to };
            return true;
        }) as never,
        updateRunFn: (async (_db: never, _runId: string, patch: never) => {
            const p = patch as Record<string, unknown>;
            const map: Record<string, string> = {
                workflowKind: "workflow_kind",
                status: "status",
                caseId: "case_id",
                matchMethod: "match_method",
                matchConfidence: "match_confidence",
                extracted: "extracted",
                citations: "citations",
                confidence: "confidence",
                verification: "verification",
                proposal: "proposal",
                ackEmailId: "ack_email_id",
                operationIds: "operation_ids",
                error: "error",
                retryCount: "retry_count",
                nextAttemptAt: "next_attempt_at",
                triageReason: "triage_reason",
                reviewedBy: "reviewed_by",
                reviewedAt: "reviewed_at",
            };
            const next = { ...store.run } as unknown as Record<string, unknown>;
            for (const [k, v] of Object.entries(p)) {
                if (map[k]) next[map[k]] = v;
            }
            store.run = next as unknown as AutomationRun;
            return { ...store.run };
        }) as never,
    };
    return store;
}

function happyDeps(
    store: ReturnType<typeof makeRunStore>,
    overrides?: Partial<ProcessRunDeps>,
): ProcessRunDeps {
    return {
        getRunFn: store.getRunFn,
        claimRunStepFn: store.claimRunStepFn,
        updateRunFn: store.updateRunFn,
        scheduleRetryFn: async () => {
            throw new Error("scheduleRetry not expected");
        },
        getEmailFn: async () => makeEmail({}),
        loadPlaybookConfigFn: async () => ({ ok: true, config }),
        loadRunDocumentsFn: async () => ({
            documents: [],
            pageTexts: new Map(),
            unprocessed: [],
        }),
        extractClaimsFn: async () => claimExtraction(),
        extractInvoiceFn: async () => {
            throw new Error("invoice extraction not expected");
        },
        evaluateUnverifiedFn: async () => {
            throw new Error("evaluator not expected");
        },
        matchClaimRunFn: async () => ({
            caseId: "case-1",
            method: "claim_number" as const,
            confidence: 1,
            needsCaseConfirm: false,
        }),
        matchInvoiceRunFn: async () => {
            throw new Error("invoice match not expected");
        },
        stageClaimRunFn: async () => ({ staged: true as const }),
        stageInvoiceRunFn: async () => {
            throw new Error("invoice stage not expected");
        },
        getUserApiKeysFn: async () => ({}),
        heartbeatIntervalMs: 60_000,
        ...overrides,
    };
}

async function main() {
    console.log("automation/pipeline.test.ts");

    await test("nextStep decision table", () => {
        const cases: [Partial<AutomationRun>, string][] = [
            [{}, "classify"],
            [{ workflow_kind: "claim_correspondence" }, "extract"],
            [
                {
                    workflow_kind: "claim_correspondence",
                    extracted: { claims: [] },
                },
                "match",
            ],
            [
                {
                    workflow_kind: "vendor_invoice",
                    extracted: { vendor: {} },
                    case_id: "c1",
                },
                "stage",
            ],
            [{ status: "staged" }, "done"],
            [{ status: "approved" }, "done"],
            [{ status: "rejected" }, "done"],
            [{ status: "failed" }, "done"],
            [{ status: "skipped" }, "done"],
            [{ status: "triage" }, "done"],
        ];
        for (const [partial, expected] of cases) {
            assert.equal(
                nextStep(makeRun(partial)),
                expected,
                JSON.stringify(partial),
            );
        }
    });

    await test("backoffDelayMs: 2^retry × 30s, capped at 30 minutes", () => {
        assert.equal(backoffDelayMs(0), 30_000);
        assert.equal(backoffDelayMs(1), 60_000);
        assert.equal(backoffDelayMs(2), 120_000);
        assert.equal(backoffDelayMs(5), 960_000);
        assert.equal(backoffDelayMs(6), 1_800_000, "cap engages at 2^6×30s=32min");
        assert.equal(backoffDelayMs(50), 1_800_000, "huge retry counts stay capped");
    });

    await test("withHeartbeat: beats while running, cleared after, result returned", async () => {
        let beats = 0;
        const result = await withHeartbeat(
            {
                db: fakeDb,
                runId: "run-1",
                intervalMs: 5,
                updateRunFn: (async () => {
                    beats += 1;
                    return null;
                }) as never,
            },
            async () => {
                await new Promise((r) => setTimeout(r, 40));
                return "done";
            },
        );
        assert.equal(result, "done");
        assert.ok(beats >= 2, `heartbeat fired during the step (${beats})`);
        const after = beats;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(beats, after, "the interval is cleared once the step ends");
    });

    await test("withHeartbeat: cleared on throw too", async () => {
        let beats = 0;
        await assert.rejects(
            withHeartbeat(
                {
                    db: fakeDb,
                    runId: "run-1",
                    intervalMs: 5,
                    updateRunFn: (async () => {
                        beats += 1;
                        return null;
                    }) as never,
                },
                async () => {
                    await new Promise((r) => setTimeout(r, 15));
                    throw new Error("boom");
                },
            ),
            /boom/,
        );
        const after = beats;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(beats, after);
    });

    await test("processRun: full claim walk queued→…→staged with sequential claims", async () => {
        const store = makeRunStore(makeRun({}));
        const result = await processRun(fakeDb, "run-1", happyDeps(store));
        assert.equal(result.outcome, "staged");
        assert.deepEqual(store.claims, [
            "queued->classifying",
            "classifying->extracting",
            "extracting->matching",
            "matching->staging",
        ]);
        assert.equal(store.run.workflow_kind, "claim_correspondence");
        assert.equal(store.run.case_id, "case-1");
        assert.equal(store.run.match_method, "claim_number");
        assert.ok(
            (store.run.confidence ?? 0) >= 0.75,
            "verified extraction carries its aggregate confidence",
        );
    });

    await test("processRun: lost claim → hands off without touching anything", async () => {
        const store = makeRunStore(makeRun({ status: "classifying" }));
        const result = await processRun(fakeDb, "run-1", happyDeps(store));
        assert.equal(result.outcome, "lost-claim");
    });

    await test("processRun: unclassifiable mail → skipped (triage_reason null, error null)", async () => {
        const store = makeRunStore(makeRun({}));
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                getEmailFn: async () =>
                    makeEmail({
                        from_address: "friend@gmail.com",
                        subject: "lunch?",
                        body_text: "see you at noon",
                    }),
            }),
        );
        assert.equal(result.outcome, "skipped");
        assert.equal(store.run.status, "skipped");
        assert.equal(store.run.triage_reason, null);
        assert.equal(store.run.error, null);
    });

    await test("processRun: playbook misconfiguration → triage, not a crash loop", async () => {
        const store = makeRunStore(makeRun({}));
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                loadPlaybookConfigFn: async () => ({
                    ok: false,
                    key: "pi.claims.carrier_registry",
                    detail: "not an array",
                }),
            }),
        );
        assert.equal(result.outcome, "triage");
        assert.equal(store.run.status, "triage");
        assert.match(
            store.run.triage_reason ?? "",
            /playbook misconfigured: pi\.claims\.carrier_registry/,
        );
    });

    await test("processRun: aggregate below extraction_min → triage with reason", async () => {
        const store = makeRunStore(makeRun({}));
        const lowConfidence: ClaimExtraction = {
            claims: [
                {
                    claim_number: field("24-1", "Claim No. 24-1", 0.4),
                    carrier: field("Example Mutual", "Example Mutual Insurance", 0.4),
                },
            ],
            summary: "s",
        };
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, { extractClaimsFn: async () => lowConfidence }),
        );
        assert.equal(result.outcome, "triage");
        assert.match(store.run.triage_reason ?? "", /extraction confidence/);
    });

    await test("processRun: evaluator-unsupported REQUIRED field → triage", async () => {
        const store = makeRunStore(makeRun({}));
        const unverifiable: ClaimExtraction = {
            claims: [
                {
                    // Quote does not appear in the email body, and the "PDF"
                    // has no text — deterministic verification must fail.
                    claim_number: {
                        value: "24-9",
                        quote: "quote not present anywhere",
                        page: 1,
                        source: "pdf",
                        confidence: 0.95,
                    },
                    carrier: field("Example Mutual", "Example Mutual Insurance", 0.95),
                },
            ],
            summary: "s",
        };
        let evaluatorCalled = false;
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                loadRunDocumentsFn: async () => ({
                    documents: [{ data: "aGk=", filename: "scan.pdf" }],
                    pageTexts: new Map([["doc-1", [""]]]),
                    unprocessed: [],
                }),
                extractClaimsFn: async () => unverifiable,
                evaluateUnverifiedFn: async (input) => {
                    evaluatorCalled = true;
                    return input.unverifiedFields.map(({ path }) => ({
                        path,
                        supported: false,
                    }));
                },
            }),
        );
        assert.equal(evaluatorCalled, true, "the LLM audit pass ran");
        assert.equal(result.outcome, "triage");
        assert.match(store.run.triage_reason ?? "", /unverified required field/);
    });

    await test("processRun: evaluator-supported correction is applied and the run proceeds", async () => {
        const store = makeRunStore(makeRun({}));
        const scanned: ClaimExtraction = {
            claims: [
                {
                    claim_number: {
                        value: "24-9",
                        quote: "scanned quote",
                        page: 1,
                        source: "pdf",
                        confidence: 0.95,
                    },
                    carrier: field("Example Mutual", "Example Mutual Insurance", 0.95),
                },
            ],
            summary: "s",
        };
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                loadRunDocumentsFn: async () => ({
                    documents: [{ data: "aGk=", filename: "scan.pdf" }],
                    pageTexts: new Map([["doc-1", [""]]]),
                    unprocessed: [],
                }),
                extractClaimsFn: async () => scanned,
                evaluateUnverifiedFn: async (input) =>
                    input.unverifiedFields.map(({ path }) => ({
                        path,
                        supported: true,
                        corrected_value: "24-9B",
                    })),
            }),
        );
        assert.equal(result.outcome, "staged");
        const extracted = store.run.extracted as unknown as ClaimExtraction;
        assert.equal(
            extracted.claims[0].claim_number.value,
            "24-9B",
            "the evaluator's corrected value is persisted",
        );
    });

    await test("processRun: match triage result routes to triage", async () => {
        const store = makeRunStore(makeRun({}));
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                matchClaimRunFn: async () => ({
                    triage: "multiple claims map to different cases",
                }),
            }),
        );
        assert.equal(result.outcome, "triage");
        assert.equal(
            store.run.triage_reason,
            "multiple claims map to different cases",
        );
    });

    await test("processRun: a step throw schedules a retry with backoff", async () => {
        const store = makeRunStore(makeRun({ retry_count: 1 }));
        let retry: { error: string; retryCount: number; delayMs: number } | null =
            null;
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                extractClaimsFn: async () => {
                    throw new Error("model unavailable");
                },
                scheduleRetryFn: (async (
                    _db: never,
                    _runId: string,
                    input: { error: string; retryCount: number; delayMs: number },
                ) => {
                    retry = input;
                }) as never,
            }),
        );
        assert.equal(result.outcome, "retry-scheduled");
        assert.ok(retry, "scheduleRetry was called");
        const r = retry as unknown as {
            error: string;
            retryCount: number;
            delayMs: number;
        };
        assert.match(r.error, /model unavailable/);
        assert.equal(r.retryCount, 2, "retry_count increments");
        assert.equal(r.delayMs, 60_000, "delay = 2^1 × 30s");
    });

    await test("processRun: at max retries a throw is terminal → failed", async () => {
        const store = makeRunStore(makeRun({ retry_count: 3 }));
        const result = await processRun(
            fakeDb,
            "run-1",
            happyDeps(store, {
                extractClaimsFn: async () => {
                    throw new Error("still broken");
                },
                maxRetriesFn: () => 3,
            }),
        );
        assert.equal(result.outcome, "failed");
        assert.equal(store.run.status, "failed");
        assert.match(store.run.error ?? "", /still broken/);
    });

    await test("processDueRuns: strictly sequential, returns counts", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const processed: string[] = [];
        // The contained crash below is EXPECTED to be logged; capture it so
        // the containment is asserted instead of polluting test output.
        const realConsoleError = console.error;
        const errorLogs: string[] = [];
        console.error = (...args: unknown[]) => {
            errorLogs.push(args.map(String).join(" "));
        };
        let result: Awaited<ReturnType<typeof processDueRuns>>;
        try {
            result = await processDueRuns(
                fakeDb,
                { limit: 5 },
                {
                    listDueRunsFn: async () => [
                        makeRun({ id: "run-a" }),
                        makeRun({ id: "run-b" }),
                        makeRun({ id: "run-c" }),
                    ],
                    processRunFn: async (_db, runId) => {
                        inFlight += 1;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        await new Promise((r) => setTimeout(r, 5));
                        processed.push(runId);
                        inFlight -= 1;
                        if (runId === "run-b") throw new Error("one bad run");
                        return { outcome: "staged" as const };
                    },
                },
            );
        } finally {
            console.error = realConsoleError;
        }
        assert.equal(maxInFlight, 1, "runs are processed one at a time");
        assert.deepEqual(processed, ["run-a", "run-b", "run-c"]);
        assert.deepEqual(
            result,
            { processed: 2, due: 3 },
            "a thrown run is contained and not counted as processed",
        );
        assert.ok(
            errorLogs.some((line) => line.includes("run-b")),
            "the contained crash is logged, not silent",
        );
    });

    // resolvePlaybookConfig — the misconfiguration seam the triage above uses.
    const entry = (key: string, value: unknown): [string, PlaybookEntry] => [
        key,
        {
            id: key,
            playbook_id: "pb",
            key,
            value_json: value,
            notes_md: "",
            is_default: true,
            updated_by: "t",
            updated_at: "2026-07-16T00:00:00Z",
        },
    ];
    const goodEntries = Object.fromEntries([
        entry("pi.claims.carrier_registry", [
            { name: "Example Mutual", domains: ["examplemutual.test"] },
        ]),
        entry("pi.invoices.vendor_registry", [
            { name: "SampleRecords", domains: ["samplerecords.test"] },
        ]),
        entry("pi.claims.extraction_guidance", "cg"),
        entry("pi.invoices.extraction_guidance", "ig"),
        entry("pi.claims.ack_template", "tpl {{claim_number}}"),
        entry("pi.claims.signature_block", "sig"),
        entry("pi.claims.reply_to", "paralegal@firm.example"),
        entry("pi.automation.confidence_thresholds", {
            extraction_min: 0.75,
            field_min: 0.7,
            match_auto: 0.95,
            match_confirm: 0.8,
        }),
        entry("pi.cases.matching_rules", { min_score: 0.85 }),
        entry("pi.invoices.expense_approval_threshold", { flag_above_usd: 2500 }),
    ]);

    await test("resolvePlaybookConfig: full seed-shaped entries resolve", () => {
        const resolved = resolvePlaybookConfig(goodEntries);
        assert.ok(resolved.ok);
        if (resolved.ok) {
            assert.equal(resolved.config.carriers[0].name, "Example Mutual");
            assert.equal(resolved.config.replyTo, "paralegal@firm.example");
            assert.equal(resolved.config.thresholds.extractionMin, 0.75);
            assert.equal(resolved.config.matchingMinScore, 0.85);
            assert.equal(resolved.config.expenseFlagAboveUsd, 2500);
        }
    });

    await test("resolvePlaybookConfig: broken registry / missing thresholds → the offending key", () => {
        const brokenRegistry = {
            ...goodEntries,
            ...Object.fromEntries([
                entry("pi.claims.carrier_registry", { not: "an array" }),
            ]),
        };
        const r1 = resolvePlaybookConfig(brokenRegistry);
        assert.deepEqual(
            { ok: r1.ok, key: r1.ok ? null : r1.key },
            { ok: false, key: "pi.claims.carrier_registry" },
        );

        const noThresholds = { ...goodEntries };
        delete (noThresholds as Record<string, unknown>)[
            "pi.automation.confidence_thresholds"
        ];
        const r2 = resolvePlaybookConfig(noThresholds);
        assert.deepEqual(
            { ok: r2.ok, key: r2.ok ? null : r2.key },
            { ok: false, key: "pi.automation.confidence_thresholds" },
        );
    });

    await test("resolvePlaybookConfig: reply_to and expense threshold are optional", () => {
        const minimal = { ...goodEntries };
        delete (minimal as Record<string, unknown>)["pi.claims.reply_to"];
        delete (minimal as Record<string, unknown>)[
            "pi.invoices.expense_approval_threshold"
        ];
        const resolved = resolvePlaybookConfig(minimal);
        assert.ok(resolved.ok);
        if (resolved.ok) {
            assert.equal(resolved.config.replyTo, "");
            assert.equal(resolved.config.expenseFlagAboveUsd, null);
        }
    });

    console.log("automation/pipeline.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
