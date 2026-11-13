// backend/src/lib/playbooks.test.ts
import assert from "node:assert/strict";
import {
    resolveFirmId,
    getPlaybookEntry,
    getPlaybookEntries,
    getEffectivePlaybookEntries,
    setPlaybookEntry,
    listPlaybookEntries,
    deletePlaybookEntry,
    DEFAULT_SHARED_FIRM_ID,
} from "./playbooks";

// Minimal in-memory supabase mock matching the call patterns used by
// playbooks.ts. Every chain method returns `this` so the fluent API
// composes; the final method (`.single()`, `.maybeSingle()`, await on
// the builder) returns the captured result.

type Row = Record<string, unknown>;
type Tbl = { rows: Row[] };

function mockSupabase(
    initial: Record<string, Row[]> = {},
    forcedErrors: Record<string, { message: string }> = {},
) {
    const tables: Record<string, Tbl> = {};
    for (const [k, v] of Object.entries(initial)) tables[k] = { rows: v };

    return {
        _tables: tables,
        from(table: string) {
            const tbl = (tables[table] ??= { rows: [] });
            const filters: { col: string; val: unknown }[] = [];
            const inFilters: { col: string; vals: unknown[] }[] = [];
            let pending: Promise<unknown> | null = null;
            const matches = (row: Row) =>
                filters.every((f) => row[f.col] === f.val) &&
                inFilters.every((f) => f.vals.includes(row[f.col]));
            const fail = forcedErrors[table];
            const api = {
                select() {
                    return this;
                },
                insert(row: Row | Row[]) {
                    const arr = Array.isArray(row) ? row : [row];
                    for (const r of arr) {
                        tbl.rows.push({
                            id: r.id ?? crypto.randomUUID(),
                            ...r,
                        });
                    }
                    pending = Promise.resolve({
                        data: arr,
                        error: null,
                    });
                    return this;
                },
                update(patch: Row) {
                    for (const r of tbl.rows.filter(matches)) {
                        Object.assign(r, patch);
                    }
                    pending = Promise.resolve({ data: null, error: null });
                    return this;
                },
                upsert(row: Row, opts?: { onConflict?: string }) {
                    const conflictCols = (opts?.onConflict ?? "")
                        .split(",")
                        .map((c) => c.trim())
                        .filter(Boolean);
                    const existing = conflictCols.length
                        ? tbl.rows.find((r) =>
                              conflictCols.every((c) => r[c] === row[c]),
                          )
                        : undefined;
                    if (existing) {
                        Object.assign(existing, row);
                    } else {
                        tbl.rows.push({ id: row.id ?? crypto.randomUUID(), ...row });
                    }
                    pending = Promise.resolve({ data: null, error: null });
                    return this;
                },
                delete() {
                    pending = (async () => {
                        const before = tbl.rows.length;
                        tbl.rows = tbl.rows.filter((row) => !matches(row));
                        return { data: null, error: null, count: before - tbl.rows.length };
                    })();
                    return this;
                },
                eq(col: string, val: unknown) {
                    filters.push({ col, val });
                    return this;
                },
                in(col: string, vals: unknown[]) {
                    inFilters.push({ col, vals });
                    return this;
                },
                limit() {
                    return this;
                },
                maybeSingle() {
                    if (fail) return Promise.resolve({ data: null, error: fail });
                    const match = tbl.rows.find(matches);
                    return Promise.resolve({
                        data: match ?? null,
                        error: null,
                    });
                },
                single() {
                    if (fail) return Promise.resolve({ data: null, error: fail });
                    const match = tbl.rows.find(matches);
                    return Promise.resolve({
                        data: match ?? null,
                        error: match
                            ? null
                            : { message: "not found", code: "PGRST116" },
                    });
                },
                then(onFulfilled: (v: unknown) => unknown) {
                    if (pending) return pending.then(onFulfilled);
                    if (fail) {
                        return Promise.resolve({ data: null, error: fail }).then(
                            onFulfilled,
                        );
                    }
                    const matched = tbl.rows.filter(matches);
                    return Promise.resolve({
                        data: matched,
                        error: null,
                    }).then(onFulfilled);
                },
            };
            return api;
        },
    } as never; // matches the surface area we use; full Supabase typing is irrelevant for tests
}

// Single-firm model: resolveFirmId returns the deployment's shared firm
// slug (env FIRM_ID) for EVERY user — never the per-user id — so all
// colleagues share one firm playbook/memory. Falls back loudly to
// "pilot-firm" when FIRM_ID is unset (never per-user).
async function testResolveFirmIdUsesEnvSlugForEveryone() {
    const prev = process.env.FIRM_ID;
    process.env.FIRM_ID = "acme-firm";
    try {
        assert.equal(await resolveFirmId("user-abc"), "acme-firm");
        assert.equal(await resolveFirmId("user-xyz"), "acme-firm");
    } finally {
        if (prev === undefined) delete process.env.FIRM_ID;
        else process.env.FIRM_ID = prev;
    }
}

async function testResolveFirmIdFallsBackWhenUnset() {
    const prev = process.env.FIRM_ID;
    delete process.env.FIRM_ID;
    try {
        const id = await resolveFirmId("user-abc");
        assert.equal(id, "pilot-firm");
        assert.notEqual(id, "user-abc");
    } finally {
        if (prev === undefined) delete process.env.FIRM_ID;
        else process.env.FIRM_ID = prev;
    }
}

async function testSetAndGetEntryRoundTrip() {
    const db = mockSupabase();
    await setPlaybookEntry(db, "user-x", "nda.standard_positions", {
        value: { mutual: true },
        notes_md: "Anthropic default",
    });
    const entry = await getPlaybookEntry(
        db,
        "user-x",
        "nda.standard_positions",
    );
    assert.deepEqual(entry?.value_json, { mutual: true });
    assert.equal(entry?.notes_md, "Anthropic default");
}

async function testGetEntriesBatch() {
    const db = mockSupabase();
    await setPlaybookEntry(db, "user-y", "a", { value: 1 });
    await setPlaybookEntry(db, "user-y", "b", { value: 2 });
    const entries = await getPlaybookEntries(db, "user-y", ["a", "b"]);
    assert.equal(entries.a?.value_json, 1);
    assert.equal(entries.b?.value_json, 2);
}

async function testListEntriesEmptyForUnknownFirm() {
    const db = mockSupabase();
    const list = await listPlaybookEntries(db, "ghost-user");
    assert.deepEqual(list, []);
}

// 1.2: a concurrent double-write on the same key must collapse to a
// single row via the atomic upsert (not produce two rows).
async function testConcurrentSetCollapsesToOneRow() {
    const db = mockSupabase();
    await Promise.all([
        setPlaybookEntry(db, "user-z", "k", { value: 1 }),
        setPlaybookEntry(db, "user-z", "k", { value: 2 }),
    ]);
    const all = await listPlaybookEntries(db, "user-z");
    const forKey = all.filter((e) => e.key === "k");
    assert.equal(forKey.length, 1);
}

// 1.1: getPlaybookEntries returns only the requested keys, built from
// the single .in() result.
async function testGetEntriesBatchFiltersByKey() {
    const db = mockSupabase();
    await setPlaybookEntry(db, "user-w", "a", { value: 1 });
    await setPlaybookEntry(db, "user-w", "b", { value: 2 });
    await setPlaybookEntry(db, "user-w", "c", { value: 3 });
    const entries = await getPlaybookEntries(db, "user-w", ["a", "c"]);
    assert.deepEqual(Object.keys(entries).sort(), ["a", "c"]);
    assert.equal(entries.a?.value_json, 1);
    assert.equal(entries.c?.value_json, 3);
}

// 1.4: delete removes the entry so a subsequent read is a genuine miss.
async function testDeleteEntryRemovesRow() {
    const db = mockSupabase();
    await setPlaybookEntry(db, "user-d", "gone", { value: 1 });
    assert.ok(await getPlaybookEntry(db, "user-d", "gone"));
    await deletePlaybookEntry(db, "user-d", "gone");
    assert.equal(await getPlaybookEntry(db, "user-d", "gone"), null);
}

// 1.3: a forced query error must throw, not be swallowed into null/[].
async function testReadErrorsThrow() {
    const fail = { message: "boom" };
    // ensurePlaybook creates the row first, then we force the entries
    // read to error.
    const seed = mockSupabase();
    await setPlaybookEntry(seed, "user-e", "k", { value: 1 });
    const seedTables = (seed as unknown as { _tables: Record<string, Tbl> })
        ._tables;
    const playbookRows = seedTables.firm_playbooks.rows;
    const entryRows = seedTables.playbook_entries.rows;

    const db = mockSupabase(
        { firm_playbooks: playbookRows, playbook_entries: entryRows },
        { playbook_entries: fail },
    );
    await assert.rejects(() => getPlaybookEntry(db, "user-e", "k"));
    await assert.rejects(() => getPlaybookEntries(db, "user-e", ["k"]));
    await assert.rejects(() => listPlaybookEntries(db, "user-e"));
}

// 2.4: firm override present → firm value wins over the seeded default.
async function testEffectiveFirmOverrideWins() {
    const db = mockSupabase();
    await setPlaybookEntry(db, DEFAULT_SHARED_FIRM_ID, "nda.positions", {
        value: "DEFAULT",
    });
    await setPlaybookEntry(db, "firm-1", "nda.positions", { value: "FIRM" });
    const eff = await getEffectivePlaybookEntries(db, "firm-1", [
        "nda.positions",
    ]);
    assert.equal(eff["nda.positions"]?.value_json, "FIRM");
}

// 2.4: firm has no entry → falls back to the default-shared value.
async function testEffectiveFallsBackToDefault() {
    const db = mockSupabase();
    await setPlaybookEntry(db, DEFAULT_SHARED_FIRM_ID, "nda.positions", {
        value: "DEFAULT",
    });
    const eff = await getEffectivePlaybookEntries(db, "firm-2", [
        "nda.positions",
    ]);
    assert.equal(eff["nda.positions"]?.value_json, "DEFAULT");
}

// 2.4: key absent from BOTH firm and default-shared → omitted entirely.
async function testEffectiveAbsentInBothOmitted() {
    const db = mockSupabase();
    await setPlaybookEntry(db, DEFAULT_SHARED_FIRM_ID, "present.key", {
        value: 1,
    });
    const eff = await getEffectivePlaybookEntries(db, "firm-3", [
        "present.key",
        "missing.key",
    ]);
    assert.equal(eff["present.key"]?.value_json, 1);
    assert.equal("missing.key" in eff, false);
    assert.deepEqual(Object.keys(eff), ["present.key"]);
}

// 2.4: mixed — some keys overridden by the firm, others inherited.
async function testEffectiveMixedFirmAndDefault() {
    const db = mockSupabase();
    await setPlaybookEntry(db, DEFAULT_SHARED_FIRM_ID, "a", { value: "dA" });
    await setPlaybookEntry(db, DEFAULT_SHARED_FIRM_ID, "b", { value: "dB" });
    await setPlaybookEntry(db, "firm-4", "b", { value: "fB" });
    const eff = await getEffectivePlaybookEntries(db, "firm-4", ["a", "b"]);
    assert.equal(eff.a?.value_json, "dA"); // inherited
    assert.equal(eff.b?.value_json, "fB"); // overridden
}

async function main() {
    await testResolveFirmIdUsesEnvSlugForEveryone();
    await testResolveFirmIdFallsBackWhenUnset();
    await testSetAndGetEntryRoundTrip();
    await testGetEntriesBatch();
    await testGetEntriesBatchFiltersByKey();
    await testListEntriesEmptyForUnknownFirm();
    await testConcurrentSetCollapsesToOneRow();
    await testDeleteEntryRemovesRow();
    await testReadErrorsThrow();
    await testEffectiveFirmOverrideWins();
    await testEffectiveFallsBackToDefault();
    await testEffectiveAbsentInBothOmitted();
    await testEffectiveMixedFirmAndDefault();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
