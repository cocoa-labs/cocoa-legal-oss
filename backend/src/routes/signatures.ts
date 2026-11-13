// backend/src/routes/signatures.ts
//
// HTTP layer for the native e-signature engine. Two routers:
//   signaturesRouter — authenticated envelope actions (list / get / approve /
//                      cancel). Approval does the heavy lifting: flatten the
//                      source document to PDF, hash + store the original, mint
//                      per-signer tokens, and email signing links.
//   signRouter       — PUBLIC, token-gated signer endpoints (GET signer view,
//                      POST sign). When the last signer signs, the completion
//                      pipeline stamps + cryptographically signs the executed
//                      PDF, builds the Certificate of Completion, registers the
//                      executed PDF as an in-app document (best-effort), and
//                      emails all parties.
//
// Mirrors the route/auth pattern in routes/operations.ts: requireAuth +
// res.locals.userId, createServerSupabase() per request, { detail } errors.

import { Router } from "express";
import type { Request, Response } from "express";

import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    createEnvelope,
    dedupeSignerInputs,
    getEnvelope,
    getEnvelopeWithSigners,
    listEnvelopes,
    setEnvelopeStatus,
    claimEnvelopeForSending,
    releaseEnvelopeSendClaim,
    repinEnvelopeSourceVersion,
    claimEnvelopeForCompletion,
    revokePendingSignerTokens,
    setSignerToken,
    findSignerByTokenHash,
    findSignerByEnvelopeAndEmail,
    markSignerViewed,
    markSignerSigned,
    recordEvent,
    listEvents,
    allSignersComplete,
    insertSignatureFields,
    getEnvelopeFields,
} from "../lib/signatures/store";
import type {
    EnvelopeStatus,
    SignatureEnvelope,
    SignatureFieldInput,
    SignatureFieldType,
    SignatureSigner,
    SignerInput,
    SignerRole,
    SignerStatus,
} from "../lib/signatures/types";
import {
    assertBetaRecipientsAllowed,
    betaModeEnabled,
    BetaPolicyError,
    signaturesNonbindingFor,
} from "../lib/betaPolicy";
import { recordAuditEvent } from "../lib/audit";
import {
    createAgentOperation,
    failAgentOperation,
    updateAgentOperation,
} from "../lib/operations";
import { ensureDocAccess, checkProjectAccess, listAccessibleProjectIds } from "../lib/access";
import { getEmailConnector } from "../lib/connectors/registry";
import { ConnectorNotConfiguredError } from "../lib/connectors/types";
import { loadActiveVersion } from "../lib/documentVersions";
import { insertDocumentVersionCompat } from "../lib/documentVersions";
import {
    downloadFile,
    deleteFile,
    uploadFile,
    getSignedUrl,
    signatureOriginalKey,
    signatureExecutedKey,
    signatureCertificateKey,
    signerSignatureImageKey,
} from "../lib/storage";
import { ensurePdf, looksLikePdf, stampBetaNotice, stampSignatures } from "../lib/signatures/pdf";
import type { FieldStampInput } from "../lib/signatures/pdf";
import { resolveSignerPlacements } from "../lib/signatures/anchors";
import { embedCryptographicSignature } from "../lib/signatures/pdf";
import type { SignerStampInput } from "../lib/signatures/pdf";
import { buildCertificateOfCompletion } from "../lib/signatures/certificate";
import { describeSigningIdentity } from "../lib/signatures/cert";
import { sha256Hex } from "../lib/signatures/hash";
import { generateSignerToken, hashSignerToken } from "../lib/signatures/tokens";
import {
    signRequestEmail,
    completionEmail,
    completionReadyEmail,
} from "../lib/signatures/emailTemplates";
import {
    converterHttpError,
    type DocumentConverterErrorCode,
} from "../lib/libreoffice";
import {
    ensureVersionExportable,
    ensureVersionPdfRenditionExportable,
    layoutQaVersionValues,
} from "../lib/documentLayoutGate";
import {
    extractPdfTextForQa,
    layoutQaHttpError,
    verifyPdfLayout,
    type DocumentLayoutQaErrorCode,
} from "../lib/documentLayoutQa";
import { extractDocxTextView } from "../lib/docxLayout";

const router = Router();
router.use(requireAuth);

const signRouter = Router();

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Envelope statuses under which a signature may still be captured. A magic
 * link must not outlive its envelope's lifecycle: signer tokens stay valid in
 * the DB after a cancel (and revocation is best-effort), so without checking
 * the envelope itself a CANCELLED envelope could still be signed — and, with
 * the completion claim, raced toward 'completed'.
 */
const SIGNABLE_ENVELOPE_STATUSES: ReadonlySet<EnvelopeStatus> = new Set([
    "sent",
    "partially_signed",
]);

export function isSignableEnvelopeStatus(status: EnvelopeStatus): boolean {
    return SIGNABLE_ENVELOPE_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof createServerSupabase>;

async function envelopeAccessAllowed(
    db: Db,
    envelope: SignatureEnvelope,
    userId: string,
    userEmail: string,
    permission: "read" | "approve",
): Promise<boolean> {
    if (!envelope.project_id) return envelope.user_id === userId;
    const access = await checkProjectAccess(
        envelope.project_id,
        userId,
        userEmail,
        db,
        permission,
    );
    return access.ok;
}

/** Convert a Node Buffer to a tightly-bounded ArrayBuffer for uploadFile. */
function bufferToArrayBuffer(buf: Buffer): ArrayBuffer {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
}

/** Public-safe signer shape: never leaks the access_token_hash. */
type PublicSigner = Omit<SignatureSigner, never>;

/** Strip the access token hash before returning a signer to any client. */
function publicSigner(signer: SignatureSigner): PublicSigner {
    // SignatureSigner (serialized) does not include access_token_hash, but we
    // defensively delete it in case a raw row ever reaches here.
    const copy = { ...(signer as unknown as Record<string, unknown>) };
    delete copy.access_token_hash;
    return copy as PublicSigner;
}

function publicSigners(signers: SignatureSigner[]): PublicSigner[] {
    return signers.map(publicSigner);
}

/**
 * Resolve a document's current-version bytes + a display filename. Used to
 * obtain the source document for PDF flattening at approval time and (during
 * completion) for naming the executed document. Returns null bytes when the
 * document or its bytes cannot be loaded.
 *
 * Prefers the version's stored PDF rendition over the source bytes when one
 * exists — see the comment at the download below for why that is both safe
 * and desirable.
 */
async function loadSourceDocument(
    db: Db,
    documentId: string | null,
    sourceVersionId: string | null,
): Promise<{
    bytes: Buffer | null;
    filename: string;
    fileType: string | null;
    expectedText?: string;
}> {
    if (!documentId)
        return { bytes: null, filename: "Document", fileType: null };
    let filename = "Document";
    // The stored file_type ("docx"/"pdf"/…) is the reliable format signal: the
    // human-facing `filename` below prefers the version's display_name, which is
    // a label and may carry no extension, so ensurePdf needs this to detect type.
    let fileType: string | null = null;
    try {
        const { data: doc } = await db
            .from("documents")
            .select("filename, file_type")
            .eq("id", documentId)
            .single();
        if (doc?.filename) filename = String(doc.filename);
        if (doc?.file_type) fileType = String(doc.file_type);
    } catch {
        // fall back to the default name
    }
    const active = await loadActiveVersion(documentId, db, sourceVersionId);
    if (!active) return { bytes: null, filename, fileType };
    if (active.display_name) filename = active.display_name;
    await ensureVersionExportable({
        db,
        documentId,
        versionId: active.id,
        fileType,
    });

    // Prefer the version's stored PDF rendition. Every uploaded document gets
    // one at upload time (documentUpload.ts), and the approval path only
    // re-converts the source to reach the same PDF — so using the rendition
    // takes LibreOffice out of the approval path for uploaded documents
    // entirely. Documents Quill drafts have no rendition and still convert.
    //
    // This cannot serve stale bytes for the version we resolved:
    //   - `pdf_storage_path` lives on `document_versions` and is selected by
    //     exact version id (documentVersions.ts loadActiveVersion).
    //   - Those rows are append-only in the two columns that matter. Every
    //     write that sets a path is an INSERT of a NEW row (most through
    //     `insertDocumentVersionCompat`); the only UPDATEs against
    //     `document_versions` anywhere set `display_name` alone
    //     (routes/documents.ts, routes/projects.ts), and no migration carries
    //     a trigger, UPDATE or backfill that touches either path column.
    //   - No storage object any resolvable version points at gets rewritten.
    //     Per-version renditions are keyed by a random version slug. The
    //     document-scoped `convertedPdfKey` IS rewritable — documentCleanCopies.ts
    //     re-uploads it when it reuses an existing `documents` row instead of
    //     inserting one — but that reuse selects only rows with
    //     `current_version_id IS NULL`, and `loadActiveVersion` resolves nothing
    //     for those: it needs either the envelope's pinned `source_version_id`
    //     (itself the id a successful `loadActiveVersion` returned) or a
    //     non-null `documents.current_version_id`. Bytes at a `storage_path`
    //     CAN be rewritten in place (chatTools.ts runEditDocument's
    //     turn-collapsing branch, and docxAssembly.ts persistAuthoredDocx on a
    //     retry), but every row those touch is an assistant-edit or
    //     Quill-authored version, whose inserts never set `pdf_storage_path` —
    //     so none of them is reachable from this branch.
    //   - It cannot disagree with the source bytes either, whichever version
    //     this resolves — the envelope's pinned `source_version_id`, or the
    //     document's current version when the envelope carries none. (Both
    //     creation paths now pin at proposal time; a NULL pin means a LEGACY
    //     envelope staged before pinning existed. And a pin that has fallen
    //     behind the document no longer reaches this function silently:
    //     renderAndSendEnvelope refuses the send unless the approver
    //     explicitly picks the prepared or the current version.) The rendition
    //     is read from the SAME row `loadActiveVersion` returned as
    //     `storage_path`, so the two always describe one version.
    //
    // Any failure falls through to the source bytes below: this is a pure
    // optimization and must never turn a working approval into a failure.
    if (active.pdf_storage_path) {
        try {
            const rendition = await ensureVersionPdfRenditionExportable({
                db,
                documentId,
                versionId: active.id,
                fileType,
            });
            if (rendition.bytes) {
                const buf = rendition.bytes;
                // Trust the header, not the column: a truncated or wrongly
                // keyed object must not be handed to the signing pipeline.
                if (looksLikePdf(buf)) {
                    let expectedText = rendition.expectedText;
                    if (!expectedText && fileType === "docx") {
                        const source = await downloadFile(active.storage_path);
                        if (source) {
                            expectedText = await extractDocxTextView(
                                Buffer.from(source),
                                "all",
                            );
                        }
                    }
                    return {
                        bytes: buf,
                        filename,
                        fileType: "pdf",
                        expectedText,
                    };
                }
                console.warn(
                    `[signatures] ignoring non-PDF rendition at ${active.pdf_storage_path} for version ${active.id}; falling back to the source bytes`,
                );
            }
        } catch (err) {
            console.warn(
                `[signatures] PDF rendition lookup failed for version ${active.id}; falling back to the source bytes`,
                err,
            );
        }
    }

    const bytes = await downloadFile(active.storage_path);
    const sourceBytes = bytes ? Buffer.from(bytes) : null;
    const expectedText =
        sourceBytes && fileType === "docx"
            ? await extractDocxTextView(sourceBytes, "all")
            : undefined;
    return { bytes: sourceBytes, filename, fileType, expectedText };
}

/** Resolve the envelope owner's email (best-effort) for completion emails. */
async function resolveOwnerEmail(
    db: Db,
    userId: string,
): Promise<string | null> {
    try {
        const { data } = await db
            .from("user_profiles")
            .select("email")
            .eq("user_id", userId)
            .maybeSingle();
        const email = (data as { email?: string | null } | null)?.email;
        return email ?? null;
    } catch {
        return null;
    }
}

/** Resolve the owner's display name (best-effort), falling back to their email. */
async function resolveOwnerName(
    db: Db,
    userId: string,
    fallbackEmail: string,
): Promise<string> {
    try {
        const { data } = await db
            .from("user_profiles")
            .select("display_name")
            .eq("user_id", userId)
            .maybeSingle();
        const displayName = (data as { display_name?: string | null } | null)
            ?.display_name;
        if (typeof displayName === "string" && displayName.trim())
            return displayName.trim();
    } catch {
        // fall back to the email below
    }
    return fallbackEmail;
}

/** Loose email shape check for user-supplied signer addresses. */
function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Mint a fresh single-use token for one signer, persist its hash, and email
 * them the `${SIGN_PUBLIC_BASE_URL}/sign/<token>` link. Used by both the initial
 * send (renderAndSendEnvelope) and the resend route, so the link format and the
 * minting stay in one place. Re-minting here rotates any prior token for that
 * signer, which is exactly what resend wants (the previous link goes dead).
 */
async function mintAndEmailSignerLink(
    db: Db,
    envelope: SignatureEnvelope,
    signer: SignatureSigner,
    expiresAt: string,
): Promise<string> {
    const baseUrl = process.env.SIGN_PUBLIC_BASE_URL ?? "";
    const { token, tokenHash } = generateSignerToken();
    await setSignerToken(db, signer.id, tokenHash, expiresAt);
    const link = `${baseUrl}/sign/${token}`;
    const { text, html } = signRequestEmail({
        subject: envelope.subject,
        message: envelope.message,
        link,
        nonbinding: await signaturesNonbindingFor(db, {
            orgId: envelope.org_id,
            projectId: envelope.project_id,
            userId: envelope.user_id,
        }),
    });
    await getEmailConnector().send({
        to: [signer.email],
        subject: envelope.subject,
        text,
        html,
    });
    // Return the freshly-minted plaintext link. Only the hash is persisted, so
    // this is the one moment the link is recoverable; the resend route hands it
    // back to the (authenticated, owner-checked) caller so they can copy + deliver
    // it directly when email is delayed or spam-filtered.
    return link;
}

/**
 * How an envelope's pinned source version stands against the document's
 * current one. `document_changed` is the whole point: the request was prepared
 * against specific bytes, and approving it later must not silently sign
 * whatever the document has become since.
 */
export interface EnvelopeVersionState {
    document_changed: boolean;
    prepared_version_number: number | null;
    current_version_number: number | null;
    /**
     * False when the pinned version ROW itself is gone, as opposed to merely
     * being superseded. Part of the client contract, not an internal detail:
     * the refusal message leans on it to say "an earlier version that no longer
     * exists" rather than "an earlier version", and a card that polls this
     * state instead of provoking the 409 must be able to say the same thing.
     */
    prepared_version_resolved: boolean;
}

/**
 * Resolve the version state of one envelope, or null when there is nothing to
 * compare: no document, NO PIN (a legacy envelope staged before pinning
 * existed — never block those, and never backfill them, since a backfill would
 * assert a version review that never happened), or a document with no
 * resolvable current version.
 *
 * Costs exactly ONE `loadActive` call in the matching case, which is the
 * overwhelmingly common one. The second call happens only on a real divergence,
 * to name the prepared version in the message — and it can legitimately resolve
 * nothing, if the pinned version row is gone.
 */
export async function resolveEnvelopeVersionState(
    db: Db,
    envelope: Pick<SignatureEnvelope, "document_id" | "source_version_id">,
    loadActive: typeof loadActiveVersion = loadActiveVersion,
): Promise<
    | (EnvelopeVersionState & {
          current_version_id: string;
      })
    | null
> {
    const pinned = envelope.source_version_id;
    if (!envelope.document_id || !pinned) return null;
    const current = await loadActive(envelope.document_id, db);
    if (!current) return null;
    if (current.id === pinned) {
        return {
            document_changed: false,
            prepared_version_number: current.version_number,
            current_version_number: current.version_number,
            current_version_id: current.id,
            prepared_version_resolved: true,
        };
    }
    const prepared = await loadActive(envelope.document_id, db, pinned);
    return {
        document_changed: true,
        prepared_version_number: prepared?.version_number ?? null,
        current_version_number: current.version_number,
        current_version_id: current.id,
        prepared_version_resolved: !!prepared,
    };
}

/**
 * Human phrase for a version in the refusal message. A missing NUMBER and a
 * missing ROW are different facts and must not be conflated — telling an
 * approver a version "no longer exists" when it does would send them off to
 * re-prepare a request they could simply have confirmed.
 */
function describeVersion(
    versionNumber: number | null,
    missingLabel: string,
): string {
    return versionNumber === null ? missingLabel : `version ${versionNumber}`;
}

export interface RenderAndSendDependencies {
    loadSource: typeof loadSourceDocument;
    convertToPdf: typeof ensurePdf;
    upload: typeof uploadFile;
    claim: typeof claimEnvelopeForSending;
    loadEnvelope: typeof getEnvelopeWithSigners;
    revokeTokens: typeof revokePendingSignerTokens;
    releaseClaim: typeof releaseEnvelopeSendClaim;
    dispatchLink: typeof mintAndEmailSignerLink;
    addEvent: typeof recordEvent;
    failOperation: typeof failAgentOperation;
    updateOperation: typeof updateAgentOperation;
    /** Resolves the document's CURRENT version for the staleness gate. */
    loadActive: typeof loadActiveVersion;
    /** Persists an approver's explicit "send the current version" re-pin. */
    repinSourceVersion: typeof repinEnvelopeSourceVersion;
    verifyPdf: typeof verifyPdfLayout;
}

const DEFAULT_RENDER_AND_SEND_DEPENDENCIES: RenderAndSendDependencies = {
    loadSource: loadSourceDocument,
    convertToPdf: ensurePdf,
    upload: uploadFile,
    claim: claimEnvelopeForSending,
    loadEnvelope: getEnvelopeWithSigners,
    revokeTokens: revokePendingSignerTokens,
    releaseClaim: releaseEnvelopeSendClaim,
    dispatchLink: mintAndEmailSignerLink,
    addEvent: recordEvent,
    failOperation: failAgentOperation,
    updateOperation: updateAgentOperation,
    loadActive: loadActiveVersion,
    repinSourceVersion: repinEnvelopeSourceVersion,
    verifyPdf: verifyPdfLayout,
};

/**
 * Render the envelope's source document to a stored PDF and dispatch signing
 * links, flipping the envelope to `sent`.
 *
 * Behavior is identical to the logic that was inlined in `POST /:id/approve`:
 *  1. load + flatten the source document to PDF (400 when it has no bytes)
 *  2. hash + upload the original under the signature-original key
 *  3. atomically claim pending_approval → sent while persisting the original
 *     path/hash; concurrent approvals may preflight but only one can dispatch
 *  4. mint a magic-link token per *external* signer (role 'signer', email !=
 *     approver) and email the link; the self-signer row is skipped and stays
 *     `pending` with no token. Sends run concurrently via Promise.allSettled;
 *     a ConnectorNotConfiguredError maps to 503, any other send error rethrows.
 *  5. record the `sent` event and mark the agent operation succeeded
 *
 * Step 0 is the staleness gate: an envelope pinned to a version the document
 * has since moved past is REFUSED (409 SIGNATURE_STALE_VERSION) unless the
 * approver explicitly picks a side via `confirmPreparedVersion` /
 * `useCurrentVersion`. Picking the prepared side when that version's row is
 * gone is refused the same way (409 SIGNATURE_PREPARED_VERSION_UNAVAILABLE):
 * it cannot be honored, and letting it fail as a send would take the agent
 * operation terminal under an envelope that is still pending.
 *
 * It lives here, not in a route, because two routes reach this pipeline — POST
 * /signatures/:id/approve and POST /operations/:id/approve →
 * runApprovedOperationSideEffect — and a route-level guard would be bypassed
 * by the other. Only the signatures route accepts the overrides; the generic
 * operations panel gets the plain 409 pointing at the signature card.
 *
 * Callers own the 404/403/owner/status guards; this helper assumes the envelope
 * is approved-and-ready and performs only the render + send.
 */
export async function renderAndSendEnvelope(
    db: Db,
    params: {
        envelope: SignatureEnvelope;
        signers: SignatureSigner[];
        approverUserId: string;
        approverEmail: string;
        /** Approver chose the version the request was prepared against. */
        confirmPreparedVersion?: boolean;
        /** Approver chose the document's current version (persists a re-pin). */
        useCurrentVersion?: boolean;
        /**
         * The pinned version row is already known to exist, because THIS
         * request resolved it microseconds ago. Set ONLY by
         * `sendFreshlyPinnedEnvelope`; it is not readable from a request body
         * and no route sets it.
         *
         * It suppresses the "prepared version is gone" pre-check below, which
         * on that flow would cost a redundant lookup and — far worse — could
         * refuse a freshly created envelope with a choice its caller has no way
         * to make, stranding it in `pending_approval`. That is the same reason
         * the staleness gate itself is answered up front there.
         */
        preparedVersionKnownPresent?: boolean;
    },
    dependencyOverrides: Partial<RenderAndSendDependencies> = {},
): Promise<
    | { ok: true }
    | {
          ok: false;
          status: number;
          detail: string;
          code?:
              | DocumentConverterErrorCode
              | DocumentLayoutQaErrorCode
              | "SIGNATURE_SEND_FAILED"
              | "SIGNATURE_STALE_VERSION"
              | "SIGNATURE_PREPARED_VERSION_UNAVAILABLE"
              | "BETA_RECIPIENT_NOT_ALLOWED"
              | "BETA_DATA_POLICY_REQUIRED";
      }
> {
    const {
        envelope,
        signers,
        approverUserId,
        approverEmail,
        confirmPreparedVersion = false,
        useCurrentVersion = false,
        preparedVersionKnownPresent = false,
    } = params;
    const dependencies = {
        ...DEFAULT_RENDER_AND_SEND_DEPENDENCIES,
        ...dependencyOverrides,
    };
    const now = new Date().toISOString();
    let phase = "check_version";
    let claimed = false;

    try {
        await assertBetaRecipientsAllowed(db, {
            orgId: envelope.org_id,
            projectId: envelope.project_id,
            userId: envelope.user_id,
            recipients: signers.map((signer) => signer.email),
        });
    } catch (error) {
        if (error instanceof BetaPolicyError) {
            return {
                ok: false,
                status: error.status,
                code: error.code,
                detail: error.message,
            };
        }
        throw error;
    }

    // Both overrides at once is a client bug, and the two mean opposite things.
    // Refuse rather than guess which one the approver actually clicked — this
    // is a cryptographic signature on a specific set of bytes.
    if (confirmPreparedVersion && useCurrentVersion) {
        return {
            ok: false,
            status: 400,
            detail: "Choose either the prepared version or the current version, not both.",
        };
    }

    // A version choice on a legacy envelope carrying NO pin is unanswerable,
    // and silently ignoring it is the dangerous reading: with nothing pinned
    // the send falls through to the document's CURRENT version, so
    // `confirm_prepared_version: true` would do the exact opposite of what its
    // name promises. Honoring it is not an option either — there is no
    // recorded prepared version to send, and inventing one is precisely the
    // backfill that would assert a version review nobody performed. So refuse,
    // and say why.
    //
    // A PLAIN approve (no flags) on these envelopes is deliberately untouched:
    // production has pending NULL-pin envelopes and they must keep sending.
    if (
        !envelope.source_version_id &&
        (confirmPreparedVersion || useCurrentVersion)
    ) {
        return {
            ok: false,
            status: 400,
            detail: "This signature request predates version pinning, so there is no prepared version to choose between. Approve it without a version choice, or cancel and prepare a new request.",
        };
    }

    // A failed dispatch is retryable only while no signer has acted. Tokens are
    // revoked before the conditional status rollback, so a partially-delivered
    // email cannot leave a live magic link attached to a pending envelope.
    const rollbackClaim = async (): Promise<boolean> => {
        if (!claimed) return true;
        try {
            const current = await dependencies.loadEnvelope(db, envelope.id);
            const hasProgress =
                current?.signers.some(
                    (signer) =>
                        signer.role === "signer" && signer.status !== "pending",
                ) ?? false;
            if (hasProgress || current?.envelope.status !== "sent")
                return false;
            await dependencies.revokeTokens(db, envelope.id);
            return await dependencies.releaseClaim(db, envelope.id);
        } catch (rollbackErr) {
            console.error(
                `[signatures] CRITICAL: failed to roll back claim on envelope ${envelope.id} after a send error`,
                rollbackErr,
            );
            return false;
        }
    };

    const recordFailure = async (
        error: unknown,
        retryable: boolean,
        code: string,
    ) => {
        console.error("[signatures] send failed", {
            envelopeId: envelope.id,
            documentId: envelope.document_id,
            phase,
            code,
            retryable,
            error: error instanceof Error ? error.message : String(error),
        });
        await Promise.allSettled([
            dependencies.addEvent(db, {
                envelopeId: envelope.id,
                type: "send_failed",
                payload: { phase, code, retryable },
            }),
            dependencies.failOperation(
                db,
                envelope.agent_operation_id,
                error instanceof Error ? error : new Error(String(error)),
            ),
        ]);
    };

    try {
        // 0. Staleness gate. `send_for_signature` only STAGES an envelope, so
        // the document can be edited between proposal and approval; without
        // this the signer cryptographically signs bytes nobody reviewed when
        // the request was prepared.
        //
        // Three-way, not "just send the current version". The per-turn version
        // anchor means an envelope can be born mismatched AND be exactly right:
        // when the user is reading Lease.docx v2 in Doc Review while the matter
        // document is at v5 and asks Quill to send "this", the proposal
        // correctly pins v2. If the only forward action were "send current",
        // that block would override the user's deliberate choice. So both
        // directions have to be reachable, and neither is the default.
        //
        // No TOCTOU window for a PINNED envelope past this point: the gate
        // leaves `sendVersionId` holding an immutable version id, threaded
        // into loadSource, so an edit landing mid-send adds a new version row
        // and cannot change which bytes get signed. A legacy NULL pin has no
        // id to send by: `sendVersionId` stays null and loadSource re-resolves
        // the document's current version, exactly as it did before this gate
        // existed. That window is inherent to those envelopes — closing it
        // would mean backfilling a version review that never happened.
        let sendVersionId = envelope.source_version_id;
        // `confirmPreparedVersion` sends the pin as-is, which is already what
        // `sendVersionId` holds, so no lookup can change the outcome — don't
        // pay for two queries whose results we would only discard. The no-flag
        // path is unchanged: it still resolves the state and still refuses on a
        // divergence. `useCurrentVersion` still needs the lookup, to learn
        // which version to re-pin to.
        const versionState = confirmPreparedVersion
            ? null
            : await resolveEnvelopeVersionState(
                  db,
                  envelope,
                  dependencies.loadActive,
              );

        // The one thing confirming a pin still has to establish: that the
        // pinned ROW is actually there. It can be gone — that is precisely the
        // case the staleness refusal below names "an earlier version that no
        // longer exists" — and `loadSource` resolves by exact version id with NO
        // fallback, so without this the confirmed send runs on to `load_source`,
        // finds no bytes, and returns "Source document bytes could not be
        // loaded": a storage-layer string shown to an approver who did nothing
        // wrong, on a path that also calls `recordFailure` and so marks the
        // agent operation terminal while the envelope stays `pending_approval`.
        // That is exactly the dead-row state the staleness refusal is written
        // to avoid, reached by pressing the button that refusal offers.
        //
        // So refuse the way that refusal refuses: no `recordFailure`, operation
        // untouched, envelope still pending and still retryable via the two
        // choices that remain. One targeted lookup, only on this path, and
        // never the document's current version — nothing it could say changes
        // the answer.
        if (
            confirmPreparedVersion &&
            !preparedVersionKnownPresent &&
            envelope.document_id &&
            sendVersionId
        ) {
            const prepared = await dependencies.loadActive(
                envelope.document_id,
                db,
                sendVersionId,
            );
            if (!prepared) {
                await dependencies.addEvent(db, {
                    envelopeId: envelope.id,
                    type: "send_failed",
                    payload: {
                        phase,
                        code: "SIGNATURE_PREPARED_VERSION_UNAVAILABLE",
                        retryable: true,
                    },
                });
                return {
                    ok: false,
                    status: 409,
                    code: "SIGNATURE_PREPARED_VERSION_UNAVAILABLE",
                    // "Send the current version" is the surviving button's
                    // label, word for word, so the mapping from sentence to
                    // affordance stays exact.
                    detail: "The version this signature request was prepared against is no longer available, so it cannot be sent. Send the current version instead, or cancel and prepare a new request.",
                };
            }
        }

        if (versionState?.document_changed) {
            if (!useCurrentVersion) {
                // Deliberately NOT recordFailure: that would also fail the
                // agent operation, marking it terminal (`failed`,
                // completed_at set) while the envelope stays
                // `pending_approval` and retryable — the operations panel
                // would show a dead row while the signature card still offers
                // approval. This is a refusal awaiting a decision, not a
                // failure. Mirror of the claim-conflict 409 below. The event
                // alone keeps it in the audit trail.
                await dependencies.addEvent(db, {
                    envelopeId: envelope.id,
                    type: "send_failed",
                    payload: {
                        phase,
                        code: "SIGNATURE_STALE_VERSION",
                        retryable: true,
                    },
                });
                const prepared = describeVersion(
                    versionState.prepared_version_number,
                    versionState.prepared_version_resolved
                        ? "an earlier version"
                        : "an earlier version that no longer exists",
                );
                const current = describeVersion(
                    versionState.current_version_number,
                    "a newer version",
                );
                return {
                    ok: false,
                    status: 409,
                    code: "SIGNATURE_STALE_VERSION",
                    detail: `This signature request was prepared against ${prepared}, but the document is now ${current}. Send the prepared version or the current version explicitly from the signature card, or cancel and prepare a new request.`,
                };
            }
            // Persist the re-pin BEFORE any send side effect, so
            // source_version_id stays a truthful record of what was sent even
            // if the send then fails and is retried. Conditional on
            // pending_approval: losing that race means another approval is
            // already dispatching, which is exactly the existing 409.
            const repinned = await dependencies.repinSourceVersion(
                db,
                envelope.id,
                versionState.current_version_id,
            );
            if (!repinned) {
                return {
                    ok: false,
                    status: 409,
                    detail: "This signature request is already being sent or is no longer pending approval.",
                };
            }
            sendVersionId = versionState.current_version_id;
            await dependencies.addEvent(db, {
                envelopeId: envelope.id,
                type: "version_repinned",
                payload: {
                    from_version_id: envelope.source_version_id,
                    to_version_id: versionState.current_version_id,
                    to_version_number: versionState.current_version_number,
                    approved_by: approverUserId,
                },
            });
        }

        // Prepare the immutable original BEFORE status changes. A missing
        // converter or storage failure therefore leaves the envelope visibly
        // pending and immediately retryable.
        phase = "load_source";
        const { bytes, filename, fileType, expectedText } =
            await dependencies.loadSource(
                db,
                envelope.document_id,
                sendVersionId,
            );
        if (!bytes) {
            const error = new Error(
                "Source document bytes could not be loaded",
            );
            await recordFailure(error, true, "SIGNATURE_SEND_FAILED");
            return {
                ok: false,
                status: 400,
                detail: error.message,
                code: "SIGNATURE_SEND_FAILED",
            };
        }

        phase = "convert_source";
        let original = await dependencies.convertToPdf({
            bytes,
            filename,
            fileType,
        });
        if (betaModeEnabled()) original = await stampBetaNotice(original);
        phase = "verify_original";
        await dependencies.verifyPdf(original, { expectedText });
        const originalSha256 = sha256Hex(original);
        const originalPdfPath = signatureOriginalKey(
            approverUserId,
            envelope.id,
        );
        phase = "upload_original";
        await dependencies.upload(
            originalPdfPath,
            bufferToArrayBuffer(original),
            "application/pdf",
        );

        // Claim only after preparation succeeds. The deterministic storage key
        // makes two concurrent preflights harmless; this conditional update is
        // still the single winner for token minting and email side effects.
        phase = "claim_envelope";
        const claim = await dependencies.claim(db, envelope.id, {
            userId: approverUserId,
            at: now,
            originalPdfPath,
            originalSha256,
        });
        if (!claim) {
            return {
                ok: false,
                status: 409,
                detail: "This signature request is already being sent or is no longer pending approval.",
            };
        }
        claimed = true;

        const expiresAt =
            envelope.expires_at ??
            new Date(Date.now() + FOURTEEN_DAYS_MS).toISOString();
        const selfEmail = approverEmail ?? "";

        // Per-signer: mint a token, persist its hash, email the signing link.
        // The envelope owner (self-signer) signs in-app via sign-self, so we
        // skip minting a token / emailing a magic link for their row; it stays
        // `pending` with no token. External signers are emailed as usual.
        // The sends are independent, so dispatch them concurrently.
        const externalSigners = signers.filter(
            (s) =>
                s.role === "signer" &&
                !(
                    selfEmail &&
                    s.email.toLowerCase() === selfEmail.toLowerCase()
                ),
        );
        phase = "dispatch_links";
        const sendResults = await Promise.allSettled(
            externalSigners.map((signer) =>
                dependencies.dispatchLink(
                    db,
                    envelope,
                    signer,
                    expiresAt,
                ),
            ),
        );
        const sendFailure = sendResults.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (sendFailure) {
            throw sendFailure.reason;
        }

        phase = "finalize_send";
        await dependencies.addEvent(db, {
            envelopeId: envelope.id,
            type: "sent",
            payload: { approved_by: approverUserId },
        });
        await dependencies.updateOperation(db, envelope.agent_operation_id, {
            status: "succeeded",
            approvalStatus: "approved",
            approvedByUserId: approverUserId,
            completed: true,
        });
        await recordAuditEvent(db, { orgId: envelope.org_id, matterId: envelope.matter_id, projectId: envelope.project_id, actorUserId: approverUserId, eventType: "signature.sent", targetType: "signature_envelope", targetId: envelope.id });

        return { ok: true };
    } catch (err) {
        const retryable = await rollbackClaim();
        const converter = converterHttpError(err);
        if (converter) {
            await recordFailure(err, retryable, converter.code);
            return { ok: false, ...converter };
        }
        const layoutQa = layoutQaHttpError(err);
        if (layoutQa) {
            await recordFailure(err, retryable, layoutQa.code);
            return {
                ok: false,
                status: layoutQa.status,
                detail: layoutQa.detail,
                code: layoutQa.code,
            };
        }
        if (err instanceof ConnectorNotConfiguredError) {
            await recordFailure(err, retryable, "SIGNATURE_SEND_FAILED");
            return {
                ok: false,
                status: 503,
                detail: err.message,
                code: "SIGNATURE_SEND_FAILED",
            };
        }
        await recordFailure(err, retryable, "SIGNATURE_SEND_FAILED");
        return {
            ok: false,
            status: 502,
            detail: retryable
                ? "The signature request could not be sent. It remains pending and can be retried."
                : "Some signing activity may already have occurred. The request remains active; review its status and resend any pending links.",
            code: "SIGNATURE_SEND_FAILED",
        };
    }
}

/**
 * Send an envelope THIS SAME REQUEST just created and pinned.
 *
 * `POST /signatures` resolves the document's active version, pins it, and
 * sends — but createAgentOperation + createEnvelope + insertSignatureFields sit
 * in between, so three or more round trips separate the pin from the gate. An
 * edit landing in that window would otherwise turn a 201 into a 409 telling the
 * caller to choose a version "from the signature card" — a card this flow never
 * renders — and strand the envelope it just created in `pending_approval`.
 *
 * So this path answers the gate up front instead of tripping over it. That is
 * NOT a bypass: it still runs through `renderAndSendEnvelope`, it still sends
 * the PINNED version, and a second ungated route into the send pipeline is
 * exactly what the gate exists to prevent. The confirmation is true by
 * construction — the approver here IS the caller, and the version being
 * confirmed is the one this very request resolved microseconds earlier.
 *
 * Conditioned on the pin actually being present so the flag can never
 * contradict the envelope: an unpinned envelope has nothing to confirm (and
 * `renderAndSendEnvelope` refuses a version choice on one), while the gate is a
 * no-op there anyway.
 */
export function sendFreshlyPinnedEnvelope(
    db: Db,
    params: {
        envelope: SignatureEnvelope;
        signers: SignatureSigner[];
        approverUserId: string;
        approverEmail: string;
    },
    dependencyOverrides: Partial<RenderAndSendDependencies> = {},
): ReturnType<typeof renderAndSendEnvelope> {
    return renderAndSendEnvelope(
        db,
        {
            ...params,
            confirmPreparedVersion: params.envelope.source_version_id !== null,
            // Same "true by construction" argument, applied to the row's
            // existence: this request resolved that version microseconds ago,
            // so the confirm path must not re-verify it — and must not be able
            // to refuse this flow with a version choice it never offers.
            preparedVersionKnownPresent: true,
        },
        dependencyOverrides,
    );
}

/**
 * Shared serializer for the authenticated single-envelope response. Used by both
 * `GET /signatures/:id` and `POST /signatures` so the two payloads cannot drift.
 * `executedPdfUrl`/`certificateUrl` are passed in by the caller (null for a
 * freshly-sent envelope that has not been executed yet).
 */
export function serializeEnvelopeDetail(
    envelope: SignatureEnvelope,
    signers: SignatureSigner[],
    urls: {
        executedPdfUrl: string | null;
        certificateUrl: string | null;
    },
    /**
     * Only supplied where it is both meaningful and free to compute (a
     * pending_approval envelope that carries a pin). Omitted entirely
     * otherwise, so the other call sites keep their existing payload shape.
     */
    versionState?: EnvelopeVersionState | null,
): {
    envelope: {
        id: string;
        status: EnvelopeStatus;
        subject: string;
        message: string;
        document_id: string | null;
        executed_document_id: string | null;
        expires_at: string | null;
        completed_at: string | null;
        created_at: string;
    };
    signers: {
        id: string;
        name: string;
        email: string;
        role: SignerRole;
        status: SignerStatus;
        viewed_at: string | null;
        signed_at: string | null;
    }[];
    executed_pdf_url: string | null;
    certificate_url: string | null;
    version_state?: EnvelopeVersionState;
} {
    return {
        ...(versionState
            ? {
                  version_state: {
                      document_changed: versionState.document_changed,
                      prepared_version_number:
                          versionState.prepared_version_number,
                      current_version_number:
                          versionState.current_version_number,
                      // Deliberately included: without it the hub card can only
                      // say "an earlier version" while the 409 for the SAME
                      // envelope says "an earlier version that no longer
                      // exists" — one reads as still sendable, the other as
                      // re-prepare. `current_version_id` stays out; it is the
                      // re-pin target, not something a client decides with.
                      prepared_version_resolved:
                          versionState.prepared_version_resolved,
                  },
              }
            : {}),
        envelope: {
            id: envelope.id,
            status: envelope.status,
            subject: envelope.subject,
            message: envelope.message,
            document_id: envelope.document_id,
            executed_document_id: envelope.executed_document_id,
            expires_at: envelope.expires_at,
            completed_at: envelope.completed_at,
            created_at: envelope.created_at,
        },
        signers: publicSigners(signers).map((s) => ({
            id: s.id,
            name: s.name,
            email: s.email,
            role: s.role,
            status: s.status,
            viewed_at: s.viewed_at,
            signed_at: s.signed_at,
        })),
        executed_pdf_url: urls.executedPdfUrl,
        certificate_url: urls.certificateUrl,
    };
}

// ---------------------------------------------------------------------------
// Completion pipeline
// ---------------------------------------------------------------------------

/**
 * Run the executed-document pipeline when the last signer signs:
 *  1. gather signer stamp inputs
 *  2. stamp + cryptographically sign the original PDF; hash + store it
 *  3. build + store the Certificate of Completion
 *  4. register the executed PDF as an in-app document (best-effort)
 *  5. persist the executed-artifact metadata; record the event + operation
 *  6. email the executed PDF + certificate to all parties (best-effort)
 *
 * Status contract: the caller MUST have already claimed 'completed' via
 * claimEnvelopeForCompletion (see claimAndRunCompletion); this function never
 * sets envelope status itself. It THROWS on any pre-artifact failure (missing
 * or undownloadable original, stamping, upload) — the caller rolls the claim
 * back to 'partially_signed' and records a 'completion_failed' event so a
 * transient R2/crypto error at the last-signer moment leaves the envelope
 * recoverable (POST /signatures/:id/retry-completion) instead of stranded as
 * a false 'completed'. Steps 4 and 6 stay best-effort: once the executed PDF
 * and certificate exist, a registration/email hiccup must not roll back.
 */
async function runCompletion(
    db: Db,
    envelope: SignatureEnvelope,
    signers: SignatureSigner[],
): Promise<void> {
    const documentName = await (async () => {
        const { filename } = await loadSourceDocument(
            db,
            envelope.document_id,
            envelope.source_version_id,
        );
        return filename;
    })();

    // 1. Load the original PDF and resolve where each signature should land
    // (token → text-anchor → bottom-stack fallback; best-effort, never throws).
    // These used to be silent `return`s — which, combined with a swallowed R2
    // error in downloadFile, stranded a fully-signed envelope forever with
    // zero log output. Throw instead: the caller rolls the claim back and the
    // owner can retry.
    if (!envelope.original_pdf_path)
        throw new Error(
            `envelope ${envelope.id} has no original_pdf_path; cannot build the executed PDF`,
        );
    const originalRaw = await downloadFile(envelope.original_pdf_path);
    if (!originalRaw)
        throw new Error(
            `original PDF ${envelope.original_pdf_path} could not be downloaded; cannot complete envelope ${envelope.id}`,
        );
    const original = Buffer.from(originalRaw);
    // 2. Load each signer's captured mark once (drawn PNG, if any).
    const signerParticipants = signers.filter((s) => s.role === "signer");
    const pngBySigner = new Map<string, Buffer | null>();
    for (const s of signerParticipants) {
        let png: Buffer | null = null;
        if (s.signature_image_path) {
            const raw = await downloadFile(s.signature_image_path);
            png = raw ? Buffer.from(raw) : null;
        }
        pngBySigner.set(s.id, png);
    }

    // 3. Decide placement. Explicit sender-placed fields (Phase 2) win and are
    // stamped exactly in their boxes; otherwise fall back to the token /
    // text-anchor heuristic (Phase 1). Then crypto-sign.
    const fields = await getEnvelopeFields(db, envelope.id);
    let stamped: Buffer;
    let placementMode: string;
    if (fields.length > 0) {
        const signerById = new Map(signerParticipants.map((s) => [s.id, s]));
        const fieldInputs: FieldStampInput[] = [];
        for (const f of fields) {
            const s = signerById.get(f.signer_id);
            if (!s) continue;
            fieldInputs.push({
                type: f.type,
                page: f.page,
                xPct: f.x_pct,
                yPct: f.y_pct,
                wPct: f.w_pct,
                hPct: f.h_pct,
                name: s.name,
                typedName: s.typed_name,
                signaturePng: pngBySigner.get(s.id) ?? null,
                signedAt: s.signed_at ?? new Date().toISOString(),
            });
        }
        stamped = await stampSignatures(original, [], { fields: fieldInputs });
        placementMode = "fields";
    } else {
        const { placements, coverRects, mode } = await resolveSignerPlacements(
            original,
            signers,
        );
        placementMode = mode;
        const stampInputs: SignerStampInput[] = signerParticipants.map((s) => ({
            name: s.name,
            typedName: s.typed_name,
            signaturePng: pngBySigner.get(s.id) ?? null,
            signedAt: s.signed_at ?? new Date().toISOString(),
            placement: placements.get(s.id),
        }));
        stamped = await stampSignatures(original, stampInputs, { coverRects });
    }
    const executed = await embedCryptographicSignature(stamped);
    const originalExpectedText = await extractPdfTextForQa(original);
    const executedQa = await verifyPdfLayout(executed, {
        expectedText: originalExpectedText,
    });
    const executedSha256 = sha256Hex(executed);

    // 3. Certificate of Completion.
    // Resolved in the same process that just signed, so the disclosure and the
    // attribution row always match the certificate that produced the signature.
    const signingIdentity = describeSigningIdentity();
    const events = await listEvents(db, envelope.id);
    const cert = await buildCertificateOfCompletion({
        envelopeId: envelope.id,
        subject: envelope.subject,
        documentName,
        originalSha256: envelope.original_sha256 ?? "",
        executedSha256,
        signers: signers.map((s) => ({
            name: s.name,
            email: s.email,
            signedAt: s.signed_at,
            ip: s.signer_ip,
            consentAt: s.consent_at,
        })),
        events: events.map((e) => ({
            type: e.type,
            created_at: e.created_at,
            detail:
                typeof e.payload?.detail === "string"
                    ? (e.payload.detail as string)
                    : undefined,
        })),
        signingIdentity,
    });
    await verifyPdfLayout(cert, {
        expectedText: [
            "Certificate of Completion",
            envelope.id,
            envelope.subject,
            documentName,
            ...signers.flatMap((signer) => [signer.name, signer.email]),
        ].join(" "),
    });
    const executedPath = signatureExecutedKey(envelope.user_id, envelope.id);
    const certificatePath = signatureCertificateKey(
        envelope.user_id,
        envelope.id,
    );
    try {
        await uploadFile(
            executedPath,
            bufferToArrayBuffer(executed),
            "application/pdf",
        );
        await uploadFile(
            certificatePath,
            bufferToArrayBuffer(cert),
            "application/pdf",
        );
    } catch (error) {
        await Promise.all([
            deleteFile(executedPath).catch(() => {}),
            deleteFile(certificatePath).catch(() => {}),
        ]);
        throw error;
    }

    // 4. Register the executed PDF as an in-app document (best-effort).
    let executedDocumentId: string | undefined;
    let executedVersionId: string | undefined;
    try {
        const executedFilename = `${documentName.replace(/\.[^./\\]+$/, "")} (executed).pdf`;
        const { data: docRow, error: docErr } = await db
            .from("documents")
            .insert({
                project_id: envelope.project_id,
                user_id: envelope.user_id,
                filename: executedFilename,
                file_type: "pdf",
                size_bytes: executed.byteLength,
                status: "ready",
            })
            .select("id")
            .single();
        if (!docErr && docRow) {
            executedDocumentId = docRow.id as string;
            const versionRow = await insertDocumentVersionCompat({
                db,
                fallbackSource: "user_upload",
                errorMessage: "Failed to record executed document version.",
                values: {
                    document_id: executedDocumentId,
                    storage_path: signatureExecutedKey(
                        envelope.user_id,
                        envelope.id,
                    ),
                    source: "generated",
                    version_number: 1,
                    display_name: executedFilename,
                    created_by_user_id: envelope.user_id,
                    metadata: {
                        derivation_kind: "executed_signature_pdf",
                        signature_envelope_id: envelope.id,
                        layout_qa: {
                            status: "passed",
                            schema_version: executedQa.schema_version,
                            checked_at: executedQa.checked_at,
                        },
                    },
                    ...layoutQaVersionValues(executedQa),
                },
            });
            executedVersionId = versionRow.id;
            await db
                .from("documents")
                .update({ current_version_id: executedVersionId })
                .eq("id", executedDocumentId);
        }
    } catch (err) {
        // Best-effort: a failure here must not break completion.
        console.warn("[signatures] executed-doc registration failed", err);
        executedDocumentId = undefined;
        executedVersionId = undefined;
    }

    // 5. Persist the executed-artifact metadata + record event/operation.
    // Status is NOT written here: the caller already claimed 'completed'
    // upfront (claimEnvelopeForCompletion), and re-writing it would resurrect
    // a claim that was rolled back or cancelled while this pipeline ran.
    const { error: metadataError } = await db
        .from("signature_envelopes")
        .update({
            executed_pdf_path: signatureExecutedKey(
                envelope.user_id,
                envelope.id,
            ),
            executed_sha256: executedSha256,
            certificate_path: signatureCertificateKey(
                envelope.user_id,
                envelope.id,
            ),
            ...(executedDocumentId
                ? { executed_document_id: executedDocumentId }
                : {}),
            ...(executedVersionId
                ? { executed_version_id: executedVersionId }
                : {}),
            completed_at: new Date().toISOString(),
        })
        .eq("id", envelope.id);
    if (metadataError) throw metadataError;

    // Signing-identity attribution (migration 041). Separate best-effort
    // update: a schema that predates 041 must never sink the executed-artifact
    // metadata above.
    try {
        const { error: attributionError } = await db
            .from("signature_envelopes")
            .update({
                signing_cert_mode: signingIdentity.mode,
                signing_cert_subject: signingIdentity.subjectCN,
                signing_cert_issuer: signingIdentity.issuerCN,
                signing_cert_serial: signingIdentity.serialHex,
                signing_cert_fingerprint_sha256:
                    signingIdentity.sha256Fingerprint,
                signing_cert_not_after:
                    signingIdentity.notAfter.toISOString(),
            })
            .eq("id", envelope.id);
        if (attributionError) throw attributionError;
    } catch (err) {
        console.warn(
            "[signatures] signing-identity attribution failed (is migration 041 applied?)",
            err,
        );
    }
    await recordEvent(db, {
        envelopeId: envelope.id,
        type: "completed",
        payload: {
            executed_sha256: executedSha256,
            placement_mode: placementMode,
        },
    });
    await updateAgentOperation(db, envelope.agent_operation_id, {
        status: "succeeded",
        completed: true,
        resultDocumentId: executedDocumentId ?? null,
        metadata: { executed_sha256: executedSha256 },
    });

    // 6. Notify all parties (best-effort — completion is already persisted).
    //
    // The owner is internal to the sending Workspace, so intra-domain delivery
    // is reliable: they get the attachment copy (executed PDF + certificate).
    // External signers are on consumer mailboxes whose spam filters quarantine
    // the attachment-laden, multi-recipient "completed" notice (an executed
    // contract + a hash/IP-laden certificate from a young sending domain reads
    // as a fake-DocuSign lure). So each external signer instead gets a
    // single-recipient, attachment-FREE email with a secure download link —
    // matching the signing invite, which delivers to the inbox. Sends are
    // per-recipient so one failure can't take the others down, and each failure
    // is logged distinctly rather than swallowed as one opaque line.
    try {
        const ownerEmail = await resolveOwnerEmail(db, envelope.user_id);
        const ownerEmailLower = ownerEmail ? ownerEmail.toLowerCase() : null;
        const subject = `Signed & completed — ${documentName}`;
        const nonbinding = await signaturesNonbindingFor(db, {
            orgId: envelope.org_id,
            projectId: envelope.project_id,
            userId: envelope.user_id,
        });

        // External signer rows (anyone who isn't the owner), deduped by email.
        // Each gets a fresh 14-day token so the link works even if the original
        // signing token has expired; the old link going dead is fine post-sign.
        const externalByEmail = new Map<string, SignatureSigner>();
        for (const s of signers) {
            const email = typeof s.email === "string" ? s.email.trim() : "";
            if (!email) continue;
            const lower = email.toLowerCase();
            if (ownerEmailLower && lower === ownerEmailLower) continue;
            if (!externalByEmail.has(lower)) externalByEmail.set(lower, s);
        }

        const baseUrl = process.env.SIGN_PUBLIC_BASE_URL ?? "";
        const downloadExpiry = new Date(
            Date.now() + FOURTEEN_DAYS_MS,
        ).toISOString();

        const sends: { label: string; run: () => Promise<unknown> }[] = [];

        for (const signer of externalByEmail.values()) {
            sends.push({
                label: signer.email,
                run: async () => {
                    const { token, tokenHash } = generateSignerToken();
                    await setSignerToken(
                        db,
                        signer.id,
                        tokenHash,
                        downloadExpiry,
                    );
                    const ready = completionReadyEmail({
                        documentName,
                        link: `${baseUrl}/sign/${token}`,
                        nonbinding,
                    });
                    await getEmailConnector().send({
                        to: [signer.email],
                        subject,
                        text: ready.text,
                        html: ready.html,
                    });
                },
            });
        }

        if (ownerEmail) {
            sends.push({
                label: ownerEmail,
                run: async () => {
                    const completion = completionEmail({
                        documentName,
                        nonbinding,
                    });
                    await getEmailConnector().send({
                        to: [ownerEmail],
                        subject,
                        text: completion.text,
                        html: completion.html,
                        attachments: [
                            {
                                filename: "executed.pdf",
                                contentType: "application/pdf",
                                content: executed,
                            },
                            {
                                filename: "certificate.pdf",
                                contentType: "application/pdf",
                                content: cert,
                            },
                        ],
                    });
                },
            });
        }

        const results = await Promise.allSettled(sends.map((s) => s.run()));
        results.forEach((r, i) => {
            if (r.status === "rejected") {
                console.error(
                    `[signatures] completion email to ${sends[i].label} failed`,
                    r.reason,
                );
            }
        });
    } catch (err) {
        // Best-effort: completion already persisted. Log so a silent setup
        // failure (e.g. owner lookup) is visible rather than opaque.
        console.error("[signatures] completion notify failed", err);
    }
}

/**
 * Atomically claim the envelope's terminal status, then run the completion
 * pipeline. Returns:
 *   'completed'   — this call won the claim and the pipeline succeeded
 *   'not_claimed' — another call already owns/owned completion (or the
 *                   envelope is no longer live, e.g. cancelled). NOT an error.
 *   'failed'      — this call won the claim but the pipeline threw; the claim
 *                   was rolled back to 'partially_signed'
 *
 * The claim (conditional UPDATE, sent/partially_signed → completed) is the
 * mutex that makes the last-signer transition single-winner: a double submit
 * or two concurrent last signers both reach this point, but only one proceeds
 * into the seconds-long stamping/PKCS#12 pipeline. Without it, completion was
 * read-then-act and only flipped status at the END of that pipeline, so the
 * whole thing could run twice.
 *
 * Rollback contract (mirror of renderAndSendEnvelope's send claim): on ANY
 * pipeline failure after a successful claim, roll the envelope back to
 * 'partially_signed', record a 'completion_failed' event
 * (signature_events.type is unconstrained — see migration 012), and log
 * loudly. The owner then recovers via POST /signatures/:id/retry-completion;
 * the alternative was a fully-signed envelope stranded forever in silence.
 */
async function claimAndRunCompletion(
    db: Db,
    envelopeId: string,
    signers: SignatureSigner[],
): Promise<"completed" | "not_claimed" | "failed"> {
    const claimed = await claimEnvelopeForCompletion(db, envelopeId);
    if (!claimed) return "not_claimed";
    try {
        await runCompletion(db, claimed, signers);
        return "completed";
    } catch (err) {
        console.error(
            `[signatures] CRITICAL: completion pipeline failed for envelope ${envelopeId}; rolling back to partially_signed (owner can POST /signatures/${envelopeId}/retry-completion)`,
            err,
        );
        try {
            await setEnvelopeStatus(db, envelopeId, "partially_signed");
        } catch (rollbackErr) {
            console.error(
                `[signatures] CRITICAL: failed to roll back completion claim on envelope ${envelopeId} — envelope may read 'completed' without an executed PDF`,
                rollbackErr,
            );
        }
        await recordEvent(db, {
            envelopeId,
            type: "completion_failed",
            payload: {
                detail: err instanceof Error ? err.message : String(err),
            },
        }).catch(() => {});
        return "failed";
    }
}

/**
 * Capture one signer's signature and advance the envelope. Shared by the public
 * token route (`POST /sign/:token`) and the authed self-sign route
 * (`POST /signatures/:id/sign-self`):
 *  1. optionally decode + upload the drawn signature PNG
 *  2. mark the signer signed (conditional — see below) + record the `signed`
 *     event
 *  3. reload signers and, when all signers are complete, claim + run the
 *     completion pipeline (single-winner; see claimAndRunCompletion)
 *
 * Callers own their own validation (token / ownership, consent, already-signed)
 * before invoking this; the helper performs the capture + sign + completion.
 * `signed: false` means markSignerSigned matched no row — another submit signed
 * this signer between the caller's read and the update — and callers map it to
 * 409 (the first submit owns the event + completion).
 */
async function applySignerSignature(
    db: Db,
    params: {
        envelope: SignatureEnvelope;
        signer: SignatureSigner;
        typedName: string;
        signaturePng: string | null;
        drawn: boolean;
        ip: string;
        userAgent: string;
    },
): Promise<
    | { signed: true; allComplete: boolean }
    | { signed: false; reason: "already_signed" }
> {
    const { envelope, signer, typedName, signaturePng, drawn, ip, userAgent } =
        params;
    const now = new Date().toISOString();

    // Persist a drawn signature image when supplied.
    let signatureImagePath: string | null = null;
    if (drawn && signaturePng) {
        const base64 = signaturePng.replace(/^data:image\/png;base64,/, "");
        const pngBuffer = Buffer.from(base64, "base64");
        const key = signerSignatureImageKey(
            envelope.user_id,
            envelope.id,
            signer.id,
        );
        await uploadFile(key, bufferToArrayBuffer(pngBuffer), "image/png");
        signatureImagePath = key;
    }

    const signedRow = await markSignerSigned(db, signer.id, {
        typedName,
        signatureImagePath: signatureImagePath as unknown as string,
        ip,
        userAgent,
        consentAt: now,
    });
    if (!signedRow) {
        // Conditional update matched no row: a concurrent submit signed this
        // row after the caller's already-signed check. Don't record a second
        // 'signed' event or race the completion pipeline.
        return { signed: false, reason: "already_signed" };
    }
    await recordEvent(db, {
        envelopeId: envelope.id,
        signerId: signer.id,
        type: "signed",
        ip,
        userAgent,
    });
    await recordAuditEvent(db, {
        orgId: envelope.org_id,
        matterId: envelope.matter_id,
        projectId: envelope.project_id,
        eventType: "signature.signed",
        targetType: "signature_envelope",
        targetId: envelope.id,
    });

    // Reload signers; if all are complete, claim + run the completion
    // pipeline. A lost claim or a failed pipeline still responds ok to the
    // signer — THEIR signature was recorded; completion is owned by the claim
    // winner (or, after a rollback, by the owner's retry-completion).
    const reloaded = await getEnvelopeWithSigners(db, envelope.id);
    const signers = reloaded?.signers ?? [];
    const allComplete = allSignersComplete(signers);
    if (allComplete && reloaded) {
        await claimAndRunCompletion(db, envelope.id, signers);
    }

    return { signed: true, allComplete };
}

// ---------------------------------------------------------------------------
// signaturesRouter (mounted at /signatures, authenticated)
// ---------------------------------------------------------------------------

// GET /signatures — list the caller's envelopes.
router.get("/", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        // ?project_id scopes to one matter's envelopes (access-checked);
        // otherwise list the caller's own envelopes across all matters.
        const projectId =
            typeof req.query.project_id === "string" && req.query.project_id
                ? req.query.project_id
                : null;
        if (projectId) {
            const access = await checkProjectAccess(
                projectId,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(403)
                    .json({ detail: "No access to this matter." });
        }
        const envelopes = await listEnvelopes(db, projectId
            ? { projectId }
            : {
                  projectIds: await listAccessibleProjectIds(
                      userId,
                      userEmail,
                      db,
                  ),
              });
        // Strip token hashes from every nested signer.
        const safe = envelopes.map((e) => ({
            envelope: e.envelope,
            signers: publicSigners(e.signers),
        }));
        res.json({ envelopes: safe });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to load envelopes",
        });
    }
});

// GET /signatures/:id — one envelope with signers (token hashes stripped).
router.get("/:id", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const result = await getEnvelopeWithSigners(db, req.params.id);
        if (!result)
            return void res.status(404).json({ detail: "Envelope not found" });
        const { envelope } = result;
        if (!(await envelopeAccessAllowed(db, envelope, userId, userEmail, "read")))
            return void res.status(403).json({ detail: "Forbidden" });

        const executedPdfUrl = envelope.executed_pdf_path
            ? await getSignedUrl(
                  envelope.executed_pdf_path,
                  900,
                  "signed.pdf",
                  "inline",
              )
            : null;
        const certificateUrl = envelope.certificate_path
            ? await getSignedUrl(
                  envelope.certificate_path,
                  900,
                  "certificate.pdf",
                  "inline",
              )
            : null;

        // Version state only where the approval card can act on it: a pending
        // envelope that carries a pin. This endpoint is polled every 6 seconds
        // by the status card, so every other envelope (sent, completed,
        // cancelled, or legacy-unpinned) must add ZERO queries. Best-effort —
        // a lookup failure degrades to "no version state" rather than 500ing a
        // poll that has nothing to do with versions.
        const versionState =
            envelope.status === "pending_approval" && envelope.source_version_id
                ? await resolveEnvelopeVersionState(db, envelope).catch(
                      () => null,
                  )
                : null;

        res.json(
            serializeEnvelopeDetail(
                envelope,
                result.signers,
                { executedPdfUrl, certificateUrl },
                versionState,
            ),
        );
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to load envelope",
        });
    }
});

// GET /signatures/document-pdf/:documentId — the document's active version
// flattened to PDF (the SAME bytes the completion pipeline stamps onto). The
// field-placement UI renders this so placed coordinates line up exactly with
// the executed PDF. Authorized against the document (owner or shared-project).
router.get("/document-pdf/:documentId", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const documentId = req.params.documentId;
        const { data: doc } = await db
            .from("documents")
            .select("id, user_id, project_id, org_id, matter_id, filename, current_version_id, lifecycle_status")
            .eq("id", documentId)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const access = await ensureDocAccess(
            doc as {
                id: string;
                user_id: string;
                project_id: string | null;
                filename: string | null;
                current_version_id: string | null;
            },
            userId,
            userEmail,
            db,
        );
        if (!access.ok)
            return void res
                .status(403)
                .json({ detail: "You do not have access to this document." });

        const { bytes, filename, fileType } = await loadSourceDocument(
            db,
            documentId,
            null,
        );
        if (!bytes)
            return void res
                .status(400)
                .json({ detail: "Document has no bytes to render." });
        const pdf = await ensurePdf({ bytes, filename, fileType });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Cache-Control", "no-store");
        res.send(pdf);
    } catch (err) {
        const converter = converterHttpError(err);
        if (converter) {
            return void res.status(converter.status).json({
                detail: converter.detail,
                code: converter.code,
            });
        }
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to render document PDF",
        });
    }
});

// POST /signatures — create an envelope from a document and send it for
// signature in one step (non-chat "Send for signature" action). Authorizes
// against the document, snapshots its active version, normalizes signers, then
// reuses renderAndSendEnvelope so the send behaves exactly like /:id/approve.
router.post("/", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as {
            document_id?: unknown;
            signers?: unknown;
            subject?: unknown;
            message?: unknown;
            expires_in_days?: unknown;
            include_self_as_signer?: unknown;
            fields?: unknown;
        };

        const documentId =
            typeof body.document_id === "string" ? body.document_id.trim() : "";
        if (!documentId)
            return void res
                .status(400)
                .json({ detail: "document_id is required." });

        // Load the document and authorize (owner or shared-project member).
        const { data: doc } = await db
            .from("documents")
            .select("id, user_id, project_id, filename, current_version_id")
            .eq("id", documentId)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docRow = doc as {
            id: string;
            user_id: string;
            project_id: string | null;
            org_id: string | null;
            matter_id: string | null;
            filename: string | null;
            current_version_id: string | null;
            lifecycle_status: string | null;
        };
        const access = await ensureDocAccess(docRow, userId, userEmail, db, "approve");
        if (!access.ok)
            return void res
                .status(403)
                .json({ detail: "You do not have access to this document." });

        // Snapshot the active version to send.
        const active = await loadActiveVersion(documentId, db);
        if (!active)
            return void res
                .status(400)
                .json({ detail: "Document has no version to send." });
        const sourceVersionId = active.id;

        // Normalize signers: trim, require a valid email, default role 'signer',
        // and drop blanks.
        const rawSigners = Array.isArray(body.signers) ? body.signers : [];
        const signerInputs: SignerInput[] = [];
        for (const raw of rawSigners) {
            if (!raw || typeof raw !== "object") continue;
            const r = raw as {
                name?: unknown;
                email?: unknown;
                role?: unknown;
            };
            const email = typeof r.email === "string" ? r.email.trim() : "";
            if (!email || !looksLikeEmail(email)) continue;
            const name =
                typeof r.name === "string" && r.name.trim()
                    ? r.name.trim()
                    : email;
            const role: SignerRole = r.role === "cc" ? "cc" : "signer";
            signerInputs.push({ name, email, role });
        }

        // Optionally append the caller as a signer when not already present.
        if (body.include_self_as_signer === true && userEmail) {
            const already = signerInputs.some(
                (s) => s.email.toLowerCase() === userEmail.toLowerCase(),
            );
            if (!already) {
                const selfName = await resolveOwnerName(db, userId, userEmail);
                signerInputs.push({
                    name: selfName,
                    email: userEmail,
                    role: "signer",
                });
            }
        }

        // Collapse duplicate emails (same rule the chat path uses) and require
        // at least one actual signer.
        const signers = dedupeSignerInputs(signerInputs);
        if (!signers.some((s) => s.role === "signer"))
            return void res
                .status(400)
                .json({ detail: "Add at least one signer." });

        // Parse optional sender-placed fields (visual drag-drop placement). Each
        // references its signer by email; we keep only known types/valid coords
        // and clamp to [0,1]. Unknown emails are dropped.
        const allowedFieldTypes = new Set<SignatureFieldType>([
            "signature",
            "initials",
            "date",
            "name",
        ]);
        const signerEmails = new Set(
            signers.map((s) => s.email.trim().toLowerCase()),
        );
        const rawFields = Array.isArray(body.fields) ? body.fields : [];
        const fieldInputs: SignatureFieldInput[] = [];
        for (const raw of rawFields) {
            if (!raw || typeof raw !== "object") continue;
            const r = raw as Record<string, unknown>;
            const email =
                typeof r.signer_email === "string" ? r.signer_email.trim() : "";
            const type = typeof r.type === "string" ? r.type : "signature";
            if (!email || !signerEmails.has(email.toLowerCase())) continue;
            if (!allowedFieldTypes.has(type as SignatureFieldType)) continue;
            const nums = [r.x_pct, r.y_pct, r.w_pct, r.h_pct].map((v) =>
                typeof v === "number" && Number.isFinite(v) ? v : NaN,
            );
            if (nums.some((n) => Number.isNaN(n))) continue;
            const page =
                typeof r.page === "number" && Number.isFinite(r.page)
                    ? Math.max(0, Math.floor(r.page))
                    : 0;
            const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
            fieldInputs.push({
                signer_email: email,
                type: type as SignatureFieldType,
                page,
                x_pct: clamp(nums[0]),
                y_pct: clamp(nums[1]),
                w_pct: clamp(nums[2]),
                h_pct: clamp(nums[3]),
            });
        }

        const expiresInDays =
            typeof body.expires_in_days === "number" &&
            Number.isFinite(body.expires_in_days)
                ? body.expires_in_days
                : 14;
        const expiresAt = new Date(
            Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
        ).toISOString();

        const subject =
            typeof body.subject === "string" && body.subject.trim()
                ? body.subject.trim()
                : "Signature request";
        const message =
            typeof body.message === "string" && body.message.trim()
                ? body.message.trim()
                : "";

        // Track the action as an agent operation (no approval gate — the caller
        // explicitly invoked "Send for signature").
        const op = await createAgentOperation({
            db,
            userId,
            projectId: docRow.project_id ?? null,
            toolName: "send_for_signature",
            actionType: "send_for_signature",
            mutating: true,
            requiresApproval: false,
            sourceDocumentId: documentId,
            // Same pin the envelope gets below — the ledger row must agree
            // with the envelope about which version was sent.
            sourceVersionId,
            arguments: { signer_count: signers.length, via: "document_action" },
        });

        const created = await createEnvelope(db, {
            userId,
            orgId: docRow.org_id,
            matterId: docRow.matter_id,
            projectId: docRow.project_id ?? null,
            agentOperationId: op?.id ?? null,
            documentId,
            sourceVersionId,
            subject,
            message,
            originalPdfPath: "",
            originalSha256: "",
            expiresAt,
            signers,
        });
        if (!created)
            return void res.status(503).json({
                detail: "Signature service is not available. Try again later.",
            });

        // Persist sender-placed fields (best-effort; completion falls back to
        // the anchor heuristic if the table is missing or no fields were placed).
        if (fieldInputs.length > 0)
            await insertSignatureFields(
                db,
                created.envelope.id,
                created.signers,
                fieldInputs,
            ).catch(() => 0);

        // Render + send immediately, reusing the shared pipeline — through
        // sendFreshlyPinnedEnvelope, because this request resolved and pinned
        // `sourceVersionId` a few round trips up and so confirms its own pin
        // rather than letting an edit landing in that window 409 the send
        // against a signature card this flow never opens.
        const sent = await sendFreshlyPinnedEnvelope(db, {
            envelope: created.envelope,
            signers: created.signers,
            approverUserId: userId,
            approverEmail: userEmail,
        });
        if (!sent.ok) {
            return void res.status(sent.status).json({
                detail: sent.detail,
                ...(sent.code ? { code: sent.code } : {}),
            });
        }

        // Reload and return the same shape as GET /signatures/:id (executed +
        // certificate are null for a freshly-sent envelope).
        const reloaded = await getEnvelopeWithSigners(db, created.envelope.id);
        const envelope = reloaded?.envelope ?? created.envelope;
        const signerRows = reloaded?.signers ?? created.signers;
        res.status(201).json(
            serializeEnvelopeDetail(envelope, signerRows, {
                executedPdfUrl: null,
                certificateUrl: null,
            }),
        );
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to create signature request",
        });
    }
});

// POST /signatures/:id/approve — flatten, store, tokenize, and email links.
//
// Optional body flags resolve a SIGNATURE_STALE_VERSION refusal (the document
// moved past the version this request was prepared against). This is the only
// route that accepts them: the generic operations panel has no version picker,
// so it gets the plain 409 telling the approver to use the signature card.
// `express.json` is mounted for ["/sign", "/signatures"] in index.ts, so the
// body is parsed; `req.body` is still guarded for a request that sends none.
router.post("/:id/approve", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const body = (req.body ?? {}) as {
            confirm_prepared_version?: unknown;
            use_current_version?: unknown;
        };
        // Strict === true: a truthy string from a mis-typed client must not
        // silently authorize signing a version the approver never saw.
        const confirmPreparedVersion = body.confirm_prepared_version === true;
        const useCurrentVersion = body.use_current_version === true;

        const result = await getEnvelopeWithSigners(db, req.params.id);
        if (!result)
            return void res.status(404).json({ detail: "Envelope not found" });
        const { envelope, signers } = result;
        if (!(await envelopeAccessAllowed(db, envelope, userId, userEmail, "approve")))
            return void res.status(403).json({ detail: "Forbidden" });
        if (envelope.status !== "pending_approval")
            return void res
                .status(400)
                .json({ detail: "Envelope is not pending approval" });

        const sent = await renderAndSendEnvelope(db, {
            envelope,
            signers,
            approverUserId: userId,
            approverEmail: userEmail,
            confirmPreparedVersion,
            useCurrentVersion,
        });
        if (!sent.ok)
            return void res.status(sent.status).json({
                detail: sent.detail,
                ...(sent.code ? { code: sent.code } : {}),
            });

        const reloaded = await getEnvelopeWithSigners(db, envelope.id);
        res.json({
            envelope: reloaded?.envelope ?? envelope,
            signers: publicSigners(reloaded?.signers ?? signers),
        });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to approve envelope",
        });
    }
});

// POST /signatures/:id/sign-self — the envelope owner signs their own row
// in-app (no magic link), reusing the shared signer-apply pipeline.
router.post("/:id/sign-self", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const result = await getEnvelopeWithSigners(db, req.params.id);
        if (!result)
            return void res.status(404).json({ detail: "Envelope not found" });
        const { envelope } = result;
        if (!(await envelopeAccessAllowed(db, envelope, userId, userEmail, "approve")))
            return void res.status(403).json({ detail: "Forbidden" });
        // Same lifecycle guard as the public token route: signing a cancelled
        // (or otherwise non-live) envelope must be impossible from every path.
        if (!isSignableEnvelopeStatus(envelope.status))
            return void res.status(409).json({
                detail: "This signature request is no longer active.",
            });

        // Target a *pending* row so a second same-email signer row stays
        // reachable after the first is signed (the lowest-order row may already
        // be signed). Only when there is no pending row do we look again to tell
        // "already signed" (409) apart from "not a signer here" (404).
        const signer = await findSignerByEnvelopeAndEmail(
            db,
            envelope.id,
            userEmail,
            { status: "pending" },
        );
        if (!signer) {
            const existing = await findSignerByEnvelopeAndEmail(
                db,
                envelope.id,
                userEmail,
            );
            if (existing && existing.status === "signed")
                return void res
                    .status(409)
                    .json({ detail: "You have already signed." });
            return void res.status(404).json({
                detail: "No pending signature for you on this envelope.",
            });
        }

        const body = (req.body ?? {}) as {
            typed_name?: unknown;
            signature_png?: unknown;
            consent?: unknown;
            drawn?: unknown;
        };
        const typedName =
            typeof body.typed_name === "string" ? body.typed_name : "";
        const consent = body.consent === true;
        const drawn = body.drawn === true;
        const signaturePng =
            typeof body.signature_png === "string" ? body.signature_png : null;

        if (!consent)
            return void res.status(400).json({ detail: "Consent required." });

        const ip = req.ip ?? "";
        const userAgent = req.header("user-agent") ?? "";

        const applied = await applySignerSignature(db, {
            envelope,
            signer,
            typedName,
            signaturePng,
            drawn,
            ip,
            userAgent,
        });
        if (!applied.signed)
            return void res
                .status(409)
                .json({ detail: "You have already signed." });

        res.json({
            ok: true,
            status: "signed",
            all_complete: applied.allComplete,
        });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error ? err.message : "Failed to sign envelope",
        });
    }
});

// POST /signatures/:id/cancel — cancel a (non-completed) envelope.
router.post("/:id/cancel", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const envelope = await getEnvelope(db, req.params.id);
        if (!envelope)
            return void res.status(404).json({ detail: "Envelope not found" });
        if (!(await envelopeAccessAllowed(db, envelope, userId, userEmail, "approve")))
            return void res.status(403).json({ detail: "Forbidden" });
        // An executed envelope is a legal record — it cannot be un-completed.
        if (envelope.status === "completed")
            return void res.status(409).json({
                detail: "This envelope is already completed and cannot be cancelled.",
            });
        const cancelled = await setEnvelopeStatus(db, envelope.id, "cancelled");
        // Revoke the outstanding magic links (belt) on top of the /sign/:token
        // envelope-status guard (braces) — a cancelled envelope must not be
        // signable through a link that was emailed before the cancel.
        await revokePendingSignerTokens(db, envelope.id);
        await updateAgentOperation(db, envelope.agent_operation_id, {
            status: "cancelled",
        });
        await recordEvent(db, {
            envelopeId: envelope.id,
            type: "cancelled",
            payload: { cancelled_by: userId },
        });
        await recordAuditEvent(db, {
            orgId: envelope.org_id,
            matterId: envelope.matter_id,
            projectId: envelope.project_id,
            actorUserId: userId,
            eventType: "signature.cancelled",
            targetType: "signature_envelope",
            targetId: envelope.id,
        });
        res.json({ envelope: cancelled ?? envelope });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to cancel envelope",
        });
    }
});

// POST /signatures/:id/retry-completion — owner-only recovery for an envelope
// whose signers ALL signed but whose completion pipeline failed (the claim was
// rolled back to 'partially_signed' and a 'completion_failed' event recorded —
// see claimAndRunCompletion). Re-claims and re-runs the pipeline. Mirrors the
// owner checks of cancel/resend.
router.post("/:id/retry-completion", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const result = await getEnvelopeWithSigners(db, req.params.id);
        if (!result)
            return void res.status(404).json({ detail: "Envelope not found" });
        const { envelope, signers } = result;
        if (!(await envelopeAccessAllowed(db, envelope, userId, userEmail, "approve")))
            return void res.status(403).json({ detail: "Forbidden" });
        if (
            envelope.status !== "partially_signed" ||
            !allSignersComplete(signers)
        )
            return void res.status(409).json({
                detail: "This envelope is not awaiting a completion retry.",
            });

        const outcome = await claimAndRunCompletion(db, envelope.id, signers);
        if (outcome === "failed")
            return void res.status(502).json({
                detail: "Completion failed again; the envelope was returned to partially_signed. Check the server logs.",
            });
        if (outcome === "not_claimed")
            return void res.status(409).json({
                detail: "Completion is already running or already finished.",
            });

        const reloaded = await getEnvelopeWithSigners(db, envelope.id);
        res.json({
            envelope: reloaded?.envelope ?? envelope,
            signers: publicSigners(reloaded?.signers ?? signers),
        });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to retry completion",
        });
    }
});

// POST /:id/resend — re-mint + re-email signing links for still-pending external
// signers. Recovers from a lost / wrong-port / never-delivered link without
// recreating the envelope. Only the token hash is stored, so the prior link is
// unrecoverable; re-minting here rotates it (the old link goes dead). The in-app
// self-signer (no token, signs via sign-self) and already signed/declined
// signers are skipped.
router.post("/:id/resend", async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerSupabase();
    try {
        const result = await getEnvelopeWithSigners(db, req.params.id);
        if (!result)
            return void res.status(404).json({ detail: "Envelope not found" });
        const { envelope, signers } = result;
        if (!(await envelopeAccessAllowed(db, envelope, userId, userEmail, "approve")))
            return void res.status(403).json({ detail: "Forbidden" });
        if (
            envelope.status !== "sent" &&
            envelope.status !== "partially_signed"
        )
            return void res.status(409).json({
                detail: "This envelope is not awaiting signatures.",
            });

        const expiresAt =
            envelope.expires_at ??
            new Date(Date.now() + FOURTEEN_DAYS_MS).toISOString();
        // Pending external signers only: skip the in-app self-signer (the
        // approver's own row, which carries no token) and anyone done.
        const targets = signers.filter(
            (s) =>
                s.role === "signer" &&
                s.status === "pending" &&
                !(
                    userEmail &&
                    s.email.toLowerCase() === userEmail.toLowerCase()
                ),
        );
        if (targets.length === 0)
            return void res.status(409).json({
                detail: "No pending signers to resend to.",
            });

        const sendResults = await Promise.allSettled(
            targets.map(async (signer) => ({
                email: signer.email,
                link: await mintAndEmailSignerLink(
                    db,
                    envelope,
                    signer,
                    expiresAt,
                ),
            })),
        );
        const sendFailure = sendResults.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (sendFailure) {
            if (sendFailure.reason instanceof ConnectorNotConfiguredError)
                return void res
                    .status(503)
                    .json({ detail: sendFailure.reason.message });
            throw sendFailure.reason;
        }
        // Hand the minted links back to the owner so they can copy + deliver them
        // directly — email to external domains can be delayed or spam-filtered
        // (for example when the sending domain has no SPF/DKIM/DMARC), and the
        // localhost dev link only resolves on this machine anyway.
        const resentLinks = sendResults
            .filter(
                (
                    r,
                ): r is PromiseFulfilledResult<{
                    email: string;
                    link: string;
                }> => r.status === "fulfilled",
            )
            .map((r) => r.value);

        await recordEvent(db, {
            envelopeId: envelope.id,
            type: "resent",
            payload: {
                resent_by: userId,
                signer_count: targets.length,
            },
        });

        const reloaded = await getEnvelopeWithSigners(db, envelope.id);
        const executedPdfUrl = envelope.executed_pdf_path
            ? await getSignedUrl(
                  envelope.executed_pdf_path,
                  900,
                  "signed.pdf",
                  "inline",
              )
            : null;
        const certificateUrl = envelope.certificate_path
            ? await getSignedUrl(
                  envelope.certificate_path,
                  900,
                  "certificate.pdf",
                  "inline",
              )
            : null;
        res.json({
            ...serializeEnvelopeDetail(
                reloaded?.envelope ?? envelope,
                reloaded?.signers ?? signers,
                { executedPdfUrl, certificateUrl },
            ),
            resent_links: resentLinks,
        });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to resend signing links",
        });
    }
});

// ---------------------------------------------------------------------------
// signRouter (mounted at /sign, PUBLIC — token-gated)
// ---------------------------------------------------------------------------

/** True when an ISO timestamp is in the past. */
function isExpired(iso: string | null): boolean {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t < Date.now();
}

// GET /sign/:token — signer-facing envelope view.
signRouter.get("/:token", async (req: Request, res: Response) => {
    const db = createServerSupabase();
    try {
        const tokenHash = hashSignerToken(req.params.token);
        const found = await findSignerByTokenHash(db, tokenHash);
        if (!found)
            return void res
                .status(404)
                .json({ error: "Invalid or expired link" });
        const { signer, envelope } = found;
        if (isExpired(signer.token_expires_at))
            return void res
                .status(410)
                .json({ error: "expired", expired: true });

        const alreadySigned = signer.status === "signed";
        const completed = envelope.status === "completed";

        // Lifecycle guard: the token only proves WHO the signer is — the
        // envelope decides whether there is anything left to sign. Cancelled /
        // declined / expired envelopes are gone (410). 'completed' stays
        // reachable on GET: the completion email links signers back here to
        // download the executed PDF + certificate (see esign-test-script.md).
        // `detail` is the repo-wide error key; `error` is what the public sign
        // page's extractError reads — send both.
        if (!completed && !isSignableEnvelopeStatus(envelope.status))
            return void res.status(410).json({
                detail: "This signature request is no longer active.",
                error: "This signature request is no longer active.",
            });

        const ip = req.ip ?? "";
        const userAgent = req.header("user-agent") ?? "";
        const newlyViewed = await markSignerViewed(db, signer.id, {
            ip,
            userAgent,
        });
        if (newlyViewed) {
            await recordEvent(db, {
                envelopeId: envelope.id,
                signerId: signer.id,
                type: "viewed",
                ip,
                userAgent,
            });
            await recordAuditEvent(db, {
                orgId: envelope.org_id,
                matterId: envelope.matter_id,
                projectId: envelope.project_id,
                eventType: "signature.viewed",
                targetType: "signature_envelope",
                targetId: envelope.id,
            });
        }

        let documentName = "Document";
        const src = await loadSourceDocument(
            db,
            envelope.document_id,
            envelope.source_version_id,
        );
        if (src.filename) documentName = src.filename;

        const pdfUrl = envelope.original_pdf_path
            ? await getSignedUrl(
                  envelope.original_pdf_path,
                  900,
                  "document.pdf",
              )
            : null;

        // Once completed, let the signer download their executed copy + the
        // certificate straight from this page (the completion email links here).
        // Inline disposition lets the browser render the PDF; minted fresh on
        // every load (900s) so the links never go stale. Mirrors the owner
        // route (GET /signatures/:id).
        const executedPdfUrl =
            completed && envelope.executed_pdf_path
                ? await getSignedUrl(
                      envelope.executed_pdf_path,
                      900,
                      "signed.pdf",
                      "inline",
                  )
                : null;
        const certificateUrl =
            completed && envelope.certificate_path
                ? await getSignedUrl(
                      envelope.certificate_path,
                      900,
                      "certificate.pdf",
                      "inline",
                  )
                : null;

        res.json({
            envelope: {
                id: envelope.id,
                subject: envelope.subject,
                message: envelope.message,
                document_name: documentName,
                status: envelope.status,
                expires_at: envelope.expires_at,
            },
            signer: {
                id: signer.id,
                name: signer.name,
                email: signer.email,
                status: signer.status,
            },
            pdf_url: pdfUrl,
            executed_pdf_url: executedPdfUrl,
            certificate_url: certificateUrl,
            already_signed: alreadySigned,
            expired: false,
            completed,
            signatures_nonbinding: await signaturesNonbindingFor(db, {
                orgId: envelope.org_id,
                projectId: envelope.project_id,
                userId: envelope.user_id,
            }),
        });
    } catch (err) {
        // Log the real error: non-Error throws (e.g. raw PostgREST objects)
        // collapse to the generic message below, which hides the cause.
        console.error("[sign] GET /sign/:token failed", err);
        res.status(500).json({
            error:
                err instanceof Error
                    ? err.message
                    : "Failed to load signing page",
        });
    }
});

// POST /sign/:token — capture a signature.
signRouter.post("/:token", async (req: Request, res: Response) => {
    const db = createServerSupabase();
    try {
        const tokenHash = hashSignerToken(req.params.token);
        const found = await findSignerByTokenHash(db, tokenHash);
        if (!found)
            return void res
                .status(404)
                .json({ error: "Invalid or expired link" });
        const { signer, envelope } = found;
        if (isExpired(signer.token_expires_at))
            return void res
                .status(410)
                .json({ error: "expired", expired: true });
        // Lifecycle guard: only a live envelope may accept a signature. The
        // token validates the signer, not the envelope — without this check a
        // CANCELLED envelope could still be signed through a link emailed
        // before the cancel, and driven to 'completed'. Unlike the GET,
        // 'completed' is NOT signable here.
        if (!isSignableEnvelopeStatus(envelope.status))
            return void res.status(410).json({
                detail: "This signature request is no longer active.",
                error: "This signature request is no longer active.",
            });
        if (signer.status === "declined")
            return void res
                .status(409)
                .json({ error: "This signer has declined" });

        const body = (req.body ?? {}) as {
            typed_name?: unknown;
            signature_png?: unknown;
            consent?: unknown;
            drawn?: unknown;
        };
        const typedName =
            typeof body.typed_name === "string" ? body.typed_name : "";
        const consent = body.consent === true;
        const drawn = body.drawn === true;
        const signaturePngDataUrl =
            typeof body.signature_png === "string" ? body.signature_png : null;

        if (!consent)
            return void res.status(400).json({ error: "Consent required" });
        if (signer.status === "signed")
            return void res.status(409).json({ error: "Already signed" });

        const ip = req.ip ?? "";
        const userAgent = req.header("user-agent") ?? "";

        const applied = await applySignerSignature(db, {
            envelope,
            signer,
            typedName,
            signaturePng: signaturePngDataUrl,
            drawn,
            ip,
            userAgent,
        });
        if (!applied.signed)
            return void res.status(409).json({ error: "Already signed" });

        res.json({
            ok: true,
            status: "signed",
            all_complete: applied.allComplete,
        });
    } catch (err) {
        // Log the real error: non-Error throws collapse to the generic message.
        console.error("[sign] POST /sign/:token failed", err);
        res.status(500).json({
            error:
                err instanceof Error
                    ? err.message
                    : "Failed to record signature",
        });
    }
});

export { router as signaturesRouter, signRouter };
