// backend/src/lib/memory.test.ts
import assert from "node:assert/strict";
import {
    setPersonalMemoryEntry,
    disablePersonalMemoryEntry,
    listPersonalMemory,
    selectMemoryForTurn,
    formatMemoryLines,
    listFirmMemory,
    proposeFirmMemoryCandidate,
    listFirmMemoryCandidates,
    approveFirmMemoryCandidate,
    rejectFirmMemoryCandidate,
    detectPrivateFactSignals,
    type MemoryEntry,
} from "./memory";

// In-memory supabase mock covering the call shapes memory.ts uses:
// read (select+eq+order), insert (+ .select().single() returning), upsert with
// onConflict + partial-null-key semantics (null keys never collide, matching
// the `where key is not null` partial unique index), update+eq (+ .select()
// returning for status-guarded claims), and maybeSingle/single. Writes are
// applied at resolution time so eq filters chained after update/delete are
// honored.
type Row = Record<string, unknown>;
type Tbl = { rows: Row[] };

function mockSupabase(
    initial: Record<string, Row[]> = {},
    forcedErrors: Record<string, { message: string; code?: string }> = {},
) {
    const tables: Record<string, Tbl> = {};
    for (const [k, v] of Object.entries(initial)) tables[k] = { rows: v };

    return {
        _tables: tables,
        from(table: string) {
            const tbl = (tables[table] ??= { rows: [] });
            const filters: { col: string; val: unknown }[] = [];
            let mode: "read" | "insert" | "upsert" | "update" | "delete" = "read";
            let returning = false;
            let patch: Row | null = null;
            let written: Row[] = [];
            const fail = forcedErrors[table];
            const matches = (row: Row) =>
                filters.every((f) => row[f.col] === f.val);

            function applyWrite() {
                if (mode === "update") {
                    written = tbl.rows.filter(matches);
                    for (const r of written) Object.assign(r, patch);
                } else if (mode === "delete") {
                    written = tbl.rows.filter(matches);
                    tbl.rows = tbl.rows.filter((r) => !matches(r));
                }
            }
            function resolveList() {
                if (fail) return { data: null, error: fail };
                if (mode === "read")
                    return { data: tbl.rows.filter(matches), error: null };
                applyWrite();
                return { data: returning ? written : null, error: null };
            }
            function resolveOne() {
                if (fail) return { data: null, error: fail };
                if (mode === "read")
                    return { data: tbl.rows.find(matches) ?? null, error: null };
                applyWrite();
                return {
                    data: (returning ? written : [])[0] ?? null,
                    error: null,
                };
            }

            const api = {
                select() {
                    if (mode !== "read") returning = true;
                    return this;
                },
                order() {
                    return this;
                },
                insert(row: Row | Row[]) {
                    mode = "insert";
                    const arr = Array.isArray(row) ? row : [row];
                    written = arr.map((r) => ({
                        id: r.id ?? crypto.randomUUID(),
                        ...r,
                    }));
                    for (const r of written) tbl.rows.push(r);
                    return this;
                },
                upsert(row: Row, opts?: { onConflict?: string }) {
                    mode = "upsert";
                    const cols = (opts?.onConflict ?? "")
                        .split(",")
                        .map((c) => c.trim())
                        .filter(Boolean);
                    const nullKey = cols.includes("key") && row.key == null;
                    const existing =
                        cols.length && !nullKey
                            ? tbl.rows.find((r) =>
                                  cols.every((c) => r[c] === row[c]),
                              )
                            : undefined;
                    if (existing) {
                        Object.assign(existing, row);
                        written = [existing];
                    } else {
                        const nr = { id: row.id ?? crypto.randomUUID(), ...row };
                        tbl.rows.push(nr);
                        written = [nr];
                    }
                    return this;
                },
                update(p: Row) {
                    mode = "update";
                    patch = p;
                    return this;
                },
                delete() {
                    mode = "delete";
                    return this;
                },
                eq(col: string, val: unknown) {
                    filters.push({ col, val });
                    return this;
                },
                maybeSingle() {
                    return Promise.resolve(resolveOne());
                },
                single() {
                    return Promise.resolve(resolveOne());
                },
                then(onFulfilled: (v: unknown) => unknown) {
                    return Promise.resolve(resolveList()).then(onFulfilled);
                },
            };
            return api;
        },
    } as never;
}

function entry(over: Partial<MemoryEntry>): MemoryEntry {
    return {
        id: over.id ?? crypto.randomUUID(),
        user_id: "u",
        kind: "preference",
        key: null,
        content: "x",
        value_json: {},
        is_active: true,
        priority: 0,
        updated_at: "2026-01-01T00:00:00Z",
        ...over,
    };
}

// --- personal memory: DB round-trip shape ---

async function testSetKeyedAndListRoundTrip() {
    const db = mockSupabase();
    await setPersonalMemoryEntry(db, "u1", {
        kind: "preference",
        key: "style.citation",
        content: "Prefers Bluebook citations",
    });
    const list = await listPersonalMemory(db, "u1");
    assert.equal(list.length, 1);
    assert.equal(list[0].content, "Prefers Bluebook citations");
    assert.equal(list[0].key, "style.citation");
}

async function testSetKeyedUpsertsToOneRow() {
    const db = mockSupabase();
    await setPersonalMemoryEntry(db, "u2", {
        kind: "preference",
        key: "style.citation",
        content: "Bluebook",
    });
    await setPersonalMemoryEntry(db, "u2", {
        kind: "preference",
        key: "style.citation",
        content: "ALWD",
    });
    const list = await listPersonalMemory(db, "u2");
    assert.equal(list.length, 1);
    assert.equal(list[0].content, "ALWD");
}

async function testNullKeyNotesDoNotCollide() {
    const db = mockSupabase();
    await setPersonalMemoryEntry(db, "u3", { kind: "note", content: "note A" });
    await setPersonalMemoryEntry(db, "u3", { kind: "note", content: "note B" });
    const list = await listPersonalMemory(db, "u3");
    assert.equal(list.length, 2);
}

async function testDisableRemovesFromActiveList() {
    const db = mockSupabase();
    await setPersonalMemoryEntry(db, "u4", {
        kind: "fact",
        key: "represents",
        content: "Represents landlords",
    });
    assert.equal((await listPersonalMemory(db, "u4")).length, 1);
    await disablePersonalMemoryEntry(db, "u4", { key: "represents" });
    assert.equal((await listPersonalMemory(db, "u4")).length, 0);
}

async function testDisableIsScopedToUser() {
    const db = mockSupabase();
    await setPersonalMemoryEntry(db, "owner", {
        kind: "fact",
        key: "k",
        content: "mine",
    });
    await setPersonalMemoryEntry(db, "other", {
        kind: "fact",
        key: "k",
        content: "theirs",
    });
    await disablePersonalMemoryEntry(db, "owner", { key: "k" });
    assert.equal((await listPersonalMemory(db, "owner")).length, 0);
    assert.equal((await listPersonalMemory(db, "other")).length, 1);
}

// --- pure selection/merge/format logic ---

async function testPersonalOverridesFirmOnSameKey() {
    const personal = [entry({ key: "style.citation", content: "Bluebook" })];
    const firm = [
        entry({ firm_id: "f", user_id: undefined, key: "style.citation", content: "ALWD" }),
        entry({ firm_id: "f", user_id: undefined, key: "nda.position", content: "Mutual only" }),
    ];
    const sel = selectMemoryForTurn(personal, firm);
    assert.ok(sel.personal.some((e) => e.key === "style.citation"));
    assert.ok(!sel.firm.some((e) => e.key === "style.citation"));
    assert.ok(sel.firm.some((e) => e.key === "nda.position"));
}

async function testBudgetTruncates() {
    const big = "x".repeat(100);
    const personal = [
        entry({ id: "a", content: big, updated_at: "2026-01-04T00:00:00Z" }),
        entry({ id: "b", content: big, updated_at: "2026-01-03T00:00:00Z" }),
        entry({ id: "c", content: big, updated_at: "2026-01-02T00:00:00Z" }),
        entry({ id: "d", content: big, updated_at: "2026-01-01T00:00:00Z" }),
    ];
    const sel = selectMemoryForTurn(personal, [], { charBudget: 250 });
    assert.equal(sel.personal.length, 2);
    assert.equal(sel.truncated, true);
}

async function testNoTruncationUnderBudget() {
    const personal = [entry({ content: "short" })];
    const sel = selectMemoryForTurn(personal, [], { charBudget: 1000 });
    assert.equal(sel.truncated, false);
    assert.equal(sel.personal.length, 1);
}

async function testFormatMemoryLines() {
    const out = formatMemoryLines([
        entry({ content: "Represents landlords" }),
        entry({ content: "Prefers Bluebook" }),
    ]);
    assert.match(out, /- Represents landlords/);
    assert.match(out, /- Prefers Bluebook/);
}

// --- firm memory: suggest-then-approve ---

async function testProposeCreatesPendingCandidateNotInjected() {
    const db = mockSupabase();
    const cand = await proposeFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        proposedByUserId: "u1",
        kind: "preference",
        proposedKey: "nda.position",
        proposedContent: "Firm insists on mutual NDAs",
        rationale: "Seen across three matters",
    });
    assert.ok(cand);
    assert.equal(cand.status, "pending");
    // A pending candidate must NOT surface in injected firm memory.
    assert.equal((await listFirmMemory(db, "pilot-firm")).length, 0);
    assert.equal(
        (await listFirmMemoryCandidates(db, "pilot-firm", "pending")).length,
        1,
    );
}

async function testProposeDedupSuppressesDuplicatePending() {
    const db = mockSupabase();
    const args = {
        firmId: "pilot-firm",
        proposedByUserId: "u1",
        kind: "preference" as const,
        proposedKey: "nda.position",
        proposedContent: "x",
        rationale: "",
    };
    const a = await proposeFirmMemoryCandidate(db, args);
    const b = await proposeFirmMemoryCandidate(db, args);
    assert.ok(a);
    assert.equal(b, null);
    assert.equal(
        (await listFirmMemoryCandidates(db, "pilot-firm", "pending")).length,
        1,
    );
}

async function testApproveWritesEntryAndVersion() {
    const db = mockSupabase();
    const cand = await proposeFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        proposedByUserId: "u1",
        kind: "preference",
        proposedKey: "nda.position",
        proposedContent: "Mutual NDAs only",
        rationale: "",
    });
    const res = await approveFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        candidateId: cand!.id,
        reviewerUserId: "admin",
    });
    assert.equal(res.ok, true);
    const firm = await listFirmMemory(db, "pilot-firm");
    assert.equal(firm.length, 1);
    assert.equal(firm[0].content, "Mutual NDAs only");
    // a version snapshot was written
    const versions =
        (db as unknown as { _tables: Record<string, Tbl> })._tables
            .firm_memory_versions?.rows ?? [];
    assert.equal(versions.length, 1);
    // and the candidate is no longer pending
    assert.equal(
        (await listFirmMemoryCandidates(db, "pilot-firm", "pending")).length,
        0,
    );
}

async function testApproveIsStatusGuardedNoDoubleApply() {
    const db = mockSupabase();
    const cand = await proposeFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        proposedByUserId: "u1",
        kind: "fact",
        proposedKey: "k",
        proposedContent: "v",
        rationale: "",
    });
    const first = await approveFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        candidateId: cand!.id,
        reviewerUserId: "admin",
    });
    const second = await approveFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        candidateId: cand!.id,
        reviewerUserId: "admin",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal((await listFirmMemory(db, "pilot-firm")).length, 1);
}

async function testRejectDoesNotWriteEntry() {
    const db = mockSupabase();
    const cand = await proposeFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        proposedByUserId: "u1",
        kind: "note",
        proposedContent: "maybe",
        rationale: "",
    });
    const res = await rejectFirmMemoryCandidate(db, {
        firmId: "pilot-firm",
        candidateId: cand!.id,
        reviewerUserId: "admin",
        note: "not general enough",
    });
    assert.equal(res.ok, true);
    assert.equal((await listFirmMemory(db, "pilot-firm")).length, 0);
    assert.equal(
        (await listFirmMemoryCandidates(db, "pilot-firm", "pending")).length,
        0,
    );
}

// The firm-memory reads are exposed directly by /firm-memory routes, so a
// not-yet-applied migration 030 must degrade to "no firm memory" rather than
// 500 the page. Matches the tolerateMissingSchema precedent in calendar/
// recordings/email stores. Genuine errors must still surface.
async function testListFirmMemoryToleratesMissingSchema() {
    const db = mockSupabase(
        {},
        {
            firm_memory_entries: {
                message: 'relation "firm_memory_entries" does not exist',
                code: "42P01",
            },
        },
    );
    assert.deepEqual(await listFirmMemory(db, "pilot-firm"), []);
}

async function testListFirmCandidatesToleratesMissingSchema() {
    const db = mockSupabase(
        {},
        {
            firm_memory_candidates: {
                message: "Could not find the table in the schema cache",
                code: "PGRST205",
            },
        },
    );
    assert.deepEqual(
        await listFirmMemoryCandidates(db, "pilot-firm", "pending"),
        [],
    );
}

async function testRealFirmMemoryErrorsStillThrow() {
    const db = mockSupabase(
        {},
        { firm_memory_entries: { message: "connection reset by peer" } },
    );
    await assert.rejects(() => listFirmMemory(db, "pilot-firm"));
}

async function testDetectPrivateFactSignals() {
    assert.ok(
        detectPrivateFactSignals("Contact john@acme.com about the deal").length >
            0,
    );
    assert.ok(detectPrivateFactSignals("Call 415-555-1212 tomorrow").length > 0);
    assert.equal(
        detectPrivateFactSignals("Firm prefers mutual NDAs").length,
        0,
    );
}

async function main() {
    await testSetKeyedAndListRoundTrip();
    await testSetKeyedUpsertsToOneRow();
    await testNullKeyNotesDoNotCollide();
    await testDisableRemovesFromActiveList();
    await testDisableIsScopedToUser();
    await testPersonalOverridesFirmOnSameKey();
    await testBudgetTruncates();
    await testNoTruncationUnderBudget();
    await testFormatMemoryLines();
    await testProposeCreatesPendingCandidateNotInjected();
    await testProposeDedupSuppressesDuplicatePending();
    await testApproveWritesEntryAndVersion();
    await testApproveIsStatusGuardedNoDoubleApply();
    await testRejectDoesNotWriteEntry();
    await testListFirmMemoryToleratesMissingSchema();
    await testListFirmCandidatesToleratesMissingSchema();
    await testRealFirmMemoryErrorsStillThrow();
    await testDetectPrivateFactSignals();
    console.log("memory.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
