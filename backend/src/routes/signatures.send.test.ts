import assert from "node:assert/strict";

import type { ActiveVersion } from "../lib/documentVersions";
import {
    DOCUMENT_LAYOUT_QA_FAILED,
    DocumentLayoutQaError,
} from "../lib/documentLayoutQa";
import {
    DOCUMENT_CONVERTER_UNAVAILABLE,
    DocumentConverterError,
} from "../lib/libreoffice";
import type {
    EnvelopeStatus,
    SignatureEnvelope,
    SignatureSigner,
} from "../lib/signatures/types";
import {
    isSignableEnvelopeStatus,
    renderAndSendEnvelope,
    resolveEnvelopeVersionState,
    sendFreshlyPinnedEnvelope,
    serializeEnvelopeDetail,
    type EnvelopeVersionState,
    type RenderAndSendDependencies,
} from "./signatures";

const envelope: SignatureEnvelope = {
    id: "env-1",
    org_id: null,
    user_id: "owner-1",
    project_id: null,
    chat_id: null,
    agent_operation_id: "op-1",
    document_id: "doc-1",
    source_version_id: "version-1",
    status: "pending_approval",
    subject: "Sign this",
    message: "",
    original_pdf_path: null,
    original_sha256: null,
    executed_pdf_path: null,
    executed_sha256: null,
    executed_document_id: null,
    executed_version_id: null,
    certificate_path: null,
    expires_at: null,
    approved_by: null,
    approved_at: null,
    completed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
};

const signer: SignatureSigner = {
    id: "signer-1",
    envelope_id: envelope.id,
    name: "External Signer",
    email: "signer@example.test",
    order_index: 0,
    role: "signer",
    status: "pending",
    token_expires_at: null,
    signature_image_path: null,
    typed_name: null,
    consent_at: null,
    viewed_at: null,
    signed_at: null,
    declined_at: null,
    decline_reason: null,
    signer_ip: null,
    signer_user_agent: null,
    created_at: envelope.created_at,
    updated_at: envelope.updated_at,
};

type EventRecord = { type: string; payload?: Record<string, unknown> | null };

function activeVersion(id: string, versionNumber: number): ActiveVersion {
    return {
        id,
        storage_path: `documents/${id}.docx`,
        pdf_storage_path: null,
        version_number: versionNumber,
        display_name: null,
        source: "assistant_edit",
    };
}

function dependencies(
    overrides: Partial<RenderAndSendDependencies> = {},
): RenderAndSendDependencies {
    const sentEnvelope = { ...envelope, status: "sent" as const };
    return {
        loadSource: async () => ({
            bytes: Buffer.from("docx"),
            filename: "fixture.docx",
            fileType: "docx",
        }),
        // Default: the document still sits on the version the fixture envelope
        // is pinned to, so the staleness gate is a no-op for every test that
        // is not about it.
        loadActive: async () => activeVersion(envelope.source_version_id!, 1),
        repinSourceVersion: async () => envelope,
        convertToPdf: async () => Buffer.from("%PDF-test"),
        verifyPdf: async (bytes) => ({
            schema_version: 1,
            artifact_type: "pdf",
            sha256: bytes.toString("hex"),
            checked_at: "2026-08-26T00:00:00.000Z",
            status: "passed",
            pdf: {
                analyzer_version: 1,
                sha256: bytes.toString("hex"),
                page_count: 1,
                text_item_count: 1,
                rendered_token_count: 1,
                expected_token_count: 0,
                expected_token_coverage: 1,
                ordered_token_coverage: 1,
                collision_count: 0,
                out_of_bounds_count: 0,
                affected_pages: [],
                failure_reasons: [],
                status: "passed",
            },
        }),
        upload: async () => undefined,
        claim: async () => sentEnvelope,
        loadEnvelope: async () => ({
            envelope: sentEnvelope,
            signers: [signer],
        }),
        revokeTokens: async () => undefined,
        releaseClaim: async () => true,
        dispatchLink: async () => "https://example.test/sign/token",
        addEvent: async () => undefined,
        failOperation: async () => null,
        updateOperation: async () => null,
        ...overrides,
    } as RenderAndSendDependencies;
}

const params = {
    envelope,
    signers: [signer],
    approverUserId: envelope.user_id,
    approverEmail: "owner@example.test",
};

async function testConverterFailureThenRecovery(): Promise<void> {
    let converterAvailable = false;
    let claims = 0;
    let dispatches = 0;
    let failedOperations = 0;
    const events: EventRecord[] = [];

    const deps = dependencies({
        convertToPdf: async () => {
            if (!converterAvailable) {
                throw new DocumentConverterError(
                    DOCUMENT_CONVERTER_UNAVAILABLE,
                    "missing soffice",
                );
            }
            return Buffer.from("%PDF-recovered");
        },
        claim: async () => {
            claims += 1;
            return { ...envelope, status: "sent" };
        },
        dispatchLink: async () => {
            dispatches += 1;
            return "https://example.test/sign/token";
        },
        addEvent: async (_db, input) => {
            events.push({ type: input.type, payload: input.payload });
        },
        failOperation: async () => {
            failedOperations += 1;
            return null;
        },
    });

    const failed = await renderAndSendEnvelope({} as never, params, deps);
    assert.deepEqual(failed, {
        ok: false,
        status: 503,
        code: DOCUMENT_CONVERTER_UNAVAILABLE,
        detail: "Document conversion is temporarily unavailable. The signature request remains pending and can be retried.",
    });
    assert.equal(envelope.status, "pending_approval");
    assert.equal(claims, 0, "conversion failure never claims the envelope");
    assert.equal(dispatches, 0, "conversion failure sends no signer links");
    assert.equal(failedOperations, 1);
    assert.deepEqual(events[0], {
        type: "send_failed",
        payload: {
            phase: "convert_source",
            code: DOCUMENT_CONVERTER_UNAVAILABLE,
            retryable: true,
        },
    });

    converterAvailable = true;
    const retried = await renderAndSendEnvelope({} as never, params, deps);
    assert.deepEqual(retried, { ok: true });
    assert.equal(claims, 1);
    assert.equal(dispatches, 1);
    assert.equal(events.at(-1)?.type, "sent");
}

async function testLayoutFailureNeverUploadsOrSends(): Promise<void> {
    let uploads = 0;
    let claims = 0;
    let dispatches = 0;
    const report = {
        schema_version: 1 as const,
        artifact_type: "pdf" as const,
        sha256: "failed",
        checked_at: "2026-08-26T00:00:00.000Z",
        status: "failed" as const,
        failure_code: DOCUMENT_LAYOUT_QA_FAILED,
    };
    const result = await renderAndSendEnvelope(
        {} as never,
        params,
        dependencies({
            verifyPdf: async () => {
                throw new DocumentLayoutQaError(
                    DOCUMENT_LAYOUT_QA_FAILED,
                    "Synthetic collision failure",
                    report,
                );
            },
            upload: async () => {
                uploads += 1;
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
        }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.status, 422);
        assert.equal(result.code, DOCUMENT_LAYOUT_QA_FAILED);
    }
    assert.equal(uploads, 0);
    assert.equal(claims, 0);
    assert.equal(dispatches, 0);
}

async function testDispatchFailureCleansUpAndRollsBack(): Promise<void> {
    let revoked = 0;
    let released = 0;
    let failedOperations = 0;
    const events: EventRecord[] = [];

    const result = await renderAndSendEnvelope(
        {} as never,
        params,
        dependencies({
            dispatchLink: async () => {
                throw new Error("email transport failed");
            },
            revokeTokens: async () => {
                revoked += 1;
            },
            releaseClaim: async () => {
                released += 1;
                return true;
            },
            addEvent: async (_db, input) => {
                events.push({ type: input.type, payload: input.payload });
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
        }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.status, 502);
        assert.equal(result.code, "SIGNATURE_SEND_FAILED");
        assert.match(result.detail, /remains pending/i);
    }
    assert.equal(revoked, 1, "newly minted signer tokens are revoked");
    assert.equal(released, 1, "the send claim returns to pending approval");
    assert.equal(failedOperations, 1);
    assert.deepEqual(events.at(-1), {
        type: "send_failed",
        payload: {
            phase: "dispatch_links",
            code: "SIGNATURE_SEND_FAILED",
            retryable: true,
        },
    });
}

// ---------------------------------------------------------------------------
// Staleness gate
//
// send_for_signature only STAGES an envelope; approval can land days later,
// after the document has been edited. Without this gate approval renders
// whatever loadActiveVersion resolves, so the signer cryptographically signs
// bytes nobody reviewed when the request was prepared.
// ---------------------------------------------------------------------------

/**
 * The document has moved on: it is now `version-5` (v5), while the fixture
 * envelope is still pinned to `version-1` (v2). Records every lookup so a test
 * can prove the gate ran — and, for the NULL-pin case, that it did not.
 */
function staleLoadActive(lookups: (string | null)[]) {
    return async (
        _documentId: string,
        _db: unknown,
        versionId?: string | null,
    ) => {
        lookups.push(versionId ?? null);
        return versionId
            ? activeVersion(versionId, 2)
            : activeVersion("version-5", 5);
    };
}

async function testPinnedMatchingCurrentSends(): Promise<void> {
    let claims = 0;
    let dispatches = 0;
    const lookups: (string | null)[] = [];

    const result = await renderAndSendEnvelope(
        {} as never,
        params,
        dependencies({
            loadActive: async (
                _documentId: string,
                _db: unknown,
                versionId?: string | null,
            ) => {
                lookups.push(versionId ?? null);
                return activeVersion("version-1", 2);
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
        }),
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(claims, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(
        lookups,
        [null],
        "the matching case must cost exactly ONE version lookup — it is the common path",
    );
}

async function testStalePinRefusesWithoutTouchingTheOperation(): Promise<void> {
    let claims = 0;
    let dispatches = 0;
    let failedOperations = 0;
    let repins = 0;
    const events: EventRecord[] = [];
    const lookups: (string | null)[] = [];

    const result = await renderAndSendEnvelope(
        {} as never,
        params,
        dependencies({
            loadActive: staleLoadActive(lookups),
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
            addEvent: async (_db, input) => {
                events.push({ type: input.type, payload: input.payload });
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
            repinSourceVersion: async () => {
                repins += 1;
                return envelope;
            },
        }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.status, 409);
        assert.equal(result.code, "SIGNATURE_STALE_VERSION");
        assert.match(
            result.detail,
            /prepared against version 2/,
            "the refusal must name the version the request was prepared against",
        );
        assert.match(
            result.detail,
            /now version 5/,
            "and the version the document has moved to",
        );
    }
    assert.equal(claims, 0, "a stale envelope is never claimed for sending");
    assert.equal(dispatches, 0, "and no signer link goes out");
    assert.equal(repins, 0, "no flag was passed, so nothing is re-pinned");
    // THE assertion that separates a refusal from every other failure path in
    // this function: failing the operation would mark the agent_operations row
    // terminal (failed, completed_at set) while the envelope stays
    // pending_approval and retryable — a dead row in the operations panel next
    // to a signature card still offering Approve.
    assert.equal(
        failedOperations,
        0,
        "a refusal awaiting the approver's decision must NOT fail the operation",
    );
    assert.deepEqual(
        events,
        [
            {
                type: "send_failed",
                payload: {
                    phase: "check_version",
                    code: "SIGNATURE_STALE_VERSION",
                    retryable: true,
                },
            },
        ],
        "exactly one audit event, attributable to the version check",
    );
    assert.deepEqual(
        lookups,
        [null, "version-1"],
        "current version first, then the pinned one to name it in the message",
    );
}

// A pin whose version row is gone is still a divergence — but the message must
// not invent a number for it, and must not claim it merely "changed" either.
async function testDanglingPinIsNamedAsGone(): Promise<void> {
    const result = await renderAndSendEnvelope(
        {} as never,
        params,
        dependencies({
            loadActive: async (
                _documentId: string,
                _db: unknown,
                versionId?: string | null,
            ) => (versionId ? null : activeVersion("version-5", 5)),
        }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.code, "SIGNATURE_STALE_VERSION");
        assert.match(
            result.detail,
            /prepared against an earlier version that no longer exists/,
        );
        assert.match(result.detail, /now version 5/);
    }
}

// The 409 sentence and the polled `version_state` describe the SAME envelope,
// and an approver may be looking at either surface. So the fact that separates
// "an earlier version" from "an earlier version that no longer exists" has to
// travel on `version_state` too — the second phrasing says re-prepare the
// request, the first reads as still sendable, and that is not a difference two
// cards may quietly disagree about.
async function testVersionStateCarriesThePreparedResolvedFlag(): Promise<void> {
    const urls = { executedPdfUrl: null, certificateUrl: null };
    const serialize = (state: EnvelopeVersionState | null) =>
        serializeEnvelopeDetail(envelope, [signer], urls, state).version_state;

    const dangling = await resolveEnvelopeVersionState(
        {} as never,
        envelope,
        async (_documentId, _db, versionId) =>
            versionId ? null : activeVersion("version-5", 5),
    );
    assert.deepEqual(
        serialize(dangling),
        {
            document_changed: true,
            prepared_version_number: null,
            current_version_number: 5,
            prepared_version_resolved: false,
        },
        "a pin whose row is gone must reach the client as such, not merely as 'changed'",
    );

    const moved = await resolveEnvelopeVersionState(
        {} as never,
        envelope,
        async (_documentId, _db, versionId) =>
            versionId
                ? activeVersion("version-1", 2)
                : activeVersion("version-5", 5),
    );
    assert.deepEqual(
        serialize(moved),
        {
            document_changed: true,
            prepared_version_number: 2,
            current_version_number: 5,
            prepared_version_resolved: true,
        },
        "a pin that still resolves is still sendable and must not read as deleted",
    );

    const matching = await resolveEnvelopeVersionState(
        {} as never,
        envelope,
        async () => activeVersion(envelope.source_version_id!, 1),
    );
    assert.deepEqual(serialize(matching), {
        document_changed: false,
        prepared_version_number: 1,
        current_version_number: 1,
        prepared_version_resolved: true,
    });
}

async function testLegacyNullPinSkipsTheGate(): Promise<void> {
    let claims = 0;
    let lookups = 0;
    const unpinned = { ...envelope, source_version_id: null };

    const result = await renderAndSendEnvelope(
        {} as never,
        { ...params, envelope: unpinned },
        dependencies({
            loadActive: async () => {
                lookups += 1;
                return activeVersion("version-5", 5);
            },
            claim: async () => {
                claims += 1;
                return { ...unpinned, status: "sent" };
            },
        }),
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(claims, 1);
    assert.equal(
        lookups,
        0,
        "legacy unpinned envelopes predate pinning: no comparison exists to make, and production has pending ones",
    );
}

async function testUseCurrentVersionRepinsThenSends(): Promise<void> {
    const repinCalls: unknown[][] = [];
    const loadedVersions: (string | null)[] = [];
    const events: EventRecord[] = [];
    let claims = 0;

    const result = await renderAndSendEnvelope(
        {} as never,
        { ...params, useCurrentVersion: true },
        dependencies({
            loadActive: staleLoadActive([]),
            repinSourceVersion: async (...args: unknown[]) => {
                repinCalls.push(args);
                return { ...envelope, source_version_id: "version-5" };
            },
            loadSource: async (
                _db: unknown,
                _documentId: string | null,
                sourceVersionId: string | null,
            ) => {
                loadedVersions.push(sourceVersionId);
                return {
                    bytes: Buffer.from("docx"),
                    filename: "fixture.docx",
                    fileType: "docx",
                };
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            addEvent: async (_db, input) => {
                events.push({ type: input.type, payload: input.payload });
            },
        }),
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(repinCalls.length, 1);
    assert.deepEqual(
        repinCalls[0].slice(1),
        ["env-1", "version-5"],
        "the re-pin must target this envelope and the document's CURRENT version",
    );
    assert.deepEqual(
        loadedVersions,
        ["version-5"],
        "the send must actually use the re-pinned version, not the stale pin",
    );
    assert.equal(claims, 1);
    assert.deepEqual(
        events.find((e) => e.type === "version_repinned"),
        {
            type: "version_repinned",
            payload: {
                from_version_id: "version-1",
                to_version_id: "version-5",
                to_version_number: 5,
                approved_by: envelope.user_id,
            },
        },
        "the provenance move is auditable: from, to, and who chose it",
    );
}

async function testConfirmPreparedVersionSendsThePin(): Promise<void> {
    const loadedVersions: (string | null)[] = [];
    const lookups: (string | null)[] = [];
    let repins = 0;
    let claims = 0;

    const result = await renderAndSendEnvelope(
        {} as never,
        { ...params, confirmPreparedVersion: true },
        dependencies({
            loadActive: staleLoadActive(lookups),
            repinSourceVersion: async () => {
                repins += 1;
                return envelope;
            },
            loadSource: async (
                _db: unknown,
                _documentId: string | null,
                sourceVersionId: string | null,
            ) => {
                loadedVersions.push(sourceVersionId);
                return {
                    bytes: Buffer.from("docx"),
                    filename: "fixture.docx",
                    fileType: "docx",
                };
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
        }),
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(claims, 1);
    assert.deepEqual(
        loadedVersions,
        ["version-1"],
        "the deliberately-prepared version is what gets signed",
    );
    assert.equal(
        repins,
        0,
        "the pin already names what we send — rewriting provenance here would be a lie",
    );
    assert.deepEqual(
        lookups,
        ["version-1"],
        "exactly ONE lookup, and only to establish that the pinned row is still there — that answer is load-bearing (see the vanished-pin test). The document's current version is still never queried: a confirmed send must not pay for a comparison it would only discard",
    );
}

// "Send the prepared version" is offered by the staleness refusal itself, and
// that refusal can be the one that says the prepared version "no longer
// exists". Pressing it must not run the send: `loadSource` resolves by exact
// version id with no fallback, so it would 400 with a storage-layer string AND
// call recordFailure — taking the agent operation terminal under an envelope
// still sitting in pending_approval, the exact dead row the refusal path exists
// to prevent.
async function testConfirmingAVanishedPreparedVersionIsRefused(): Promise<void> {
    let claims = 0;
    let dispatches = 0;
    let repins = 0;
    let failedOperations = 0;
    let sourceLoads = 0;
    const events: EventRecord[] = [];
    const lookups: (string | null)[] = [];

    const vanishedPin = async (
        _documentId: string,
        _db: unknown,
        versionId?: string | null,
    ) => {
        lookups.push(versionId ?? null);
        // The pin is gone; the document has since moved to version-5.
        return versionId ? null : activeVersion("version-5", 5);
    };

    const result = await renderAndSendEnvelope(
        {} as never,
        { ...params, confirmPreparedVersion: true },
        dependencies({
            loadActive: vanishedPin,
            loadSource: async () => {
                sourceLoads += 1;
                return {
                    bytes: null,
                    filename: "fixture.docx",
                    fileType: "docx",
                };
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
            repinSourceVersion: async () => {
                repins += 1;
                return envelope;
            },
            addEvent: async (_db, input) => {
                events.push({ type: input.type, payload: input.payload });
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
        }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(
            result.status,
            409,
            "a conflict with the envelope's current state, like the staleness refusal it answers — not a malformed request",
        );
        assert.equal(result.code, "SIGNATURE_PREPARED_VERSION_UNAVAILABLE");
        assert.match(
            result.detail,
            /no longer available/i,
            "the sentence must say what happened, not name a storage layer",
        );
        assert.match(
            result.detail,
            /current version instead, or cancel/i,
            "and name the two choices that remain",
        );
        assert.doesNotMatch(result.detail, /bytes could not be loaded/i);
    }
    assert.equal(sourceLoads, 0, "refused BEFORE the send is attempted");
    assert.equal(claims, 0, "so the envelope is never claimed for sending");
    assert.equal(dispatches, 0, "and no signer link goes out");
    assert.equal(repins, 0, "confirming a pin never rewrites provenance");
    // THE assertion. A refusal leaves the approver two live choices, so the
    // operation must stay exactly where it was: failing it here would mark the
    // agent_operations row terminal (failed, completed_at set) beneath an
    // envelope that is still pending_approval and still sendable.
    assert.equal(
        failedOperations,
        0,
        "a refusal awaiting the approver's decision must NOT fail the operation",
    );
    assert.deepEqual(
        events,
        [
            {
                type: "send_failed",
                payload: {
                    phase: "check_version",
                    code: "SIGNATURE_PREPARED_VERSION_UNAVAILABLE",
                    retryable: true,
                },
            },
        ],
        "exactly one audit event, attributable to the version check",
    );
    assert.deepEqual(
        lookups,
        ["version-1"],
        "one targeted lookup for the pinned row, and never the current version — nothing it could say changes the answer",
    );

    // The create flow confirms a pin it resolved microseconds earlier, and has
    // no version choice to offer, so this refusal must not reach it: it would
    // strand the envelope POST /signatures just created. Same reason that flow
    // answers the staleness gate up front.
    const fresh = await sendFreshlyPinnedEnvelope(
        {} as never,
        params,
        dependencies({
            loadActive: vanishedPin,
            claim: async () => ({ ...envelope, status: "sent" as const }),
        }),
    );
    assert.deepEqual(fresh, { ok: true });
    assert.deepEqual(
        lookups,
        ["version-1"],
        "and it costs that flow no extra lookup either",
    );
}

// The document's CURRENT version can fail to resolve — a document with a NULL
// current_version_id, or a version row that is gone. That is not a divergence:
// there is nothing to compare the pin against. Sending the pin is the safe
// direction, since it is still exactly the bytes the request was prepared
// against.
async function testUnresolvableCurrentVersionSendsThePin(): Promise<void> {
    const loadedVersions: (string | null)[] = [];
    const lookups: (string | null)[] = [];
    const events: EventRecord[] = [];
    let claims = 0;
    let failedOperations = 0;

    const result = await renderAndSendEnvelope(
        {} as never,
        params,
        dependencies({
            loadActive: async (
                _documentId: string,
                _db: unknown,
                versionId?: string | null,
            ) => {
                lookups.push(versionId ?? null);
                return null;
            },
            loadSource: async (
                _db: unknown,
                _documentId: string | null,
                sourceVersionId: string | null,
            ) => {
                loadedVersions.push(sourceVersionId);
                return {
                    bytes: Buffer.from("docx"),
                    filename: "fixture.docx",
                    fileType: "docx",
                };
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            addEvent: async (_db, input) => {
                events.push({ type: input.type, payload: input.payload });
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
        }),
    );

    assert.deepEqual(
        result,
        { ok: true },
        "an unresolvable current version is not evidence the document moved",
    );
    assert.equal(claims, 1);
    assert.deepEqual(
        loadedVersions,
        ["version-1"],
        "and the send still goes out on the PINNED version",
    );
    assert.deepEqual(lookups, [null], "one lookup, with nothing to compare to");
    assert.equal(failedOperations, 0);
    assert.deepEqual(
        events.map((e) => e.type),
        ["sent"],
        "nothing was refused, so nothing is logged as a failure",
    );
}

// Both flags name a *pinned* version. On a legacy envelope with no pin there is
// nothing to name: `confirm_prepared_version` would fall through to the
// document's CURRENT version, the exact opposite of what it says.
async function testVersionChoiceOnAnUnpinnedEnvelopeIsRefused(): Promise<void> {
    const unpinned = { ...envelope, source_version_id: null };
    let claims = 0;
    let dispatches = 0;
    let repins = 0;
    let failedOperations = 0;
    let lookups = 0;

    const deps = () =>
        dependencies({
            loadActive: async () => {
                lookups += 1;
                return activeVersion("version-5", 5);
            },
            claim: async () => {
                claims += 1;
                return { ...unpinned, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
            repinSourceVersion: async () => {
                repins += 1;
                return unpinned;
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
        });

    const flags = ["confirmPreparedVersion", "useCurrentVersion"] as const;
    for (const flag of flags) {
        const result = await renderAndSendEnvelope(
            {} as never,
            { ...params, envelope: unpinned, [flag]: true },
            deps(),
        );
        assert.equal(
            result.ok,
            false,
            `${flag} on an unpinned envelope must be refused, not silently ignored`,
        );
        if (!result.ok) {
            assert.equal(result.status, 400);
            assert.match(result.detail, /predates version pinning/i);
        }
    }

    assert.equal(claims, 0, "a refused choice never sends anything");
    assert.equal(dispatches, 0);
    assert.equal(repins, 0, "and never rewrites a legacy envelope's provenance");
    assert.equal(
        failedOperations,
        0,
        "a 400 is input validation, not a failed operation",
    );
    assert.equal(lookups, 0);

    // The load-bearing half of the rule: production has pending NULL-pin
    // envelopes, and a PLAIN approve on them must keep sending exactly as it
    // did before any of this existed.
    const plain = await renderAndSendEnvelope(
        {} as never,
        { ...params, envelope: unpinned },
        deps(),
    );
    assert.deepEqual(plain, { ok: true });
    assert.equal(claims, 1);
}

// POST /signatures resolves the document's active version, pins it, then runs
// createAgentOperation + createEnvelope + insertSignatureFields before it
// reaches the gate. An edit landing in that window must not 409 the caller with
// a message pointing at a signature card this flow never renders — and must not
// strand the pending_approval envelope it just created.
async function testFreshlyPinnedSendSurvivesAConcurrentEdit(): Promise<void> {
    const loadedVersions: (string | null)[] = [];
    const lookups: (string | null)[] = [];
    let claims = 0;
    let dispatches = 0;
    let repins = 0;
    let failedOperations = 0;

    const result = await sendFreshlyPinnedEnvelope(
        {} as never,
        params,
        dependencies({
            // The document moved to version-5 between the pin and this send.
            loadActive: staleLoadActive(lookups),
            loadSource: async (
                _db: unknown,
                _documentId: string | null,
                sourceVersionId: string | null,
            ) => {
                loadedVersions.push(sourceVersionId);
                return {
                    bytes: Buffer.from("docx"),
                    filename: "fixture.docx",
                    fileType: "docx",
                };
            },
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
            repinSourceVersion: async () => {
                repins += 1;
                return envelope;
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
        }),
    );

    assert.deepEqual(
        result,
        { ok: true },
        "the request that pinned this version microseconds ago must not refuse its own send",
    );
    assert.equal(claims, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(
        loadedVersions,
        ["version-1"],
        "and it sends the version it pinned — confirming a pin is not 'send whatever is current'",
    );
    assert.equal(repins, 0, "confirming a pin never rewrites provenance");
    assert.equal(failedOperations, 0);
    assert.deepEqual(lookups, [], "the confirmation is known up front");

    // If the pin somehow did not persist there is nothing to confirm, and the
    // flag must degrade to a plain send rather than trip the unpinned-choice
    // 400 and break every manual send.
    const unpinned = { ...envelope, source_version_id: null };
    const fallback = await sendFreshlyPinnedEnvelope(
        {} as never,
        { ...params, envelope: unpinned },
        dependencies({
            claim: async () => ({ ...unpinned, status: "sent" as const }),
        }),
    );
    assert.deepEqual(fallback, { ok: true });
}

async function testLostRepinRaceDoesNotSend(): Promise<void> {
    let claims = 0;
    let dispatches = 0;
    let failedOperations = 0;

    const result = await renderAndSendEnvelope(
        {} as never,
        { ...params, useCurrentVersion: true },
        dependencies({
            loadActive: staleLoadActive([]),
            // Conditional on status = pending_approval: null means the
            // envelope already dispatched or was cancelled under us.
            repinSourceVersion: async () => null,
            claim: async () => {
                claims += 1;
                return { ...envelope, status: "sent" };
            },
            dispatchLink: async () => {
                dispatches += 1;
                return "https://example.test/sign/token";
            },
            failOperation: async () => {
                failedOperations += 1;
                return null;
            },
        }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.status, 409);
        assert.match(result.detail, /already being sent|no longer pending/i);
    }
    assert.equal(claims, 0, "never send under a pin we failed to persist");
    assert.equal(dispatches, 0);
    assert.equal(failedOperations, 0);
}

async function testBothOverridesAreRefused(): Promise<void> {
    let lookups = 0;
    const result = await renderAndSendEnvelope(
        {} as never,
        { ...params, confirmPreparedVersion: true, useCurrentVersion: true },
        dependencies({
            loadActive: async () => {
                lookups += 1;
                return activeVersion("version-1", 2);
            },
        }),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
    assert.equal(lookups, 0, "a contradictory request is refused, not guessed");
}

function testOnlyLiveStatusesAreSignable(): void {
    const statuses: EnvelopeStatus[] = [
        "draft",
        "pending_approval",
        "sent",
        "partially_signed",
        "completed",
        "declined",
        "expired",
        "cancelled",
    ];
    assert.deepEqual(statuses.filter(isSignableEnvelopeStatus), [
        "sent",
        "partially_signed",
    ]);
}

async function main(): Promise<void> {
    await testConverterFailureThenRecovery();
    await testLayoutFailureNeverUploadsOrSends();
    await testDispatchFailureCleansUpAndRollsBack();
    await testPinnedMatchingCurrentSends();
    await testStalePinRefusesWithoutTouchingTheOperation();
    await testDanglingPinIsNamedAsGone();
    await testVersionStateCarriesThePreparedResolvedFlag();
    await testLegacyNullPinSkipsTheGate();
    await testUseCurrentVersionRepinsThenSends();
    await testConfirmPreparedVersionSendsThePin();
    await testConfirmingAVanishedPreparedVersionIsRefused();
    await testUnresolvableCurrentVersionSendsThePin();
    await testVersionChoiceOnAnUnpinnedEnvelopeIsRefused();
    await testFreshlyPinnedSendSurvivesAConcurrentEdit();
    await testLostRepinRaceDoesNotSend();
    await testBothOverridesAreRefused();
    testOnlyLiveStatusesAreSignable();
    console.log("signatures.send.test.ts: all passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
