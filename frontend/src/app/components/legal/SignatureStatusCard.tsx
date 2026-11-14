"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    FileSignature,
    Check,
    CheckCheck,
    Clock,
    Eye,
    Loader2,
    FileCheck2,
    Award,
    PenLine,
    Ban,
    Copy,
    ShieldCheck,
    X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { signatureConsentCopy } from "@/app/lib/signatureConsentCopy";
import { useSignaturesNonbinding } from "@/app/lib/useSignaturesNonbinding";
import {
    ApiError,
    approveSignature,
    cancelSignature,
    getSignatureEnvelope,
    resendSignatureLinks,
    signSelf,
    SIGNATURE_STALE_VERSION,
    type SignatureEnvelopeDetail,
    type SignerRef,
} from "@/app/lib/cocoaLegalApi";
import SignaturePad, { type SignatureMode } from "./SignaturePad";
import {
    describeVersionMismatch,
    SignatureVersionChoice,
} from "./SignatureVersionChoice";

/** Envelope statuses after which no further progress is possible. */
const TERMINAL_STATUSES = new Set([
    "completed",
    "declined",
    "cancelled",
    "expired",
]);
const LIVE_SIGNING_STATUSES = new Set(["sent", "partially_signed"]);

const POLL_INTERVAL_MS = 6000;

function isTerminal(status: string | undefined | null): boolean {
    return !!status && TERMINAL_STATUSES.has(status);
}

export function isLiveSigningStatus(
    status: string | undefined | null,
): boolean {
    return !!status && LIVE_SIGNING_STATUSES.has(status);
}

function formatStamp(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function EnvelopeStatusBadge({ status }: { status: string }) {
    const map: Record<
        string,
        { label: string; cls: string; icon: React.ReactNode }
    > = {
        sent: {
            label: "Awaiting signatures",
            cls: "bg-amber-100 text-amber-900",
            icon: <Clock className="h-3 w-3" />,
        },
        partially_signed: {
            label: "Partially signed",
            cls: "bg-blue-100 text-blue-800",
            icon: <PenLine className="h-3 w-3" />,
        },
        completed: {
            label: "Completed",
            cls: "bg-green-100 text-green-800",
            icon: <CheckCheck className="h-3 w-3" />,
        },
        declined: {
            label: "Declined",
            cls: "bg-red-100 text-red-700",
            icon: <Ban className="h-3 w-3" />,
        },
        cancelled: {
            label: "Cancelled",
            cls: "bg-gray-100 text-gray-600",
            icon: <X className="h-3 w-3" />,
        },
        expired: {
            label: "Expired",
            cls: "bg-gray-100 text-gray-600",
            icon: <Clock className="h-3 w-3" />,
        },
        pending_approval: {
            label: "Pending approval",
            cls: "bg-amber-100 text-amber-900",
            icon: <Clock className="h-3 w-3" />,
        },
        draft: {
            label: "Draft",
            cls: "bg-gray-100 text-gray-600",
            icon: <Clock className="h-3 w-3" />,
        },
    };
    const meta = map[status] ?? {
        label: status,
        cls: "bg-gray-100 text-gray-600",
        icon: <Clock className="h-3 w-3" />,
    };
    return (
        <span
            className={`ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.cls}`}
        >
            {meta.icon}
            {meta.label}
        </span>
    );
}

function SignerChip({ status }: { status: string | undefined }) {
    const s = status ?? "pending";
    if (s === "signed") {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-800">
                <Check className="h-3 w-3" />
                Signed
            </span>
        );
    }
    if (s === "viewed") {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-800">
                <Eye className="h-3 w-3" />
                Viewed
            </span>
        );
    }
    if (s === "declined") {
        return (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                <Ban className="h-3 w-3" />
                Declined
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
            <Clock className="h-3 w-3" />
            Pending
        </span>
    );
}

/**
 * Live status view for an e-signature envelope, rendered inline in the chat
 * after the envelope has been approved & sent. It polls the backend while the
 * envelope is non-terminal so the user watches each signer move pending →
 * viewed → signed without leaving the conversation, and — when the signed-in
 * user is themselves a pending signer — lets them sign in-app via the same
 * signature pad the public signer page uses.
 */
export function SignatureStatusCard({
    envelopeId,
    initialSigners,
    onCancelled,
}: {
    envelopeId: string;
    initialSigners?: SignerRef[];
    /** Called after the envelope is successfully cancelled (e.g. to refetch a list). */
    onCancelled?: () => void;
}) {
    const { user } = useAuth();
    const signaturesNonbinding = useSignaturesNonbinding();

    const [detail, setDetail] = useState<SignatureEnvelopeDetail | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    // Which executed-artifact link is being re-minted (for the on-click fetch).
    const [opening, setOpening] = useState<"executed" | "certificate" | null>(
        null,
    );

    // Resend-link state (recover a lost / undelivered external link).
    const [resending, setResending] = useState(false);
    const [resentAt, setResentAt] = useState<number | null>(null);
    const [resendError, setResendError] = useState<string | null>(null);
    // Freshly-minted links returned by the resend call, so the owner can copy +
    // deliver directly when email is delayed or spam-filtered.
    const [resentLinks, setResentLinks] = useState<
        { email: string; link: string }[]
    >([]);
    const [copiedLink, setCopiedLink] = useState<string | null>(null);

    // A pending envelope can be recovered directly from the signature hub.
    // Keep the same explicit arm → confirm gate used by the chat approval card.
    const [approvalState, setApprovalState] = useState<
        "idle" | "arming" | "sending"
    >("idle");
    const [approvalError, setApprovalError] = useState<string | null>(null);
    // The backend's 409 sentence, kept only as a fallback for the window where
    // the refusal is known but `version_state` isn't (a refetch that failed).
    // The poll is the primary detector here — this card learns about a mismatch
    // without anyone clicking anything.
    const [staleRefusal, setStaleRefusal] = useState<string | null>(null);
    // Which version choice is in flight, so the other cannot also be fired.
    const [sendingChoice, setSendingChoice] = useState<
        "prepared" | "current" | null
    >(null);

    // Cancel state (arm → confirm). Only offered for non-terminal envelopes.
    const [cancelArmed, setCancelArmed] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState<string | null>(null);

    // In-app signing panel state.
    const [signOpen, setSignOpen] = useState(false);
    const [mode, setMode] = useState<SignatureMode>("type");
    const [typedName, setTypedName] = useState("");
    const [hasDrawing, setHasDrawing] = useState(false);
    const [consent, setConsent] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [signError, setSignError] = useState<string | null>(null);
    const exportRef = useRef<(() => string | null) | null>(null);

    // Keep the latest signers available for first paint before the first fetch
    // resolves, falling back to whatever the parent handed us.
    const signers = detail?.signers ?? initialSigners ?? [];
    const status = detail?.envelope.status;
    const isLive = isLiveSigningStatus(status);

    // The document has moved off the version this request was pinned to. The
    // server only sends `version_state` for a pending, pinned envelope, so its
    // absence means "nothing to choose between" — never "unchanged".
    const versionState = detail?.version_state ?? null;
    const versionNotice =
        versionState?.document_changed === true
            ? describeVersionMismatch(versionState)
            : staleRefusal;
    const versionMismatch =
        status === "pending_approval" && versionNotice !== null;

    const refetch = useCallback(async () => {
        try {
            const next = await getSignatureEnvelope(envelopeId);
            setDetail(next);
            setLoadError(null);
            // A mismatch can resolve without anyone acting here — the pinned
            // version is restored, or the envelope leaves pending_approval
            // entirely — so a recorded refusal must not outlive it and keep
            // the plain approve hidden.
            if (!next.version_state?.document_changed) setStaleRefusal(null);
            return next;
        } catch (err) {
            setLoadError(
                err instanceof Error
                    ? err.message
                    : "Could not load signature status.",
            );
            return null;
        }
    }, [envelopeId]);

    // Open the executed PDF / certificate via a FRESHLY-minted signed URL. The
    // URL stored in `detail` is a short-lived presigned link captured at the last
    // poll; polling stops at completion, so a click minutes later would hit an
    // expired URL (R2 "AccessDenied / Request has expired"). Re-fetch on click so
    // the link is always fresh. The blank tab is opened synchronously (inside the
    // click gesture) to avoid popup blocking, then pointed at the fresh URL.
    const openArtifact = useCallback(
        async (kind: "executed" | "certificate") => {
            const tab = window.open("about:blank", "_blank");
            if (tab) tab.opener = null;
            setOpening(kind);
            try {
                const fresh = await getSignatureEnvelope(envelopeId);
                const url =
                    kind === "executed"
                        ? fresh.executed_pdf_url
                        : fresh.certificate_url;
                if (url) {
                    if (tab) tab.location.href = url;
                    else window.open(url, "_blank", "noopener,noreferrer");
                } else if (tab) {
                    tab.close();
                }
            } catch {
                if (tab) tab.close();
            } finally {
                setOpening(null);
            }
        },
        [envelopeId],
    );

    const handleResend = useCallback(async () => {
        setResending(true);
        setResendError(null);
        try {
            const next = await resendSignatureLinks(envelopeId);
            setDetail(next);
            setResentLinks(next.resent_links ?? []);
            setResentAt(Date.now());
        } catch (err) {
            setResendError(
                err instanceof Error
                    ? err.message
                    : "Could not resend the signing link.",
            );
        } finally {
            setResending(false);
        }
    }, [envelopeId]);

    const handleApprove = useCallback(async () => {
        setApprovalState("sending");
        setApprovalError(null);
        try {
            const approved = await approveSignature(envelopeId);
            // Dropping `version_state` is intentional: the envelope has left
            // pending_approval, so there is nothing left to choose between.
            setDetail((previous) => ({
                envelope: approved.envelope,
                signers: approved.signers,
                executed_pdf_url: previous?.executed_pdf_url ?? null,
                certificate_url: previous?.certificate_url ?? null,
            }));
            setStaleRefusal(null);
            setApprovalState("idle");
        } catch (error) {
            setApprovalState("idle");
            // Refetch FIRST: it repaints from the server's own version_state,
            // which is what drives the choice below, and it clears any stale
            // refusal — so recording this one has to come after it.
            await refetch();
            if (
                error instanceof ApiError &&
                error.code === SIGNATURE_STALE_VERSION
            ) {
                // A refusal awaiting a decision, not a failure. Keep it out of
                // the red error line; it belongs in the version choice.
                setStaleRefusal(error.message);
                return;
            }
            setApprovalError(
                error instanceof Error
                    ? error.message
                    : "Could not send this document for signature.",
            );
        }
    }, [envelopeId, refetch]);

    /**
     * Answer the mismatch. Exactly one flag goes out (the backend 400s both
     * together), and only from the choice below — which only appears once a
     * mismatch is actually detected, since these flags are also a 400 on a
     * legacy envelope that carries no pin.
     */
    const handleApproveVersion = useCallback(
        async (choice: "prepared" | "current") => {
            setSendingChoice(choice);
            setApprovalError(null);
            try {
                const approved = await approveSignature(
                    envelopeId,
                    choice === "prepared"
                        ? { confirmPreparedVersion: true }
                        : { useCurrentVersion: true },
                );
                setDetail((previous) => ({
                    envelope: approved.envelope,
                    signers: approved.signers,
                    executed_pdf_url: previous?.executed_pdf_url ?? null,
                    certificate_url: previous?.certificate_url ?? null,
                }));
                setStaleRefusal(null);
            } catch (error) {
                setApprovalError(
                    error instanceof Error
                        ? error.message
                        : "Could not send this document for signature.",
                );
                // Leaves the choice standing (the envelope is still pending),
                // with the failure shown inside it.
                await refetch();
            } finally {
                setSendingChoice(null);
            }
        },
        [envelopeId, refetch],
    );

    const handleCopy = useCallback(async (link: string) => {
        try {
            await navigator.clipboard.writeText(link);
            setCopiedLink(link);
            window.setTimeout(() => setCopiedLink(null), 1500);
        } catch {
            // Clipboard can be blocked (permissions / insecure context); the link
            // text is shown alongside so it can still be selected manually.
            setCopiedLink(null);
        }
    }, []);

    const handleCancel = useCallback(async () => {
        setCancelling(true);
        setCancelError(null);
        try {
            const next = await cancelSignature(envelopeId);
            setDetail((prev) =>
                prev ? { ...prev, envelope: next.envelope } : prev,
            );
            setCancelArmed(false);
            // Re-fetch to settle signer rows + asset URLs, and notify the parent.
            await refetch();
            onCancelled?.();
        } catch (err) {
            setCancelError(
                err instanceof Error
                    ? err.message
                    : "Could not cancel this signature request.",
            );
        } finally {
            setCancelling(false);
        }
    }, [envelopeId, refetch, onCancelled]);

    // Poll on mount and every POLL_INTERVAL_MS while the envelope is
    // non-terminal. The interval is cleared on terminal status or unmount.
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
        const run = async () => {
            const next = await refetch();
            if (next && isTerminal(next.envelope.status)) stop();
        };
        void run();
        timer = setInterval(() => void run(), POLL_INTERVAL_MS);
        return () => stop();
    }, [refetch]);

    // Polling can reveal a cancel, rollback, or completion while the form is
    // open. Never preserve a stale form that would submit against an inactive
    // envelope, and do not reopen it if the request is later retried.
    useEffect(() => {
        if (status && !isLive) {
            setSignOpen(false);
            setSignError(null);
            setConsent(false);
        }
    }, [status, isLive]);

    // Find the signed-in user's own pending signer slot (case-insensitive email
    // match). Only a pending signer can sign in-app.
    const myEmail = user?.email?.trim().toLowerCase() ?? "";
    const isMine = (s: SignerRef): boolean =>
        !!myEmail && (s.email ?? "").trim().toLowerCase() === myEmail;
    const myPendingSigner = myEmail
        ? (signers.find(
              (s) =>
                  isMine(s) &&
                  (s.status ?? "pending") !== "signed" &&
                  (s.status ?? "pending") !== "declined",
          ) ?? null)
        : null;

    const canSubmit =
        isLive &&
        consent &&
        !submitting &&
        (mode === "type" ? typedName.trim().length > 0 : hasDrawing);

    const openSignPanel = () => {
        // Seed the typed name from the signer record for convenience.
        if (myPendingSigner?.name && !typedName) {
            setTypedName(myPendingSigner.name);
        }
        setSignError(null);
        setSignOpen(true);
    };

    const handleSign = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            if (!canSubmit) return;
            setSignError(null);
            setSubmitting(true);
            try {
                const drawn = mode === "draw";
                const signaturePng = drawn
                    ? (exportRef.current?.() ?? null)
                    : null;
                if (drawn && !signaturePng) {
                    setSignError(
                        "Please draw your signature before submitting.",
                    );
                    setSubmitting(false);
                    return;
                }
                await signSelf(envelopeId, {
                    typed_name: typedName.trim(),
                    signature_png: signaturePng,
                    consent: true,
                    drawn,
                });
                // Success — collapse the panel and immediately re-fetch, since
                // the envelope may now be completed.
                setSignOpen(false);
                setConsent(false);
                await refetch();
            } catch (err) {
                setSignError(
                    err instanceof Error
                        ? err.message
                        : "We could not record your signature. Please try again.",
                );
                await refetch();
            } finally {
                setSubmitting(false);
            }
        },
        [canSubmit, mode, typedName, envelopeId, refetch],
    );

    const completed = status === "completed";
    const subject =
        detail?.envelope.subject ||
        detail?.envelope.document_name ||
        "Signature request";

    return (
        <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-3 font-sans">
            <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700 ring-1 ring-purple-200">
                    <FileSignature className="h-3.5 w-3.5" />
                </div>
                <span className="min-w-0 truncate text-sm font-semibold text-gray-800">
                    {subject}
                </span>
                {status ? (
                    <EnvelopeStatusBadge status={status} />
                ) : (
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-gray-400">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Loading
                    </span>
                )}
            </div>

            {!detail && !loadError ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Checking signature status…
                </div>
            ) : null}

            {signers.length > 0 && (
                <ul className="mt-3 space-y-1.5 rounded-md border border-purple-100 bg-white p-2">
                    {signers.map((s, i) => {
                        const stamp =
                            (s.status ?? "pending") === "signed"
                                ? formatStamp(s.signed_at)
                                : (s.status ?? "pending") === "viewed"
                                  ? formatStamp(s.viewed_at)
                                  : null;
                        const isMe = isMine(s);
                        // An external signer still awaiting action can have their
                        // link re-minted + re-emailed (recovers a lost link).
                        const canResend =
                            isLive &&
                            !isMe &&
                            (s.role ?? "signer") === "signer" &&
                            ((s.status ?? "pending") === "pending" ||
                                (s.status ?? "pending") === "viewed") &&
                            !isTerminal(status);
                        return (
                            <li
                                key={s.id ?? `${s.email}-${i}`}
                                className="flex flex-wrap items-center gap-1.5 text-xs"
                            >
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-purple-100 text-[10px] font-bold text-purple-700">
                                    {i + 1}
                                </span>
                                <span className="font-semibold text-gray-900">
                                    {s.name || s.email || "Signer"}
                                </span>
                                {isMe && (
                                    <span className="rounded bg-purple-50 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-purple-700">
                                        You
                                    </span>
                                )}
                                {s.email && (
                                    <span className="text-gray-500">
                                        &lt;{s.email}&gt;
                                    </span>
                                )}
                                <span className="ml-auto flex items-center gap-1.5">
                                    {stamp && (
                                        <span className="text-[10px] text-gray-400">
                                            {stamp}
                                        </span>
                                    )}
                                    {canResend && (
                                        <button
                                            type="button"
                                            onClick={() => void handleResend()}
                                            disabled={resending}
                                            title="Re-send this signing link"
                                            className="inline-flex items-center gap-1 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                                        >
                                            {resending ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <PenLine className="h-3 w-3" />
                                            )}
                                            Resend
                                        </button>
                                    )}
                                    <SignerChip status={s.status} />
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}

            {loadError && (
                <p className="mt-2 text-xs leading-5 text-red-700">
                    {loadError}
                </p>
            )}

            {resendError && (
                <p className="mt-2 text-xs leading-5 text-red-700">
                    {resendError}
                </p>
            )}

            {/* The version choice renders its own failures, so don't double up. */}
            {approvalError && !versionMismatch && (
                <p className="mt-2 text-xs leading-5 text-red-700">
                    {approvalError}
                </p>
            )}
            {resentAt !== null && !resendError && (
                <div className="mt-2 space-y-1.5">
                    <p className="inline-flex items-center gap-1 text-xs leading-5 text-green-700">
                        <Check className="h-3.5 w-3.5" />
                        Signing link re-sent by email.
                    </p>
                    {resentLinks.length > 0 && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
                            <p className="text-[11px] leading-4 text-amber-800">
                                If it doesn&apos;t arrive, the email may be
                                filtered to spam. Copy the link and send it to
                                the signer directly:
                            </p>
                            <ul className="mt-1.5 space-y-1">
                                {resentLinks.map((l) => (
                                    <li
                                        key={l.email}
                                        className="flex items-center gap-1.5"
                                    >
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void handleCopy(l.link)
                                            }
                                            className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
                                        >
                                            {copiedLink === l.link ? (
                                                <Check className="h-3 w-3" />
                                            ) : (
                                                <Copy className="h-3 w-3" />
                                            )}
                                            {copiedLink === l.link
                                                ? "Copied"
                                                : "Copy link"}
                                        </button>
                                        <span className="truncate text-[10px] text-gray-500">
                                            {l.email}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* Completed: offer the signed PDF + certificate. */}
            {completed && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                        <CheckCheck className="h-3.5 w-3.5" />
                        All parties signed
                    </span>
                    {detail?.executed_pdf_url && (
                        <button
                            type="button"
                            onClick={() => void openArtifact("executed")}
                            disabled={opening !== null}
                            className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
                        >
                            {opening === "executed" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <FileCheck2 className="h-3.5 w-3.5" />
                            )}
                            View signed PDF
                        </button>
                    )}
                    {detail?.certificate_url && (
                        <button
                            type="button"
                            onClick={() => void openArtifact("certificate")}
                            disabled={opening !== null}
                            className="inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60"
                        >
                            {opening === "certificate" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Award className="h-3.5 w-3.5 text-amber-600" />
                            )}
                            Certificate
                        </button>
                    )}
                </div>
            )}

            {/* The poll surfaces a version mismatch here without anyone
                clicking: `version_state` arrives on every 6s tick for a pending,
                pinned envelope. When it says the document has moved, the plain
                approve is REPLACED by the choice — leaving it up would only earn
                another refusal. "Cancel request" below is the third way out. */}
            {versionMismatch && versionNotice && (
                <SignatureVersionChoice
                    notice={versionNotice}
                    sending={sendingChoice}
                    disabled={cancelling || approvalState === "sending"}
                    // Straight off the poll. `undefined` (no version_state, or
                    // a backend that predates the field) stays undefined on
                    // purpose — it means "unknown", and the choice keeps both
                    // sends on offer exactly as it does today.
                    preparedVersionResolved={
                        versionState?.prepared_version_resolved
                    }
                    error={approvalError}
                    onSendPrepared={() => void handleApproveVersion("prepared")}
                    onSendCurrent={() => void handleApproveVersion("current")}
                />
            )}

            {/* A rolled-back request is recoverable here; it is not signable
                until approval finishes and the envelope becomes live. */}
            {status === "pending_approval" && !versionMismatch && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {approvalState === "arming" ? (
                        <>
                            <span className="text-xs font-medium text-amber-900">
                                Email signing links now?
                            </span>
                            <button
                                type="button"
                                onClick={() => void handleApprove()}
                                className="inline-flex items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-amber-200 hover:bg-amber-700"
                            >
                                <ShieldCheck className="h-3.5 w-3.5" />
                                Confirm send
                            </button>
                            <button
                                type="button"
                                onClick={() => setApprovalState("idle")}
                                className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                            >
                                Back
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setApprovalState("arming")}
                            disabled={approvalState === "sending"}
                            className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                        >
                            {approvalState === "sending" ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <PenLine className="h-3.5 w-3.5" />
                            )}
                            {approvalState === "sending"
                                ? "Sending…"
                                : "Approve & Send for signature"}
                        </button>
                    )}
                </div>
            )}

            {/* In-app signing for the signed-in user when it's their turn. */}
            {isLive && myPendingSigner && !signOpen && (
                <div className="mt-3">
                    <button
                        type="button"
                        onClick={openSignPanel}
                        className="inline-flex items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-amber-200 hover:bg-amber-700"
                    >
                        <PenLine className="h-3.5 w-3.5" />
                        It&apos;s your turn — Sign
                    </button>
                </div>
            )}

            {isLive && myPendingSigner && signOpen && (
                <form
                    onSubmit={handleSign}
                    noValidate
                    className="mt-3 rounded-lg border border-purple-100 bg-white p-3"
                >
                    <div className="mb-2.5 flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-800">
                            Add your signature
                        </span>
                        <button
                            type="button"
                            onClick={() => setSignOpen(false)}
                            disabled={submitting}
                            className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                            aria-label="Close signing panel"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    <SignaturePad
                        mode={mode}
                        onModeChange={setMode}
                        typedName={typedName}
                        onTypedNameChange={setTypedName}
                        onDrawingChange={setHasDrawing}
                        exportRef={exportRef}
                        disabled={submitting}
                    />

                    <label className="mb-1.5 mt-3 flex cursor-pointer items-start gap-2.5">
                        <input
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                            disabled={submitting}
                            className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                        />
                        <span className="text-[13px] leading-relaxed text-gray-700">
                            {signatureConsentCopy(signaturesNonbinding).checkbox}
                        </span>
                    </label>

                    {signError && (
                        <div
                            role="alert"
                            className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] leading-snug text-red-700"
                        >
                            {signError}
                        </div>
                    )}

                    <div className="mt-3 flex items-center gap-2">
                        <button
                            type="submit"
                            disabled={!canSubmit}
                            aria-disabled={!canSubmit}
                            className="inline-flex items-center gap-1.5 rounded bg-gradient-to-br from-amber-600 to-amber-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:from-stone-300 disabled:to-stone-300 disabled:text-stone-100"
                        >
                            {submitting ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Signing…
                                </>
                            ) : (
                                <>
                                    <PenLine className="h-3.5 w-3.5" />
                                    Sign document
                                </>
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => setSignOpen(false)}
                            disabled={submitting}
                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {/* Cancel a still-in-flight request (sent / partially signed /
                pending approval). Hidden once terminal. Two-step: arm → confirm. */}
            {status && !isTerminal(status) && (
                <div className="mt-3 border-t border-purple-100 pt-3">
                    {cancelError && (
                        <p className="mb-2 text-xs leading-5 text-red-700">
                            {cancelError}
                        </p>
                    )}
                    {cancelArmed ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-gray-600">
                                Cancel this request? Signers can no longer sign.
                            </span>
                            <button
                                type="button"
                                onClick={() => void handleCancel()}
                                disabled={cancelling}
                                className="inline-flex items-center gap-1.5 rounded border border-red-600 bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                            >
                                {cancelling ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Ban className="h-3.5 w-3.5" />
                                )}
                                Confirm cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => setCancelArmed(false)}
                                disabled={cancelling}
                                className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                            >
                                Keep request
                            </button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => {
                                setCancelError(null);
                                setCancelArmed(true);
                            }}
                            className="inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                        >
                            <Ban className="h-3.5 w-3.5" />
                            Cancel request
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
