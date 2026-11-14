"use client";

import { useState } from "react";
import {
    GitCompareArrows,
    PenLine,
    FileSignature,
    Loader2,
    ShieldCheck,
    X,
} from "lucide-react";
import {
    ApiError,
    approveSignature,
    cancelSignature,
    SIGNATURE_PREPARED_VERSION_UNAVAILABLE,
    SIGNATURE_STALE_VERSION,
    type SignerRef,
} from "@/app/lib/cocoaLegalApi";
import type { AssistantEvent } from "../shared/types";
import { SignatureStatusCard } from "./SignatureStatusCard";
import { SignatureVersionChoice } from "./SignatureVersionChoice";

type SignaturePending = Extract<AssistantEvent, { type: "signature_pending" }>;

type CardState =
    | "idle"
    | "arming"
    | "sending"
    /** The document moved off the pinned version; the approver must pick one. */
    | "version_choice"
    | "sent"
    | "cancelling"
    | "cancelled";

/**
 * Inline approval card for an agent-prepared e-signature envelope. Rendered in
 * the assistant message stream from a `signature_pending` event. Emailing the
 * signing links is an explicit human-in-the-loop gate: "Approve & Send for
 * signature" first arms a distinct confirm button before links go out.
 *
 * A second gate sits behind that one. The request is pinned to the document
 * version it was prepared against, and the backend refuses (409
 * SIGNATURE_STALE_VERSION) to send once the document has moved off it. That
 * refusal turns this card into a three-way choice — send the prepared version,
 * send the current one, or cancel — because both directions are legitimate and
 * neither can be the default. The exception is a prepared version whose row is
 * gone: the backend cannot send it, so that side is withdrawn as soon as it
 * says so and the choice narrows to two.
 */
export function SignatureApprovalCard({ event }: { event: SignaturePending }) {
    const [state, setState] = useState<CardState>("idle");
    /** A failure of a SEND. Handed to the version choice, which frames it that way. */
    const [error, setError] = useState<string | null>(null);
    /**
     * A failure of the CANCEL, kept apart from `error` on purpose. Sharing one
     * slot put a failed cancel inside the amber send-choice box, attributed to
     * a send the approver never made.
     */
    const [cancelError, setCancelError] = useState<string | null>(null);
    // The backend's own 409 sentence, which already names BOTH version numbers.
    // Rendered verbatim rather than restated: two subtly different accounts of
    // which version is which is worse than one.
    const [versionNotice, setVersionNotice] = useState<string | null>(null);
    // The prepared version's row is gone, so it cannot be sent at all. This
    // card has no `version_state` to read it from — the event carries none —
    // so it learns the fact the only way it can: the server says so. Until
    // then it stays `undefined`, i.e. "unknown", and the choice is unchanged.
    const [preparedVersionGone, setPreparedVersionGone] = useState(false);
    // Which version choice is in flight, so the other cannot also be fired.
    const [sendingChoice, setSendingChoice] = useState<
        "prepared" | "current" | null
    >(null);
    // Signers returned by the approve call, handed to the status card for an
    // immediate first paint before its own first poll resolves.
    const [sentSigners, setSentSigners] = useState<SignerRef[] | undefined>(
        undefined,
    );

    // On reload the event is hydrated with the envelope's current status. If it
    // has already been acted on (sent / signing / completed / cancelled / etc.),
    // show the live status card instead of a stale approve affordance — it polls
    // and renders the real lifecycle state.
    const alreadyActioned =
        !!event.status &&
        event.status !== "pending_approval" &&
        event.status !== "draft";

    const terminal = state === "sent" || state === "cancelled";
    const busy =
        state === "sending" || state === "cancelling" || sendingChoice !== null;

    // Once a mismatch has been reported the card stays in the choice until it
    // resolves one way or another — including while a cancel is in flight, so
    // the plain "Approve & Send" (which would only be refused again) never
    // flashes back into view.
    const inVersionChoice = versionNotice !== null && !terminal;

    // Pre-click heads-up, only on a reloaded chat: `document_changed` is
    // hydration-only, so `undefined` means "not known here", not "unchanged".
    const showVersionNotice =
        event.document_changed === true && !inVersionChoice && !terminal;

    const confirmSend = async () => {
        if (busy || terminal) return;
        setState("sending");
        setError(null);
        setCancelError(null);
        try {
            const res = await approveSignature(event.envelope_id);
            setSentSigners(res.signers);
            setState("sent");
        } catch (err) {
            // A version mismatch is a question, not a failure. The document
            // moved off the version this request was pinned to, and only the
            // approver can say which one goes to the signers — so open the
            // choice rather than dead-ending on a red string.
            if (
                err instanceof ApiError &&
                err.code === SIGNATURE_STALE_VERSION
            ) {
                setVersionNotice(err.message);
                setState("version_choice");
                return;
            }
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not send this document for signature.",
            );
            setState("idle");
        }
    };

    /**
     * Answer the mismatch. Exactly one flag goes out — the backend 400s both
     * together — and only from here, i.e. only after a mismatch was actually
     * reported (it also 400s either flag on a legacy envelope with no pin).
     *
     * One click, no second gate: the notice above these buttons IS the
     * confirmation context, and it names the version each one sends.
     */
    const sendVersion = async (choice: "prepared" | "current") => {
        if (busy || terminal) return;
        setSendingChoice(choice);
        setError(null);
        setCancelError(null);
        try {
            const res = await approveSignature(
                event.envelope_id,
                choice === "prepared"
                    ? { confirmPreparedVersion: true }
                    : { useCurrentVersion: true },
            );
            setSentSigners(res.signers);
            setState("sent");
        } catch (err) {
            // The prepared version cannot be sent — its row is gone. That is a
            // refusal, not a send failure: nothing was claimed, nothing was
            // dispatched, and the operation is untouched. So don't paint it
            // red. Replace the notice with the server's own account (which
            // names only the choices that remain) and withdraw the button that
            // can never work, leaving "Send the current version" and cancel.
            if (
                err instanceof ApiError &&
                err.code === SIGNATURE_PREPARED_VERSION_UNAVAILABLE
            ) {
                setVersionNotice(err.message);
                setPreparedVersionGone(true);
                return; // `finally` still clears the in-flight choice.
            }
            // Stay in the choice: the decision is still open, and re-reading
            // the same notice is what the approver needs to try the other side.
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not send this document for signature.",
            );
        } finally {
            setSendingChoice(null);
        }
    };

    const cancel = async () => {
        if (busy || terminal) return;
        setState("cancelling");
        // Clearing a prior SEND failure is still right — the approver has moved
        // on from it — but this failure reports into its own slot.
        setError(null);
        setCancelError(null);
        try {
            await cancelSignature(event.envelope_id);
            setState("cancelled");
        } catch (err) {
            setCancelError(
                err instanceof Error
                    ? err.message
                    : "Could not cancel this envelope.",
            );
            setState("idle");
        }
    };

    // Once approved & sent, hand off to the live status card so the user keeps
    // watching each signer progress to completion (and can sign in-app when it
    // is their turn) without leaving the chat.
    if (state === "sent" || alreadyActioned) {
        return (
            <SignatureStatusCard
                envelopeId={event.envelope_id}
                initialSigners={sentSigners}
            />
        );
    }

    return (
        <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-3 font-sans">
            <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700 ring-1 ring-purple-200">
                    <FileSignature className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-semibold text-gray-800">
                    Ready to send for signature
                </span>
                <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                    <ShieldCheck className="h-3 w-3" />
                    Approval required
                </span>
            </div>

            <dl className="mt-3 space-y-1 text-sm">
                <div className="flex gap-2">
                    <dt className="w-20 shrink-0 font-medium text-gray-500">
                        Document
                    </dt>
                    <dd className="min-w-0 break-words font-medium text-gray-900">
                        {event.document_name || "—"}
                    </dd>
                </div>
                <div className="flex gap-2">
                    <dt className="w-20 shrink-0 font-medium text-gray-500">
                        Subject
                    </dt>
                    <dd className="min-w-0 break-words text-gray-900">
                        {event.subject || "—"}
                    </dd>
                </div>
            </dl>

            {event.signers.length > 0 && (
                <ul className="mt-3 space-y-1.5 rounded-md border border-purple-100 bg-white p-2">
                    {event.signers.map((s, i) => (
                        <li
                            key={`${s.email}-${i}`}
                            className="flex flex-wrap items-center gap-1.5 text-xs"
                        >
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-purple-100 text-[10px] font-bold text-purple-700">
                                {i + 1}
                            </span>
                            <span className="font-semibold text-gray-900">
                                {s.name || s.email}
                            </span>
                            {s.email && (
                                <span className="text-gray-500">
                                    &lt;{s.email}&gt;
                                </span>
                            )}
                            {s.role && (
                                <span className="ml-auto rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-purple-700">
                                    {s.role}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {/* Heads-up BEFORE the click, on a reloaded chat where the event
                carries the hydrated comparison. Stating the fact and what
                happens next — no alarm language, because a request prepared
                against the version the user was reading in Doc Review is born
                changed and is exactly right. The current version number is not
                hydrated onto the event, so it is not claimed here. */}
            {showVersionNotice && (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2">
                    <p className="flex items-start gap-1.5 text-xs leading-5 text-amber-900">
                        <GitCompareArrows className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            {typeof event.version_number === "number"
                                ? `This request was prepared against version ${event.version_number}. The document has changed since, so approving will ask which version to send.`
                                : "The document has changed since this request was prepared, so approving will ask which version to send."}
                        </span>
                    </p>
                </div>
            )}

            {inVersionChoice && versionNotice && (
                <SignatureVersionChoice
                    notice={versionNotice}
                    sending={sendingChoice}
                    disabled={busy}
                    // Only ever `false` once the server has said so; never a
                    // guess. Undefined until then, which is today's behaviour.
                    preparedVersionResolved={
                        preparedVersionGone ? false : undefined
                    }
                    error={error}
                    onSendPrepared={() => void sendVersion("prepared")}
                    onSendCurrent={() => void sendVersion("current")}
                />
            )}

            {/* The choice block renders its own failures, so don't double up. */}
            {error && !inVersionChoice && (
                <p className="mt-2 text-xs leading-5 text-red-700">{error}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {state === "cancelled" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                        <X className="h-3.5 w-3.5" />
                        Cancelled
                    </span>
                ) : inVersionChoice ? (
                    // The third way out. Labelled in full here so it cannot be
                    // read as "dismiss this choice" — it cancels the request.
                    <button
                        type="button"
                        onClick={cancel}
                        disabled={busy}
                        className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {state === "cancelling"
                            ? "Cancelling…"
                            : "Cancel request"}
                    </button>
                ) : state === "arming" ? (
                    <>
                        <span className="text-xs font-medium text-amber-900">
                            Email signing links now?
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
                                    <PenLine className="h-3.5 w-3.5" />
                                    Approve &amp; Send for signature
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

            {/* The cancel's own failure line: under the cancel control and
                outside the amber choice box, so it can never be read as a
                send the approver never made. */}
            {cancelError && (
                <p className="mt-2 text-xs leading-5 text-red-700">
                    {cancelError}
                </p>
            )}
        </div>
    );
}
