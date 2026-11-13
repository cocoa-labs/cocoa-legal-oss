import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDocumentActionState } from "./documentActionState";

test("V2 sent plus current V3 preserves completion and makes freshness explicit", () => {
    const [state] = deriveDocumentActionState({
        documents: [{ id: "doc-1", filename: "Parenting Plan.docx", current_version_id: "v3", updated_at: "2026-08-06T03:00:00Z" }],
        versions: [
            { id: "v2", document_id: "doc-1", version_number: 2, source: "assistant_edit", created_at: "2026-08-06T02:00:00Z" },
            { id: "v3", document_id: "doc-1", version_number: 3, source: "assistant_edit", created_at: "2026-08-06T03:00:00Z" },
        ],
        emails: [{ id: "email-chat-a", status: "sent", attachments: [{ document_id: "doc-1", version_id: "v2" }], sent_at: "2026-08-06T02:30:00Z", updated_at: "2026-08-06T02:30:00Z" }],
        envelopes: [], operations: [],
    });
    assert.deepEqual(state.delivery.sent_versions.map((item) => item.version_number), [2]);
    assert.equal(state.delivery.current_version_sent, false);
    assert.equal(state.delivery.newer_version_available, true);
    assert.equal(state.current_version.number, 3);
});

test("email reply and signer timestamps come only from authoritative records", () => {
    const [state] = deriveDocumentActionState({
        documents: [{ id: "doc-1", filename: "Plan.docx", current_version_id: "v2", updated_at: "2026-08-06T03:00:00Z" }],
        versions: [{ id: "v2", document_id: "doc-1", version_number: 2, source: "upload", created_at: "2026-08-06T02:00:00Z" }],
        emails: [
            { id: "out", direction: "outbound", status: "sent", attachments: [{ document_id: "doc-1", version_id: "v2" }], from_address: "sender@pilot.test", to_addresses: ["recipient@pilot.test"], cc_addresses: [], bcc_addresses: [], provider_thread_id: "thread-1", sent_at: "2026-08-06T02:30:00Z", updated_at: "2026-08-06T02:30:00Z" },
            { id: "reply", direction: "inbound", status: "received", attachments: [], from_address: "recipient@pilot.test", provider_thread_id: "thread-1", sent_at: null, received_at: "2026-08-06T02:45:00Z", updated_at: "2026-08-06T02:45:00Z" },
        ],
        envelopes: [{ id: "env-1", document_id: "doc-1", source_version_id: "v2", status: "partially_signed", updated_at: "2026-08-06T03:00:00Z" }],
        signers: [{ id: "signer-1", envelope_id: "env-1", name: "Pilot Signer", email: "recipient@pilot.test", status: "signed", viewed_at: "2026-08-06T02:50:00Z", signed_at: "2026-08-06T02:55:00Z", declined_at: null }],
        operations: [],
    });
    assert.equal(state.delivery.sent_versions[0].replies[0].email_id, "reply");
    assert.equal(state.signature.versions[0].signers[0].viewed_at, "2026-08-06T02:50:00Z");
    assert.equal(state.signature.versions[0].signers[0].signed_at, "2026-08-06T02:55:00Z");
    assert.equal("delivered" in state.delivery, false);
    assert.equal("viewed" in state.delivery, false);
});
