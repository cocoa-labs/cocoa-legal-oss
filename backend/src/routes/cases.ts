// backend/src/routes/cases.ts
//
// HTTP layer for the PI case system (mounted at /cases): list/create/detail/
// patch cases, the CasePeer CSV import (multipart; dry-run planning or
// sequential execution via lib/pi/csvImport.ts), and expense patching.
// Mirrors the route/auth pattern in routes/email.ts: requireAuth +
// res.locals.userId, createServerSupabase() per request, { detail } errors,
// with every read/write tenancy-scoped to the calling user. Routes stay
// thin — all business logic lives in lib/pi/*.

import { Router } from "express";
import type { Request, Response } from "express";

import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { singleFileUpload } from "../lib/upload";
import {
    PI_CASE_STATUSES,
    PI_EXPENSE_STATUSES,
    createCase,
    getCase,
    getExpense,
    listCases,
    listExpensesForCase,
    listPoliciesForCase,
    updateCase,
    updateExpense,
    type PiCasePatch,
    type PiCaseStatus,
    type PiExpenseStatus,
} from "../lib/pi/store";
import { ImportTooLargeError, runCsvImport } from "../lib/pi/csvImport";
import { toIsoDate } from "../lib/automation/match";
import { isMissingAutomationSchema, listRuns } from "../lib/automation/runsStore";
import type { AutomationRun } from "../lib/automation/types";

const router = Router();
router.use(requireAuth);

function detailOf(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
}

function intParam(value: unknown): number | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isCaseStatus(value: unknown): value is PiCaseStatus {
    return (
        typeof value === "string" &&
        (PI_CASE_STATUSES as readonly string[]).includes(value)
    );
}

function isExpenseStatus(value: unknown): value is PiExpenseStatus {
    return (
        typeof value === "string" &&
        (PI_EXPENSE_STATUSES as readonly string[]).includes(value)
    );
}

// GET /cases?status=&needs_review=&search=&limit=&offset=
router.get("/", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const rawStatus = req.query.status;
        if (rawStatus !== undefined && !isCaseStatus(rawStatus)) {
            return void res.status(400).json({
                detail: `Invalid status; expected one of ${PI_CASE_STATUSES.join(", ")}`,
            });
        }
        const needsReview =
            req.query.needs_review === "true"
                ? true
                : req.query.needs_review === "false"
                  ? false
                  : undefined;
        const cases = await listCases(db, userId, {
            status: rawStatus as PiCaseStatus | undefined,
            needsReview,
            search:
                typeof req.query.search === "string" && req.query.search.trim()
                    ? req.query.search.trim()
                    : undefined,
            limit: intParam(req.query.limit),
            offset: intParam(req.query.offset),
        });
        res.json({ cases });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to load cases") });
    }
});

// POST /cases — manual case creation.
router.post("/", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const clientName =
            typeof body.client_name === "string" ? body.client_name.trim() : "";
        if (!clientName) {
            return void res
                .status(400)
                .json({ detail: "client_name is required" });
        }
        if (body.status !== undefined && !isCaseStatus(body.status)) {
            return void res.status(400).json({
                detail: `Invalid status; expected one of ${PI_CASE_STATUSES.join(", ")}`,
            });
        }
        let dateOfLoss: string | null | undefined;
        if (typeof body.date_of_loss === "string" && body.date_of_loss.trim()) {
            dateOfLoss = toIsoDate(body.date_of_loss);
            if (!dateOfLoss) {
                return void res.status(400).json({
                    detail: 'Unparseable date_of_loss (expected MM/DD/YYYY or YYYY-MM-DD)',
                });
            }
        }
        const created = await createCase(db, {
            userId,
            clientName,
            caseNumber:
                typeof body.case_number === "string" && body.case_number.trim()
                    ? body.case_number.trim()
                    : null,
            dateOfLoss: dateOfLoss ?? null,
            status: body.status as PiCaseStatus | undefined,
            origin: "manual",
        });
        res.json({ case: created });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to create case") });
    }
});

// POST /cases/import — CasePeer CSV import (multipart field "file", body
// fields mapping = JSON string of field→header, dry_run = "true"/"false").
// The whole decision flow lives in lib/pi/csvImport.runCsvImport; this
// handler only validates the request envelope and maps outcomes to statuses:
// header/mapping-level failures → 400 on BOTH paths (nothing written), row
// cap → 413, dry run → the plan, execute → counts with plan-time AND
// execution-time row errors merged (a rejected row never silently vanishes).
// Registered before the /:id routes so "import" can never be captured as a
// case id.
router.post(
    "/import",
    singleFileUpload("file"),
    async (req: Request, res: Response) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const file = req.file;
            if (!file) {
                return void res.status(400).json({
                    detail: 'A CSV file is required (multipart field "file")',
                });
            }
            const rawMapping = (req.body ?? {}).mapping;
            if (typeof rawMapping !== "string" || !rawMapping.trim()) {
                return void res.status(400).json({
                    detail: 'A "mapping" body field (JSON of case field → CSV header) is required',
                });
            }
            let parsedMapping: unknown;
            try {
                parsedMapping = JSON.parse(rawMapping);
            } catch {
                return void res
                    .status(400)
                    .json({ detail: "mapping must be valid JSON" });
            }
            if (
                !parsedMapping ||
                typeof parsedMapping !== "object" ||
                Array.isArray(parsedMapping) ||
                !Object.values(parsedMapping).every(
                    (v) => typeof v === "string",
                )
            ) {
                return void res.status(400).json({
                    detail: "mapping must be a JSON object of case field → CSV header name (strings)",
                });
            }

            const outcome = await runCsvImport(db, userId, {
                csvText: file.buffer.toString("utf8"),
                mapping: parsedMapping as Record<string, string>,
                dryRun:
                    String((req.body ?? {}).dry_run ?? "").toLowerCase() ===
                    "true",
            });
            switch (outcome.kind) {
                case "header_error":
                    return void res
                        .status(400)
                        .json({ detail: outcome.detail });
                case "too_large":
                    return void res
                        .status(413)
                        .json({ detail: outcome.detail });
                case "dry_run":
                    return void res.json({
                        plans: outcome.plans,
                        errors: outcome.errors,
                        summary: outcome.summary,
                    });
                case "executed":
                    return void res.json(outcome.result);
            }
        } catch (err) {
            // Backstop only — runCsvImport pre-checks the cap.
            if (err instanceof ImportTooLargeError) {
                return void res.status(413).json({ detail: err.message });
            }
            res.status(500).json({
                detail: detailOf(err, "Failed to import cases"),
            });
        }
    },
);

// GET /cases/:id — the case plus its policies, expenses, filed documents,
// and automation runs.
router.get("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const piCase = await getCase(db, userId, req.params.id);
        if (!piCase)
            return void res.status(404).json({ detail: "Case not found" });

        const [policies, expenses] = await Promise.all([
            listPoliciesForCase(db, piCase.id),
            listExpensesForCase(db, piCase.id),
        ]);

        // Documents filed into the case's project (narrow select — the case
        // view needs identity, not version plumbing). No project → none.
        let documents: Record<string, unknown>[] = [];
        if (piCase.project_id) {
            const { data, error } = await db
                .from("documents")
                .select("id, filename, file_type, created_at")
                .eq("project_id", piCase.project_id)
                .order("created_at", { ascending: true });
            if (error) throw error;
            documents = (data as Record<string, unknown>[] | null) ?? [];
        }

        // The case's automation runs. pi_cases and automation_runs ship in
        // the same migration, but tolerate a partial schema anyway.
        let runs: AutomationRun[] = [];
        try {
            runs = await listRuns(db, userId, { caseId: piCase.id });
        } catch (err) {
            if (!isMissingAutomationSchema(err)) throw err;
        }

        res.json({ case: piCase, policies, expenses, documents, runs });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to load case") });
    }
});

// PATCH /cases/:id — update the provided fields only.
router.patch("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const patch: PiCasePatch = {};
        if (body.client_name !== undefined) {
            const clientName =
                typeof body.client_name === "string"
                    ? body.client_name.trim()
                    : "";
            if (!clientName) {
                return void res
                    .status(400)
                    .json({ detail: "client_name cannot be blank" });
            }
            patch.clientName = clientName;
        }
        if (body.case_number !== undefined) {
            if (body.case_number === null) patch.caseNumber = null;
            else if (typeof body.case_number === "string")
                patch.caseNumber = body.case_number.trim() || null;
            else
                return void res
                    .status(400)
                    .json({ detail: "case_number must be a string or null" });
        }
        if (body.date_of_loss !== undefined) {
            if (body.date_of_loss === null) {
                patch.dateOfLoss = null;
            } else if (
                typeof body.date_of_loss === "string" &&
                body.date_of_loss.trim()
            ) {
                const iso = toIsoDate(body.date_of_loss);
                if (!iso) {
                    return void res.status(400).json({
                        detail: "Unparseable date_of_loss (expected MM/DD/YYYY or YYYY-MM-DD)",
                    });
                }
                patch.dateOfLoss = iso;
            } else {
                patch.dateOfLoss = null;
            }
        }
        if (body.status !== undefined) {
            if (!isCaseStatus(body.status)) {
                return void res.status(400).json({
                    detail: `Invalid status; expected one of ${PI_CASE_STATUSES.join(", ")}`,
                });
            }
            patch.status = body.status;
        }
        if (body.needs_review !== undefined) {
            if (typeof body.needs_review !== "boolean") {
                return void res
                    .status(400)
                    .json({ detail: "needs_review must be a boolean" });
            }
            patch.needsReview = body.needs_review;
        }
        if (Object.keys(patch).length === 0) {
            return void res.status(400).json({
                detail: "No recognized fields to update (client_name, case_number, date_of_loss, status, needs_review)",
            });
        }
        const updated = await updateCase(db, userId, req.params.id, patch);
        if (!updated)
            return void res.status(404).json({ detail: "Case not found" });
        res.json({ case: updated });
    } catch (err) {
        res.status(500).json({ detail: detailOf(err, "Failed to update case") });
    }
});

// PATCH /cases/:caseId/expenses/:expenseId — status / paid_by / notes. A
// "paid" transition stamps paid_at in the store and defaults paid_by to the
// acting user when the body does not name a payer.
router.patch(
    "/:caseId/expenses/:expenseId",
    async (req: Request, res: Response) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const piCase = await getCase(db, userId, req.params.caseId);
            if (!piCase)
                return void res.status(404).json({ detail: "Case not found" });
            const expense = await getExpense(db, userId, req.params.expenseId);
            if (!expense || expense.case_id !== piCase.id) {
                return void res
                    .status(404)
                    .json({ detail: "Expense not found on this case" });
            }

            const patch: {
                status?: PiExpenseStatus;
                paidBy?: string;
                notes?: string | null;
            } = {};
            if (body.status !== undefined) {
                if (!isExpenseStatus(body.status)) {
                    return void res.status(400).json({
                        detail: `Invalid status; expected one of ${PI_EXPENSE_STATUSES.join(", ")}`,
                    });
                }
                patch.status = body.status;
            }
            if (body.paid_by !== undefined) {
                if (typeof body.paid_by !== "string" || !body.paid_by.trim()) {
                    return void res
                        .status(400)
                        .json({ detail: "paid_by must be a non-empty string" });
                }
                patch.paidBy = body.paid_by.trim();
            }
            if (body.notes !== undefined) {
                if (body.notes !== null && typeof body.notes !== "string") {
                    return void res
                        .status(400)
                        .json({ detail: "notes must be a string or null" });
                }
                patch.notes = body.notes;
            }
            if (Object.keys(patch).length === 0) {
                return void res.status(400).json({
                    detail: "No recognized fields to update (status, paid_by, notes)",
                });
            }
            // Marking paid without naming a payer records the acting user.
            if (patch.status === "paid" && patch.paidBy === undefined) {
                patch.paidBy = userEmail || userId;
            }

            const updated = await updateExpense(db, userId, expense.id, patch);
            if (!updated)
                return void res
                    .status(404)
                    .json({ detail: "Expense not found" });
            res.json({ expense: updated });
        } catch (err) {
            res.status(500).json({
                detail: detailOf(err, "Failed to update expense"),
            });
        }
    },
);

export { router as casesRouter };
