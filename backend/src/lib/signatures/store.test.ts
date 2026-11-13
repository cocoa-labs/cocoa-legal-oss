// backend/src/lib/signatures/store.test.ts
import assert from "node:assert/strict";

import {
    claimEnvelopeForCompletion,
    claimEnvelopeForSending,
    createEnvelope,
    releaseEnvelopeSendClaim,
    dedupeSignerInputs,
    markSignerSigned,
    normalizeEventPayload,
    repinEnvelopeSourceVersion,
    revokePendingSignerTokens,
} from "./store";
import type { SignerInput } from "./types";

// Minimal chainable Supabase stub: builder methods return the same object; the
// conditional-claim chain (.update().eq().eq().select().maybeSingle()) resolves
// to the single matched row, or null when the status WHERE didn't match.
function makeDb(rows: unknown[]) {
    const c: Record<string, unknown> = {
        update: () => c,
        eq: () => c,
        select: () => c,
        maybeSingle: () =>
            Promise.resolve({ data: rows[0] ?? null, error: null }),
    };
    return { from: () => c } as never;
}

// Recording stub: logs every builder call so tests can assert the exact
// conditional filters a store function issues — for the claim/guard functions
// the WHERE clause IS the concurrency contract, so the filters are what we
// pin, not just the win/lose outcome.
function makeRecordingDb(result: { data?: unknown }) {
    const calls: { method: string; args: unknown[] }[] = [];
    const c: Record<string, unknown> = {};
    const record =
        (method: string) =>
        (...args: unknown[]) => {
            calls.push({ method, args });
            return c;
        };
    for (const m of ["update", "eq", "neq", "in", "not", "select"]) {
        c[m] = record(m);
    }
    c.maybeSingle = () =>
        Promise.resolve({ data: result.data ?? null, error: null });
    // Supabase builders are thenables; store functions that end on a filter
    // (revokePendingSignerTokens) await the chain directly.
    c.then = (resolve: (v: unknown) => void) =>
        resolve({ data: result.data ?? null, error: null });
    return { db: { from: () => c } as never, calls };
}

// Insert recorder for createEnvelope. Two different chain shapes run against
// two different tables: the envelope is .insert().select().single(), while the
// signer rows are .insert().select() awaited directly (Supabase builders are
// thenables). Inserts are keyed by table so an assertion can never accidentally
// read the signers payload when it means the envelope's.
function makeInsertRecordingDb(rows: {
    envelope: Record<string, unknown>;
    signers?: unknown[];
}) {
    const inserts: { table: string; payload: unknown }[] = [];
    const db = {
        from(table: string) {
            const c: Record<string, unknown> = {};
            c.insert = (payload: unknown) => {
                inserts.push({ table, payload });
                return c;
            };
            c.select = () => c;
            c.single = () =>
                Promise.resolve({ data: rows.envelope, error: null });
            c.then = (resolve: (v: unknown) => void) =>
                resolve({ data: rows.signers ?? [], error: null });
            return c;
        },
    } as never;
    return { db, inserts };
}

function makeEnvelopeRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "env1",
        user_id: "u1",
        org_id: null,
        project_id: null,
        chat_id: null,
        agent_operation_id: null,
        document_id: "doc1",
        source_version_id: null,
        subject: "Signature request",
        message: "",
        status: "pending_approval",
        original_pdf_path: "",
        original_sha256: "",
        expires_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

const BASE_ENVELOPE_INPUT = {
    userId: "u1",
    documentId: "doc1",
    subject: "Signature request",
    message: "",
    originalPdfPath: "",
    originalSha256: "",
    signers: [
        { name: "Counterparty", email: "cp@example.com", role: "signer" },
    ] as SignerInput[],
};

function envelopeInsertPayload(
    inserts: { table: string; payload: unknown }[],
): Record<string, unknown> {
    const row = inserts.find((i) => i.table === "signature_envelopes");
    assert.ok(row, "createEnvelope must insert into signature_envelopes");
    return row.payload as Record<string, unknown>;
}

// signature_envelopes.source_version_id is the whole integrity story for the
// chat signature flow: send_for_signature only STAGES an envelope, and the
// approve route renders whatever loadActiveVersion(documentId, db, <pin>)
// resolves. A dropped pin there means approval renders documents'
// current_version_id — the document as of APPROVAL — and the signer
// cryptographically signs bytes nobody reviewed when the request was prepared.
// Nothing else asserted the insert shape, so the column could be dropped from
// this payload without a single test going red.
async function testCreateEnvelopePinsSourceVersion() {
    const { db, inserts } = makeInsertRecordingDb({
        envelope: makeEnvelopeRow({ source_version_id: "v-7" }),
        signers: [],
    });
    const created = await createEnvelope(db, {
        ...BASE_ENVELOPE_INPUT,
        sourceVersionId: "v-7",
    });
    assert.equal(
        envelopeInsertPayload(inserts).source_version_id,
        "v-7",
        "the proposed version must be written to the row, not left for approval time to guess",
    );
    assert.equal(
        created?.envelope.source_version_id,
        "v-7",
        "and it must survive serialization back to the caller",
    );
}

// The unpinned case must be an explicit null rather than an absent key:
// `undefined` is dropped from a Supabase insert body, which would silently
// take the column's DB-side default instead of the value this function chose.
async function testCreateEnvelopeOmittedSourceVersionIsExplicitNull() {
    const { db, inserts } = makeInsertRecordingDb({
        envelope: makeEnvelopeRow(),
        signers: [],
    });
    await createEnvelope(db, BASE_ENVELOPE_INPUT);
    const payload = envelopeInsertPayload(inserts);
    assert.ok(
        "source_version_id" in payload,
        "the key must always be present, never merely undefined",
    );
    assert.equal(payload.source_version_id, null);
}

// Regression guard for the self-signing deadlock. An envelope with the same
// email on two `signer` rows could never reach 'completed': sign-self only ever
// reaches the lowest-order pending row, and approval mints no magic-link token
// for a self-matching row, so the second row was strandable forever
// (allSignersComplete requires every `signer` row to be 'signed'). De-duping
// signer inputs at creation removes that precondition.
//   See routes/signatures.ts (sign-self / approve) and
//   store.findSignerByEnvelopeAndEmail.

async function testCollapsesDuplicateSignerEmails() {
    const signers: SignerInput[] = [
        { name: "Me", email: "self@example.com", role: "signer" },
        { name: "Me again", email: "self@example.com", role: "signer" },
    ];
    const result = dedupeSignerInputs(signers);
    assert.equal(
        result.length,
        1,
        "duplicate signer email must collapse to a single row",
    );
    assert.equal(result[0].email, "self@example.com");
    assert.equal(result[0].role, "signer");
}

async function testMatchIsCaseAndWhitespaceInsensitive() {
    const signers: SignerInput[] = [
        { name: "Me", email: "Self@Example.com", role: "signer" },
        { name: "Me again", email: "  self@example.com  ", role: "signer" },
    ];
    assert.equal(dedupeSignerInputs(signers).length, 1);
}

async function testPreservesDistinctSignersAndOrder() {
    const signers: SignerInput[] = [
        { name: "Owner", email: "owner@example.com", role: "signer" },
        { name: "Counterparty", email: "cp@example.com", role: "signer" },
    ];
    const result = dedupeSignerInputs(signers);
    assert.equal(result.length, 2);
    assert.deepEqual(
        result.map((s) => s.email),
        ["owner@example.com", "cp@example.com"],
    );
}

async function testNeverDowngradesSignerToCc() {
    // A cc listed before a signer with the same email must collapse to a
    // *signer* — otherwise that person is never asked to sign, and an envelope
    // left with zero `signer` rows would vacuously "complete" with no
    // signatures at all.
    const signers: SignerInput[] = [
        { name: "Watcher", email: "dual@example.com", role: "cc" },
        { name: "Signer", email: "dual@example.com", role: "signer" },
    ];
    const result = dedupeSignerInputs(signers);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, "signer");
}

async function testDropsBlankEmails() {
    const signers: SignerInput[] = [
        { name: "Ghost", email: "   ", role: "signer" },
        { name: "Real", email: "real@example.com", role: "signer" },
    ];
    const result = dedupeSignerInputs(signers);
    assert.equal(result.length, 1);
    assert.equal(result[0].email, "real@example.com");
}

// Regression guard for the signer-page 500. `signature_events.payload` is
// `jsonb NOT NULL default '{}'`; a column default does not apply to an explicit
// null, so recordEvent must never insert null. The `viewed` event (GET
// /sign/:token) is the only caller that passes no payload, so a `?? null`
// regression there 500s every signer-page load. normalizeEventPayload pins {}.
function testNormalizesMissingPayloadToObject() {
    assert.deepEqual(normalizeEventPayload(), {}, "undefined payload -> {}");
    assert.deepEqual(normalizeEventPayload(null), {}, "null payload -> {}");
}

function testPreservesProvidedPayload() {
    const payload = { approved_by: "u1", signer_count: 2 };
    assert.deepEqual(normalizeEventPayload(payload), payload);
}

// claimEnvelopeForSending is the mutex that stops two concurrent approvals from
// both dispatching signing links. The conditional UPDATE (status still
// pending_approval) matches a row → this caller won the claim; matches nothing
// → null, and the caller bails (the other send owns it).
async function testClaimEnvelopeForSending() {
    const { db, calls } = makeRecordingDb({
        data: { id: "env1", status: "sent" },
    });
    const claim = {
        userId: "u1",
        at: "2026-01-01T00:00:00Z",
        originalPdfPath: "signatures/u1/env1/original.pdf",
        originalSha256: "abc123",
    };
    const won = await claimEnvelopeForSending(db, "env1", claim);
    assert.equal(won?.id, "env1", "matched row → claimed");
    const update = calls.find((call) => call.method === "update");
    assert.deepEqual(update?.args[0], {
        status: "sent",
        approved_by: claim.userId,
        approved_at: claim.at,
        original_pdf_path: claim.originalPdfPath,
        original_sha256: claim.originalSha256,
    });

    const lost = await claimEnvelopeForSending(makeDb([]), "env1", claim);
    assert.equal(lost, null, "no row matched → not claimed");
}

async function testReleaseEnvelopeSendClaim(): Promise<void> {
    const { db, calls } = makeRecordingDb({ data: { id: "env1" } });
    assert.equal(await releaseEnvelopeSendClaim(db, "env1"), true);
    const update = calls.find((call) => call.method === "update");
    assert.deepEqual(update?.args[0], { status: "pending_approval" });
    const filters = calls.filter((call) => call.method === "eq");
    assert.deepEqual(
        filters.map((call) => call.args),
        [
            ["id", "env1"],
            ["status", "sent"],
        ],
        "rollback must never overwrite a completed/cancelled envelope",
    );

    assert.equal(
        await releaseEnvelopeSendClaim(makeRecordingDb({}).db, "env1"),
        false,
    );
}

// repinEnvelopeSourceVersion moves an envelope's provenance pin when the
// approver explicitly chooses "send the current version" over the version the
// request was prepared against. The `status = pending_approval` filter is the
// CONTRACT, not an implementation detail: an envelope that already dispatched
// has signers looking at the bytes the old pin named, and rewriting
// source_version_id there would make the audit trail claim they signed
// something else. Same reason it is conditional as claimEnvelopeForSending.
async function testRepinEnvelopeSourceVersion(): Promise<void> {
    const { db, calls } = makeRecordingDb({
        data: makeEnvelopeRow({ source_version_id: "v-9" }),
    });
    const repinned = await repinEnvelopeSourceVersion(db, "env1", "v-9");
    assert.equal(repinned?.source_version_id, "v-9");

    const update = calls.find((call) => call.method === "update");
    assert.deepEqual(
        update?.args[0],
        { source_version_id: "v-9" },
        "the re-pin touches ONLY the pin — status, approver, and artifact " +
            "columns belong to the claim that runs after it",
    );
    const filters = calls.filter((call) => call.method === "eq");
    assert.deepEqual(
        filters.map((call) => call.args),
        [
            ["id", "env1"],
            ["status", "pending_approval"],
        ],
        "an override must never rewrite the provenance of an envelope that " +
            "already dispatched or was cancelled",
    );
}

async function testRepinEnvelopeSourceVersionLostRace(): Promise<void> {
    assert.equal(
        await repinEnvelopeSourceVersion(makeRecordingDb({}).db, "env1", "v-9"),
        null,
        "no row matched (already sent / cancelled) → null so the caller declines to send, not a throw",
    );
}

// claimEnvelopeForCompletion is the last-signer mutex: a double-submitted or
// concurrent final signature must not run the (slow, non-transactional)
// stamping/PKCS#12 pipeline twice. The conditional UPDATE claims 'completed'
// upfront — only the winner proceeds into runCompletion; the loser gets null
// and skips it (its signature is already recorded). The filters are the
// contract: id match + status still awaiting signatures.
async function testClaimEnvelopeForCompletionWinner() {
    const { db, calls } = makeRecordingDb({
        data: { id: "env1", status: "completed" },
    });
    const won = await claimEnvelopeForCompletion(db, "env1");
    assert.equal(won?.id, "env1", "matched row → claimed");
    assert.equal(won?.status, "completed");

    const update = calls.find((c) => c.method === "update");
    assert.deepEqual(
        update?.args[0],
        { status: "completed" },
        "the claim flips ONLY status; artifact metadata lands later in runCompletion",
    );
    const eq = calls.find((c) => c.method === "eq");
    assert.deepEqual(eq?.args, ["id", "env1"]);
    const inFilter = calls.find((c) => c.method === "in");
    assert.deepEqual(
        inFilter?.args,
        ["status", ["sent", "partially_signed"]],
        "claim must only fire while the envelope is awaiting signatures — " +
            "a cancelled/completed envelope must never be (re)claimed",
    );
}

async function testClaimEnvelopeForCompletionLoser() {
    const lost = await claimEnvelopeForCompletion(
        makeRecordingDb({}).db,
        "env1",
    );
    assert.equal(
        lost,
        null,
        "no row matched (another claim won, or envelope cancelled) → null, not a throw",
    );
}

// markSignerSigned must be conditional on status <> 'signed': the route-level
// already-signed check reads the signer before updating, so two near-simultaneous
// submits both pass it. The WHERE guard makes the row update single-winner; a
// no-row result tells the caller "already signed" (409) instead of silently
// double-recording the signature.
async function testMarkSignerSignedGuard() {
    const signedRow = {
        id: "s1",
        envelope_id: "env1",
        status: "signed",
        email: "a@example.com",
        name: "A",
        role: "signer",
        order_index: 0,
    };
    const { db, calls } = makeRecordingDb({ data: signedRow });
    const won = await markSignerSigned(db, "s1", {
        typedName: "A",
        signatureImagePath: "signatures/u/e/signers/s1/signature.png",
        ip: "1.2.3.4",
        userAgent: "ua",
        consentAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(won?.id, "s1", "matched row → signer returned");

    const neq = calls.find((c) => c.method === "neq");
    assert.deepEqual(
        neq?.args,
        ["status", "signed"],
        "update must carry the status <> 'signed' guard",
    );
    const eq = calls.find((c) => c.method === "eq");
    assert.deepEqual(eq?.args, ["id", "s1"]);

    const dup = await markSignerSigned(makeRecordingDb({}).db, "s1", {
        typedName: "A",
        signatureImagePath: "p",
        ip: "",
        userAgent: "",
        consentAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(
        dup,
        null,
        "already-signed row → no-row result (caller maps to 409), not a throw",
    );
}

// Cancel must revoke the magic links of everyone who hasn't finished: setting
// the envelope to 'cancelled' alone leaves live tokens behind (belt) — the
// route-level status guard is the braces. Signed/declined rows keep their
// hashes for the audit trail.
async function testRevokePendingSignerTokensScoping() {
    const { db, calls } = makeRecordingDb({});
    await revokePendingSignerTokens(db, "env1");

    const update = calls.find((c) => c.method === "update");
    assert.deepEqual(
        update?.args[0],
        { access_token_hash: null, token_expires_at: null },
        "revocation nulls the token hash AND its expiry",
    );
    const eq = calls.find((c) => c.method === "eq");
    assert.deepEqual(
        eq?.args,
        ["envelope_id", "env1"],
        "scoped to the envelope",
    );
    const notFilter = calls.find((c) => c.method === "not");
    assert.deepEqual(
        notFilter?.args,
        ["status", "in", '("signed","declined")'],
        "signed/declined rows are exempt — their tokens stay for the audit trail",
    );
}

async function main() {
    await testCollapsesDuplicateSignerEmails();
    await testMatchIsCaseAndWhitespaceInsensitive();
    await testPreservesDistinctSignersAndOrder();
    await testNeverDowngradesSignerToCc();
    await testDropsBlankEmails();
    testNormalizesMissingPayloadToObject();
    testPreservesProvidedPayload();
    await testClaimEnvelopeForSending();
    await testReleaseEnvelopeSendClaim();
    await testRepinEnvelopeSourceVersion();
    await testRepinEnvelopeSourceVersionLostRace();
    await testClaimEnvelopeForCompletionWinner();
    await testClaimEnvelopeForCompletionLoser();
    await testMarkSignerSignedGuard();
    await testRevokePendingSignerTokensScoping();
    await testCreateEnvelopePinsSourceVersion();
    await testCreateEnvelopeOmittedSourceVersionIsExplicitNull();
    console.log("store.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
