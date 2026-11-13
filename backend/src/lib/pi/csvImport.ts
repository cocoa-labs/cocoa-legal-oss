// backend/src/lib/pi/csvImport.ts
//
// Dependency-free CSV import for CasePeer case exports, powering
// POST /cases/import. Layered so the whole mapping contract is unit-testable
// without a database:
//   - parseCsv: hand-rolled RFC-4180-ish parser (quoted fields, escaped
//     quotes, commas/newlines inside quotes, CRLF/LF, trailing newline, BOM);
//   - planImport: header + mapping → per-row PiCaseImportRow plans; invalid
//     rows collect as RowErrors, header/mapping-level failures that poison
//     the whole file surface as a single headerError (never a throw);
//   - executeImport: sequential upsertCaseFromImport per plan, capped at
//     MAX_IMPORT_ROWS (ImportTooLargeError → 413);
//   - runCsvImport: the /cases/import decision flow (cap → plan → dry-run or
//     execute) as one pure-ish orchestrator, so the route stays a thin
//     outcome→status mapper and the abort-before-write guarantees are
//     testable against an injected upsert. Plan-time row rejections are
//     MERGED into the execute response (mergeImportErrors) — a row that
//     failed planning must never silently vanish from the result.
//
// case_number is required in the mapping AND per row — it is the
// (user_id, case_number) idempotency key upsertCaseFromImport dedupes on,
// so a row without one can never import safely. client_name is required per
// row because pi_cases.client_name is NOT NULL (and a fresh import row may
// create the case). Mapping keys with no dedicated pi_cases column pass
// through into the case's attributes (merged on update by the store).

import type { createServerSupabase } from "../supabase";
import { toIsoDate } from "../automation/match";
import {
    PI_CASE_STATUSES,
    upsertCaseFromImport,
    type PiCaseImportRow,
    type PiCaseStatus,
} from "./store";

type Db = ReturnType<typeof createServerSupabase>;

/** Hard cap on data rows per import request. */
export const MAX_IMPORT_ROWS = 2000;

export interface RowError {
    /** Index into the parsed rows array (0 = header; data rows start at 1). */
    rowIndex: number;
    detail: string;
}

export interface ImportRowPlan {
    rowIndex: number;
    row: PiCaseImportRow;
}

export interface ImportPlanResult {
    plans: ImportRowPlan[];
    /** Row-level problems (rowIndex >= 1); these rows are excluded from
     * plans but the rest of the file still imports. */
    errors: RowError[];
    /** A header/mapping-level failure that poisons the WHOLE file (no
     * header row, required mapping key absent, mapped column not found in
     * the header) — joined details, or null. When set, plans and errors are
     * empty and callers must abort (routes answer 400 { detail }) rather
     * than report a clean-looking zero-row import. */
    headerError: string | null;
}

export interface ImportExecuteResult {
    created: number;
    updated: number;
    /** Rows whose upsert failed at execution time (also listed in errors). */
    skipped: number;
    errors: RowError[];
}

/** Thrown by executeImport above MAX_IMPORT_ROWS; routes map it to 413. */
export class ImportTooLargeError extends Error {
    constructor(rowCount: number) {
        super(
            `Import has ${rowCount} rows; the maximum per request is ${MAX_IMPORT_ROWS}.`,
        );
        this.name = "ImportTooLargeError";
    }
}

/**
 * RFC-4180-ish CSV parser: quoted fields, `""` escapes inside quotes, commas
 * and newlines inside quotes, CRLF or LF records, an optional trailing
 * newline (no phantom last row), and a leading BOM. Deliberately tolerant —
 * a stray quote mid-field is kept literally rather than thrown on, because
 * the operator sees per-row plan errors, not parser exceptions.
 */
export function parseCsv(text: string): string[][] {
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    const endField = () => {
        row.push(field);
        field = "";
    };
    const endRow = () => {
        endField();
        rows.push(row);
        row = [];
    };

    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }
        if (ch === '"' && field === "") {
            // A quote only OPENS at field start; anywhere else it is literal.
            inQuotes = true;
            i += 1;
            continue;
        }
        if (ch === ",") {
            endField();
            i += 1;
            continue;
        }
        if (ch === "\r") {
            endRow();
            i += src[i + 1] === "\n" ? 2 : 1;
            continue;
        }
        if (ch === "\n") {
            endRow();
            i += 1;
            continue;
        }
        field += ch;
        i += 1;
    }
    // Final record when the file does not end with a newline. A row that is
    // nothing but one empty field (i.e. a blank final line) is dropped.
    if (field !== "" || row.length > 0) endRow();
    if (rows.length > 0) {
        const last = rows[rows.length - 1];
        if (last.length === 1 && last[0] === "") rows.pop();
    }
    return rows;
}

/** Mapping keys with a dedicated pi_cases column; everything else is a
 * passthrough into attributes. */
const DEDICATED_FIELDS = new Set([
    "case_number",
    "client_name",
    "date_of_loss",
    "status",
]);

/** Resolve a mapped header name to its column index: exact (trimmed) match
 * first, case-insensitive fallback, -1 when absent. */
function headerIndex(headers: string[], name: string): number {
    const trimmed = headers.map((h) => h.trim());
    const wanted = name.trim();
    const exact = trimmed.indexOf(wanted);
    if (exact >= 0) return exact;
    const lower = wanted.toLowerCase();
    return trimmed.findIndex((h) => h.toLowerCase() === lower);
}

/**
 * Turn parsed CSV rows + a field→header mapping into per-row import plans.
 * Pure: header-level problems (no header row, unmapped required fields, a
 * mapped column missing from the header) abort with a joined headerError and
 * no plans — they poison every row identically, so pushing on as row errors
 * would fabricate a clean-looking zero-row import. Data-row problems become
 * one RowError per row (all of the row's issues joined) and never a throw.
 * Blank rows are skipped silently. Empty optional cells leave the field
 * ABSENT so a re-import cannot blank values the user filled in by hand (the
 * store's update-only-what-is-provided rule).
 */
export function planImport(
    rows: string[][],
    mapping: Record<string, string>,
): ImportPlanResult {
    if (rows.length === 0) {
        return {
            plans: [],
            errors: [],
            headerError: "CSV is empty — a header row is required",
        };
    }
    const headers = rows[0];

    const headerProblems: string[] = [];
    for (const required of ["case_number", "client_name"] as const) {
        if (!mapping[required]?.trim()) {
            headerProblems.push(
                `mapping must include "${required}" (it is required to import a row)`,
            );
        }
    }

    const columns: { field: string; index: number }[] = [];
    for (const [field, headerName] of Object.entries(mapping)) {
        if (typeof headerName !== "string" || !headerName.trim()) continue;
        const index = headerIndex(headers, headerName);
        if (index < 0) {
            headerProblems.push(
                `mapped column "${headerName}" (for "${field}") was not found in the CSV header`,
            );
            continue;
        }
        columns.push({ field, index });
    }
    if (headerProblems.length > 0) {
        return { plans: [], errors: [], headerError: headerProblems.join("; ") };
    }

    const errors: RowError[] = [];
    const plans: ImportRowPlan[] = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        const cells = rows[rowIndex];
        if (cells.every((cell) => !cell.trim())) continue; // blank line

        const problems: string[] = [];
        let caseNumber = "";
        let clientName = "";
        let dateOfLoss: string | undefined;
        let status: PiCaseStatus | undefined;
        const attributes: Record<string, unknown> = {};

        for (const column of columns) {
            const raw = (cells[column.index] ?? "").trim();
            if (column.field === "case_number") {
                caseNumber = raw;
            } else if (column.field === "client_name") {
                clientName = raw;
            } else if (column.field === "date_of_loss") {
                if (!raw) continue;
                const iso = toIsoDate(raw);
                if (iso) dateOfLoss = iso;
                else
                    problems.push(
                        `unparseable date_of_loss "${raw}" (expected MM/DD/YYYY or YYYY-MM-DD)`,
                    );
            } else if (column.field === "status") {
                if (!raw) continue;
                const normalized = raw.toLowerCase();
                if ((PI_CASE_STATUSES as readonly string[]).includes(normalized)) {
                    status = normalized as PiCaseStatus;
                } else {
                    problems.push(
                        `invalid status "${raw}" (expected one of ${PI_CASE_STATUSES.join(", ")})`,
                    );
                }
            } else if (!DEDICATED_FIELDS.has(column.field)) {
                if (raw) attributes[column.field] = raw;
            }
        }

        if (!caseNumber) problems.push("missing case_number");
        if (!clientName) problems.push("missing client_name");
        if (problems.length > 0) {
            errors.push({ rowIndex, detail: problems.join("; ") });
            continue;
        }

        const row: PiCaseImportRow = { caseNumber, clientName };
        if (dateOfLoss !== undefined) row.dateOfLoss = dateOfLoss;
        if (status !== undefined) row.status = status;
        if (Object.keys(attributes).length > 0) row.attributes = attributes;
        plans.push({ rowIndex, row });
    }

    return { plans, errors, headerError: null };
}

export interface ExecuteImportDeps {
    upsertFn?: typeof upsertCaseFromImport;
}

/**
 * Apply import plans sequentially via upsertCaseFromImport (idempotent on
 * (user_id, case_number)). One row's failure is contained as a RowError +
 * skipped count — the rest of the batch proceeds. Throws ImportTooLargeError
 * above MAX_IMPORT_ROWS before touching anything.
 */
export async function executeImport(
    db: Db,
    userId: string,
    plans: ImportRowPlan[],
    deps: ExecuteImportDeps = {},
): Promise<ImportExecuteResult> {
    if (plans.length > MAX_IMPORT_ROWS) {
        throw new ImportTooLargeError(plans.length);
    }
    const upsert = deps.upsertFn ?? upsertCaseFromImport;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: RowError[] = [];
    for (const plan of plans) {
        try {
            const { action } = await upsert(db, userId, plan.row);
            if (action === "created") created += 1;
            else updated += 1;
        } catch (err) {
            skipped += 1;
            errors.push({
                rowIndex: plan.rowIndex,
                detail: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { created, updated, skipped, errors };
}

/**
 * Fold plan-time row rejections into an execution result so the import
 * response accounts for EVERY non-blank data row: rows the planner rejected
 * join the rows whose upsert failed, sorted by row, and each counts as
 * skipped. Invariant: skipped === errors.length, and created + updated +
 * skipped covers every row that was neither blank nor header.
 */
export function mergeImportErrors(
    planErrors: RowError[],
    result: ImportExecuteResult,
): ImportExecuteResult {
    return {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped + planErrors.length,
        errors: [...planErrors, ...result.errors].sort(
            (a, b) => a.rowIndex - b.rowIndex,
        ),
    };
}

/** Outcome of one /cases/import request; the route maps kinds to statuses
 * (header_error → 400, too_large → 413, the rest → 200). */
export type ImportRequestOutcome =
    | { kind: "header_error"; detail: string }
    | { kind: "too_large"; detail: string }
    | {
          kind: "dry_run";
          plans: ImportRowPlan[];
          errors: RowError[];
          summary: { total_rows: number; planned: number; invalid: number };
      }
    | { kind: "executed"; result: ImportExecuteResult };

/**
 * The whole /cases/import decision flow: parse → cap check → plan →
 * dry-run report or execute-with-merged-errors. Header/mapping-level
 * failures and the row cap abort BEFORE any write, on both paths; the
 * execute result's errors include plan-time rejections (mergeImportErrors),
 * so a partially-bad file can never come back as a clean-looking success.
 */
export async function runCsvImport(
    db: Db,
    userId: string,
    input: { csvText: string; mapping: Record<string, string>; dryRun: boolean },
    deps: ExecuteImportDeps = {},
): Promise<ImportRequestOutcome> {
    const rows = parseCsv(input.csvText);
    const dataRows = Math.max(0, rows.length - 1);
    if (dataRows > MAX_IMPORT_ROWS) {
        return {
            kind: "too_large",
            detail: `CSV has ${dataRows} data rows; the maximum per import is ${MAX_IMPORT_ROWS}`,
        };
    }
    const { plans, errors, headerError } = planImport(rows, input.mapping);
    if (headerError) {
        return { kind: "header_error", detail: headerError };
    }
    if (input.dryRun) {
        return {
            kind: "dry_run",
            plans,
            errors,
            summary: {
                total_rows: dataRows,
                planned: plans.length,
                invalid: errors.length,
            },
        };
    }
    const executed = await executeImport(db, userId, plans, deps);
    return { kind: "executed", result: mergeImportErrors(errors, executed) };
}
