// backend/src/lib/pi/store.test.ts
//
// Pure pieces of the PI case store: normalizeClientName (the canonical
// client-name key later phases match inbound email against) plus the write
// choreography of the upsert/update helpers, pinned against a scripted
// Supabase stub. The pinned filters and payloads ARE the contracts the
// phase-4 pipeline builds on: the (user_id, case_number) idempotency lookup,
// "only overwrite what the import row provides", attribute merging, tenancy
// scoping, and paid-status stamping. No live database.
import assert from "node:assert/strict";
import {
    findCaseIdByClaimNumber,
    normalizeClientName,
    updateCase,
    updateExpense,
    upsertCaseFromImport,
    upsertPolicy,
} from "./store";

// Scripted chainable Supabase stub: each db.from() consumes the next scripted
// result; every builder call is recorded so tests can pin tables, filters and
// payloads. Terminal reads (single / maybeSingle / awaiting the chain itself)
// resolve to the scripted {data, error}.
interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown },
    ) => {
        const c: Record<string, unknown> = {};
        const record =
            (method: string) =>
            (...args: unknown[]) => {
                log.calls.push({ method, args });
                return c;
            };
        for (const m of [
            "insert",
            "update",
            "upsert",
            "delete",
            "select",
            "eq",
            "neq",
            "in",
            "is",
            "or",
            "not",
            "ilike",
            "lt",
            "lte",
            "gt",
            "gte",
            "order",
            "limit",
            "range",
        ]) {
            c[m] = record(m);
        }
        const resolved = {
            data: result.data ?? null,
            error: result.error ?? null,
        };
        c.single = () => Promise.resolve(resolved);
        c.maybeSingle = () => Promise.resolve(resolved);
        c.then = (resolve: (v: unknown) => void) => resolve(resolved);
        return c;
    };
    const db = {
        from: (table: string) => {
            const log: ChainLog = { table, calls: [] };
            chains.push(log);
            return makeChain(log, script[next++] ?? {});
        },
    } as never;
    return { db, chains };
}

function callsOf(chain: ChainLog, method: string) {
    return chain.calls.filter((c) => c.method === method);
}

function testNormalizeClientName() {
    // Case + whitespace: the normalized form is the matching key, so it must
    // be stable across formatting differences.
    assert.equal(normalizeClientName("John Smith"), "john smith");
    assert.equal(normalizeClientName("  JOHN\t  SMITH \n"), "john smith");
    // Punctuation is stripped without introducing spaces.
    assert.equal(normalizeClientName("O'Sample, Jr."), "osample jr");
    assert.equal(normalizeClientName("Mary-Jane Watson"), "maryjane watson");
    // Diacritics fold to their ASCII base letters.
    assert.equal(
        normalizeClientName("Josué Éjemplo Ñandú"),
        "josue ejemplo nandu",
    );
    // Non-Latin letters are preserved — a CJK name must never normalize to
    // the empty string (an empty key would "match" everything).
    assert.equal(normalizeClientName("张三"), "张三");
    assert.equal(normalizeClientName("Acme Corp. (Insured)"), "acme corp insured");
    assert.equal(normalizeClientName(""), "");
    assert.equal(normalizeClientName(" . , ; "), "");
}

async function testUpsertImportCreatesWhenAbsent() {
    const { db, chains } = makeDb([
        { data: null }, // lookup by (user_id, case_number) → no case yet
        { data: { id: "case-1" } }, // insert returns the new row id
    ]);
    const result = await upsertCaseFromImport(db, "user-1", {
        caseNumber: "PI-2026-001",
        clientName: "José O'Sample",
        dateOfLoss: "2026-01-15",
        attributes: { loss_state: "CA" },
    });
    assert.deepEqual(result, { id: "case-1", action: "created" });

    assert.equal(chains[0].table, "pi_cases");
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["user_id", "user-1"],
            ["case_number", "PI-2026-001"],
        ],
        "idempotency lookup is scoped to (user_id, case_number)",
    );

    const payload = callsOf(chains[1], "insert")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.user_id, "user-1");
    assert.equal(payload.case_number, "PI-2026-001");
    assert.equal(payload.client_name, "José O'Sample");
    assert.equal(
        payload.client_name_normalized,
        "jose osample",
        "normalized name is computed at write time",
    );
    assert.equal(payload.origin, "csv_import");
    assert.equal(payload.date_of_loss, "2026-01-15");
    assert.deepEqual(payload.attributes, { loss_state: "CA" });
}

async function testUpsertImportRequiresClientNameToCreate() {
    // client_name is NOT NULL — creating a case from an import row that
    // carries no client name must fail loudly, not insert "".
    const { db } = makeDb([{ data: null }]);
    await assert.rejects(
        upsertCaseFromImport(db, "user-1", { caseNumber: "PI-1" }),
        /clientName/,
    );
}

async function testUpsertImportUpdatesOnlyProvidedFields() {
    const { db, chains } = makeDb([
        { data: { id: "case-2", attributes: { prior: 1 } } },
        { data: { id: "case-2" } },
    ]);
    const result = await upsertCaseFromImport(db, "user-1", {
        caseNumber: "PI-2026-001",
        dateOfLoss: "2026-02-02",
        attributes: { loss_state: "CA" },
    });
    assert.deepEqual(result, { id: "case-2", action: "updated" });

    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.deepEqual(
        Object.keys(payload).sort(),
        ["attributes", "date_of_loss", "updated_at"],
        "only fields the import row provides are overwritten (plus updated_at)",
    );
    assert.deepEqual(
        payload.attributes,
        { prior: 1, loss_state: "CA" },
        "extra import columns merge into attributes instead of replacing them",
    );
    assert.deepEqual(callsOf(chains[1], "eq")[0].args, ["id", "case-2"]);
}

async function testUpsertImportInsertRaceFallsBackToUpdate() {
    // Two concurrent imports of the same row: the loser's insert hits the
    // (user_id, case_number) unique index and must converge on an update of
    // the winner's row, not throw.
    const { db, chains } = makeDb([
        { data: null }, // lookup: absent
        { error: { code: "23505", message: "duplicate key" } }, // insert loses
        { data: { id: "case-3", attributes: {} } }, // re-read finds the winner
        { data: { id: "case-3" } }, // update applies the row
    ]);
    const result = await upsertCaseFromImport(db, "user-1", {
        caseNumber: "PI-2026-001",
        clientName: "Jane Doe",
    });
    assert.deepEqual(result, { id: "case-3", action: "updated" });
    assert.equal(chains.length, 4);
}

async function testUpdateCaseRecomputesNormalizedName() {
    const { db, chains } = makeDb([{ data: { id: "case-1" } }]);
    await updateCase(db, "user-1", "case-1", {
        clientName: "Anna-María  Ejemplo",
    });
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.client_name, "Anna-María  Ejemplo");
    assert.equal(payload.client_name_normalized, "annamaria ejemplo");
    assert.equal(
        typeof payload.updated_at,
        "string",
        "updated_at is always bumped",
    );
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["id", "case-1"],
            ["user_id", "user-1"],
        ],
        "update is scoped to the owning user",
    );
}

async function testUpdateCaseWithoutNameLeavesNormalizedAlone() {
    const { db, chains } = makeDb([{ data: { id: "case-1" } }]);
    await updateCase(db, "user-1", "case-1", {
        status: "settled",
        needsReview: false,
    });
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.deepEqual(
        Object.keys(payload).sort(),
        ["needs_review", "status", "updated_at"],
        "client_name_normalized is only recomputed when client_name changes",
    );
}

async function testUpsertPolicyUpdatesExistingClaimRow() {
    const { db, chains } = makeDb([
        { data: { id: "pol-1" } }, // lookup by (case_id, claim_number)
        { data: { id: "pol-1", case_id: "case-1", carrier: "Acme Mutual" } },
    ]);
    const policy = await upsertPolicy(db, "case-1", {
        carrier: "Acme Mutual",
        claimNumber: "CLM-2210",
        adjuster: { name: "Pat Doe" },
    });
    assert.equal(policy.id, "pol-1");
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["case_id", "case-1"],
            ["claim_number", "CLM-2210"],
        ],
        "same case + same claim number → update, not a duplicate row",
    );
    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.carrier, "Acme Mutual");
    assert.deepEqual(payload.adjuster, { name: "Pat Doe" });
    assert.equal(typeof payload.updated_at, "string");
    assert.ok(
        !("policy_limits" in payload),
        "fields not provided are not overwritten",
    );
}

async function testUpsertPolicyInsertRaceFallsBackToUpdate() {
    // Two runs referencing the same claim number (different emails) can
    // interleave lookup-then-insert; the loser hits the
    // pi_case_policies_case_claim_unique index and must converge on updating
    // the winner's row — mirroring upsertCaseFromImport — not throw.
    const { db, chains } = makeDb([
        { data: null }, // lookup: no (case_id, claim_number) row yet
        { error: { code: "23505", message: "duplicate key" } }, // insert loses
        { data: { id: "pol-9" } }, // re-fetch finds the winner
        { data: { id: "pol-9", case_id: "case-1", carrier: "Acme Mutual" } },
    ]);
    const policy = await upsertPolicy(db, "case-1", {
        carrier: "Acme Mutual",
        claimNumber: "CLM-2210",
    });
    assert.equal(policy.id, "pol-9");
    assert.equal(chains.length, 4);
    assert.deepEqual(
        callsOf(chains[2], "eq").map((c) => c.args),
        [
            ["case_id", "case-1"],
            ["claim_number", "CLM-2210"],
        ],
        "the recovery re-fetch resolves by the conflicting (case_id, claim_number)",
    );
    assert.deepEqual(
        callsOf(chains[3], "eq")[0].args,
        ["id", "pol-9"],
        "the update lands on the winner's row",
    );
    const payload = callsOf(chains[3], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.carrier, "Acme Mutual");
    assert.equal(typeof payload.updated_at, "string");
}

async function testUpsertPolicyInsertsWithoutClaimNumber() {
    const { db, chains } = makeDb([
        { data: { id: "pol-2", case_id: "case-1", carrier: "Acme" } },
    ]);
    const policy = await upsertPolicy(db, "case-1", { carrier: "Acme" });
    assert.equal(policy.id, "pol-2");
    assert.equal(chains.length, 1, "no claim_number → straight insert");
    assert.equal(callsOf(chains[0], "insert").length, 1);
}

async function testFindCaseIdByClaimNumberScopesToUser() {
    const { db, chains } = makeDb([{ data: [{ case_id: "case-7" }] }]);
    const id = await findCaseIdByClaimNumber(db, "user-1", "CLM-2210");
    assert.equal(id, "case-7");
    assert.equal(chains[0].table, "pi_case_policies");
    const select = callsOf(chains[0], "select")[0];
    assert.match(
        String(select.args[0]),
        /pi_cases!inner/,
        "the join to pi_cases is what enforces tenancy",
    );
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["claim_number", "CLM-2210"],
            ["pi_cases.user_id", "user-1"],
        ],
    );

    const missing = await findCaseIdByClaimNumber(
        makeDb([{ data: [] }]).db,
        "user-1",
        "CLM-X",
    );
    assert.equal(missing, null);
}

async function testUpdateExpenseMarkPaidStampsPaidFields() {
    const { db, chains } = makeDb([{ data: { id: "exp-1" } }]);
    await updateExpense(db, "user-1", "exp-1", {
        status: "paid",
        paidBy: "user-1",
    });
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.status, "paid");
    assert.equal(payload.paid_by, "user-1");
    assert.equal(
        typeof payload.paid_at,
        "string",
        "marking paid stamps paid_at",
    );
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["id", "exp-1"],
            ["user_id", "user-1"],
        ],
        "expense updates are scoped to the owning user",
    );
}

async function testUpdateExpenseNonPaidStatusDoesNotStamp() {
    const { db, chains } = makeDb([{ data: { id: "exp-1" } }]);
    await updateExpense(db, "user-1", "exp-1", { status: "approved" });
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.ok(!("paid_at" in payload));
    assert.ok(!("paid_by" in payload));
}

async function main() {
    testNormalizeClientName();
    await testUpsertImportCreatesWhenAbsent();
    await testUpsertImportRequiresClientNameToCreate();
    await testUpsertImportUpdatesOnlyProvidedFields();
    await testUpsertImportInsertRaceFallsBackToUpdate();
    await testUpdateCaseRecomputesNormalizedName();
    await testUpdateCaseWithoutNameLeavesNormalizedAlone();
    await testUpsertPolicyUpdatesExistingClaimRow();
    await testUpsertPolicyInsertRaceFallsBackToUpdate();
    await testUpsertPolicyInsertsWithoutClaimNumber();
    await testFindCaseIdByClaimNumberScopesToUser();
    await testUpdateExpenseMarkPaidStampsPaidFields();
    await testUpdateExpenseNonPaidStatusDoesNotStamp();
    console.log("pi/store.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
