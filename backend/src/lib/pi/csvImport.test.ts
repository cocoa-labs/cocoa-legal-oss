// backend/src/lib/pi/csvImport.test.ts
//
// The CasePeer CSV import is the bulk on-ramp for pi_cases, so what's pinned
// here is the whole pure layer the /cases/import route leans on: the
// hand-rolled RFC-4180-ish parser (quoted fields, escaped quotes, embedded
// commas/newlines, CRLF, trailing newline), planImport's mapping semantics
// (header resolution, mandatory case_number/client_name, tolerant dates,
// status validation, passthrough → attributes, RowErrors instead of throws),
// and executeImport's sequencing over an injected upsert (created/updated
// counting, per-row error containment, the 2000-row cap). No live database —
// executeImport is driven with a fake upsertCaseFromImport that honors the
// real (user_id, case_number) idempotency contract.
import assert from "node:assert/strict";
import {
    ImportTooLargeError,
    MAX_IMPORT_ROWS,
    executeImport,
    mergeImportErrors,
    parseCsv,
    planImport,
    runCsvImport,
    type ImportRowPlan,
} from "./csvImport";
import type { PiCaseImportRow } from "./store";

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

const MAPPING = {
    case_number: "Case #",
    client_name: "Client Name",
    date_of_loss: "DOL",
    status: "Status",
    phone: "Phone",
};

async function main(): Promise<void> {
    console.log("pi/csvImport.test.ts");

    // -----------------------------------------------------------------------
    // parseCsv
    // -----------------------------------------------------------------------

    await test("parseCsv: plain rows, LF line endings", () => {
        assert.deepEqual(parseCsv("a,b,c\n1,2,3"), [
            ["a", "b", "c"],
            ["1", "2", "3"],
        ]);
    });

    await test("parseCsv: CRLF line endings", () => {
        assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
            ["a", "b"],
            ["1", "2"],
        ]);
    });

    await test("parseCsv: trailing newline does not add a phantom row", () => {
        assert.deepEqual(parseCsv("a,b\n1,2\n"), [
            ["a", "b"],
            ["1", "2"],
        ]);
    });

    await test("parseCsv: quoted fields with embedded commas", () => {
        assert.deepEqual(parseCsv('name,firm\n"Doe, Jane",Acme'), [
            ["name", "firm"],
            ["Doe, Jane", "Acme"],
        ]);
    });

    await test("parseCsv: escaped quotes inside quoted fields", () => {
        assert.deepEqual(parseCsv('a\n"He said ""hi"""'), [
            ["a"],
            ['He said "hi"'],
        ]);
    });

    await test("parseCsv: embedded newlines inside quoted fields", () => {
        assert.deepEqual(parseCsv('a,b\n"line1\nline2",x\n3,4'), [
            ["a", "b"],
            ["line1\nline2", "x"],
            ["3", "4"],
        ]);
    });

    await test("parseCsv: embedded CRLF inside quoted fields survives verbatim", () => {
        assert.deepEqual(parseCsv('a\r\n"one\r\ntwo"\r\n'), [
            ["a"],
            ["one\r\ntwo"],
        ]);
    });

    await test("parseCsv: empty fields and empty trailing field", () => {
        assert.deepEqual(parseCsv("a,,c\n,,"), [
            ["a", "", "c"],
            ["", "", ""],
        ]);
    });

    await test("parseCsv: leading BOM is stripped", () => {
        assert.deepEqual(parseCsv("﻿a,b\n1,2"), [
            ["a", "b"],
            ["1", "2"],
        ]);
    });

    await test("parseCsv: empty input → no rows", () => {
        assert.deepEqual(parseCsv(""), []);
        assert.deepEqual(parseCsv("\n"), []);
    });

    await test("parseCsv: quote after content is literal (tolerant, no throw)", () => {
        assert.deepEqual(parseCsv('ab"c,d'), [['ab"c', "d"]]);
    });

    // -----------------------------------------------------------------------
    // planImport
    // -----------------------------------------------------------------------

    const header = ["Case #", "Client Name", "DOL", "Status", "Phone"];

    await test("planImport: happy path maps fields, dates, status, passthrough attributes", () => {
        const { plans, errors, headerError } = planImport(
            [
                header,
                ["24-001", "Jane Doe", "03/05/2024", "Open", "555-0100"],
                ["24-002", "Ana Ñandú-Ejemplo", "2024-11-30", "settled", ""],
            ],
            MAPPING,
        );
        assert.equal(headerError, null);
        assert.deepEqual(errors, []);
        assert.equal(plans.length, 2);
        assert.deepEqual(plans[0], {
            rowIndex: 1,
            row: {
                caseNumber: "24-001",
                clientName: "Jane Doe",
                dateOfLoss: "2024-03-05",
                status: "open",
                attributes: { phone: "555-0100" },
            },
        });
        // Empty passthrough cell → no attributes key at all (a re-import must
        // not blank hand-entered attributes with empty cells).
        assert.deepEqual(plans[1].row, {
            caseNumber: "24-002",
            clientName: "Ana Ñandú-Ejemplo",
            dateOfLoss: "2024-11-30",
            status: "settled",
        });
    });

    await test("planImport: no header row → headerError, no plans, no row errors", () => {
        const { plans, errors, headerError } = planImport([], MAPPING);
        assert.deepEqual(plans, []);
        assert.deepEqual(errors, []);
        assert.ok(headerError);
        assert.match(headerError ?? "", /header/i);
    });

    await test("planImport: mapping missing case_number/client_name → headerError names both", () => {
        const { plans, errors, headerError } = planImport(
            [header, ["x", "y", "", "", ""]],
            { date_of_loss: "DOL" },
        );
        assert.deepEqual(plans, []);
        assert.deepEqual(errors, [], "header failures never masquerade as row errors");
        assert.ok(headerError);
        assert.match(headerError ?? "", /case_number/);
        assert.match(headerError ?? "", /client_name/);
    });

    await test("planImport: mapped column absent from header → headerError, no plans", () => {
        const { plans, errors, headerError } = planImport(
            [header, ["24-001", "Jane Doe", "", "", ""]],
            { ...MAPPING, client_name: "No Such Column" },
        );
        assert.deepEqual(plans, []);
        assert.deepEqual(errors, []);
        assert.ok(headerError);
        assert.match(headerError ?? "", /No Such Column/);
    });

    await test("planImport: header match is trimmed and case-insensitive as fallback", () => {
        const { plans, errors } = planImport(
            [
                [" case # ", "CLIENT NAME"],
                ["24-001", "Jane Doe"],
            ],
            { case_number: "Case #", client_name: "Client Name" },
        );
        assert.deepEqual(errors, []);
        assert.equal(plans.length, 1);
        assert.equal(plans[0].row.caseNumber, "24-001");
    });

    await test("planImport: missing client_name / case_number → RowError, never a throw", () => {
        const { plans, errors } = planImport(
            [
                header,
                ["", "Jane Doe", "", "", ""],
                ["24-002", "", "", "", ""],
                ["24-003", "Ok Client", "", "", ""],
            ],
            MAPPING,
        );
        assert.equal(plans.length, 1);
        assert.equal(plans[0].rowIndex, 3);
        assert.deepEqual(
            errors.map((e) => e.rowIndex),
            [1, 2],
        );
        assert.match(errors[0].detail, /case_number/);
        assert.match(errors[1].detail, /client_name/);
    });

    await test("planImport: date tolerance — MM/DD/YYYY and YYYY-MM-DD parse, junk is a RowError", () => {
        const { plans, errors } = planImport(
            [
                header,
                ["24-001", "A", "1/9/2024", "", ""],
                ["24-002", "B", "2024-01-09", "", ""],
                ["24-003", "C", "next tuesday", "", ""],
                ["24-004", "D", "", "", ""],
            ],
            MAPPING,
        );
        assert.equal(plans.length, 3);
        assert.equal(plans[0].row.dateOfLoss, "2024-01-09");
        assert.equal(plans[1].row.dateOfLoss, "2024-01-09");
        // Empty date cell → field left absent (update must not blank it).
        assert.equal("dateOfLoss" in plans[2].row, false);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].rowIndex, 3);
        assert.match(errors[0].detail, /date_of_loss/);
    });

    await test("planImport: invalid status → RowError; case-insensitive statuses accepted", () => {
        const { plans, errors } = planImport(
            [
                header,
                ["24-001", "A", "", "CLOSED", ""],
                ["24-002", "B", "", "archived", ""],
            ],
            MAPPING,
        );
        assert.equal(plans.length, 1);
        assert.equal(plans[0].row.status, "closed");
        assert.equal(errors.length, 1);
        assert.match(errors[0].detail, /status/);
    });

    await test("planImport: several problems on one row collapse into one RowError", () => {
        const { errors } = planImport(
            [header, ["", "", "junk-date", "junk-status", ""]],
            MAPPING,
        );
        assert.equal(errors.length, 1);
        assert.match(errors[0].detail, /case_number/);
        assert.match(errors[0].detail, /client_name/);
        assert.match(errors[0].detail, /date_of_loss/);
        assert.match(errors[0].detail, /status/);
    });

    await test("planImport: blank rows are skipped silently; short rows read as empty cells", () => {
        const { plans, errors } = planImport(
            [
                header,
                ["", "", "", "", ""],
                ["24-001", "Jane Doe"],
            ],
            MAPPING,
        );
        assert.deepEqual(errors, []);
        assert.equal(plans.length, 1);
        assert.equal(plans[0].rowIndex, 2);
        assert.equal(plans[0].row.clientName, "Jane Doe");
    });

    // -----------------------------------------------------------------------
    // executeImport — sequencing over an injected upsert, no live db
    // -----------------------------------------------------------------------

    /** Fake honoring the real upsert contract: create on unseen case_number,
     *  update on a later hit — the (user_id, case_number) idempotency key. */
    function makeFakeUpsert(seed: string[] = []) {
        const existing = new Set(seed);
        const calls: PiCaseImportRow[] = [];
        const upsertFn = async (
            _db: never,
            _userId: string,
            row: PiCaseImportRow,
        ): Promise<{ id: string; action: "created" | "updated" }> => {
            calls.push(row);
            if (existing.has(row.caseNumber)) {
                return { id: `id-${row.caseNumber}`, action: "updated" };
            }
            existing.add(row.caseNumber);
            return { id: `id-${row.caseNumber}`, action: "created" };
        };
        return { upsertFn, existing, calls };
    }

    const importRows = [
        header,
        ["24-001", "Jane Doe", "03/05/2024", "open", "555-0100"],
        ["24-002", "John Roe", "", "", ""],
    ];

    await test("executeImport: first pass creates, re-planning the same rows updates (idempotent)", async () => {
        const fake = makeFakeUpsert();

        const firstPlan = planImport(importRows, MAPPING);
        assert.deepEqual(firstPlan.errors, []);
        const first = await executeImport(fakeDb, "user-1", firstPlan.plans, {
            upsertFn: fake.upsertFn as never,
        });
        assert.deepEqual(first, { created: 2, updated: 0, skipped: 0, errors: [] });

        // Planning the SAME rows again yields plans that update, not create.
        const secondPlan = planImport(importRows, MAPPING);
        const second = await executeImport(fakeDb, "user-1", secondPlan.plans, {
            upsertFn: fake.upsertFn as never,
        });
        assert.deepEqual(second, { created: 0, updated: 2, skipped: 0, errors: [] });
        assert.equal(fake.calls.length, 4);
    });

    await test("executeImport: a row whose upsert throws is skipped + reported, the rest proceed", async () => {
        const fake = makeFakeUpsert();
        const upsertFn = async (
            db: never,
            userId: string,
            row: PiCaseImportRow,
        ) => {
            if (row.caseNumber === "24-001") throw new Error("boom");
            return fake.upsertFn(db, userId, row);
        };
        const { plans } = planImport(importRows, MAPPING);
        const result = await executeImport(fakeDb, "user-1", plans, {
            upsertFn: upsertFn as never,
        });
        assert.equal(result.created, 1);
        assert.equal(result.updated, 0);
        assert.equal(result.skipped, 1);
        assert.deepEqual(result.errors, [{ rowIndex: 1, detail: "boom" }]);
    });

    await test("executeImport: above the row cap → ImportTooLargeError, nothing written", async () => {
        const fake = makeFakeUpsert();
        const plans: ImportRowPlan[] = Array.from(
            { length: MAX_IMPORT_ROWS + 1 },
            (_, i) => ({
                rowIndex: i + 1,
                row: { caseNumber: `c-${i}`, clientName: `n-${i}` },
            }),
        );
        await assert.rejects(
            () =>
                executeImport(fakeDb, "user-1", plans, {
                    upsertFn: fake.upsertFn as never,
                }),
            ImportTooLargeError,
        );
        assert.equal(fake.calls.length, 0);
    });

    // -----------------------------------------------------------------------
    // mergeImportErrors + runCsvImport — the /cases/import decision flow
    // (review fix: plan-time rejections must never vanish from the execute
    // response, and header-level failures must abort BOTH paths pre-write)
    // -----------------------------------------------------------------------

    await test("mergeImportErrors: plan + execution errors merge sorted, skipped covers both", () => {
        const merged = mergeImportErrors(
            [{ rowIndex: 3, detail: "missing client_name" }],
            {
                created: 2,
                updated: 1,
                skipped: 1,
                errors: [{ rowIndex: 1, detail: "boom" }],
            },
        );
        assert.deepEqual(merged, {
            created: 2,
            updated: 1,
            skipped: 2,
            errors: [
                { rowIndex: 1, detail: "boom" },
                { rowIndex: 3, detail: "missing client_name" },
            ],
        });
        // Invariant the wizard can lean on: every skipped row has exactly
        // one error entry.
        assert.equal(merged.skipped, merged.errors.length);
    });

    const mixedCsv = [
        "Case #,Client Name,DOL,Status,Phone",
        "24-001,Jane Doe,03/05/2024,open,555-0100",
        "24-002,,not-a-date,,",
        "24-003,John Roe,,,",
    ].join("\n");

    await test("runCsvImport (execute): plan-rejected rows surface in errors alongside the counts", async () => {
        const fake = makeFakeUpsert();
        const outcome = await runCsvImport(
            fakeDb,
            "user-1",
            { csvText: mixedCsv, mapping: MAPPING, dryRun: false },
            { upsertFn: fake.upsertFn as never },
        );
        assert.equal(outcome.kind, "executed");
        if (outcome.kind !== "executed") return;
        assert.equal(outcome.result.created, 2);
        assert.equal(outcome.result.updated, 0);
        assert.equal(outcome.result.skipped, 1);
        assert.equal(outcome.result.errors.length, 1);
        assert.equal(outcome.result.errors[0].rowIndex, 2);
        assert.match(outcome.result.errors[0].detail, /client_name/);
        assert.match(outcome.result.errors[0].detail, /date_of_loss/);
        assert.equal(fake.calls.length, 2, "only the two valid rows reach the upsert");
    });

    await test("runCsvImport (execute): plan + execution errors are BOTH in the response", async () => {
        const fake = makeFakeUpsert();
        const upsertFn = async (
            db: never,
            userId: string,
            row: PiCaseImportRow,
        ) => {
            if (row.caseNumber === "24-003") throw new Error("db exploded");
            return fake.upsertFn(db, userId, row);
        };
        const outcome = await runCsvImport(
            fakeDb,
            "user-1",
            { csvText: mixedCsv, mapping: MAPPING, dryRun: false },
            { upsertFn: upsertFn as never },
        );
        assert.equal(outcome.kind, "executed");
        if (outcome.kind !== "executed") return;
        assert.deepEqual(
            {
                created: outcome.result.created,
                updated: outcome.result.updated,
                skipped: outcome.result.skipped,
            },
            { created: 1, updated: 0, skipped: 2 },
        );
        assert.deepEqual(
            outcome.result.errors.map((e) => e.rowIndex),
            [2, 3],
            "sorted by row: plan-rejected row 2, execution-failed row 3",
        );
        assert.match(outcome.result.errors[1].detail, /db exploded/);
    });

    await test("runCsvImport: header-level failure → header_error on BOTH paths, nothing written", async () => {
        const badMapping = { ...MAPPING, client_name: "No Such Column" };
        for (const dryRun of [false, true]) {
            const fake = makeFakeUpsert();
            const outcome = await runCsvImport(
                fakeDb,
                "user-1",
                { csvText: mixedCsv, mapping: badMapping, dryRun },
                { upsertFn: fake.upsertFn as never },
            );
            assert.equal(outcome.kind, "header_error");
            if (outcome.kind === "header_error") {
                assert.match(outcome.detail, /No Such Column/);
            }
            assert.equal(
                fake.calls.length,
                0,
                `nothing written on the ${dryRun ? "dry-run" : "execute"} path`,
            );
        }
    });

    await test("runCsvImport (dry run): plan + row errors + summary, no writes", async () => {
        const fake = makeFakeUpsert();
        const outcome = await runCsvImport(
            fakeDb,
            "user-1",
            { csvText: mixedCsv, mapping: MAPPING, dryRun: true },
            { upsertFn: fake.upsertFn as never },
        );
        assert.equal(outcome.kind, "dry_run");
        if (outcome.kind !== "dry_run") return;
        assert.equal(outcome.plans.length, 2);
        assert.equal(outcome.errors.length, 1);
        assert.deepEqual(outcome.summary, {
            total_rows: 3,
            planned: 2,
            invalid: 1,
        });
        assert.equal(fake.calls.length, 0);
    });

    await test("runCsvImport: above the row cap → too_large before planning, nothing written", async () => {
        const fake = makeFakeUpsert();
        const bigCsv =
            "Case #,Client Name\n" +
            Array.from(
                { length: MAX_IMPORT_ROWS + 1 },
                (_, i) => `c-${i},n-${i}`,
            ).join("\n");
        const outcome = await runCsvImport(
            fakeDb,
            "user-1",
            {
                csvText: bigCsv,
                mapping: { case_number: "Case #", client_name: "Client Name" },
                dryRun: false,
            },
            { upsertFn: fake.upsertFn as never },
        );
        assert.equal(outcome.kind, "too_large");
        if (outcome.kind === "too_large") {
            assert.match(outcome.detail, new RegExp(String(MAX_IMPORT_ROWS)));
        }
        assert.equal(fake.calls.length, 0);
    });

    console.log("pi/csvImport.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
