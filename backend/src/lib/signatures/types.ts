/** Shared types for the native e-signature engine. Mirrors migration 012. */

export type EnvelopeStatus =
    | "draft"
    | "pending_approval"
    | "sent"
    | "partially_signed"
    | "completed"
    | "declined"
    | "expired"
    | "cancelled";

export type SignerStatus = "pending" | "viewed" | "signed" | "declined";
export type SignerRole = "signer" | "cc";

export interface SignerInput {
    name: string;
    email: string;
    role?: SignerRole;
}

export interface SignatureSigner {
    id: string;
    envelope_id: string;
    name: string;
    email: string;
    order_index: number;
    role: SignerRole;
    status: SignerStatus;
    token_expires_at: string | null;
    signature_image_path: string | null;
    typed_name: string | null;
    consent_at: string | null;
    viewed_at: string | null;
    signed_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
    signer_ip: string | null;
    signer_user_agent: string | null;
    created_at: string;
    updated_at: string;
}

export interface SignatureEnvelope {
    id: string;
    org_id: string | null;
    matter_id?: string | null;
    user_id: string;
    project_id: string | null;
    chat_id: string | null;
    agent_operation_id: string | null;
    document_id: string | null;
    source_version_id: string | null;
    status: EnvelopeStatus;
    subject: string;
    message: string;
    original_pdf_path: string | null;
    original_sha256: string | null;
    executed_pdf_path: string | null;
    executed_sha256: string | null;
    executed_document_id: string | null;
    executed_version_id: string | null;
    certificate_path: string | null;
    expires_at: string | null;
    approved_by: string | null;
    approved_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
}

export type SignatureFieldType = "signature" | "initials" | "date" | "name";

/**
 * A sender-placed field box. Coordinates are TOP-LEFT origin, normalized to the
 * page (x/y = top-left corner fraction, y from the top; w/h = size fractions).
 * Mirrors migration 015.
 */
export interface SignatureField {
    id: string;
    envelope_id: string;
    signer_id: string;
    type: SignatureFieldType;
    page: number;
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
    created_at: string;
}

/** A field to persist at create time, referencing its signer by email. */
export interface SignatureFieldInput {
    signer_email: string;
    type: SignatureFieldType;
    page: number;
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
}

export interface SignatureEvent {
    id: string;
    envelope_id: string;
    signer_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
}

export interface EnvelopeWithSigners {
    envelope: SignatureEnvelope;
    signers: SignatureSigner[];
}
