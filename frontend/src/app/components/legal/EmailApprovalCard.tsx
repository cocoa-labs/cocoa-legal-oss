"use client";

import { useCallback, useEffect, useState } from "react";
import {
    AlertTriangle,
    Download,
    ImageIcon,
    Mail,
    Paperclip,
    Check,
    CheckCircle2,
    Loader2,
    ShieldCheck,
    X,
} from "lucide-react";
import {
    ApiError,
    approveEmail,
    cancelEmail,
    getEmailBetaPolicy,
    getEmailAttachmentManifest,
    fetchEmailAttachmentContent,
    updateEmailBetaPolicy,
    type EmailAttachmentManifestItem,
    type EmailBetaPolicyReadiness,
} from "@/app/lib/cocoaLegalApi";
import type { AssistantEvent } from "../shared/types";
import { ControlledBetaPolicySummary } from "./ControlledBetaPolicySummary";

type EmailPending = Extract<AssistantEvent, { type: "email_pending" }>;

type CardState =
    | "idle"
    | "arming"
    | "sending"
    | "sent"
    | "cancelling"
    | "cancelled"
    | "failed";

function formatAttachmentSize(size: number | null): string | null {
    if (!size || size < 1) return null;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function EmailImagePreview({
    emailId,
    attachment,
}: {
    emailId: string;
    attachment: EmailAttachmentManifestItem;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        let objectUrl: string | null = null;
        void fetchEmailAttachmentContent(emailId, attachment.index)
            .then((blob) => {
                if (!active) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            })
            .catch((reason) => {
                if (!active) return;
                setLoadError(
                    reason instanceof Error
                        ? reason.message
                        : "Preview unavailable.",
                );
            });
        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [attachment.index, emailId]);

    const size = formatAttachmentSize(attachment.size);
    const format = attachment.content_type.replace(/^image\//, "").toUpperCase();

    return (
        <figure className="overflow-hidden rounded-lg border border-blue-200 bg-white">
            <div className="flex min-h-36 items-center justify-center bg-gray-50">
                {!url && !loadError && (
                    <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                )}
                {loadError && (
                    <p className="px-4 py-6 text-center text-xs text-red-600">
                        {loadError}
                    </p>
                )}
                {url && (
                    <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full"
                        title={`Open ${attachment.filename}`}
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated blob URL */}
                        <img
                            src={url}
                            alt={attachment.filename}
                            loading="lazy"
                            decoding="async"
                            className="max-h-72 w-full object-contain"
                        />
                    </a>
                )}
            </div>
            <figcaption className="flex flex-wrap items-center gap-2 border-t border-blue-100 px-3 py-2 text-[11px] text-gray-600">
                <ImageIcon className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                <span className="min-w-0 flex-1 truncate font-medium text-gray-800">
                    {attachment.filename}
                </span>
                <span>{[format, size].filter(Boolean).join(" · ")}</span>
                {url && (
                    <a
                        href={url}
                        download={attachment.filename}
                        className="inline-flex items-center gap-1 font-medium text-blue-700 hover:text-blue-900"
                    >
                        <Download className="h-3 w-3" />
                        Download
                    </a>
                )}
            </figcaption>
        </figure>
    );
}

/**
 * Inline approval card for an agent-drafted outbound email. Rendered in the
 * assistant message stream from an `email_pending` event. Every send is an
 * explicit human-in-the-loop gate: "Approve & Send" first arms a distinct
 * confirm button before the email actually goes out.
 */
export function EmailApprovalCard({ event }: { event: EmailPending }) {
    // On reload the event is hydrated with the email's current status, so start
    // in the matching terminal state instead of a stale "ready to send".
    const initialState: CardState =
        event.status === "sent"
            ? "sent"
            : event.status === "cancelled"
              ? "cancelled"
              : event.status === "failed"
                ? "failed"
                : "idle";
    const [state, setState] = useState<CardState>(initialState);
    const [error, setError] = useState<string | null>(null);
    const [betaPolicy, setBetaPolicy] =
        useState<EmailBetaPolicyReadiness | null>(null);
    const [betaPolicyLoading, setBetaPolicyLoading] = useState(true);
    const [betaPolicySaving, setBetaPolicySaving] = useState(false);
    const [policyAcknowledged, setPolicyAcknowledged] = useState(false);
    const [setupCompleted, setSetupCompleted] = useState(false);
    const [attachmentManifest, setAttachmentManifest] = useState<
        EmailAttachmentManifestItem[] | null
    >(null);
    const [attachmentManifestError, setAttachmentManifestError] = useState<
        string | null
    >(null);

    const terminal =
        state === "sent" || state === "cancelled" || state === "failed";
    const busy =
        state === "sending" || state === "cancelling" || betaPolicySaving;
    const policyNeedsAcceptance = Boolean(
        betaPolicy?.enabled && !betaPolicy.accepted,
    );
    const needsBetaSetup = policyNeedsAcceptance;

    const loadBetaPolicy = useCallback(
        async (surfaceError = false) => {
            setBetaPolicyLoading(true);
            try {
                setBetaPolicy(await getEmailBetaPolicy(event.email_id));
            } catch (reason) {
                // Preflight is additive. If an older deployment does not expose
                // it yet, preserve the existing approval path and surface a
                // useful message only after the send gate actually refuses.
                setBetaPolicy(null);
                if (surfaceError) {
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : "Could not load the email safeguards.",
                    );
                }
            } finally {
                setBetaPolicyLoading(false);
            }
        },
        [event.email_id],
    );

    useEffect(() => {
        if (terminal) {
            setBetaPolicyLoading(false);
            return;
        }
        void loadBetaPolicy();
    }, [loadBetaPolicy, terminal]);

    useEffect(() => {
        if (event.attachments.length === 0) {
            setAttachmentManifest([]);
            return;
        }
        let active = true;
        void getEmailAttachmentManifest(event.email_id)
            .then(({ attachments }) => {
                if (!active) return;
                setAttachmentManifest(attachments);
                setAttachmentManifestError(null);
            })
            .catch((reason) => {
                if (!active) return;
                setAttachmentManifestError(
                    reason instanceof Error
                        ? reason.message
                        : "Attachment previews are unavailable.",
                );
            });
        return () => {
            active = false;
        };
    }, [event.attachments.length, event.email_id]);

    const confirmSend = async () => {
        if (busy || terminal) return;
        setState("sending");
        setError(null);
        try {
            const { email } = await approveEmail(event.email_id);
            // The approve route returns the row as-is when it isn't pending
            // (e.g. it was already cancelled or failed), so don't claim "Sent"
            // on every 200 — reflect what actually happened.
            if (email.status === "sent") {
                setState("sent");
            } else if (email.status === "cancelled") {
                setState("cancelled");
            } else {
                setError(
                    "This email wasn't sent — it may have already been cancelled. Please try again.",
                );
                setState("idle");
            }
        } catch (err) {
            if (
                err instanceof ApiError &&
                err.code === "BETA_DATA_POLICY_REQUIRED"
            ) {
                setState("idle");
                setError(null);
                setSetupCompleted(false);
                await loadBetaPolicy(true);
                return;
            }
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not send this email.",
            );
            setState("idle");
        }
    };

    const completeBetaSetup = async () => {
        if (!betaPolicy || !needsBetaSetup || busy) return;
        setBetaPolicySaving(true);
        setError(null);
        setSetupCompleted(false);
        try {
            const updated = await updateEmailBetaPolicy(event.email_id, {
                accept_data_policy: policyNeedsAcceptance || undefined,
                policy_acknowledged:
                    policyNeedsAcceptance && policyAcknowledged
                        ? true
                        : undefined,
            });
            setBetaPolicy(updated);
            setPolicyAcknowledged(false);
            setSetupCompleted(updated.accepted);
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Could not complete the email safeguards.",
            );
        } finally {
            setBetaPolicySaving(false);
        }
    };

    const cancel = async () => {
        if (busy || terminal) return;
        setState("cancelling");
        setError(null);
        try {
            await cancelEmail(event.email_id);
            setState("cancelled");
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not cancel this email.",
            );
            setState("idle");
        }
    };

    return (
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 font-sans">
            <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 ring-1 ring-blue-200">
                    <Mail className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-semibold text-gray-800">
                    Email ready to send
                </span>
                <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                    <ShieldCheck className="h-3 w-3" />
                    Approval required
                </span>
            </div>

            <dl className="mt-3 space-y-1 text-sm">
                <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-medium text-gray-500">
                        To
                    </dt>
                    <dd className="min-w-0 break-words text-gray-900">
                        {event.to.length > 0 ? event.to.join(", ") : "—"}
                    </dd>
                </div>
                {event.cc.length > 0 && (
                    <div className="flex gap-2">
                        <dt className="w-14 shrink-0 font-medium text-gray-500">
                            Cc
                        </dt>
                        <dd className="min-w-0 break-words text-gray-900">
                            {event.cc.join(", ")}
                        </dd>
                    </div>
                )}
                <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-medium text-gray-500">
                        Subject
                    </dt>
                    <dd className="min-w-0 break-words font-medium text-gray-900">
                        {event.subject || "—"}
                    </dd>
                </div>
            </dl>

            {event.body_preview && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-blue-100 bg-white px-3 py-2 text-xs leading-5 text-gray-700">
                    {event.body_preview}
                </pre>
            )}

            {event.attachments.length > 0 &&
                attachmentManifest === null &&
                !attachmentManifestError && (
                    <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-600">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
                        Loading attachment previews…
                    </div>
                )}

            {(attachmentManifest ?? event.attachments).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {(attachmentManifest ?? event.attachments)
                        .filter((attachment) => !attachment.previewable)
                        .map((a, index) => (
                            <span
                                key={`${a.source_id ?? a.document_id}:${index}`}
                                className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-700"
                                title={a.filename}
                            >
                                <Paperclip className="h-3 w-3 text-blue-600" />
                                {a.filename}
                            </span>
                        ))}
                </div>
            )}

            {attachmentManifest?.some((attachment) => attachment.previewable) && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {attachmentManifest
                        .filter((attachment) => attachment.previewable)
                        .map((attachment) => (
                            <EmailImagePreview
                                key={`${attachment.source_kind}:${attachment.source_id}:${attachment.index}`}
                                emailId={event.email_id}
                                attachment={attachment}
                            />
                        ))}
                </div>
            )}

            {attachmentManifestError && (
                <p className="mt-2 text-xs text-red-600">
                    {attachmentManifestError}
                </p>
            )}

            {needsBetaSetup && betaPolicy ? (
                <section
                    role="alert"
                    className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950"
                >
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">
                                Finish email safeguards before sending
                            </p>
                            <p className="mt-1 text-xs leading-5 text-amber-900/80">
                                This draft is safe and still pending. Complete
                                the organization-level requirements below, then
                                use the normal Approve &amp; Send confirmation.
                            </p>
                            <div className="mt-2 rounded-md border border-amber-200 bg-white/70 p-2.5">
                                <ControlledBetaPolicySummary
                                    compact
                                    showAccountLink
                                />
                            </div>

                            {betaPolicy.can_manage ? (
                                <div className="mt-3 space-y-2.5">
                                    {policyNeedsAcceptance ? (
                                        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-200 bg-white p-2.5 text-xs leading-5">
                                            <input
                                                type="checkbox"
                                                checked={policyAcknowledged}
                                                onChange={(event) =>
                                                    setPolicyAcknowledged(
                                                        event.target.checked,
                                                    )
                                                }
                                                className="mt-0.5 h-4 w-4 shrink-0 accent-amber-900"
                                            />
                                            <span>
                                                I am authorized to accept this
                                                policy for my organization, and
                                                I agree to the controlled-beta
                                                restrictions above.
                                            </span>
                                        </label>
                                    ) : null}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void completeBetaSetup()
                                            }
                                            disabled={
                                                betaPolicySaving ||
                                                (policyNeedsAcceptance &&
                                                    !policyAcknowledged)
                                            }
                                            className="inline-flex items-center gap-1.5 rounded border border-amber-900 bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            {betaPolicySaving ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <ShieldCheck className="h-3.5 w-3.5" />
                                            )}
                                            Complete email setup
                                        </button>
                                        <span className="text-[11px] text-amber-900/70">
                                            This does not send the email.
                                        </span>
                                    </div>
                                </div>
                            ) : (
                                <div className="mt-3 rounded-md border border-amber-300 bg-amber-100/70 p-2.5 text-xs leading-5">
                                    <p className="font-semibold">
                                        An organization owner or admin must
                                        complete this setup.
                                    </p>
                                    <p className="mt-1">
                                        Ask them to open this draft, or send
                                        them to Settings → Data &amp; outbound
                                        safeguards. The email will remain
                                        pending.
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            ) : setupCompleted ? (
                <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-green-700">
                    <CheckCircle2 className="h-4 w-4" />
                    Email safeguards saved. This draft is ready for approval.
                </p>
            ) : null}

            {error && (
                <p role="alert" className="mt-2 text-xs leading-5 text-red-700">
                    {error}
                </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {state === "sent" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                        <Check className="h-3.5 w-3.5" />
                        Sent
                    </span>
                ) : state === "cancelled" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                        <X className="h-3.5 w-3.5" />
                        Cancelled
                    </span>
                ) : state === "failed" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
                        <X className="h-3.5 w-3.5" />
                        Failed to send
                    </span>
                ) : betaPolicyLoading ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Checking email safeguards…
                    </span>
                ) : needsBetaSetup ? (
                    <button
                        type="button"
                        onClick={cancel}
                        disabled={busy}
                        className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {state === "cancelling"
                            ? "Cancelling…"
                            : "Cancel draft"}
                    </button>
                ) : state === "arming" ? (
                    <>
                        <span className="text-xs font-medium text-amber-900">
                            Send this email?
                        </span>
                        <button
                            type="button"
                            onClick={confirmSend}
                            className="inline-flex items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-amber-200 hover:bg-amber-700"
                        >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Confirm send
                        </button>
                        <button
                            type="button"
                            onClick={() => setState("idle")}
                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                        >
                            Back
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => setState("arming")}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                        >
                            {state === "sending" ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Sending…
                                </>
                            ) : (
                                <>
                                    <Mail className="h-3.5 w-3.5" />
                                    Approve &amp; Send
                                </>
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={cancel}
                            disabled={busy}
                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {state === "cancelling" ? "Cancelling…" : "Cancel"}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
