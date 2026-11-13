import type { createServerSupabase } from "../supabase";
import type {
    EnvelopeStatus,
    EnvelopeWithSigners,
    SignatureEnvelope,
    SignatureEvent,
    SignatureField,
    SignatureFieldInput,
    SignatureFieldType,
    SignatureSigner,
    SignerInput,
    SignerRole,
    SignerStatus,
} from "./types";

type Db = ReturnType<typeof createServerSupabase>;

interface EnvelopeRow {
    id: string;
    user_id: string;
    org_id: string | null;
    matter_id: string | null;
    project_id: string | null;
    chat_id: string | null;
    agent_operation_id: string | null;
    document_id: string;
    source_version_id: string | null;
    subject: string;
    message: string | null;
    status: string;
    original_pdf_path: string;
    original_sha256: string;
    executed_pdf_path: string | null;
    executed_sha256: string | null;
    executed_document_id: string | null;
    executed_version_id: string | null;
    certificate_path: string | null;
    expires_at: string | null;
    completed_at: string | null;
    approved_at: string | null;
    approved_by: string | null;
    created_at: string;
    updated_at: string;
}

interface SignerRow {
    id: string;
    envelope_id: string;
    email: string;
    name: string;
    role: string;
    order_index: number;
    status: string;
    access_token_hash: string | null;
    token_expires_at: string | null;
    viewed_at: string | null;
    signed_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
    typed_name: string | null;
    signature_image_path: string | null;
    consent_at: string | null;
    signer_ip: string | null;
    signer_user_agent: string | null;
    created_at: string;
    updated_at: string;
}

interface EventRow {
    id: string;
    envelope_id: string;
    signer_id: string | null;
    type: string;
    payload: Record<string, unknown> | null;
    ip: string | null;
    user_agent: string | null;
    created_at: string;
}

function serializeEnvelope(row: EnvelopeRow): SignatureEnvelope {
    return {
        id: row.id,
        user_id: row.user_id,
        org_id: row.org_id ?? null,
        matter_id: row.matter_id ?? null,
        project_id: row.project_id ?? null,
        chat_id: row.chat_id ?? null,
        agent_operation_id: row.agent_operation_id ?? null,
        document_id: row.document_id,
        source_version_id: row.source_version_id ?? null,
        subject: row.subject,
        message: row.message ?? "",
        status: row.status as EnvelopeStatus,
        original_pdf_path: row.original_pdf_path,
        original_sha256: row.original_sha256,
        executed_pdf_path: row.executed_pdf_path ?? null,
        executed_sha256: row.executed_sha256 ?? null,
        executed_document_id: row.executed_document_id ?? null,
        executed_version_id: row.executed_version_id ?? null,
        certificate_path: row.certificate_path ?? null,
        expires_at: row.expires_at ?? null,
        completed_at: row.completed_at ?? null,
        approved_at: row.approved_at ?? null,
        approved_by: row.approved_by ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function serializeSigner(row: SignerRow): SignatureSigner {
    return {
        id: row.id,
        envelope_id: row.envelope_id,
        name: row.name,
        email: row.email,
        order_index: row.order_index,
        role: row.role as SignerRole,
        status: row.status as SignerStatus,
        token_expires_at: row.token_expires_at ?? null,
        signature_image_path: row.signature_image_path ?? null,
        typed_name: row.typed_name ?? null,
        consent_at: row.consent_at ?? null,
        viewed_at: row.viewed_at ?? null,
        signed_at: row.signed_at ?? null,
        declined_at: row.declined_at ?? null,
        decline_reason: row.decline_reason ?? null,
        signer_ip: row.signer_ip ?? null,
        signer_user_agent: row.signer_user_agent ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function serializeEvent(row: EventRow): SignatureEvent {
    return {
        id: row.id,
        envelope_id: row.envelope_id,
        signer_id: row.signer_id ?? null,
        type: row.type,
        payload: row.payload ?? {},
        ip: row.ip ?? null,
        user_agent: row.user_agent ?? null,
        created_at: row.created_at,
    };
}

const MISSING_SCHEMA_CODES = new Set([
    "42P01",
    "PGRST205",
    "PGRST204",
    "42703",
]);

function isMissingSignatureSchema(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const code = (error as { code?: string }).code;
    if (code && MISSING_SCHEMA_CODES.has(code)) return true;
    const message = (error as { message?: string }).message ?? "";
    return /relation .* does not exist|could not find the table|schema cache/i.test(
        message,
    );
}

async function tolerateMissingSchema<T>(
    label: string,
    fallback: T,
    work: () => Promise<T>,
): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (isMissingSignatureSchema(error)) {
            if (process.env.NODE_ENV !== "production") {
                console.warn(
                    `[signatures] ${label}: schema missing, returning fallback`,
                    error,
                );
            }
            return fallback;
        }
        throw error;
    }
}

/**
 * Collapse signer inputs so no email appears on two rows. A duplicated email
 * would create two `signer` rows for one person, and the self-signing flow can
 * never drive both to 'signed': sign-self only reaches the lowest-order pending
 * row (see findSignerByEnvelopeAndEmail) and approval mints no magic-link token
 * for a self-matching row, so the second row strands and the envelope can never
 * reach 'completed'. De-duping at creation removes that precondition.
 *
 * Matching is case-insensitive on the trimmed email; blank emails are dropped.
 * The first occurrence wins, but a later `signer` upgrades a kept `cc` so a
 * required signer is never silently downgraded to a notification-only recipient
 * (which would otherwise leave the envelope with zero signer rows).
 */
export function dedupeSignerInputs(signers: SignerInput[]): SignerInput[] {
    const byEmail = new Map<string, SignerInput>();
    for (const signer of signers) {
        const key = signer.email.trim().toLowerCase();
        if (!key) continue;
        const existing = byEmail.get(key);
        if (!existing) {
            byEmail.set(key, signer);
        } else if (existing.role === "cc" && signer.role !== "cc") {
            byEmail.set(key, { ...existing, role: "signer" });
        }
    }
    return [...byEmail.values()];
}

export async function createEnvelope(
    db: Db,
    input: {
        userId: string;
        orgId?: string | null;
        matterId?: string | null;
        projectId?: string | null;
        chatId?: string | null;
        agentOperationId?: string | null;
        documentId: string;
        sourceVersionId?: string | null;
        subject: string;
        message: string;
        originalPdfPath: string;
        originalSha256: string;
        expiresAt?: string | null;
        signers: SignerInput[];
    },
): Promise<EnvelopeWithSigners | null> {
    return tolerateMissingSchema("createEnvelope", null, async () => {
        let orgId = input.orgId ?? null;
        let matterId = input.matterId ?? null;
        if (input.projectId && (!orgId || !matterId)) {
            const { data: project } = await db.from("projects").select("org_id, matter_id").eq("id", input.projectId).maybeSingle();
            orgId = orgId ?? project?.org_id ?? null;
            matterId = matterId ?? project?.matter_id ?? null;
        }
        const { data: envelopeData, error: envelopeError } = await db
            .from("signature_envelopes")
            .insert({
                user_id: input.userId,
                org_id: orgId,
                matter_id: matterId,
                project_id: input.projectId ?? null,
                chat_id: input.chatId ?? null,
                agent_operation_id: input.agentOperationId ?? null,
                document_id: input.documentId,
                source_version_id: input.sourceVersionId ?? null,
                subject: input.subject,
                message: input.message,
                status: "pending_approval",
                original_pdf_path: input.originalPdfPath,
                original_sha256: input.originalSha256,
                expires_at: input.expiresAt ?? null,
            })
            .select("*")
            .single();
        if (envelopeError) throw envelopeError;
        const envelope = serializeEnvelope(envelopeData as EnvelopeRow);

        let signers: SignatureSigner[] = [];
        if (input.signers.length > 0) {
            const signerRows = input.signers.map((signer, index) => ({
                envelope_id: envelope.id,
                email: signer.email,
                name: signer.name,
                role: signer.role ?? "signer",
                order_index: index,
                status: "pending",
            }));
            const { data: signerData, error: signerError } = await db
                .from("signature_signers")
                .insert(signerRows)
                .select("*");
            if (signerError) throw signerError;
            signers = ((signerData as SignerRow[] | null) ?? [])
                .map(serializeSigner)
                .sort((a, b) => a.order_index - b.order_index);
        }

        return { envelope, signers };
    });
}

export async function getEnvelope(
    db: Db,
    id: string,
): Promise<SignatureEnvelope | null> {
    return tolerateMissingSchema("getEnvelope", null, async () => {
        const { data, error } = await db
            .from("signature_envelopes")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        return serializeEnvelope(data as EnvelopeRow);
    });
}

async function getSignersForEnvelope(
    db: Db,
    envelopeId: string,
): Promise<SignatureSigner[]> {
    const { data, error } = await db
        .from("signature_signers")
        .select("*")
        .eq("envelope_id", envelopeId)
        .order("order_index", { ascending: true });
    if (error) throw error;
    return ((data as SignerRow[] | null) ?? []).map(serializeSigner);
}

export async function getEnvelopeWithSigners(
    db: Db,
    id: string,
): Promise<EnvelopeWithSigners | null> {
    return tolerateMissingSchema("getEnvelopeWithSigners", null, async () => {
        const { data, error } = await db
            .from("signature_envelopes")
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const envelope = serializeEnvelope(data as EnvelopeRow);
        const signers = await getSignersForEnvelope(db, envelope.id);
        return { envelope, signers };
    });
}

/**
 * The envelope (+ signers) created for a given agent operation, if any. Used by
 * the operations approval route to actually dispatch signing links when a
 * reloaded send_for_signature card is approved via /operations/:id/approve
 * (which comes back keyed by operation id, not envelope id). Returns null when
 * no envelope is linked or the schema is missing.
 */
export async function getEnvelopeWithSignersByOperationId(
    db: Db,
    operationId: string,
): Promise<EnvelopeWithSigners | null> {
    if (!operationId) return null;
    const id = await tolerateMissingSchema(
        "getEnvelopeWithSignersByOperationId",
        null,
        async () => {
            const { data, error } = await db
                .from("signature_envelopes")
                .select("id")
                .eq("agent_operation_id", operationId)
                .order("created_at", { ascending: false })
                .limit(1);
            if (error) throw error;
            return (data as { id: string }[] | null)?.[0]?.id ?? null;
        },
    );
    return id ? getEnvelopeWithSigners(db, id) : null;
}

export async function listEnvelopes(
    db: Db,
    filters: { userId?: string; projectId?: string; projectIds?: string[]; limit?: number },
): Promise<EnvelopeWithSigners[]> {
    return tolerateMissingSchema("listEnvelopes", [], async () => {
        // Scope by matter (projectId) when given, else by owner (userId).
        let query = db.from("signature_envelopes").select("*");
        if (filters.projectId)
            query = query.eq("project_id", filters.projectId);
        else if (filters.projectIds)
            query = filters.projectIds.length
                ? query.in("project_id", filters.projectIds)
                : query.eq("project_id", "00000000-0000-0000-0000-000000000000");
        else if (filters.userId) query = query.eq("user_id", filters.userId);
        const { data, error } = await query
            .order("created_at", { ascending: false })
            .limit(Math.min(filters.limit ?? 50, 100));
        if (error) throw error;
        const envelopes = ((data as EnvelopeRow[] | null) ?? []).map(
            serializeEnvelope,
        );
        if (envelopes.length === 0) return [];
        const ids = envelopes.map((envelope) => envelope.id);
        const { data: signerData, error: signerError } = await db
            .from("signature_signers")
            .select("*")
            .in("envelope_id", ids)
            .order("order_index", { ascending: true });
        if (signerError) throw signerError;
        const signersByEnvelope = new Map<string, SignatureSigner[]>();
        for (const row of (signerData as SignerRow[] | null) ?? []) {
            const signer = serializeSigner(row);
            const list = signersByEnvelope.get(signer.envelope_id) ?? [];
            list.push(signer);
            signersByEnvelope.set(signer.envelope_id, list);
        }
        return envelopes.map((envelope) => ({
            envelope,
            signers: signersByEnvelope.get(envelope.id) ?? [],
        }));
    });
}

/**
 * Signature envelopes belonging to a chat, newest first (no signer join — only
 * the envelope status is needed). Lets enrichWithPriorEvents tell the agent on
 * a later turn that it already prepared or sent a signature request in this
 * conversation. Tolerates a missing schema (returns []).
 */
export async function listEnvelopesByChat(
    db: Db,
    chatId: string,
    opts?: { limit?: number },
): Promise<SignatureEnvelope[]> {
    return tolerateMissingSchema("listEnvelopesByChat", [], async () => {
        const { data, error } = await db
            .from("signature_envelopes")
            .select("*")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: false })
            .limit(Math.min(opts?.limit ?? 20, 50));
        if (error) throw error;
        return ((data as EnvelopeRow[] | null) ?? []).map(serializeEnvelope);
    });
}

export async function setEnvelopeStatus(
    db: Db,
    id: string,
    status: EnvelopeStatus,
    extra?: Partial<{
        approvedBy: string;
        approvedAt: string;
        completedAt: string;
        executedPdfPath: string;
        executedSha256: string;
        executedDocumentId: string;
        executedVersionId: string;
        certificatePath: string;
    }>,
): Promise<SignatureEnvelope | null> {
    return tolerateMissingSchema("setEnvelopeStatus", null, async () => {
        const patch: Record<string, unknown> = { status };
        if (extra?.approvedBy !== undefined)
            patch.approved_by = extra.approvedBy;
        if (extra?.approvedAt !== undefined)
            patch.approved_at = extra.approvedAt;
        if (extra?.completedAt !== undefined)
            patch.completed_at = extra.completedAt;
        if (extra?.executedPdfPath !== undefined)
            patch.executed_pdf_path = extra.executedPdfPath;
        if (extra?.executedSha256 !== undefined)
            patch.executed_sha256 = extra.executedSha256;
        if (extra?.executedDocumentId !== undefined)
            patch.executed_document_id = extra.executedDocumentId;
        if (extra?.executedVersionId !== undefined)
            patch.executed_version_id = extra.executedVersionId;
        if (extra?.certificatePath !== undefined)
            patch.certificate_path = extra.certificatePath;
        const { data, error } = await db
            .from("signature_envelopes")
            .update(patch)
            .eq("id", id)
            .select("*")
            .single();
        if (error) throw error;
        return serializeEnvelope(data as EnvelopeRow);
    });
}

/**
 * Atomically claim an envelope for sending: flip status pending_approval → sent
 * (recording the approver) ONLY if it is still pending_approval, returning the
 * claimed envelope or null if THIS call lost the race / it was no longer
 * pending. The single conditional UPDATE is the mutex that stops two concurrent
 * approvals from both dispatching signing links. The caller must roll the claim
 * back to pending_approval if the subsequent (non-transactional) send fails.
 * Tolerates a missing schema (returns null → caller bails).
 */
export async function claimEnvelopeForSending(
    db: Db,
    id: string,
    approver: {
        userId: string;
        at: string;
        originalPdfPath: string;
        originalSha256: string;
    },
): Promise<SignatureEnvelope | null> {
    return tolerateMissingSchema("claimEnvelopeForSending", null, async () => {
        const { data, error } = await db
            .from("signature_envelopes")
            .update({
                status: "sent",
                approved_by: approver.userId,
                approved_at: approver.at,
                original_pdf_path: approver.originalPdfPath,
                original_sha256: approver.originalSha256,
            })
            .eq("id", id)
            .eq("status", "pending_approval")
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeEnvelope(data as EnvelopeRow) : null;
    });
}

/**
 * Release a failed send claim only while the envelope is still `sent`.
 * Callers first verify that no signer progressed, revoke minted tokens, then
 * use this conditional update so a concurrent completion/cancel cannot be
 * overwritten by a stale failure handler.
 */
export async function releaseEnvelopeSendClaim(
    db: Db,
    id: string,
): Promise<boolean> {
    return tolerateMissingSchema(
        "releaseEnvelopeSendClaim",
        false,
        async () => {
            const { data, error } = await db
                .from("signature_envelopes")
                .update({ status: "pending_approval" })
                .eq("id", id)
                .eq("status", "sent")
                .select("id")
                .maybeSingle();
            if (error) throw error;
            return !!data;
        },
    );
}

/**
 * Move a still-pending envelope's provenance pin to another document version.
 *
 * Only reachable from the explicit `use_current_version` override on approval:
 * the approver was shown that the document moved past the version the request
 * was prepared against and chose to send the CURRENT one. Persisting the new
 * pin before any send side effect keeps `source_version_id` a truthful record
 * of what was sent even if the send then fails and is retried.
 *
 * Conditional on `status = 'pending_approval'` for the same reason
 * claimEnvelopeForSending is: an envelope that already dispatched (or was
 * cancelled) has a provenance record that must never be rewritten — its
 * signers may already be looking at the bytes the old pin named. A no-row
 * result means this call lost that race and returns null, and the caller
 * declines to send rather than sending under a pin it failed to persist.
 * Tolerates a missing schema (returns null → caller bails).
 */
export async function repinEnvelopeSourceVersion(
    db: Db,
    id: string,
    sourceVersionId: string,
): Promise<SignatureEnvelope | null> {
    return tolerateMissingSchema(
        "repinEnvelopeSourceVersion",
        null,
        async () => {
            const { data, error } = await db
                .from("signature_envelopes")
                .update({ source_version_id: sourceVersionId })
                .eq("id", id)
                .eq("status", "pending_approval")
                .select("*")
                .maybeSingle();
            if (error) throw error;
            return data ? serializeEnvelope(data as EnvelopeRow) : null;
        },
    );
}

/**
 * Atomically claim an envelope for completion: flip status → completed ONLY
 * while it is still awaiting signatures (sent / partially_signed), returning
 * the claimed envelope or null when THIS call lost the race / the envelope is
 * no longer live. The single conditional UPDATE is the mutex that stops a
 * double-submitted (or two concurrent) last signers from both running the
 * seconds-long stamping/PKCS#12 completion pipeline — mirror of
 * claimEnvelopeForSending above. The status filter also means a cancelled
 * envelope can never be driven to 'completed' by a stale signing link.
 *
 * The caller MUST roll the claim back to 'partially_signed' if the subsequent
 * (non-transactional) pipeline fails — otherwise a transient error strands a
 * fully-signed envelope as a false 'completed' with no executed PDF.
 * Tolerates a missing schema (returns null → caller bails).
 */
export async function claimEnvelopeForCompletion(
    db: Db,
    id: string,
): Promise<SignatureEnvelope | null> {
    return tolerateMissingSchema(
        "claimEnvelopeForCompletion",
        null,
        async () => {
            const { data, error } = await db
                .from("signature_envelopes")
                .update({ status: "completed" })
                .eq("id", id)
                .in("status", ["sent", "partially_signed"])
                .select("*")
                .maybeSingle();
            if (error) throw error;
            return data ? serializeEnvelope(data as EnvelopeRow) : null;
        },
    );
}

export async function setSignerToken(
    db: Db,
    signerId: string,
    tokenHash: string,
    tokenExpiresAt: string,
): Promise<void> {
    await tolerateMissingSchema("setSignerToken", undefined, async () => {
        const { error } = await db
            .from("signature_signers")
            .update({
                access_token_hash: tokenHash,
                token_expires_at: tokenExpiresAt,
            })
            .eq("id", signerId);
        if (error) throw error;
    });
}

/**
 * Null out the magic-link tokens of every signer on an envelope who hasn't
 * finished (status not 'signed'/'declined'). Called when the owner cancels:
 * setting the envelope to 'cancelled' alone leaves the outstanding links
 * live — belt (this revocation) and braces (the route-level envelope-status
 * guard on /sign/:token). Finished rows keep their hashes so the audit trail
 * stays intact. Tolerates a missing schema (no-op).
 */
export async function revokePendingSignerTokens(
    db: Db,
    envelopeId: string,
): Promise<void> {
    await tolerateMissingSchema(
        "revokePendingSignerTokens",
        undefined,
        async () => {
            const { error } = await db
                .from("signature_signers")
                .update({ access_token_hash: null, token_expires_at: null })
                .eq("envelope_id", envelopeId)
                .not("status", "in", '("signed","declined")');
            if (error) throw error;
        },
    );
}

export async function findSignerByTokenHash(
    db: Db,
    tokenHash: string,
): Promise<{ signer: SignatureSigner; envelope: SignatureEnvelope } | null> {
    return tolerateMissingSchema("findSignerByTokenHash", null, async () => {
        const { data, error } = await db
            .from("signature_signers")
            .select("*")
            .eq("access_token_hash", tokenHash)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const signer = serializeSigner(data as SignerRow);
        const { data: envelopeData, error: envelopeError } = await db
            .from("signature_envelopes")
            .select("*")
            .eq("id", signer.envelope_id)
            .maybeSingle();
        if (envelopeError) throw envelopeError;
        if (!envelopeData) return null;
        return {
            signer,
            envelope: serializeEnvelope(envelopeData as EnvelopeRow),
        };
    });
}

export async function findSignerByEnvelopeAndEmail(
    db: Db,
    envelopeId: string,
    email: string,
    opts?: { status?: SignerStatus },
): Promise<SignatureSigner | null> {
    return tolerateMissingSchema(
        "findSignerByEnvelopeAndEmail",
        null,
        async () => {
            // Escape PostgREST ilike metacharacters so the match is a
            // case-insensitive equality, not a wildcard pattern.
            const pattern = email.replace(/[%_\\]/g, (c) => `\\${c}`);
            let query = db
                .from("signature_signers")
                .select("*")
                .eq("envelope_id", envelopeId)
                .ilike("email", pattern);
            // When a status is requested, target a *signable* row. Without the
            // filter the lowest-order row always wins regardless of status, so
            // an envelope with the same email on two rows could never advance
            // once that lowest row was signed.
            if (opts?.status) query = query.eq("status", opts.status);
            const { data, error } = await query
                .order("order_index", { ascending: true })
                .limit(1)
                .maybeSingle();
            if (error) throw error;
            if (!data) return null;
            return serializeSigner(data as SignerRow);
        },
    );
}

export async function markSignerViewed(
    db: Db,
    signerId: string,
    meta: { ip: string; userAgent: string },
): Promise<boolean> {
    return tolerateMissingSchema("markSignerViewed", false, async () => {
        const { data, error } = await db
            .from("signature_signers")
            .update({
                status: "viewed",
                viewed_at: new Date().toISOString(),
                signer_ip: meta.ip,
                signer_user_agent: meta.userAgent,
            })
            .eq("id", signerId)
            .eq("status", "pending")
            .select("id")
            .maybeSingle();
        if (error) throw error;
        return Boolean(data);
    });
}

/**
 * Mark a signer signed — conditionally, like its sibling markSignerViewed.
 * The route-level "already signed" check reads the signer BEFORE updating, so
 * two near-simultaneous submits both pass it; the status <> 'signed' guard
 * here makes the row update single-winner. A null return means another submit
 * already signed this row — callers map it to 409 instead of double-recording
 * the signature (and double-triggering completion).
 */
export async function markSignerSigned(
    db: Db,
    signerId: string,
    input: {
        typedName: string;
        signatureImagePath: string;
        ip: string;
        userAgent: string;
        consentAt: string;
    },
): Promise<SignatureSigner | null> {
    return tolerateMissingSchema("markSignerSigned", null, async () => {
        const { data, error } = await db
            .from("signature_signers")
            .update({
                status: "signed",
                typed_name: input.typedName,
                signature_image_path: input.signatureImagePath,
                signer_ip: input.ip,
                signer_user_agent: input.userAgent,
                consent_at: input.consentAt,
                signed_at: new Date().toISOString(),
            })
            .eq("id", signerId)
            .neq("status", "signed")
            .select("*")
            .maybeSingle();
        if (error) throw error;
        return data ? serializeSigner(data as SignerRow) : null;
    });
}

export async function markSignerDeclined(
    db: Db,
    signerId: string,
    input: { reason: string; ip: string; userAgent: string },
): Promise<SignatureSigner | null> {
    return tolerateMissingSchema("markSignerDeclined", null, async () => {
        const { data, error } = await db
            .from("signature_signers")
            .update({
                status: "declined",
                decline_reason: input.reason,
                signer_ip: input.ip,
                signer_user_agent: input.userAgent,
                declined_at: new Date().toISOString(),
            })
            .eq("id", signerId)
            .select("*")
            .single();
        if (error) throw error;
        return serializeSigner(data as SignerRow);
    });
}

/**
 * `signature_events.payload` is `jsonb NOT NULL default '{}'`. A column default
 * only applies when the column is omitted from the INSERT, so passing an
 * explicit `null` violates the constraint (Postgres 23502). Normalize a
 * missing/null payload to `{}` so every event — notably the `viewed` event,
 * the one recordEvent caller that passes no payload — inserts cleanly.
 */
export function normalizeEventPayload(
    payload?: Record<string, unknown> | null,
): Record<string, unknown> {
    return payload ?? {};
}

export async function recordEvent(
    db: Db,
    input: {
        envelopeId: string;
        signerId?: string | null;
        type: string;
        payload?: Record<string, unknown> | null;
        ip?: string | null;
        userAgent?: string | null;
    },
): Promise<void> {
    await tolerateMissingSchema("recordEvent", undefined, async () => {
        const { error } = await db.from("signature_events").insert({
            envelope_id: input.envelopeId,
            signer_id: input.signerId ?? null,
            type: input.type,
            payload: normalizeEventPayload(input.payload),
            ip: input.ip ?? null,
            user_agent: input.userAgent ?? null,
        });
        if (error) throw error;
    });
}

export async function listEvents(
    db: Db,
    envelopeId: string,
): Promise<SignatureEvent[]> {
    return tolerateMissingSchema("listEvents", [], async () => {
        const { data, error } = await db
            .from("signature_events")
            .select("*")
            .eq("envelope_id", envelopeId)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return ((data as EventRow[] | null) ?? []).map(serializeEvent);
    });
}

export function allSignersComplete(signers: SignatureSigner[]): boolean {
    return signers
        .filter((signer) => signer.role === "signer")
        .every((signer) => signer.status === "signed");
}

interface FieldRow {
    id: string;
    envelope_id: string;
    signer_id: string;
    type: string;
    page: number;
    x_pct: number;
    y_pct: number;
    w_pct: number;
    h_pct: number;
    created_at: string;
}

function serializeField(row: FieldRow): SignatureField {
    return {
        id: row.id,
        envelope_id: row.envelope_id,
        signer_id: row.signer_id,
        type: row.type as SignatureFieldType,
        page: row.page,
        x_pct: row.x_pct,
        y_pct: row.y_pct,
        w_pct: row.w_pct,
        h_pct: row.h_pct,
        created_at: row.created_at,
    };
}

/**
 * Persist sender-placed fields for a freshly-created envelope. Fields reference
 * their signer by email; this resolves each to the created signer's id and
 * drops fields whose email isn't a signer on the envelope. Degrades to a no-op
 * if the table is missing (the completion path then falls back to anchors).
 */
export async function insertSignatureFields(
    db: Db,
    envelopeId: string,
    signers: SignatureSigner[],
    fields: SignatureFieldInput[],
): Promise<number> {
    if (fields.length === 0) return 0;
    const idByEmail = new Map<string, string>();
    for (const s of signers) idByEmail.set(s.email.trim().toLowerCase(), s.id);

    const rows = fields
        .map((f) => {
            const signerId = idByEmail.get(f.signer_email.trim().toLowerCase());
            if (!signerId) return null;
            return {
                envelope_id: envelopeId,
                signer_id: signerId,
                type: f.type,
                page: f.page,
                x_pct: f.x_pct,
                y_pct: f.y_pct,
                w_pct: f.w_pct,
                h_pct: f.h_pct,
            };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) return 0;

    return tolerateMissingSchema("insertSignatureFields", 0, async () => {
        const { error } = await db.from("signature_fields").insert(rows);
        if (error) throw error;
        return rows.length;
    });
}

/** All sender-placed fields for an envelope (empty when none / table missing). */
export async function getEnvelopeFields(
    db: Db,
    envelopeId: string,
): Promise<SignatureField[]> {
    return tolerateMissingSchema("getEnvelopeFields", [], async () => {
        const { data, error } = await db
            .from("signature_fields")
            .select("*")
            .eq("envelope_id", envelopeId)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return ((data as FieldRow[] | null) ?? []).map(serializeField);
    });
}
