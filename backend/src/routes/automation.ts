// backend/src/routes/automation.ts
//
// HTTP layer for the automation queue (mounted at /automation): the run list
// and detail the phase-6 review UI reads, the human decisions (approve /
// reject / retry / reassign — all delegated to lib/automation/approve.ts and
// runsStore.ts; nothing here mutates case data directly), a status snapshot,
// and an authed force-poll. Distinct from the PUBLIC secret-gated
// /email-inbound/* endpoints, which are untouched.
//
// Migration tolerance: every route that can meaningfully run before the 023
// automation tables exist degrades — /status and /runs report zeros/empty
// with schema_ready:false, /poll still ingests, run-scoped routes 404 —
// never a 500 crash (mirroring the scheduler/ingest discipline).

import { Router } from "express";
import type { Request, Response } from "express";

import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    approveRun,
    invalidAmountCentsEdit,
    rejectRun,
    reassignRun,
    type ApproveEdits,
} from "../lib/automation/approve";
import {
    REQUEUEABLE_RUN_STATUSES,
    countRunsByStatus,
    getAutomationState,
    getRun,
    isMissingAutomationSchema,
    listRuns,
    requeueRun,
} from "../lib/automation/runsStore";
import {
    automationDraftsOnly,
    automationEnabled,
    automationPollIntervalMs,
} from "../lib/automation/env";
import { processDueRuns } from "../lib/automation/pipeline";
import { RUN_STATUSES, type AutomationRun, type RunStatus } from "../lib/automation/types";
import { GMAIL_HISTORY_CURSOR_KEY, ingestInbound } from "../lib/email/ingest";
import { getEmail } from "../lib/email/store";
import { getCase } from "../lib/pi/store";

const router = Router();
router.use(requireAuth);

/** Runs processed by one authed force-poll. */
const FORCE_POLL_RUN_LIMIT = 10;

function detailOf(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
}

function intParam(value: unknown): number | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isRunStatus(value: unknown): value is RunStatus {
    return (
        typeof value === "string" &&
        (RUN_STATUSES as readonly string[]).includes(value)
    );
}

/** The caller's run, or null for both "no such run" and "not your run" (a
 * uniform 404 — run ids must not leak across tenants). */
async function loadOwnRun(
    db: ReturnType<typeof createServerSupabase>,
    runId: string,
    userId: string,
): Promise<AutomationRun | null> {
    const run = await getRun(db, runId);
    if (!run || run.user_id !== userId) return null;
    return run;
}

// GET /automation/runs?status=&limit=&offset=
router.get("/runs", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const rawStatus = req.query.status;
        if (rawStatus !== undefined && !isRunStatus(rawStatus)) {
            return void res.status(400).json({
                detail: `Invalid status; expected one of ${RUN_STATUSES.join(", ")}`,
            });
        }
        const runs = await listRuns(db, userId, {
            status: rawStatus as RunStatus | undefined,
            limit: intParam(req.query.limit),
            offset: intParam(req.query.offset),
        });
        res.json({ runs });
    } catch (err) {
        if (isMissingAutomationSchema(err)) {
            return void res.json({ runs: [], schema_ready: false });
        }
        res.status(500).json({ detail: detailOf(err, "Failed to load runs") });
    }
});

// GET /automation/runs/:id — the run plus its acknowledgement draft and a
// compact email/case enrichment for the queue UI. Both enrichment lookups
// are tenancy-guarded on their own: the ack/inbound email must belong to the
// caller, and getCase is user-scoped by construction.
router.get("/runs/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        let run: AutomationRun | null = null;
        try {
            run = await loadOwnRun(db, req.params.id, userId);
        } catch (err) {
            if (!isMissingAutomationSchema(err)) throw err;
        }
        if (!run) return void res.status(404).json({ detail: "Run not found" });

        const ackEmailRaw = run.ack_email_id
            ? await getEmail(db, run.ack_email_id)
            : null;
        const ackEmail =
            ackEmailRaw && ackEmailRaw.user_id === userId ? ackEmailRaw : null;

        const inbound = run.email_id ? await getEmail(db, run.email_id) : null;
        const email =
            inbound && inbound.user_id === userId
                ? {
                      id: inbound.id,
                      from_address: inbound.from_address,
                      subject: inbound.subject,
                      received_at: inbound.received_at,
                  }
                : null;

        const piCase = run.case_id
            ? await getCase(db, userId, run.case_id)
            : null;

        res.json({
            run,
            ackEmail,
            email,
            case: piCase
                ? {
                      id: piCase.id,
                      client_name: piCase.client_name,
                      case_number: piCase.case_number,
                  }
                : null,
        });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to load run") });
    }
});

// POST /automation/runs/:id/approve — body { edits?, confirmCase? }.
router.post("/runs/:id/approve", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const rawEdits =
            body.edits &&
            typeof body.edits === "object" &&
            !Array.isArray(body.edits)
                ? (body.edits as Record<string, unknown>)
                : {};
        const edits: ApproveEdits = {};
        if (body.confirmCase === true || body.confirm_case === true) {
            edits.confirmCase = true;
        }
        const policyUpserts = rawEdits.policy_upserts ?? rawEdits.policyUpserts;
        if (Array.isArray(policyUpserts)) {
            edits.policyUpserts = policyUpserts.filter(
                (v): v is Record<string, unknown> =>
                    !!v && typeof v === "object" && !Array.isArray(v),
            );
        }
        // An amount edit flows into updateExpense on approval — refuse
        // anything but a positive integer number of cents at the door
        // (the applier re-checks defensively).
        const amountCents = rawEdits.amount_cents ?? rawEdits.amountCents;
        const invalidAmount = invalidAmountCentsEdit(amountCents);
        if (invalidAmount) {
            return void res.status(400).json({ detail: invalidAmount });
        }
        if (typeof amountCents === "number") {
            edits.amountCents = amountCents;
        }

        const result = await approveRun(db, {
            runId: req.params.id,
            userId,
            edits: Object.keys(edits).length > 0 ? edits : undefined,
        });
        if (!result.ok) {
            return void res
                .status(result.status)
                .json({ detail: result.detail });
        }
        const run = await getRun(db, req.params.id);
        res.json({ run, sent: result.sent });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to approve run") });
    }
});

// POST /automation/runs/:id/reject — body { reason? }.
router.post("/runs/:id/reject", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const reason =
            typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim()
                : undefined;
        const result = await rejectRun(db, {
            runId: req.params.id,
            userId,
            reason,
        });
        if (!result.ok) {
            return void res
                .status(result.status)
                .json({ detail: result.detail });
        }
        const run = await getRun(db, req.params.id);
        res.json({ run });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to reject run") });
    }
});

// POST /automation/runs/:id/retry — requeue a failed/triaged run. The
// requeue itself is a CAS-style conditional UPDATE (claimRunStep semantics),
// so a run that moved on concurrently yields a 409, never a clobber.
router.post("/runs/:id/retry", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        let run: AutomationRun | null = null;
        try {
            run = await loadOwnRun(db, req.params.id, userId);
        } catch (err) {
            if (!isMissingAutomationSchema(err)) throw err;
        }
        if (!run) return void res.status(404).json({ detail: "Run not found" });
        if (!REQUEUEABLE_RUN_STATUSES.includes(run.status)) {
            return void res.status(409).json({
                detail: `Run is ${run.status}; only ${REQUEUEABLE_RUN_STATUSES.join(" or ")} runs can be retried`,
            });
        }
        const requeued = await requeueRun(db, run.id);
        if (!requeued) {
            return void res
                .status(409)
                .json({ detail: "Run changed state — refresh and retry" });
        }
        res.json({ run: requeued });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to retry run") });
    }
});

// POST /automation/runs/:id/reassign — body { case_id }.
router.post("/runs/:id/reassign", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const caseId =
            typeof body.case_id === "string" && body.case_id.trim()
                ? body.case_id.trim()
                : "";
        if (!caseId) {
            return void res.status(400).json({ detail: "case_id is required" });
        }
        const result = await reassignRun(db, {
            runId: req.params.id,
            userId,
            caseId,
        });
        if (!result.ok) {
            return void res
                .status(result.status)
                .json({ detail: result.detail });
        }
        const run = await getRun(db, req.params.id);
        res.json({ run });
    } catch (err) {
        res.status(500).json({
            detail: detailOf(err, "Failed to reassign run"),
        });
    }
});

// GET /automation/status — env switches + queue counts. Pre-migration this
// reports zeros/false with schema_ready:false rather than 500-ing.
router.get("/status", async (_req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        let schemaReady = true;
        let cursorPresent = false;
        let counts = Object.fromEntries(
            RUN_STATUSES.map((status) => [status, 0]),
        ) as Record<RunStatus, number>;

        try {
            const cursor = await getAutomationState(
                db,
                GMAIL_HISTORY_CURSOR_KEY,
            );
            cursorPresent = typeof cursor === "string" && cursor.length > 0;
        } catch (err) {
            if (!isMissingAutomationSchema(err)) throw err;
            schemaReady = false;
        }
        if (schemaReady) {
            try {
                counts = await countRunsByStatus(db, userId);
            } catch (err) {
                if (!isMissingAutomationSchema(err)) throw err;
                schemaReady = false;
            }
        }

        res.json({
            enabled: automationEnabled(),
            draftsOnly: automationDraftsOnly(),
            pollIntervalMs: automationPollIntervalMs(),
            cursorPresent,
            counts,
            schema_ready: schemaReady,
        });
    } catch (err) {
        res.status(500).json({
            detail: detailOf(err, "Failed to load automation status"),
        });
    }
});

// POST /automation/poll — authed force-poll: cursor-mode ingest then one
// batch of due runs. (The public secret-gated /email-inbound/* endpoints are
// a separate surface.) Ingest is internally tolerant; a pre-migration runs
// table degrades to processed:0 + schema_ready:false.
router.post("/poll", async (_req: Request, res: Response) => {
    const db = createServerSupabase();
    try {
        const { ingested } = await ingestInbound({ useCursor: true });
        let processed = 0;
        let schemaReady = true;
        try {
            processed = (
                await processDueRuns(db, { limit: FORCE_POLL_RUN_LIMIT })
            ).processed;
        } catch (err) {
            if (!isMissingAutomationSchema(err)) throw err;
            schemaReady = false;
        }
        res.json(
            schemaReady
                ? { ingested, processed }
                : { ingested, processed, schema_ready: false },
        );
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to poll") });
    }
});

export { router as automationRouter };
