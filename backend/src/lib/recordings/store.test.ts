// backend/src/lib/recordings/store.test.ts
//
// The recordings store is the state machine under the transcription pipeline
// (T4–T7). What these tests pin is its concurrency + missing-schema tolerance
// contract, mirroring automation/runsStore.test.ts: for claimRecordingStep the
// conditional WHERE (id + status=from) IS the per-step mutex, for
// acquireRecordingsLease the CAS on updated_at IS the single-scheduler
// guarantee, and (mirroring lib/email/store.ts) every store call degrades to a
// null/empty/0 fallback — never a throw — when migration 025 is unapplied. The
// jsonb parsers are pinned as never-throw sanitizers of untrusted DB rows.
// Scripted Supabase stubs only — no live database.
import assert from "node:assert/strict";
import {
    RECORDINGS_LEASE_KEY,
    acquireRecordingsLease,
    backoffDelayMs,
    claimRecordingStep,
    createRecording,
    getRecording,
    isLeaseClaimable,
    isMissingRecordingsSchema,
    listDueRecordings,
    listRecordings,
    markStalledRecordingsQueued,
    scheduleRetry,
    updateRecording,
} from "./store";
import {
    RECORDING_STATUSES,
    parseActionItems,
    parseUtterances,
} from "./types";

// Scripted chainable Supabase stub: each db.from() consumes the next scripted
// result; every builder call is recorded so tests can pin tables, filters and
// payloads. Terminal reads (single / maybeSingle / awaiting the chain itself)
// resolve to the scripted {data, error, count}. Mirror of runsStore.test.ts.
interface ChainLog {
    table: string;
    calls: { method: string; args: unknown[] }[];
}

function makeDb(script: { data?: unknown; error?: unknown; count?: number }[]) {
    const chains: ChainLog[] = [];
    let next = 0;
    const makeChain = (
        log: ChainLog,
        result: { data?: unknown; error?: unknown; count?: number },
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
            count: result.count ?? null,
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

// A fully-populated recordings row, so serializeRecording produces a complete
// Recording. Individual tests spread over the fields they exercise.
const fullRow = {
    id: "rec-1",
    user_id: "user-1",
    project_id: null,
    chat_id: null,
    chat_message_id: null,
    title: "Deposition prep",
    source: "mic",
    status: "queued",
    audio_storage_key: "r2/rec-1.webm",
    audio_mime: "audio/webm",
    audio_size_bytes: 1024,
    duration_seconds: 42,
    consent_ack_at: "2026-07-16T00:00:00Z",
    assemblyai_transcript_id: null,
    utterances: [],
    transcript_text: null,
    summary_md: null,
    action_items: [],
    transcript_document_id: null,
    voice_briefing_document_id: null,
    timeline_image_document_id: null,
    email_id: null,
    error: null,
    retry_count: 0,
    next_attempt_at: "2026-07-16T00:00:00Z",
    created_at: "2026-07-16T00:00:00Z",
    updated_at: "2026-07-16T00:00:00Z",
};

// RECORDING_STATUSES is the DB check-constraint order — the state machine.
function testRecordingStatuses() {
    assert.deepEqual(RECORDING_STATUSES, [
        "queued",
        "transcribing",
        "summarizing",
        "ready",
        "failed",
    ]);
}

// createRecording enqueues one captured audio: status 'queued', due now.
async function testCreateRecordingInsertsQueued() {
    const { db, chains } = makeDb([{ data: { ...fullRow } }]);
    const rec = await createRecording(db, {
        userId: "user-1",
        source: "mic",
        audioStorageKey: "r2/rec-1.webm",
        audioMime: "audio/webm",
        audioSizeBytes: 1024,
        consentAckAt: "2026-07-16T00:00:00Z",
    });
    assert.ok(rec, "insert returned a row");
    assert.equal(rec?.status, "queued");

    assert.equal(chains[0].table, "recordings");
    const payload = callsOf(chains[0], "insert")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.status, "queued", "inserts in the queued state");
    assert.equal(payload.user_id, "user-1");
    assert.equal(payload.source, "mic");
    assert.equal(payload.audio_storage_key, "r2/rec-1.webm");
    assert.equal(
        typeof payload.next_attempt_at,
        "string",
        "next_attempt_at seeded to now so the first tick claims it",
    );
}

// The whole store degrades on an unapplied migration 025 instead of 500-ing —
// createRecording (a write) returns null, not a throw.
async function testCreateRecordingMissingSchema() {
    const { db } = makeDb([
        {
            error: {
                code: "42P01",
                message: 'relation "public.recordings" does not exist',
            },
        },
    ]);
    // tolerateMissingSchema logs a dev-mode warning on this path; pin
    // NODE_ENV=production to keep the test output pristine without changing
    // the behavior under test (mirrors email/store.test.ts).
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        const rec = await createRecording(db, {
            userId: "user-1",
            source: "mic",
            audioStorageKey: "k",
            audioMime: "audio/webm",
            audioSizeBytes: 0,
            consentAckAt: "2026-07-16T00:00:00Z",
        });
        assert.equal(rec, null, "missing schema degrades to null, not a throw");
    } finally {
        if (previousEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnv;
    }
}

// claimRecordingStep is the per-step mutex: two schedulers ticking the same
// recording resolve to a single winner via the conditional UPDATE.
async function testClaimRecordingStepWinner() {
    const { db, chains } = makeDb([
        { data: { ...fullRow, status: "transcribing" } },
    ]);
    const claimed = await claimRecordingStep(
        db,
        "rec-1",
        "queued",
        "transcribing",
    );
    assert.ok(claimed, "matched row → this caller won the claim");
    assert.equal(claimed?.status, "transcribing");

    assert.equal(chains[0].table, "recordings");
    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.deepEqual(
        Object.keys(payload).sort(),
        ["status", "updated_at"],
        "the claim flips ONLY status (updated_at bump is the heartbeat/stall marker)",
    );
    assert.equal(payload.status, "transcribing");
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [
            ["id", "rec-1"],
            ["status", "queued"],
        ],
        "the WHERE clause is the mutex: id match + status still `from`",
    );
}

async function testClaimRecordingStepLoser() {
    const claimed = await claimRecordingStep(
        makeDb([{ data: null }]).db,
        "rec-1",
        "queued",
        "transcribing",
    );
    assert.equal(
        claimed,
        null,
        "no row matched → claim lost, returns null not a throw",
    );
}

// listDueRecordings drives the scheduler tick: only queued + transcribing rows
// whose backoff has elapsed, oldest next_attempt_at first.
async function testListDueRecordings() {
    const { db, chains } = makeDb([
        { data: [{ ...fullRow, status: "transcribing" }] },
    ]);
    const due = await listDueRecordings(db, { limit: 5 });
    assert.equal(due.length, 1);
    assert.equal(due[0].id, "rec-1");
    assert.deepEqual(due[0].utterances, [], "jsonb defaults normalized");
    assert.deepEqual(due[0].action_items, []);

    assert.equal(chains[0].table, "recordings");
    assert.deepEqual(
        callsOf(chains[0], "in")[0].args,
        ["status", ["queued", "transcribing"]],
        "only queued + transcribing are due-claimable (summarizing/ready/failed are not)",
    );
    assert.match(
        String(callsOf(chains[0], "or")[0].args[0]),
        /^next_attempt_at\.is\.null,next_attempt_at\.lte\./,
        "due = never scheduled OR backoff elapsed",
    );
    assert.deepEqual(
        callsOf(chains[0], "order")[0].args,
        ["next_attempt_at", { ascending: true }],
        "oldest next_attempt_at first",
    );
    assert.deepEqual(callsOf(chains[0], "limit")[0].args, [5]);
}

// scheduleRetry below the cap: keep the current status, push next_attempt_at
// out by delayMs, bump retry_count.
async function testScheduleRetryBelowCap() {
    const { db, chains } = makeDb([
        { data: { ...fullRow, status: "transcribing", retry_count: 1 } }, // getRecordingAny
        { data: { ...fullRow, status: "transcribing", retry_count: 2 } }, // updateRecording
    ]);
    const before = Date.now();
    const updated = await scheduleRetry(db, "rec-1", {
        error: "assemblyai still processing",
        delayMs: 30_000,
        maxRetries: 3,
    });
    assert.ok(updated, "returns the updated row");
    assert.equal(updated?.status, "transcribing", "status kept below the cap");

    // The write is the second chain (updateRecording); the first is the read.
    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.ok(
        !("status" in payload),
        "below cap keeps the current status (no status key in the patch)",
    );
    assert.equal(payload.retry_count, 2, "retry_count incremented (1 → 2)");
    assert.equal(payload.error, "assemblyai still processing");
    const at = Date.parse(String(payload.next_attempt_at));
    assert.ok(
        at >= before + 30_000 && at <= Date.now() + 31_000,
        "next attempt lands ~delayMs in the future",
    );
    assert.equal(
        typeof payload.updated_at,
        "string",
        "updateRecording always bumps the heartbeat",
    );
    assert.deepEqual(callsOf(chains[1], "eq")[0].args, ["id", "rec-1"]);
}

// scheduleRetry at the cap: retry_count + 1 exceeds maxRetries → terminal
// failed, error stored, no further backoff scheduled.
async function testScheduleRetryAtCap() {
    const { db, chains } = makeDb([
        { data: { ...fullRow, status: "transcribing", retry_count: 3 } }, // getRecordingAny
        { data: { ...fullRow, status: "failed", retry_count: 4 } }, // updateRecording
    ]);
    const updated = await scheduleRetry(db, "rec-1", {
        error: "assemblyai rejected the audio",
        delayMs: 30_000,
        maxRetries: 3,
    });
    assert.equal(updated?.status, "failed");

    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(
        payload.status,
        "failed",
        "exceeding maxRetries → terminal failed",
    );
    assert.equal(
        payload.error,
        "assemblyai rejected the audio",
        "error stored on the failed row",
    );
    assert.ok(
        !("next_attempt_at" in payload),
        "a failed row is terminal — no further backoff scheduled",
    );
}

// scheduleRetry on a vanished/absent recording (or unapplied schema) → null,
// not a throw: the read degrades and short-circuits the write.
async function testScheduleRetryMissingRow() {
    const { db, chains } = makeDb([{ data: null }]); // getRecordingAny → null
    const updated = await scheduleRetry(db, "rec-1", {
        error: "boom",
        delayMs: 30_000,
        maxRetries: 3,
    });
    assert.equal(updated, null, "no row → null, and no write attempted");
    assert.equal(chains.length, 1, "the read short-circuits before any update");
}

// markStalledRecordingsQueued: only in-flight working rows older than the
// cutoff flip back to queued, due now, without consuming a retry.
async function testMarkStalledRecordingsQueued() {
    const { db, chains } = makeDb([{ data: [{ id: "a" }, { id: "b" }] }]);
    const recovered = await markStalledRecordingsQueued(db, {
        olderThanMs: 10 * 60_000,
    });
    assert.equal(recovered, 2);

    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.status, "queued");
    assert.equal(
        typeof payload.next_attempt_at,
        "string",
        "recovered rows are due immediately (next_attempt_at = now)",
    );
    assert.ok(
        !("retry_count" in payload),
        "recovery re-queues without consuming a retry (a crash is not a failed attempt)",
    );
    assert.deepEqual(
        callsOf(chains[0], "in")[0].args,
        ["status", ["transcribing", "summarizing"]],
        "only the in-flight working statuses are swept; queued/ready/failed are untouchable",
    );
    const lt = callsOf(chains[0], "lt")[0];
    assert.equal(lt.args[0], "updated_at");
    const cutoff = Date.parse(String(lt.args[1]));
    assert.ok(
        Number.isFinite(cutoff) && cutoff <= Date.now() - 10 * 60_000 + 1000,
        "cutoff is roughly now - olderThanMs",
    );
}

// isLeaseClaimable is the pure expiry decision under acquireRecordingsLease.
function testIsLeaseClaimable() {
    const now = Date.parse("2026-07-16T12:00:00Z");
    assert.equal(isLeaseClaimable(null, "me", now), true, "no lease row yet");
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "me", claimed_until: "2026-07-16T12:05:00Z" },
            "me",
            now,
        ),
        true,
        "an instance can always renew its own live lease",
    );
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "other", claimed_until: "2026-07-16T12:05:00Z" },
            "me",
            now,
        ),
        false,
        "another live holder → not claimable",
    );
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "other", claimed_until: "2026-07-16T11:59:59Z" },
            "me",
            now,
        ),
        true,
        "expired lease → claimable",
    );
    assert.equal(
        isLeaseClaimable({ claimed_by: "other", claimed_until: null }, "me", now),
        true,
        "a lease without expiry can never wedge the scheduler forever",
    );
    assert.equal(
        isLeaseClaimable(
            { claimed_by: "other", claimed_until: "not-a-date" },
            "me",
            now,
        ),
        true,
        "malformed expiry is treated as free, not a permanent lock",
    );
}

// acquireRecordingsLease: no row yet → insert wins the singleton lease.
async function testAcquireLeaseInsertsWhenFree() {
    const { db, chains } = makeDb([
        { data: null }, // no lease row yet
        {}, // insert succeeds
    ]);
    const got = await acquireRecordingsLease(db, "worker-a", 30_000);
    assert.equal(got, true);

    assert.equal(chains[1].table, "recordings_state");
    const payload = callsOf(chains[1], "insert")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.key, RECORDINGS_LEASE_KEY);
    assert.equal(payload.claimed_by, "worker-a");
    assert.equal(typeof payload.claimed_until, "string");
}

// An instance refreshes its OWN live lease via the CAS update.
async function testAcquireLeaseRefreshesOwn() {
    const future = new Date(Date.now() + 60_000).toISOString();
    const readRow = {
        claimed_by: "worker-a",
        claimed_until: future,
        updated_at: "2026-07-16T11:59:00+00:00",
    };
    const { db, chains } = makeDb([
        { data: readRow },
        { data: { key: RECORDINGS_LEASE_KEY } }, // CAS matched
    ]);
    assert.equal(await acquireRecordingsLease(db, "worker-a", 30_000), true);

    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.claimed_by, "worker-a");
    assert.deepEqual(
        callsOf(chains[1], "eq").map((c) => c.args),
        [
            ["key", RECORDINGS_LEASE_KEY],
            ["updated_at", readRow.updated_at],
        ],
        "refresh is CAS-guarded on updated_at",
    );
}

// A live FOREIGN lease is rejected — read only, no write.
async function testAcquireLeaseRejectsLiveHolder() {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { db, chains } = makeDb([
        {
            data: {
                claimed_by: "worker-b",
                claimed_until: future,
                updated_at: "2026-07-16T11:59:00+00:00",
            },
        },
    ]);
    assert.equal(await acquireRecordingsLease(db, "worker-a", 30_000), false);
    assert.equal(chains.length, 1, "a live foreign lease → read only, no write");
}

// An EXPIRED foreign lease is stolen via a CAS on updated_at; losing that CAS
// (someone moved the row between our read and write) → not acquired.
async function testAcquireLeaseStealsExpiredViaCas() {
    const past = new Date(Date.now() - 60_000).toISOString();
    const readRow = {
        claimed_by: "worker-b",
        claimed_until: past,
        updated_at: "2026-07-16T11:00:00+00:00",
    };
    const { db, chains } = makeDb([
        { data: readRow },
        { data: { key: RECORDINGS_LEASE_KEY } }, // CAS update matched
    ]);
    assert.equal(await acquireRecordingsLease(db, "worker-a", 30_000), true);

    const payload = callsOf(chains[1], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(payload.claimed_by, "worker-a");
    assert.deepEqual(
        callsOf(chains[1], "eq").map((c) => c.args),
        [
            ["key", RECORDINGS_LEASE_KEY],
            ["updated_at", readRow.updated_at],
        ],
        "the takeover is CAS-guarded on updated_at: only steal what nobody moved",
    );

    const lost = makeDb([{ data: readRow }, { data: null }]);
    assert.equal(
        await acquireRecordingsLease(lost.db, "worker-a", 30_000),
        false,
        "losing the CAS race → lease not acquired",
    );
}

// getRecording fetches by opaque id then applies standalone-owner or current
// project-membership policy. This fixture is standalone.
async function testGetRecordingTenancyScoped() {
    const { db, chains } = makeDb([{ data: { ...fullRow } }]);
    const rec = await getRecording(db, "rec-1", "user-1");
    assert.ok(rec);
    assert.deepEqual(
        callsOf(chains[0], "eq").map((c) => c.args),
        [["id", "rec-1"]],
        "single fetch resolves the opaque id before applying tenancy policy",
    );
}

// updateRecording takes a snake_case column patch and ALWAYS bumps updated_at.
async function testUpdateRecordingBumpsUpdatedAt() {
    const { db, chains } = makeDb([
        { data: { ...fullRow, status: "ready", summary_md: "# Notes" } },
    ]);
    const updated = await updateRecording(db, "rec-1", {
        status: "ready",
        summary_md: "# Notes",
    });
    assert.equal(updated?.status, "ready");

    const payload = callsOf(chains[0], "update")[0].args[0] as Record<
        string,
        unknown
    >;
    assert.equal(
        payload.status,
        "ready",
        "snake_case column patch keys pass through unchanged",
    );
    assert.equal(payload.summary_md, "# Notes");
    assert.equal(
        typeof payload.updated_at,
        "string",
        "ALWAYS bumps updated_at (the worker heartbeat)",
    );
    assert.deepEqual(callsOf(chains[0], "eq")[0].args, ["id", "rec-1"]);
}

// listRecordings is the user-facing library read: newest first, tenancy-scoped,
// optional project filter.
async function testListRecordingsNewestFirstScoped() {
    const { db, chains } = makeDb([{ data: [{ ...fullRow }] }]);
    await listRecordings(db, "user-1", { projectId: "proj-9", limit: 10 });
    const eqs = callsOf(chains[0], "eq").map((c) => c.args);
    assert.deepEqual(eqs[0], ["user_id", "user-1"], "tenancy filter first");
    assert.ok(
        eqs.some((a) => a[0] === "project_id" && a[1] === "proj-9"),
        "project filter applied",
    );
    assert.deepEqual(
        callsOf(chains[0], "order")[0].args,
        ["created_at", { ascending: false }],
        "newest first",
    );
}

// parseUtterances: well-formed arrays pass through; garbage members are dropped
// and thin ones coerced; it never throws.
function testParseUtterances() {
    const valid = [
        { speaker: "A", text: "Hello", start_ms: 0, end_ms: 500 },
        { speaker: "B", text: "Hi", start_ms: 500, end_ms: 900 },
    ];
    assert.deepEqual(
        parseUtterances(valid),
        valid,
        "well-formed utterances pass through unchanged",
    );

    assert.deepEqual(parseUtterances(null), [], "non-array → []");
    assert.deepEqual(parseUtterances("nope"), []);
    assert.deepEqual(parseUtterances(undefined), []);
    assert.deepEqual(parseUtterances({ speaker: "A" }), [], "object → []");

    const mixed = [
        { speaker: "A", text: "kept", start_ms: 1, end_ms: 2 },
        { text: "no speaker" }, // speaker → "", times → 0
        { speaker: "B" }, // no text → dropped
        42, // not an object → dropped
        null, // dropped
        { speaker: "C", text: "bad times", start_ms: "x", end_ms: NaN }, // times → 0
    ];
    const out = parseUtterances(mixed);
    assert.equal(out.length, 3, "two malformed members dropped");
    assert.deepEqual(out[0], {
        speaker: "A",
        text: "kept",
        start_ms: 1,
        end_ms: 2,
    });
    assert.deepEqual(
        out[1],
        { speaker: "", text: "no speaker", start_ms: 0, end_ms: 0 },
        "missing speaker → '', missing times → 0",
    );
    assert.deepEqual(
        out[2],
        { speaker: "C", text: "bad times", start_ms: 0, end_ms: 0 },
        "non-finite times coerced to 0",
    );

    assert.doesNotThrow(() => parseUtterances({ a: 1 }));
}

// parseActionItems: valid arrays pass through; garbage dropped; done/owner/due
// coerced (missing done → false, missing owner/due → null); never throws.
function testParseActionItems() {
    const valid = [
        { id: "1", text: "File motion", done: false, owner: "Sam", due: "2026-08-01" },
        { id: "2", text: "Call client", done: true, owner: null, due: null },
    ];
    assert.deepEqual(
        parseActionItems(valid),
        valid,
        "well-formed action items pass through unchanged",
    );

    assert.deepEqual(parseActionItems(null), []);
    assert.deepEqual(parseActionItems("nope"), []);
    assert.deepEqual(parseActionItems({}), []);

    const mixed = [
        { id: "a", text: "kept" }, // done → false, owner/due → null
        {
            id: "b",
            text: "explicit",
            done: true,
            owner: "Lee",
            due: "2026-09-01",
        },
        { text: "no id" }, // dropped
        { id: "c" }, // no text → dropped
        { id: "d", text: "coerced", done: "yes", owner: 5, due: 7 }, // non-bool/non-string coerced
        99, // dropped
    ];
    const out = parseActionItems(mixed);
    assert.equal(out.length, 3, "malformed members dropped");
    assert.deepEqual(out[0], {
        id: "a",
        text: "kept",
        done: false,
        owner: null,
        due: null,
    });
    assert.deepEqual(out[1], {
        id: "b",
        text: "explicit",
        done: true,
        owner: "Lee",
        due: "2026-09-01",
    });
    assert.deepEqual(
        out[2],
        { id: "d", text: "coerced", done: false, owner: null, due: null },
        "non-boolean done → false; non-string owner/due → null",
    );

    assert.doesNotThrow(() => parseActionItems([{ id: 1, text: 2 }]));
}

// backoffDelayMs: exponential from a 5s base, monotone non-decreasing, capped
// at 5 minutes, negatives clamped to the base.
function testBackoffDelayMs() {
    assert.equal(backoffDelayMs(0), 5_000, "base 5s");
    assert.equal(backoffDelayMs(1), 10_000);
    assert.equal(backoffDelayMs(2), 20_000);
    assert.equal(backoffDelayMs(3), 40_000);
    for (let i = 1; i <= 12; i++) {
        assert.ok(
            backoffDelayMs(i) >= backoffDelayMs(i - 1),
            "monotone non-decreasing",
        );
    }
    assert.equal(
        backoffDelayMs(6),
        5 * 60_000,
        "cap reached by retry 6 (2^6·5s = 320s > 300s)",
    );
    assert.equal(backoffDelayMs(100), 5 * 60_000, "capped at 5 minutes");
    assert.equal(backoffDelayMs(-5), 5_000, "negative retry clamps to the base");
}

// isMissingRecordingsSchema tolerates an unapplied migration 025 but a real
// outage must still surface (mirror of isMissingAutomationSchema).
function testIsMissingRecordingsSchema() {
    assert.equal(isMissingRecordingsSchema({ code: "42P01" }), true);
    assert.equal(isMissingRecordingsSchema({ code: "PGRST205" }), true);
    assert.equal(isMissingRecordingsSchema({ code: "PGRST204" }), true);
    assert.equal(isMissingRecordingsSchema({ code: "42703" }), true);
    assert.equal(
        isMissingRecordingsSchema({
            message: 'relation "public.recordings" does not exist',
        }),
        true,
    );
    assert.equal(
        isMissingRecordingsSchema({
            message:
                "Could not find the table 'public.recordings_state' in the schema cache",
        }),
        true,
    );
    assert.equal(
        isMissingRecordingsSchema(new Error("connection refused")),
        false,
        "a real outage is NOT a missing schema — it must surface",
    );
    assert.equal(isMissingRecordingsSchema(null), false);
    assert.equal(isMissingRecordingsSchema("42P01"), false);
}

async function main() {
    testRecordingStatuses();
    await testCreateRecordingInsertsQueued();
    await testCreateRecordingMissingSchema();
    await testClaimRecordingStepWinner();
    await testClaimRecordingStepLoser();
    await testListDueRecordings();
    await testScheduleRetryBelowCap();
    await testScheduleRetryAtCap();
    await testScheduleRetryMissingRow();
    await testMarkStalledRecordingsQueued();
    testIsLeaseClaimable();
    await testAcquireLeaseInsertsWhenFree();
    await testAcquireLeaseRefreshesOwn();
    await testAcquireLeaseRejectsLiveHolder();
    await testAcquireLeaseStealsExpiredViaCas();
    await testGetRecordingTenancyScoped();
    await testUpdateRecordingBumpsUpdatedAt();
    await testListRecordingsNewestFirstScoped();
    testParseUtterances();
    testParseActionItems();
    testBackoffDelayMs();
    testIsMissingRecordingsSchema();
    console.log("recordings/store.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
