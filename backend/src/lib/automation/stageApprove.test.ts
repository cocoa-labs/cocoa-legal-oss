// backend/src/lib/automation/stageApprove.test.ts
//
// Staging and approval are where the pipeline's safety promises become
// checkable behavior, so this file pins them end to end with injected
// collaborators (no database): the ack draft body is EXACTLY deterministic
// template output (rendered template + signature — no other text can reach
// it), staging is idempotent on re-entry (ack_email_id short-circuit,
// expense reuse via automation_run_id), staging always lands at `staged`
// with pending-approval artifacts, the approve mutex has exactly one
// winner, drafts-only (default) means even approval leaves the ack email
// pending, needs_case_confirm blocks un-confirmed approvals, and reject
// cancels the pending operations + draft.
import assert from "node:assert/strict";
import { renderAckTemplate } from "./ackTemplate";
import {
    approveRun,
    applyProposalEdits,
    invalidAmountCentsEdit,
    rejectRun,
    reassignRun,
    type ApproveDeps,
} from "./approve";
import {
    ackTemplateVars,
    buildPolicyUpserts,
    stageClaimRun,
    stageInvoiceRun,
    type StageDeps,
} from "./stage";
import type { PlaybookConfig } from "./playbookConfig";
import type {
    AutomationRun,
    ClaimExtraction,
    ExtractedField,
    InvoiceExtraction,
} from "./types";
import { cancelPendingEmail, type EmailMessage } from "../email/store";
import type { PiCase, PiCaseExpense } from "../pi/store";

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
        workflow_kind: "claim_correspondence",
        status: "queued",
        case_id: "case-1",
        match_method: "claim_number",
        match_confidence: 1,
        extracted: {},
        citations: [],
        confidence: 0.9,
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
        from_address: "Jane Adjuster <jane.adjuster@examplemutual.test>",
        to_addresses: ["legal@firm.example"],
        cc_addresses: [],
        bcc_addresses: [],
        subject: "Claim 24-1 acknowledgement",
        body_text: "body",
        body_html: null,
        attachments: [
            {
                document_id: "doc-1",
                version_id: "ver-1",
                filename: "letter.pdf",
                content_type: "application/pdf",
                size: 1000,
            },
        ],
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

function field(value: string, confidence = 0.9): ExtractedField {
    return {
        value,
        quote: value,
        page: null,
        source: "email_body",
        confidence,
    };
}

const claimExtraction: ClaimExtraction = {
    claims: [
        {
            claim_number: field("24-1"),
            carrier: field("Example Mutual"),
            client_or_insured_name: field("Jane Doe"),
            adjuster_name: field("John Adjuster"),
            policy_limits_text: field("25/50"),
            adjuster_email: field("low-conf@x.com", 0.2),
        },
    ],
    summary: "ack",
};

const invoiceExtraction: InvoiceExtraction = {
    vendor: field("SampleRecords Inc."),
    invoice_number: field("INV-77"),
    amount_cents: 300_000,
    amount_raw: field("$3,000.00"),
    currency: "usd",
    matter_reference: field("Jane Doe"),
    summary: "records invoice",
};

const config: PlaybookConfig = {
    carriers: [{ name: "Example Mutual", domains: ["examplemutual.test"] }],
    vendors: [
        {
            name: "SampleRecords",
            domains: ["samplerecords.test"],
            portal_url: "https://pay.samplerecords.example",
        },
    ],
    claimsGuidance: "g",
    invoiceGuidance: "g",
    ackTemplate:
        "Re: Claim No. {{claim_number}} — {{client_name}}\n\nDear {{adjuster_name}},\n\nReceipt of {{carrier}} correspondence confirmed.",
    signatureBlock: "Sincerely,\nThe Firm",
    replyTo: "paralegal@firm.example",
    thresholds: {
        extractionMin: 0.75,
        fieldMin: 0.7,
        matchAuto: 0.95,
        matchConfirm: 0.8,
    },
    matchingMinScore: 0.5,
    expenseFlagAboveUsd: 2500,
};

const match = {
    caseId: "case-1",
    method: "claim_number" as const,
    confidence: 1,
    needsCaseConfirm: false,
};

const piCase: PiCase = {
    id: "case-1",
    user_id: "user-1",
    project_id: null,
    case_number: "CV-1",
    client_name: "Jane Q Doe",
    client_name_normalized: "jane q doe",
    date_of_loss: null,
    status: "open",
    origin: "manual",
    needs_review: false,
    attributes: {},
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
};

function makeExpense(partial: Partial<PiCaseExpense>): PiCaseExpense {
    return {
        id: "exp-1",
        case_id: "case-1",
        user_id: "user-1",
        vendor: "SampleRecords",
        invoice_number: "INV-77",
        amount_cents: 300_000,
        currency: "USD",
        status: "pending_approval",
        payment_portal_url: null,
        document_id: "doc-1",
        agent_operation_id: null,
        automation_run_id: "run-1",
        incurred_at: null,
        paid_at: null,
        paid_by: null,
        notes: null,
        metadata: {},
        created_at: "2026-07-16T00:00:00Z",
        updated_at: "2026-07-16T00:00:00Z",
        ...partial,
    };
}

interface StageRecorder {
    ops: Record<string, unknown>[];
    emails: Record<string, unknown>[];
    runPatches: Record<string, unknown>[];
    deps: StageDeps;
}

function makeStageDeps(overrides?: Partial<StageDeps>): StageRecorder {
    const rec: StageRecorder = {
        ops: [],
        emails: [],
        runPatches: [],
        deps: {},
    };
    rec.deps = {
        createAgentOperationFn: (async (input: Record<string, unknown>) => {
            rec.ops.push(input);
            return { id: `op-${rec.ops.length}` } as never;
        }) as never,
        createPendingEmailFn: (async (
            _db: never,
            input: Record<string, unknown>,
        ) => {
            rec.emails.push(input);
            return { id: `ack-${rec.emails.length}` } as never;
        }) as never,
        updateRunFn: (async (
            _db: never,
            _runId: string,
            patch: Record<string, unknown>,
        ) => {
            rec.runPatches.push(patch);
            return null;
        }) as never,
        getCaseFn: async () => piCase,
        getEmailByOperationIdFn: async () => null,
        fetchMessageIdHeaderFn: async () => "<rfc822-msg-id@examplemutual.test>",
        agentAddress: "legal@example.com",
        ...overrides,
    };
    return rec;
}

async function main() {
    console.log("automation/stageApprove.test.ts");

    await test("buildPolicyUpserts: optional fields below field_min are dropped, required always stage", () => {
        const upserts = buildPolicyUpserts(claimExtraction, {
            runId: "run-1",
            sourceDocumentId: "doc-1",
            fieldMin: 0.7,
        });
        assert.equal(upserts.length, 1);
        const u = upserts[0];
        assert.equal(u.carrier, "Example Mutual");
        assert.equal(u.claim_number, "24-1");
        assert.deepEqual(u.policy_limits, { raw_text: "25/50" });
        assert.deepEqual(
            u.adjuster,
            { name: "John Adjuster" },
            "the 0.2-confidence adjuster_email is dropped as unreliable",
        );
        assert.equal(u.source_document_id, "doc-1");
        assert.equal(u.source_run_id, "run-1");
    });

    await test("ackTemplateVars: joins claim numbers, falls back to case client name and a blank adjuster", () => {
        const twoClaims: ClaimExtraction = {
            claims: [
                { claim_number: field("24-1"), carrier: field("Example Mutual") },
                { claim_number: field("24-2"), carrier: field("Example Mutual") },
            ],
            summary: "s",
        };
        const vars = ackTemplateVars(twoClaims, "Jane Q Doe", 0.7);
        assert.deepEqual(vars, {
            claim_number: "24-1, 24-2",
            carrier: "Example Mutual",
            client_name: "Jane Q Doe",
            adjuster_name: "",
        });
    });

    await test("ackTemplateVars: unverified/unreliable optional fields never reach the draft", () => {
        // A field that FAILED citation verification has its confidence
        // dropped to 0 by the pipeline — the ack vars must apply the same
        // reliable(field, fieldMin) gate as buildPolicyUpserts.
        const unverified: ClaimExtraction = {
            claims: [
                {
                    claim_number: field("24-1"),
                    carrier: field("Example Mutual"),
                    client_or_insured_name: field("Wrong Person", 0),
                    adjuster_name: field("Hallucinated Adjuster", 0.3),
                },
            ],
            summary: "s",
        };
        const vars = ackTemplateVars(unverified, "Jane Q Doe", 0.7);
        assert.equal(
            vars.client_name,
            "Jane Q Doe",
            "an unverified client name falls back to the MATCHED case's name",
        );
        assert.equal(
            vars.adjuster_name,
            "",
            "an unreliable adjuster name falls back to empty",
        );
    });

    await test("stageClaimRun: stages pending op + DETERMINISTIC ack draft, then run → staged", async () => {
        const rec = makeStageDeps();
        const run = makeRun({ status: "staging" });
        const outcome = await stageClaimRun(
            fakeDb,
            {
                run,
                email: makeEmail({}),
                extraction: claimExtraction,
                match,
                config,
            },
            rec.deps,
        );
        assert.deepEqual(outcome, { staged: true });

        // Case-write operation: pending approval, chat-less, idempotent key.
        const caseOp = rec.ops[0] as Record<string, unknown>;
        assert.equal(caseOp.toolName, "update_case_insurance");
        assert.equal(caseOp.requiresApproval, true);
        assert.equal(caseOp.chatId, null);
        assert.equal(caseOp.idempotencyKey, "automation:run-1:case-write");
        const caseArgs = caseOp.arguments as Record<string, unknown>;
        assert.equal(caseArgs.case_id, "case-1");
        assert.equal(caseArgs.run_id, "run-1");
        assert.ok(Array.isArray(caseArgs.policy_upserts));

        // Ack operation + draft.
        const ackOp = rec.ops[1] as Record<string, unknown>;
        assert.equal(ackOp.toolName, "auto_ack_email");
        assert.equal(ackOp.requiresApproval, true);

        const draft = rec.emails[0] as Record<string, unknown>;
        assert.deepEqual(draft.to, ["jane.adjuster@examplemutual.test"]);
        assert.equal(draft.subject, "Re: Claim 24-1 acknowledgement");
        assert.equal(draft.providerThreadId, "thread-1");
        assert.equal(draft.inReplyTo, "<rfc822-msg-id@examplemutual.test>");
        assert.equal(draft.replyToAddress, "paralegal@firm.example");
        assert.equal(draft.fromAddress, "legal@example.com");
        assert.equal(draft.agentOperationId, "op-2");
        // THE outbound-safety assertion: the body is exactly template
        // substitution + signature — nothing else can be in it.
        const expectedBody =
            renderAckTemplate(config.ackTemplate, {
                claim_number: "24-1",
                carrier: "Example Mutual",
                client_name: "Jane Doe",
                adjuster_name: "John Adjuster",
            }) +
            "\n\n" +
            config.signatureBlock;
        assert.equal(draft.bodyText, expectedBody);

        // The run lands staged with the artifacts wired on.
        const patch = rec.runPatches[0] as Record<string, unknown>;
        assert.equal(patch.status, "staged");
        assert.equal(patch.ackEmailId, "ack-1");
        assert.deepEqual(patch.operationIds, ["op-1", "op-2"]);
        const proposal = patch.proposal as Record<string, unknown>;
        assert.equal(proposal.kind, "claim_correspondence");
        assert.equal(proposal.needs_case_confirm, false);
    });

    await test("stageClaimRun: idempotent re-entry — ack_email_id short-circuits draft creation", async () => {
        const rec = makeStageDeps();
        const run = makeRun({
            status: "staging",
            ack_email_id: "ack-existing",
            operation_ids: ["op-old"],
        });
        const outcome = await stageClaimRun(
            fakeDb,
            {
                run,
                email: makeEmail({}),
                extraction: claimExtraction,
                match,
                config,
            },
            rec.deps,
        );
        assert.deepEqual(outcome, { staged: true });
        assert.equal(rec.emails.length, 0, "no second draft is created");
        assert.equal(
            rec.ops.length,
            1,
            "only the (idempotency-keyed) case-write op is re-asserted",
        );
        const patch = rec.runPatches[0] as Record<string, unknown>;
        assert.equal(patch.ackEmailId, "ack-existing");
        assert.deepEqual(
            patch.operationIds,
            ["op-old", "op-1"],
            "prior operation ids are preserved and deduped",
        );
    });

    await test("stageClaimRun: a draft already tied to the ack op is recovered, not re-drafted", async () => {
        // Crash window: draft inserted, but the updateRun persisting
        // ack_email_id never ran. On re-entry the idempotency-keyed ack op
        // resolves to the same operation — its existing draft must be
        // adopted instead of creating a duplicate.
        const rec = makeStageDeps({
            getEmailByOperationIdFn: (async () => ({
                id: "ack-recovered",
            })) as never,
        });
        const outcome = await stageClaimRun(
            fakeDb,
            {
                run: makeRun({ status: "staging" }),
                email: makeEmail({}),
                extraction: claimExtraction,
                match,
                config,
            },
            rec.deps,
        );
        assert.deepEqual(outcome, { staged: true });
        assert.equal(rec.emails.length, 0, "no duplicate draft is created");
        const patch = rec.runPatches[0] as Record<string, unknown>;
        assert.equal(patch.ackEmailId, "ack-recovered");
    });

    await test("stageClaimRun: unusable sender → staged without an ack, reason recorded", async () => {
        const rec = makeStageDeps();
        const outcome = await stageClaimRun(
            fakeDb,
            {
                run: makeRun({ status: "staging" }),
                email: makeEmail({ from_address: null }),
                extraction: claimExtraction,
                match,
                config,
            },
            rec.deps,
        );
        assert.deepEqual(outcome, { staged: true });
        assert.equal(rec.emails.length, 0);
        const patch = rec.runPatches[0] as Record<string, unknown>;
        assert.equal(patch.ackEmailId, null);
        assert.equal(
            (patch.proposal as Record<string, unknown>).no_ack_reason,
            "inbound sender address unusable",
        );
    });

    await test("stageInvoiceRun: stages expense + op, files the PDF, flags above threshold", async () => {
        const rec = makeStageDeps();
        const inserted: Record<string, unknown>[] = [];
        const filed: [string, string][] = [];
        const expensePatches: Record<string, unknown>[] = [];
        const outcome = await stageInvoiceRun(
            fakeDb,
            {
                run: makeRun({
                    status: "staging",
                    workflow_kind: "vendor_invoice",
                }),
                email: makeEmail({
                    from_address: "billing@samplerecords.test",
                    subject: "Invoice INV-77",
                }),
                extraction: invoiceExtraction,
                match,
                config,
            },
            {
                ...rec.deps,
                ensureCaseProjectFn: async () => "project-1",
                setDocumentProjectFn: (async (
                    _db: never,
                    documentId: string,
                    projectId: string,
                ) => {
                    filed.push([documentId, projectId]);
                }) as never,
                findExpenseByRunIdFn: async () => null,
                insertExpenseFn: (async (
                    _db: never,
                    input: Record<string, unknown>,
                ) => {
                    inserted.push(input);
                    return makeExpense({});
                }) as never,
                updateExpenseFn: (async (
                    _db: never,
                    _userId: string,
                    _id: string,
                    patch: Record<string, unknown>,
                ) => {
                    expensePatches.push(patch);
                    return makeExpense({});
                }) as never,
            },
        );
        assert.deepEqual(outcome, { staged: true });
        assert.deepEqual(filed, [["doc-1", "project-1"]]);

        const ins = inserted[0];
        assert.equal(ins.vendor, "SampleRecords", "registry name beats extracted vendor text");
        assert.equal(ins.invoiceNumber, "INV-77");
        assert.equal(ins.amountCents, 300_000);
        assert.equal(ins.currency, "USD", "currency normalized to upper-case");
        assert.equal(ins.status, "pending_approval");
        assert.equal(ins.paymentPortalUrl, "https://pay.samplerecords.example");
        assert.equal(ins.automationRunId, "run-1");

        assert.equal(
            (expensePatches[0] as Record<string, unknown>).agentOperationId,
            "op-1",
            "the expense is linked to its pending operation",
        );

        const patch = rec.runPatches[0] as Record<string, unknown>;
        assert.equal(patch.status, "staged");
        const proposal = patch.proposal as Record<string, unknown>;
        assert.equal(proposal.kind, "vendor_invoice");
        assert.equal(
            proposal.flagged_above_threshold,
            true,
            "$3,000 exceeds the $2,500 playbook threshold",
        );
    });

    await test("stageInvoiceRun: re-entry reuses this run's expense; TRUE duplicates triage", async () => {
        // Re-entry: the expense already exists for this run → no insert.
        const rec = makeStageDeps();
        let insertCalled = false;
        const outcome = await stageInvoiceRun(
            fakeDb,
            {
                run: makeRun({
                    status: "staging",
                    workflow_kind: "vendor_invoice",
                }),
                email: makeEmail({ from_address: "billing@samplerecords.test" }),
                extraction: invoiceExtraction,
                match,
                config,
            },
            {
                ...rec.deps,
                ensureCaseProjectFn: async () => "project-1",
                setDocumentProjectFn: async () => {},
                findExpenseByRunIdFn: async () =>
                    makeExpense({ agent_operation_id: "op-1" }),
                insertExpenseFn: (async () => {
                    insertCalled = true;
                    throw new Error("must not insert on re-entry");
                }) as never,
            },
        );
        assert.deepEqual(outcome, { staged: true });
        assert.equal(insertCalled, false);

        // A duplicate from a DIFFERENT run: unique violation → triage.
        const rec2 = makeStageDeps();
        const dup = await stageInvoiceRun(
            fakeDb,
            {
                run: makeRun({
                    status: "staging",
                    workflow_kind: "vendor_invoice",
                }),
                email: makeEmail({ from_address: "billing@samplerecords.test" }),
                extraction: invoiceExtraction,
                match,
                config,
            },
            {
                ...rec2.deps,
                ensureCaseProjectFn: async () => "project-1",
                setDocumentProjectFn: async () => {},
                findExpenseByRunIdFn: async () => null,
                insertExpenseFn: (async () => {
                    throw Object.assign(new Error("duplicate key value"), {
                        code: "23505",
                    });
                }) as never,
            },
        );
        assert.deepEqual(dup, { triage: "duplicate invoice" });
    });

    await test("stageClaimRun: an idempotency-hit op aimed at a PREVIOUS case is retargeted", async () => {
        // Re-stage after a reassign: createAgentOperation's idempotency key
        // returns the EXISTING op, whose staged arguments still carry the
        // old case — the generic operations surface must never execute it.
        const opPatches: [string, Record<string, unknown>][] = [];
        const rec = makeStageDeps({
            createAgentOperationFn: (async () => ({
                id: "op-existing",
                arguments: {
                    run_id: "run-1",
                    case_id: "case-old",
                    policy_upserts: [{ carrier: "Example Mutual" }],
                },
            })) as never,
            updateAgentOperationFn: (async (
                _db: never,
                id: string,
                patch: Record<string, unknown>,
            ) => {
                opPatches.push([id, patch]);
                return null;
            }) as never,
        });
        const outcome = await stageClaimRun(
            fakeDb,
            {
                run: makeRun({ status: "staging", ack_email_id: "ack-1" }),
                email: makeEmail({}),
                extraction: claimExtraction,
                match, // caseId: "case-1"
                config,
            },
            rec.deps,
        );
        assert.deepEqual(outcome, { staged: true });
        assert.equal(opPatches.length, 1);
        const [id, patch] = opPatches[0];
        assert.equal(id, "op-existing");
        const args = patch.arguments as Record<string, unknown>;
        assert.equal(args.case_id, "case-1", "arguments retargeted to the run's current case");
        assert.equal(args.run_id, "run-1", "other arguments are merged, not dropped");
    });

    await test("stageInvoiceRun: a reused expense and op staged against a previous case are retargeted", async () => {
        const opPatches: [string, Record<string, unknown>][] = [];
        const expensePatches: [string, Record<string, unknown>][] = [];
        const rec = makeStageDeps({
            createAgentOperationFn: (async () => ({
                id: "op-existing",
                arguments: {
                    run_id: "run-1",
                    case_id: "case-old",
                    expense_id: "exp-1",
                },
            })) as never,
            updateAgentOperationFn: (async (
                _db: never,
                id: string,
                patch: Record<string, unknown>,
            ) => {
                opPatches.push([id, patch]);
                return null;
            }) as never,
        });
        const outcome = await stageInvoiceRun(
            fakeDb,
            {
                run: makeRun({
                    status: "staging",
                    workflow_kind: "vendor_invoice",
                }),
                email: makeEmail({ from_address: "billing@samplerecords.test" }),
                extraction: invoiceExtraction,
                match, // caseId: "case-1"
                config,
            },
            {
                ...rec.deps,
                ensureCaseProjectFn: async () => "project-1",
                setDocumentProjectFn: async () => {},
                findExpenseByRunIdFn: async () =>
                    makeExpense({
                        case_id: "case-old",
                        agent_operation_id: "op-existing",
                    }),
                insertExpenseFn: (async () => {
                    throw new Error("must not insert — expense exists");
                }) as never,
                updateExpenseFn: (async (
                    _db: never,
                    _userId: string,
                    id: string,
                    patch: Record<string, unknown>,
                ) => {
                    expensePatches.push([id, patch]);
                    return makeExpense({ agent_operation_id: "op-existing" });
                }) as never,
            },
        );
        assert.deepEqual(outcome, { staged: true });
        assert.deepEqual(
            expensePatches,
            [["exp-1", { caseId: "case-1" }]],
            "the reused expense moves to the run's current case",
        );
        assert.equal(opPatches.length, 1);
        assert.equal(
            (opPatches[0][1].arguments as Record<string, unknown>).case_id,
            "case-1",
        );
    });

    await test("cancelPendingEmail (store): the cancel is status-guarded, a non-pending row is untouched", async () => {
        // Scripted chain: assert the UPDATE carries BOTH the id match and
        // the status=pending_approval condition — the WHERE clause is what
        // protects a SENT acknowledgement's record from being clobbered.
        const calls: { method: string; args: unknown[] }[] = [];
        const makeChain = (result: { data: unknown }) => {
            const chain: Record<string, unknown> = {};
            for (const m of ["update", "eq", "select"]) {
                chain[m] = (...args: unknown[]) => {
                    calls.push({ method: m, args });
                    return chain;
                };
            }
            chain.maybeSingle = async () => ({ ...result, error: null });
            return chain;
        };
        const sentRow = { data: null }; // WHERE matched nothing: not pending
        const db = { from: () => makeChain(sentRow) } as never;
        const result = await cancelPendingEmail(db, "ack-1");
        assert.equal(result, null, "a non-pending email is NOT cancelled");
        assert.deepEqual(
            calls.filter((c) => c.method === "update")[0].args[0],
            { status: "cancelled" },
        );
        assert.deepEqual(
            calls.filter((c) => c.method === "eq").map((c) => c.args),
            [
                ["id", "ack-1"],
                ["status", "pending_approval"],
            ],
            "the conditional WHERE (id + still-pending) is the guard",
        );
    });

    // ─── approveRun ────────────────────────────────────────────────────────

    interface ApproveRecorder {
        opUpdates: [string, Record<string, unknown>][];
        runPatches: Record<string, unknown>[];
        sends: string[];
        policyApplies: unknown[];
        expenseApprovals: string[];
        deps: ApproveDeps;
    }

    function makeApproveDeps(
        run: AutomationRun,
        overrides?: Partial<ApproveDeps>,
    ): ApproveRecorder {
        const rec: ApproveRecorder = {
            opUpdates: [],
            runPatches: [],
            sends: [],
            policyApplies: [],
            expenseApprovals: [],
            deps: {},
        };
        rec.deps = {
            getRunFn: async () => run,
            claimRunStepFn: (async () => true) as never,
            updateRunFn: (async (
                _db: never,
                _id: string,
                patch: Record<string, unknown>,
            ) => {
                rec.runPatches.push(patch);
                return null;
            }) as never,
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "update_case_insurance",
                    status: "pending_approval",
                },
                {
                    id: "op-2",
                    tool_name: "auto_ack_email",
                    status: "pending_approval",
                },
            ],
            updateAgentOperationFn: (async (
                _db: never,
                id: string,
                patch: Record<string, unknown>,
            ) => {
                rec.opUpdates.push([id, patch]);
                return null;
            }) as never,
            applyPolicyUpsertsFn: (async (
                _db: never,
                _caseId: string,
                upserts: unknown,
            ) => {
                rec.policyApplies.push(upserts);
                return Array.isArray(upserts) ? upserts.length : 0;
            }) as never,
            applyExpenseApprovalFn: (async (
                _db: never,
                _userId: string,
                expenseId: string,
            ) => {
                rec.expenseApprovals.push(expenseId);
            }) as never,
            sendEmailNowFn: (async (_db: never, emailId: string) => {
                rec.sends.push(emailId);
                return {} as never;
            }) as never,
            draftsOnlyFn: () => true,
            ...overrides,
        };
        return rec;
    }

    const stagedClaimRun = makeRun({
        status: "staged",
        ack_email_id: "ack-1",
        operation_ids: ["op-1", "op-2"],
        proposal: {
            kind: "claim_correspondence",
            policy_upserts: [{ carrier: "Example Mutual", claim_number: "24-1" }],
            needs_case_confirm: false,
        },
    });

    await test("approveRun: drafts-only (default) applies case writes but leaves the ack pending", async () => {
        const rec = makeApproveDeps(stagedClaimRun);
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.equal(rec.policyApplies.length, 1, "policies were upserted");
        assert.deepEqual(rec.sends, [], "sendEmailNow is NEVER reached");
        // Only the case-write op is reconciled; the ack op stays pending
        // with its draft.
        assert.deepEqual(
            rec.opUpdates.map(([id]) => id),
            ["op-1"],
        );
        assert.equal(rec.opUpdates[0][1].status, "succeeded");
        const reviewed = rec.runPatches.find((p) => p.reviewedBy);
        assert.equal(reviewed?.reviewedBy, "user-1");
    });

    await test("approveRun: with drafts-only disarmed the ack email is sent", async () => {
        const rec = makeApproveDeps(stagedClaimRun, {
            draftsOnlyFn: () => false,
        });
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: true });
        assert.deepEqual(rec.sends, ["ack-1"]);
    });

    await test("approveRun: mutex loser gets a 409 and nothing executes", async () => {
        const rec = makeApproveDeps(stagedClaimRun, {
            claimRunStepFn: (async () => false) as never,
        });
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.deepEqual(
            { ok: result.ok, status: result.ok ? null : result.status },
            { ok: false, status: 409 },
        );
        assert.equal(rec.policyApplies.length, 0);
        assert.deepEqual(rec.sends, []);
    });

    await test("approveRun: needs_case_confirm blocks approval unless confirmed", async () => {
        const needsConfirm = makeRun({
            ...stagedClaimRun,
            proposal: { ...stagedClaimRun.proposal, needs_case_confirm: true },
        });
        const rec = makeApproveDeps(needsConfirm);
        const blocked = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.equal(blocked.ok, false);
        if (!blocked.ok) {
            assert.equal(blocked.status, 409);
            assert.match(blocked.detail, /confirmation/);
        }
        const confirmed = await approveRun(
            fakeDb,
            {
                runId: "run-1",
                userId: "user-1",
                edits: { confirmCase: true },
            },
            rec.deps,
        );
        assert.deepEqual(confirmed, { ok: true, sent: false });
    });

    await test("approveRun: wrong owner → 403; non-staged → 409", async () => {
        const rec = makeApproveDeps(stagedClaimRun);
        const wrongUser = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "someone-else" },
            rec.deps,
        );
        assert.equal(wrongUser.ok, false);
        if (!wrongUser.ok) assert.equal(wrongUser.status, 403);

        const triaged = makeApproveDeps(makeRun({ status: "triage" }));
        const notStaged = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            triaged.deps,
        );
        assert.equal(notStaged.ok, false);
        if (!notStaged.ok) assert.equal(notStaged.status, 409);
    });

    await test("approveRun: an execution failure puts the run back to staged with the error", async () => {
        const rec = makeApproveDeps(stagedClaimRun, {
            applyPolicyUpsertsFn: (async () => {
                throw new Error("policy table unavailable");
            }) as never,
        });
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.status, 500);
        const revert = rec.runPatches.find((p) => p.status === "staged");
        assert.ok(revert, "the run is reverted to staged for a retry");
        assert.match(String(revert?.error ?? ""), /policy table unavailable/);
        assert.deepEqual(rec.sends, [], "no ack send after a failed execution");
    });

    await test("approveRun: invoice runs approve the staged expense (with amount edit)", async () => {
        const invoiceRun = makeRun({
            status: "staged",
            workflow_kind: "vendor_invoice",
            ack_email_id: null,
            operation_ids: ["op-1"],
            proposal: {
                kind: "vendor_invoice",
                expense_id: "exp-1",
                amount_cents: 300_000,
            },
        });
        const rec = makeApproveDeps(invoiceRun, {
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "record_case_expense",
                    status: "pending_approval",
                },
            ],
        });
        const result = await approveRun(
            fakeDb,
            {
                runId: "run-1",
                userId: "user-1",
                edits: { amountCents: 250_000 },
            },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.deepEqual(rec.expenseApprovals, ["exp-1"]);
        const edited = rec.runPatches.find((p) => p.proposal);
        assert.equal(
            (edited?.proposal as Record<string, unknown>)?.amount_cents,
            250_000,
            "the operator's amount edit is persisted into the proposal",
        );
    });

    await test("approveRun: an edited amount is written back to the operation's audit record", async () => {
        const invoiceRun = makeRun({
            status: "staged",
            workflow_kind: "vendor_invoice",
            ack_email_id: null,
            operation_ids: ["op-1"],
            proposal: {
                kind: "vendor_invoice",
                expense_id: "exp-1",
                amount_cents: 300_000,
            },
        });
        const rec = makeApproveDeps(invoiceRun, {
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "record_case_expense",
                    status: "pending_approval",
                    arguments: {
                        run_id: "run-1",
                        case_id: "case-1",
                        expense_id: "exp-1",
                    },
                },
            ],
        });
        const result = await approveRun(
            fakeDb,
            {
                runId: "run-1",
                userId: "user-1",
                edits: { amountCents: 250_000 },
            },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        const [id, patch] = rec.opUpdates[0];
        assert.equal(id, "op-1");
        assert.equal(patch.status, "succeeded");
        assert.deepEqual(
            patch.arguments,
            {
                run_id: "run-1",
                case_id: "case-1",
                expense_id: "exp-1",
                amount_cents: 250_000,
            },
            "the audit record carries the amount that ACTUALLY applied",
        );
    });

    await test("approveRun: edited policy upserts are written back to the operation's audit record", async () => {
        const rec = makeApproveDeps(stagedClaimRun, {
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "update_case_insurance",
                    status: "pending_approval",
                    arguments: {
                        run_id: "run-1",
                        case_id: "case-1",
                        policy_upserts: [
                            { carrier: "Example Mutual", claim_number: "24-1" },
                        ],
                    },
                },
            ],
        });
        const result = await approveRun(
            fakeDb,
            {
                runId: "run-1",
                userId: "user-1",
                edits: { policyUpserts: [{ claim_number: "24-1-FIXED" }] },
            },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        const [, patch] = rec.opUpdates[0];
        assert.deepEqual(
            (patch.arguments as Record<string, unknown>)?.policy_upserts,
            [{ carrier: "Example Mutual", claim_number: "24-1-FIXED" }],
            "the audit record carries the EDITED upserts that applied",
        );
        assert.equal(
            (patch.arguments as Record<string, unknown>)?.case_id,
            "case-1",
            "untouched staged arguments are preserved, not dropped",
        );
    });

    await test("approveRun: an un-edited approval leaves the operation's arguments alone", async () => {
        const rec = makeApproveDeps(stagedClaimRun);
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.ok(
            !("arguments" in rec.opUpdates[0][1]),
            "no edits → the staged arguments are not rewritten",
        );
    });

    await test("invalidAmountCentsEdit: absent/valid pass, junk gets the 400 detail", () => {
        assert.equal(invalidAmountCentsEdit(undefined), null, "absent → no edit");
        assert.equal(invalidAmountCentsEdit(25_000), null);
        assert.equal(invalidAmountCentsEdit(1), null);
        for (const bad of [
            0,
            -1,
            -250_000,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            "25000",
            null,
            true,
            {},
        ]) {
            const detail = invalidAmountCentsEdit(bad);
            assert.ok(
                detail && /positive integer/.test(detail),
                `${String(bad)} must be refused with the 400 detail`,
            );
        }
    });

    await test("approveRun: executes from the FRESH post-claim snapshot, not the pre-check read", async () => {
        // A reassign lands between approveRun's initial read and its
        // staged→approved claim: case_id and the staged proposal changed.
        // Execution must use the re-fetched snapshot, or the writes land on
        // the OLD case.
        const stale = makeRun({
            ...stagedClaimRun,
            case_id: "case-1",
            proposal: {
                kind: "claim_correspondence",
                policy_upserts: [{ carrier: "Example Mutual", claim_number: "OLD" }],
                needs_case_confirm: false,
            },
        });
        const freshAfterReassign = makeRun({
            ...stagedClaimRun,
            case_id: "case-2",
            proposal: {
                kind: "claim_correspondence",
                policy_upserts: [{ carrier: "Example Mutual", claim_number: "NEW" }],
                needs_case_confirm: false,
            },
        });
        let reads = 0;
        const applied: [string, unknown][] = [];
        const rec = makeApproveDeps(stale, {
            getRunFn: async () => {
                reads += 1;
                return reads === 1 ? stale : freshAfterReassign;
            },
            applyPolicyUpsertsFn: (async (
                _db: never,
                caseId: string,
                upserts: unknown,
            ) => {
                applied.push([caseId, upserts]);
                return 1;
            }) as never,
        });
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.equal(applied.length, 1);
        assert.equal(applied[0][0], "case-2", "writes target the FRESH case");
        assert.deepEqual(
            applied[0][1],
            [{ carrier: "Example Mutual", claim_number: "NEW" }],
            "the FRESH proposal is what executes",
        );
    });

    await test("approveRun: a needs_case_confirm that appeared post-claim reverts and 409s", async () => {
        const stale = makeRun({
            ...stagedClaimRun,
            proposal: { ...stagedClaimRun.proposal, needs_case_confirm: false },
        });
        const fresh = makeRun({
            ...stagedClaimRun,
            proposal: { ...stagedClaimRun.proposal, needs_case_confirm: true },
        });
        let reads = 0;
        const rec = makeApproveDeps(stale, {
            getRunFn: async () => {
                reads += 1;
                return reads === 1 ? stale : fresh;
            },
        });
        const result = await approveRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.status, 409);
            assert.match(result.detail, /confirmation/);
        }
        assert.equal(rec.policyApplies.length, 0, "nothing executed");
        assert.ok(
            rec.runPatches.some((p) => p.status === "staged"),
            "the claimed run is reverted to staged",
        );
    });

    await test("applyProposalEdits: shallow-merges policy upserts by index and the amount", () => {
        const proposal = {
            policy_upserts: [
                { carrier: "Example Mutual", claim_number: "24-1" },
                { carrier: "Sample Casualty", claim_number: "24-2" },
            ],
            amount_cents: 1,
        };
        const edited = applyProposalEdits(proposal, {
            policyUpserts: [{ claim_number: "24-1-FIXED" }],
            amountCents: 42,
        });
        assert.deepEqual(edited.policy_upserts, [
            { carrier: "Example Mutual", claim_number: "24-1-FIXED" },
            { carrier: "Sample Casualty", claim_number: "24-2" },
        ]);
        assert.equal(edited.amount_cents, 42);
        assert.equal(
            (proposal.policy_upserts[0] as { claim_number: string })
                .claim_number,
            "24-1",
            "the original proposal object is not mutated",
        );
    });

    // ─── rejectRun ─────────────────────────────────────────────────────────

    await test("rejectRun: cancels pending ops + the still-pending ack draft, records the reason", async () => {
        const cancelled: string[] = [];
        const rec = makeApproveDeps(stagedClaimRun, {
            cancelPendingEmailFn: (async (_db: never, id: string) => {
                cancelled.push(id);
                return { id } as never; // the draft WAS still pending
            }) as never,
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "update_case_insurance",
                    status: "pending_approval",
                },
                {
                    id: "op-2",
                    tool_name: "auto_ack_email",
                    status: "succeeded",
                },
            ],
        });
        const result = await rejectRun(
            fakeDb,
            { runId: "run-1", userId: "user-1", reason: "wrong case entirely" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.deepEqual(cancelled, ["ack-1"], "the pending draft is cancelled");
        assert.deepEqual(
            rec.opUpdates.map(([id, patch]) => [id, patch.status]),
            [["op-1", "cancelled"]],
            "only PENDING operations are cancelled",
        );
        const patch = rec.runPatches.find((p) => p.reviewedBy);
        assert.equal(patch?.triageReason, "wrong case entirely");
    });

    await test("rejectRun: an ack the operator already SENT is left untouched", async () => {
        // Drafts-only flow: operator sends the ack from the email surface
        // (run stays staged), then rejects the run. The sent email's record
        // must never be mutated — the status-guarded cancel returns null
        // and reject proceeds without touching it.
        let cancelAttempted = false;
        const rec = makeApproveDeps(stagedClaimRun, {
            cancelPendingEmailFn: (async () => {
                cancelAttempted = true;
                return null; // WHERE matched nothing: the email is not pending
            }) as never,
            loadOperationsFn: async () => [],
        });
        const realConsoleLog = console.log;
        const logs: string[] = [];
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(" "));
        };
        let result: Awaited<ReturnType<typeof rejectRun>>;
        try {
            result = await rejectRun(
                fakeDb,
                { runId: "run-1", userId: "user-1" },
                rec.deps,
            );
        } finally {
            console.log = realConsoleLog;
        }
        assert.deepEqual(result, { ok: true, sent: false });
        assert.equal(cancelAttempted, true, "the guarded cancel was attempted");
        assert.ok(
            logs.some((line) => /no longer pending/.test(line)),
            "the skip is logged, not silent",
        );
    });

    await test("rejectRun: allowed from triage, refused from other statuses", async () => {
        const triageRun = makeRun({ status: "triage", operation_ids: [] });
        const rec = makeApproveDeps(triageRun, {
            loadOperationsFn: async () => [],
        });
        const fromTriage = await rejectRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            rec.deps,
        );
        assert.deepEqual(fromTriage, { ok: true, sent: false });

        const approvedRun = makeApproveDeps(makeRun({ status: "approved" }));
        const refused = await rejectRun(
            fakeDb,
            { runId: "run-1", userId: "user-1" },
            approvedRun.deps,
        );
        assert.equal(refused.ok, false);
        if (!refused.ok) assert.equal(refused.status, 409);
    });

    // ─── reassignRun (staged path) ─────────────────────────────────────────

    /** Scripted db for reassignRun's staged-op arguments read. */
    function opArgumentsDb(args: Record<string, unknown>) {
        return {
            from: () => ({
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => ({ data: { arguments: args } }),
                    }),
                }),
            }),
        } as never;
    }

    await test("reassignRun: staged run retargets case, expense, and op arguments in place", async () => {
        const opArgsDb = opArgumentsDb({
            run_id: "run-1",
            case_id: "case-1",
            expense_id: "exp-1",
        });
        const invoiceRun = makeRun({
            status: "staged",
            workflow_kind: "vendor_invoice",
            operation_ids: ["op-1"],
            proposal: { kind: "vendor_invoice", needs_case_confirm: true },
        });
        const expensePatches: [string, Record<string, unknown>][] = [];
        const filed: [string, string][] = [];
        const rec = makeApproveDeps(invoiceRun, {
            getCaseFn: async (_db, _userId, id) =>
                id === "case-2" ? { ...piCase, id: "case-2" } : null,
            findExpenseByRunIdFn: async () => makeExpense({}),
            updateExpenseFn: (async (
                _db: never,
                _userId: string,
                id: string,
                patch: Record<string, unknown>,
            ) => {
                expensePatches.push([id, patch]);
                return makeExpense({});
            }) as never,
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "record_case_expense",
                    status: "pending_approval",
                },
            ],
            ensureCaseProjectFn: async () => "project-2",
            setDocumentProjectFn: (async (
                _db: never,
                documentId: string,
                projectId: string,
            ) => {
                filed.push([documentId, projectId]);
            }) as never,
        });
        const result = await reassignRun(
            opArgsDb,
            { runId: "run-1", userId: "user-1", caseId: "case-2" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.deepEqual(expensePatches, [["exp-1", { caseId: "case-2" }]]);
        const opUpdate = rec.opUpdates.find(([id]) => id === "op-1");
        assert.equal(
            (opUpdate?.[1].arguments as Record<string, unknown>)?.case_id,
            "case-2",
            "the pending operation is retargeted",
        );
        const patch = rec.runPatches.find((p) => p.caseId);
        assert.equal(patch?.caseId, "case-2");
        assert.equal(patch?.matchMethod, "manual");
        const proposal = patch?.proposal as Record<string, unknown>;
        assert.equal(
            proposal?.needs_case_confirm,
            false,
            "manual assignment IS the confirmation",
        );
        assert.equal(
            proposal?.project_id,
            "project-2",
            "the proposal now names the NEW case's project",
        );
        assert.deepEqual(
            filed,
            [],
            "no document_id staged → nothing to re-file",
        );
    });

    await test("reassignRun: staged invoice reassign re-files the invoice PDF into the new case's project", async () => {
        const opArgsDb = opArgumentsDb({
            run_id: "run-1",
            case_id: "case-1",
            expense_id: "exp-1",
        });
        const invoiceRun = makeRun({
            status: "staged",
            workflow_kind: "vendor_invoice",
            operation_ids: ["op-1"],
            proposal: {
                kind: "vendor_invoice",
                expense_id: "exp-1",
                document_id: "doc-1",
                project_id: "project-old",
                needs_case_confirm: false,
            },
        });
        const ensured: unknown[] = [];
        const filed: [string, string][] = [];
        const rec = makeApproveDeps(invoiceRun, {
            getCaseFn: async (_db, _userId, id) =>
                id === "case-2" ? { ...piCase, id: "case-2" } : null,
            findExpenseByRunIdFn: async () => makeExpense({}),
            updateExpenseFn: (async () => makeExpense({})) as never,
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "record_case_expense",
                    status: "pending_approval",
                },
            ],
            ensureCaseProjectFn: (async (_db: never, c: unknown) => {
                ensured.push(c);
                return "project-2";
            }) as never,
            setDocumentProjectFn: (async (
                _db: never,
                documentId: string,
                projectId: string,
            ) => {
                filed.push([documentId, projectId]);
            }) as never,
        });
        const result = await reassignRun(
            opArgsDb,
            { runId: "run-1", userId: "user-1", caseId: "case-2" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.equal(
            (ensured[0] as { id?: string })?.id,
            "case-2",
            "the NEW case's project is ensured (stageInvoiceRun's mirror)",
        );
        assert.deepEqual(
            filed,
            [["doc-1", "project-2"]],
            "the invoice PDF is re-filed into the new case's project",
        );
        const patch = rec.runPatches.find((p) => p.caseId);
        assert.equal(
            (patch?.proposal as Record<string, unknown>)?.project_id,
            "project-2",
        );
    });

    // ─── reassignRun (staged claim path: ack refresh) ──────────────────────

    const claimExtractedJson = {
        claims: [
            { claim_number: field("24-1"), carrier: field("Example Mutual") },
        ],
        summary: "ack",
    };

    function makeStagedClaimRunWithAck() {
        return makeRun({
            status: "staged",
            workflow_kind: "claim_correspondence",
            ack_email_id: "ack-1",
            operation_ids: ["op-1", "op-2"],
            extracted: claimExtractedJson as never,
            proposal: {
                kind: "claim_correspondence",
                policy_upserts: [
                    { carrier: "Example Mutual", claim_number: "24-1" },
                ],
                needs_case_confirm: false,
            },
        });
    }

    await test("reassignRun: a claim run's pending ack draft is cancelled and re-staged against the new case", async () => {
        const opArgsDb = opArgumentsDb({
            run_id: "run-1",
            case_id: "case-1",
            policy_upserts: [{ carrier: "Example Mutual" }],
        });
        const run = makeStagedClaimRunWithAck();
        const cancelled: string[] = [];
        const ackCalls: Record<string, unknown>[] = [];
        const rec = makeApproveDeps(run, {
            getCaseFn: async (_db, _userId, id) =>
                id === "case-2"
                    ? { ...piCase, id: "case-2", client_name: "New Client" }
                    : null,
            findExpenseByRunIdFn: async () => null,
            cancelPendingEmailFn: (async (_db: never, id: string) => {
                cancelled.push(id);
                // The draft WAS still pending — its cancelled row comes back.
                return makeEmail({
                    id,
                    status: "cancelled",
                    agent_operation_id: "op-2",
                });
            }) as never,
            getEmailFn: (async (_db: never, id: string) =>
                id === "email-1" ? makeEmail({}) : null) as never,
            loadPlaybookConfigFn: (async () => ({
                ok: true,
                config,
            })) as never,
            stageAckDraftFn: (async (
                _db: never,
                input: Record<string, unknown>,
            ) => {
                ackCalls.push(input);
                return { ackEmailId: "ack-2", ackOpId: "op-9", noAckReason: null };
            }) as never,
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "update_case_insurance",
                    status: "pending_approval",
                },
            ],
        });
        const result = await reassignRun(
            opArgsDb,
            { runId: "run-1", userId: "user-1", caseId: "case-2" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.deepEqual(cancelled, ["ack-1"], "the pending draft is cancelled");

        // The superseded ack OPERATION is cancelled alongside its draft.
        const supersededOp = rec.opUpdates.find(([id]) => id === "op-2");
        assert.ok(supersededOp, "the old ack operation is reconciled");
        assert.equal(supersededOp?.[1].status, "cancelled");
        assert.deepEqual(supersededOp?.[1].metadata, {
            superseded_by_reassign: true,
        });

        // The new draft is rendered against the NEW case via the SAME
        // deterministic stage helper, keyed per superseded draft.
        assert.equal(ackCalls.length, 1);
        const ackInput = ackCalls[0] as {
            caseId: string;
            idempotencyKey: string;
            email: { id: string };
            extraction: { claims: { claim_number: { value: string } }[] };
        };
        assert.equal(ackInput.caseId, "case-2");
        assert.equal(
            ackInput.idempotencyKey,
            "automation:run-1:ack:reassign:ack-1",
        );
        assert.equal(ackInput.email.id, "email-1", "re-rendered from the inbound");
        assert.equal(ackInput.extraction.claims[0].claim_number.value, "24-1");

        const patch = rec.runPatches.find((p) => p.caseId);
        assert.equal(patch?.ackEmailId, "ack-2", "run.ack_email_id moves to the new draft");
        assert.deepEqual(
            patch?.operationIds,
            ["op-1", "op-2", "op-9"],
            "the new ack operation joins operation_ids",
        );
        const proposal = patch?.proposal as Record<string, unknown>;
        assert.equal(proposal.needs_case_confirm, false);
        assert.ok(
            !("ack_stale_after_reassign" in proposal),
            "a refreshed draft is not stale",
        );
    });

    await test("reassignRun: an ack the operator already SENT is never re-drafted — staleness is recorded", async () => {
        const opArgsDb = opArgumentsDb({
            run_id: "run-1",
            case_id: "case-1",
            policy_upserts: [{ carrier: "Example Mutual" }],
        });
        const run = makeStagedClaimRunWithAck();
        let ackStaged = 0;
        const rec = makeApproveDeps(run, {
            getCaseFn: async (_db, _userId, id) =>
                id === "case-2" ? { ...piCase, id: "case-2" } : null,
            findExpenseByRunIdFn: async () => null,
            cancelPendingEmailFn: (async () => null) as never, // not pending
            getEmailFn: (async (_db: never, id: string) =>
                id === "ack-1"
                    ? makeEmail({ id: "ack-1", status: "sent" })
                    : makeEmail({})) as never,
            stageAckDraftFn: (async () => {
                ackStaged += 1;
                return { ackEmailId: "ack-2", ackOpId: "op-9", noAckReason: null };
            }) as never,
            loadOperationsFn: async () => [
                {
                    id: "op-1",
                    tool_name: "update_case_insurance",
                    status: "pending_approval",
                },
            ],
        });
        const result = await reassignRun(
            opArgsDb,
            { runId: "run-1", userId: "user-1", caseId: "case-2" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.equal(ackStaged, 0, "NO second draft is created");
        const patch = rec.runPatches.find((p) => p.caseId);
        assert.ok(
            !("ackEmailId" in (patch ?? {})),
            "the sent ack keeps its record on the run",
        );
        assert.equal(
            (patch?.proposal as Record<string, unknown>)
                ?.ack_stale_after_reassign,
            true,
            "the staleness is flagged for the reviewer",
        );
        assert.ok(
            !rec.opUpdates.some(([id]) => id === "op-2"),
            "the dispatched ack's operation is left untouched",
        );
    });

    await test("reassignRun: a crash-cancelled ack draft is recreated on retry (convergence)", async () => {
        // A prior reassign cancelled the draft, then crashed before the
        // updateRun persisting the replacement — the retry's cancel returns
        // null, but the draft's status is `cancelled`, not sent: recreate.
        const opArgsDb = opArgumentsDb({
            run_id: "run-1",
            case_id: "case-1",
            policy_upserts: [{ carrier: "Example Mutual" }],
        });
        const run = makeStagedClaimRunWithAck();
        const ackCalls: Record<string, unknown>[] = [];
        const rec = makeApproveDeps(run, {
            getCaseFn: async (_db, _userId, id) =>
                id === "case-2" ? { ...piCase, id: "case-2" } : null,
            findExpenseByRunIdFn: async () => null,
            cancelPendingEmailFn: (async () => null) as never,
            getEmailFn: (async (_db: never, id: string) =>
                id === "ack-1"
                    ? makeEmail({
                          id: "ack-1",
                          status: "cancelled",
                          agent_operation_id: "op-2",
                      })
                    : makeEmail({})) as never,
            loadPlaybookConfigFn: (async () => ({
                ok: true,
                config,
            })) as never,
            stageAckDraftFn: (async (
                _db: never,
                input: Record<string, unknown>,
            ) => {
                ackCalls.push(input);
                return { ackEmailId: "ack-2", ackOpId: "op-9", noAckReason: null };
            }) as never,
            loadOperationsFn: async () => [],
        });
        const result = await reassignRun(
            opArgsDb,
            { runId: "run-1", userId: "user-1", caseId: "case-2" },
            rec.deps,
        );
        assert.deepEqual(result, { ok: true, sent: false });
        assert.equal(ackCalls.length, 1, "the replacement draft IS created");
        assert.equal(
            (ackCalls[0] as { idempotencyKey: string }).idempotencyKey,
            "automation:run-1:ack:reassign:ack-1",
            "the retry converges on the same idempotency key",
        );
        const patch = rec.runPatches.find((p) => p.caseId);
        assert.equal(patch?.ackEmailId, "ack-2");
    });

    await test("reassignRun: unknown target case → 404; foreign run → 403", async () => {
        const rec = makeApproveDeps(stagedClaimRun, {
            getCaseFn: async () => null,
        });
        const missing = await reassignRun(
            fakeDb,
            { runId: "run-1", userId: "user-1", caseId: "nope" },
            rec.deps,
        );
        assert.equal(missing.ok, false);
        if (!missing.ok) assert.equal(missing.status, 404);

        const foreign = await reassignRun(
            fakeDb,
            { runId: "run-1", userId: "intruder", caseId: "case-2" },
            rec.deps,
        );
        assert.equal(foreign.ok, false);
        if (!foreign.ok) assert.equal(foreign.status, 403);
    });

    console.log("automation/stageApprove.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
