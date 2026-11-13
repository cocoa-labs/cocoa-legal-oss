// backend/scripts/rehearsePipeline.ts
//
// Guided rehearsal for the PI email-automation pipeline: drives the
// synthetic fixtures in fixtures/pi through the REAL production code paths
// against a dev environment with migrations 023/024 applied. For each
// fixture it
//
//   1. persists the fixture's PDF attachments as documents via
//      persistInboundAttachment (the exact function ingest uses),
//   2. inserts the inbound email via createInboundEmail (the exact store
//      path ingest uses),
//   3. enqueues an automation run via enqueueRun (calling the store
//      directly — deliberately NOT the AUTOMATION_ENABLED-gated
//      maybeEnqueueAutomation, so rehearsal works while automation stays
//      OFF), and
//   4. processes it with processRun — the same state machine the scheduler
//      drives — then prints a human-readable walk-through of what happened
//      and judges it against the fixture's expected outcome.
//
// HARD BOUNDARY: this script NEVER calls approve/reject/send. The pipeline
// stops at `staged`; every artifact it creates (case-write operation, ack
// email draft, pending expense) waits for a human in the /automation queue.
// Nothing is emailed, no case data is mutated, and no payment is prepared
// beyond the pending ledger row. approve.ts is not even imported here.
//
// Requires real env (fail-fast checks below): Supabase, R2 storage, an LLM
// key for the pipeline model, and GMAIL_AGENT_OWNER_USER_ID. No live Gmail
// is touched — fixture bytes come from disk where ingest would call the
// connector.
//
// Usage (from backend/):
//   npx tsx scripts/rehearsePipeline.ts --all
//   npx tsx scripts/rehearsePipeline.ts --fixture claim-email-1 [--fixture ...]

import "../src/lib/loadEnv";

import fs from "node:fs";

import { createServerSupabase } from "../src/lib/supabase";
import { storageEnabled } from "../src/lib/storage";
import { providerForModel } from "../src/lib/llm/models";
import { automationModel } from "../src/lib/automation/env";
import {
    persistInboundAttachment,
} from "../src/lib/email/ingest";
import {
    createInboundEmail,
    getEmail,
    type EmailAttachmentRef,
} from "../src/lib/email/store";
import {
    enqueueRun,
    getRun,
    isMissingAutomationSchema,
} from "../src/lib/automation/runsStore";
import { processRun } from "../src/lib/automation/pipeline";
import { loadPlaybookConfig } from "../src/lib/automation/playbookConfig";
import type { AutomationRun } from "../src/lib/automation/types";
import { getCase, upsertCaseFromImport } from "../src/lib/pi/store";
import {
    FIXTURE_EMAIL_NAMES,
    REHEARSAL_CASES,
    loadEmailFixture,
    type FixtureEmailName,
    type LoadedEmailFixture,
} from "../src/lib/automation/rehearsalFixtures";

type Db = ReturnType<typeof createServerSupabase>;

const USAGE = [
    "Usage (from backend/):",
    "  npx tsx scripts/rehearsePipeline.ts --all",
    "  npx tsx scripts/rehearsePipeline.ts --fixture <name> [--fixture <name> ...]",
    "",
    `Fixtures: ${FIXTURE_EMAIL_NAMES.join(", ")}`,
].join("\n");

const RULE = "=".repeat(72);
const THIN = "-".repeat(72);

function die(message: string): never {
    console.error(`\nrehearsePipeline: ${message}\n`);
    process.exit(2);
}

function parseArgs(argv: string[]): FixtureEmailName[] {
    const names: FixtureEmailName[] = [];
    let all = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--all") {
            all = true;
        } else if (arg === "--fixture") {
            const value = argv[++i];
            if (!value) die(`--fixture needs a name.\n\n${USAGE}`);
            if (!(FIXTURE_EMAIL_NAMES as readonly string[]).includes(value)) {
                die(`unknown fixture "${value}".\n\n${USAGE}`);
            }
            names.push(value as FixtureEmailName);
        } else {
            die(`unknown argument "${arg}".\n\n${USAGE}`);
        }
    }
    if (all) return [...FIXTURE_EMAIL_NAMES];
    if (names.length === 0) die(`nothing selected.\n\n${USAGE}`);
    return [...new Set(names)];
}

/**
 * Fail-fast environment checks with actionable messages. Everything the
 * pipeline needs is verified BEFORE any row is written.
 */
function checkEnv(): { ownerUserId: string } {
    const missing: string[] = [];
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
        missing.push(
            "SUPABASE_URL / SUPABASE_SECRET_KEY — the dev Supabase project (run from backend/ with backend/.env populated).",
        );
    }
    if (!storageEnabled) {
        missing.push(
            "R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY — attachment PDFs are persisted to document storage exactly like real ingest.",
        );
    }
    const ownerUserId = process.env.GMAIL_AGENT_OWNER_USER_ID?.trim() ?? "";
    if (!ownerUserId) {
        missing.push(
            "GMAIL_AGENT_OWNER_USER_ID — the workspace user id (Supabase auth UUID) that owns inbound automation rows; without it the rehearsal runs would not appear in that user's /automation queue.",
        );
    }
    const model = automationModel();
    let provider: string;
    try {
        provider = providerForModel(model);
    } catch {
        die(
            `AUTOMATION_MODEL is set to "${model}", which is not a known model id.`,
        );
    }
    const keyVar =
        provider === "claude"
            ? "ANTHROPIC_API_KEY"
            : provider === "gemini"
              ? "GEMINI_API_KEY"
              : provider === "openrouter"
                ? "OPENROUTER_API_KEY"
                : "OPENAI_API_KEY";
    if (!process.env[keyVar]) {
        missing.push(
            `${keyVar} — the pipeline model is "${model}" (${provider}); extraction/verification are real LLM calls.`,
        );
    }
    if (missing.length > 0) {
        die(
            "missing required environment:\n" +
                missing.map((m) => `  - ${m}`).join("\n"),
        );
    }
    return { ownerUserId };
}

/** Probe the 023 tables + 024 playbook seed before touching anything. */
async function checkSchema(db: Db, ownerUserId: string): Promise<void> {
    for (const table of ["automation_runs", "pi_cases"] as const) {
        const { error } = await db.from(table).select("id").limit(1);
        if (error) {
            if (isMissingAutomationSchema(error)) {
                die(
                    `the "${table}" table is missing — run `npm run migrate` (it applies 023_pi_cases_automation.sql) first.`,
                );
            }
            die(`cannot reach "${table}": ${error.message}`);
        }
    }
    const resolved = await loadPlaybookConfig(db, ownerUserId);
    if (!resolved.ok) {
        die(
            `playbook misconfigured: ${resolved.key} (${resolved.detail}) — apply backend/migrations/024_pi_playbook_seed.sql (and check any firm overrides for that key).`,
        );
    }
}

/** Seed the two synthetic rehearsal cases through the production CSV-import
 * upsert (idempotent on case_number — safe to re-run forever). */
async function seedCases(db: Db, ownerUserId: string): Promise<void> {
    console.log("Seeding rehearsal cases (idempotent):");
    for (const seed of REHEARSAL_CASES) {
        const result = await upsertCaseFromImport(db, ownerUserId, {
            caseNumber: seed.caseNumber,
            clientName: seed.clientName,
            dateOfLoss: seed.dateOfLoss,
            status: "open",
        });
        console.log(
            `  ${seed.caseNumber}  "${seed.clientName}"  (dol ${seed.dateOfLoss}) — ${result.action} (${result.id})`,
        );
    }
}

function truncate(text: string, max = 100): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function formatCents(cents: unknown): string {
    if (typeof cents !== "number" || !Number.isFinite(cents)) return "?";
    return `$${(cents / 100).toFixed(2)}`;
}

interface Citation {
    path?: unknown;
    value?: unknown;
    quote?: unknown;
    page?: unknown;
    source?: unknown;
}

function printExtractedFields(run: AutomationRun): void {
    const citations = (run.citations ?? []) as Citation[];
    if (citations.length === 0) {
        console.log("  (no extracted fields recorded)");
        return;
    }
    const verification = run.verification as {
        checks?: { path?: unknown; verified?: unknown }[];
    };
    const verdicts = new Map(
        (verification.checks ?? []).map((c) => [String(c.path), c.verified === true]),
    );
    for (const c of citations) {
        const where =
            c.source === "pdf" ? `pdf p.${c.page ?? "?"}` : "email body";
        const verdict = verdicts.get(String(c.path));
        const mark = verdict === undefined ? " " : verdict ? "✓" : "✗";
        console.log(`  ${mark} ${String(c.path)} = ${JSON.stringify(c.value)}  (${where})`);
        console.log(`      quote: "${truncate(String(c.quote ?? ""))}"`);
    }
}

async function printMatch(db: Db, run: AutomationRun): Promise<void> {
    if (!run.case_id) {
        console.log("  (no case matched)");
        return;
    }
    const piCase = await getCase(db, run.user_id, run.case_id);
    const label = piCase
        ? `"${piCase.client_name}" (${piCase.case_number ?? "no case number"}, ${piCase.status})`
        : "(case row not readable)";
    const confidence =
        run.match_confidence === null ? "n/a" : run.match_confidence.toFixed(2);
    const needsConfirm =
        (run.proposal as { needs_case_confirm?: unknown }).needs_case_confirm ===
        true;
    console.log(
        `  case ${run.case_id} ${label}\n  method ${run.match_method}, confidence ${confidence}, needs human case-confirm: ${needsConfirm ? "YES" : "no"}`,
    );
}

function printProposal(run: AutomationRun): void {
    const proposal = run.proposal ?? {};
    if (run.workflow_kind === "vendor_invoice") {
        const p = proposal as Record<string, unknown>;
        console.log(`  vendor:          ${String(p.vendor ?? "?")}`);
        console.log(`  invoice number:  ${String(p.invoice_number ?? "?")}`);
        console.log(
            `  amount:          ${formatCents(p.amount_cents)} ${String(p.currency ?? "")}`,
        );
        console.log(`  expense id:      ${String(p.expense_id ?? "?")} (pending_approval)`);
        console.log(
            `  payment portal:  ${p.payment_portal_url ? String(p.payment_portal_url) : "(not configured — set portal_url in pi.invoices.vendor_registry)"}`,
        );
        console.log(
            `  flagged > $${String(p.flag_threshold_usd ?? "?")}: ${p.flagged_above_threshold === true ? "YES" : "no"}`,
        );
        return;
    }
    const upserts = (proposal as { policy_upserts?: unknown }).policy_upserts;
    if (!Array.isArray(upserts) || upserts.length === 0) {
        console.log("  (no policy upserts staged)");
        return;
    }
    upserts.forEach((raw, i) => {
        const u = (raw ?? {}) as Record<string, unknown>;
        const adjuster = (u.adjuster ?? {}) as Record<string, unknown>;
        const limits = (u.policy_limits ?? {}) as Record<string, unknown>;
        console.log(
            `  policy_upserts[${i}]: carrier=${String(u.carrier ?? "?")} claim=${String(u.claim_number ?? "?")} policy=${String(u.policy_number ?? "—")}`,
        );
        console.log(
            `      coverage=${String(u.coverage_type ?? "—")} limits=${String(limits.raw_text ?? "—")} adjuster=${String(adjuster.name ?? "—")}`,
        );
    });
}

async function printAckDraft(db: Db, run: AutomationRun): Promise<void> {
    if (!run.ack_email_id) {
        console.log("  (no acknowledgement draft for this run)");
        return;
    }
    const draft = await getEmail(db, run.ack_email_id);
    if (!draft) {
        console.log(`  (draft ${run.ack_email_id} not readable)`);
        return;
    }
    console.log(
        `  status: ${draft.status} — NOT SENT (this script never approves or sends)`,
    );
    console.log(`  to:      ${draft.to_addresses.join(", ")}`);
    console.log(`  reply-to: ${draft.reply_to_address ?? "(none — pi.claims.reply_to is empty)"}`);
    console.log(`  subject: ${draft.subject}`);
    console.log(`  ${THIN}`);
    for (const line of draft.body_text.split("\n")) {
        console.log(`  | ${line}`);
    }
    console.log(`  ${THIN}`);
}

/** PASS/FAIL judgement against the fixture's expected outcome. */
function judge(
    fixture: LoadedEmailFixture,
    run: AutomationRun,
): { pass: boolean; problems: string[] } {
    const problems: string[] = [];
    const expected = fixture.expectation;
    if (run.status !== expected.status) {
        problems.push(
            `expected status "${expected.status}" but the run is "${run.status}"${run.triage_reason ? ` (triage: ${run.triage_reason})` : ""}${run.error ? ` (error: ${run.error})` : ""}`,
        );
    }
    if ((run.workflow_kind ?? null) !== expected.kind) {
        problems.push(
            `expected classification ${expected.kind ?? "(none — skip)"} but got ${run.workflow_kind ?? "(none)"}`,
        );
    }
    if (expected.minClaims !== undefined) {
        const claims = (run.extracted as { claims?: unknown }).claims;
        const count = Array.isArray(claims) ? claims.length : 0;
        if (count < expected.minClaims) {
            problems.push(
                `expected at least ${expected.minClaims} extracted claims (multi-claim edge) but got ${count}`,
            );
        }
    }
    return { pass: problems.length === 0, problems };
}

async function rehearseOne(
    db: Db,
    ownerUserId: string,
    fixture: LoadedEmailFixture,
    stamp: string,
): Promise<boolean> {
    const { email, expectation } = fixture;
    console.log(`\n${RULE}`);
    console.log(`FIXTURE ${fixture.name} — ${expectation.exercises}`);
    console.log(RULE);

    // 1. Attachments → documents, via the exact ingest helper.
    const refs: EmailAttachmentRef[] = [];
    for (const att of email.attachments) {
        const filePath = fixture.attachmentPaths.get(att.attachmentId);
        if (!filePath) {
            throw new Error(`attachment path missing for ${att.attachmentId}`);
        }
        const bytes = fs.readFileSync(filePath);
        const ref = await persistInboundAttachment(
            ownerUserId,
            null,
            att.filename,
            bytes,
            att.contentType || "application/pdf",
        );
        if (!ref) {
            throw new Error(
                `persistInboundAttachment failed for ${att.filename} — check the documents table and R2 storage credentials`,
            );
        }
        refs.push(ref);
        console.log(`Persisted attachment ${att.filename} → document ${ref.document_id}`);
    }

    // 2. The inbound email, via the exact ingest store path. Provider ids
    // get a per-invocation stamp so repeated rehearsals create fresh rows
    // instead of tripping the provider_message_id / email_id dedupe.
    const created = await createInboundEmail(db, {
        userId: ownerUserId,
        projectId: null,
        chatId: null,
        fromAddress: email.from,
        to: email.to,
        cc: email.cc,
        subject: email.subject,
        bodyText: email.bodyText,
        bodyHtml: email.bodyHtml,
        attachments: refs,
        providerMessageId: `${email.id}-${stamp}`,
        providerThreadId: `${email.threadId}-${stamp}`,
        inReplyTo: email.inReplyTo,
        signatureEnvelopeId: null,
    });
    if (!created) {
        throw new Error(
            "createInboundEmail returned no row — is the email_messages table (migration 011) applied?",
        );
    }
    console.log(`Inserted inbound email ${created.id} (provider id ${email.id}-${stamp})`);

    // 3+4. Enqueue + process through the real pipeline.
    const { id: runId } = await enqueueRun(db, {
        emailId: created.id,
        userId: created.user_id,
    });
    console.log(`Enqueued automation run ${runId}`);
    const { outcome } = await processRun(db, runId);
    console.log(`processRun outcome: ${outcome}`);

    const run = await getRun(db, runId);
    if (!run) throw new Error(`run ${runId} disappeared after processing`);

    console.log(`\nRun walk-through`);
    console.log(`  status:        ${run.status}${run.triage_reason ? ` (triage: ${run.triage_reason})` : ""}`);
    console.log(`  workflow kind: ${run.workflow_kind ?? "(none — not PI mail)"}`);
    if (run.error) console.log(`  error:         ${run.error}`);
    if (run.confidence !== null) {
        console.log(`  extraction confidence: ${run.confidence.toFixed(2)}`);
    }

    if (run.status !== "skipped") {
        console.log(`\nExtracted fields (✓ = citation verified against its source)`);
        printExtractedFields(run);
        console.log(`\nCase match`);
        await printMatch(db, run);
        console.log(`\nStaged proposal (pending human approval)`);
        printProposal(run);
        console.log(`\nAcknowledgement draft`);
        await printAckDraft(db, run);
    }

    console.log(`\nWhere to look in the UI`);
    console.log(`  queue:  /automation  (run ${runId} under ${run.status === "staged" ? '"Ready for review"' : run.status === "triage" ? '"Needs attention"' : '"Done"'})`);
    console.log(`  run:    /automation/${runId}`);
    if (run.case_id) console.log(`  case:   /cases/${run.case_id}`);

    const verdict = judge(fixture, run);
    if (verdict.pass) {
        console.log(
            `\nPASS — ${fixture.name}: ${run.status}${run.workflow_kind ? ` ${run.workflow_kind}` : ""} as expected`,
        );
    } else {
        console.log(`\nFAIL — ${fixture.name}:`);
        for (const p of verdict.problems) console.log(`  - ${p}`);
    }
    return verdict.pass;
}

async function main(): Promise<void> {
    const selected = parseArgs(process.argv.slice(2));

    console.log(RULE);
    console.log("PI automation rehearsal — STAGING ONLY");
    console.log(
        "This script never calls approve, reject, or send. Every artifact it\ncreates waits for a human in the /automation queue; no email leaves the\nbuilding and no case data is mutated. AUTOMATION_ENABLED may stay false.",
    );
    console.log(RULE);

    const { ownerUserId } = checkEnv();
    // Fixture files are validated up front so a missing PDF fails before
    // any database write.
    const fixtures = selected.map((name) => loadEmailFixture(name));

    const db = createServerSupabase();
    await checkSchema(db, ownerUserId);
    console.log(`\nEnvironment OK — model ${automationModel()}, owner user ${ownerUserId}\n`);
    await seedCases(db, ownerUserId);

    // One stamp per invocation: repeated rehearsals mint fresh email rows.
    const stamp = Date.now().toString(36);
    const results: { name: FixtureEmailName; pass: boolean }[] = [];
    for (const fixture of fixtures) {
        try {
            const pass = await rehearseOne(db, ownerUserId, fixture, stamp);
            results.push({ name: fixture.name, pass });
        } catch (err) {
            console.error(
                `\nFAIL — ${fixture.name} crashed: ${err instanceof Error ? err.message : String(err)}`,
            );
            results.push({ name: fixture.name, pass: false });
        }
    }

    console.log(`\n${RULE}`);
    console.log("Rehearsal summary");
    for (const r of results) {
        console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    }
    const failed = results.filter((r) => !r.pass).length;
    console.log(
        failed === 0
            ? "\nAll fixtures behaved as expected. Review the staged runs in /automation,\nthen continue with docs/pi-automation.md § Shadow mode."
            : `\n${failed} fixture(s) did not behave as expected — fix before enabling automation.`,
    );
    console.log(
        "Reminder: nothing was sent or approved. Staged artifacts can be\nrejected from the queue UI if you want to clean up after the rehearsal.",
    );
    console.log(RULE);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});
