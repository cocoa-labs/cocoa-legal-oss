"use client";

import { GitCompareArrows, Loader2, PenLine } from "lucide-react";
import type { EnvelopeVersionState } from "@/app/lib/cocoLegalApi";

/**
 * Name one version the way the backend names it in its own refusal message
 * (`describeVersion` in routes/signatures.ts). A missing number must never
 * surface as "version null".
 */
function describeVersion(
    versionNumber: number | null | undefined,
    missingLabel: string,
): string {
    return typeof versionNumber === "number"
        ? `version ${versionNumber}`
        : missingLabel;
}

/**
 * The client-composed twin of the backend's 409 sentence, for the places that
 * detect the mismatch from `version_state` before any approve is attempted.
 * Deliberately word-for-word with the server's, minus its "…from the signature
 * card" pointer (here we ARE the card) — an approver must never be shown two
 * subtly different accounts of the same fact.
 */
export function describeVersionMismatch(state: EnvelopeVersionState): string {
    // A pin whose row is gone is not a choice between two versions — the
    // backend cannot send it (409 SIGNATURE_PREPARED_VERSION_UNAVAILABLE) and
    // the button is withdrawn below, so the sentence must not go on offering
    // it. Byte-identical to that refusal's own `detail`, so an approver who
    // sees this card and then provokes the server reads one account, not two.
    // It names no version number because with the prepared side gone there is
    // nothing left to compare against.
    if (state.prepared_version_resolved === false) {
        return "The version this signature request was prepared against is no longer available, so it cannot be sent. Send the current version instead, or cancel and prepare a new request.";
    }
    const prepared = describeVersion(
        state.prepared_version_number,
        // Past the branch above, the row is either known to resolve or its
        // state is UNKNOWN — `undefined` from a backend that predates the flag,
        // during a deploy window (Vercel and Railway ship separately). Unknown
        // keeps the weaker, always-true wording and keeps both sends on offer,
        // rather than announcing a deletion nobody reported.
        "an earlier version",
    );
    const current = describeVersion(
        state.current_version_number,
        "a newer version",
    );
    return `This signature request was prepared against ${prepared}, but the document is now ${current}. Send the prepared version or the current version, or cancel and prepare a new request.`;
}

/**
 * The two-way send choice an approver gets when the document has moved off the
 * version their signature request was pinned to. Shared by the in-chat approval
 * card and the signature-hub status card so the wording and the affordances
 * cannot drift apart between them.
 *
 * Deliberate choices:
 *  - This is NOT framed as an error. A mismatch is frequently correct (a
 *    request prepared against the version the user was reading in Doc Review is
 *    born mismatched), so the surface is a neutral amber notice — the same
 *    amber the cards already use for "needs your attention" — not red.
 *  - Both buttons carry identical visual weight. Neither version is the safe
 *    default; suggesting one would be the whole bug.
 *  - When the prepared version's row is GONE, its button is not rendered at
 *    all. `notice` already says that version no longer exists, and the backend
 *    refuses to send it (409 SIGNATURE_PREPARED_VERSION_UNAVAILABLE) — an
 *    affordance that contradicts the sentence right above it and cannot work is
 *    worse than one fewer choice.
 *  - The label of every button actually offered is quoted verbatim inside
 *    `notice`, which is the only place a version NUMBER appears. Numbers stay
 *    out of the buttons on purpose: the document's "current" version is a
 *    moving target the backend re-resolves at click time, and a number printed
 *    on a button reads as a promise about exactly which bytes go out.
 *  - Cancel is the third way out and is NOT rendered here: each card already
 *    owns a cancel control with its own confirm gate, and a second one would
 *    split that.
 */
export function SignatureVersionChoice({
    notice,
    sending,
    disabled,
    preparedVersionResolved,
    error,
    onSendPrepared,
    onSendCurrent,
}: {
    /** The mismatch sentence — the server's 409 `detail`, or the twin above. */
    notice: string;
    /** Which choice is in flight, so the other cannot also be fired. */
    sending: "prepared" | "current" | null;
    /**
     * Whether the pinned version's row still resolves. Only an explicit `false`
     * withdraws "Send the prepared version": `undefined` means "unknown" (a
     * backend that predates the flag, or a surface that never learned it) and
     * must keep behaving exactly as it did — withdrawing a working choice on a
     * deploy-window guess is worse than offering one the server then refuses.
     */
    preparedVersionResolved?: boolean;
    /**
     * Something else on the card is mid-flight (a cancel, most obviously).
     * Neither version can be sent until it settles, and the buttons must LOOK
     * that way — an approver clicking "send" and getting silence is worse than
     * a disabled button.
     */
    disabled?: boolean;
    /** A failure from the chosen send (not the mismatch itself). */
    error?: string | null;
    onSendPrepared: () => void;
    onSendCurrent: () => void;
}) {
    const busy = sending !== null || disabled === true;
    const preparedIsGone = preparedVersionResolved === false;
    const buttonClass =
        "inline-flex items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-amber-200 hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60";

    return (
        <div
            role="status"
            className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2.5"
        >
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                <GitCompareArrows className="h-3.5 w-3.5 shrink-0" />
                Choose the version to send
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-900">{notice}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {/* Withheld, not disabled: a greyed-out button still reads as
                    "this could work, later". This one never can. */}
                {!preparedIsGone && (
                    <button
                        type="button"
                        onClick={onSendPrepared}
                        disabled={busy}
                        title="Send the document exactly as it stood when this signature request was prepared"
                        className={buttonClass}
                    >
                        {sending === "prepared" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <PenLine className="h-3.5 w-3.5" />
                        )}
                        Send the prepared version
                    </button>
                )}
                <button
                    type="button"
                    onClick={onSendCurrent}
                    disabled={busy}
                    title="Update this signature request to the document's current version, then send that"
                    className={buttonClass}
                >
                    {sending === "current" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <PenLine className="h-3.5 w-3.5" />
                    )}
                    Send the current version
                </button>
            </div>
            {error && (
                <p className="mt-2 text-xs leading-5 text-red-700">{error}</p>
            )}
        </div>
    );
}
