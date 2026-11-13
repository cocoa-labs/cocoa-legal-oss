"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Library, MoreHorizontal, X } from "lucide-react";
import type { LegalProposal } from "@/app/hooks/useAssistantChat";
import { recordProposalMetric } from "@/app/lib/assistantReliabilityTelemetry";

/**
 * The composer's capability suggestion — one line of the capability's own
 * confirm prompt plus the actions that answer it.
 *
 * Posture is precision over recall: the chip is a suggestion a practising
 * lawyer can refuse permanently (per capability, or for the whole chat), and
 * every refusal is one click away from the suggestion itself. The render gate
 * (confidence, run target) lives in the PARENT so the two surfaces that show
 * this chip stay free to gate differently; this component renders whatever it
 * is handed.
 */

/** The sides a run may be anchored to. Fixed vocabulary, no free text. */
const REPRESENTED_PARTY_OPTIONS = [
    "vendor",
    "customer",
    "licensor",
    "licensee",
    "partner",
    "other",
] as const;

/**
 * A durable refusal that never reached the server. The chip stays put and says
 * so rather than vanishing: hiding it would promise a preference that was not
 * stored, and the suggestion would then reappear next turn unexplained.
 */
const SUPPRESSION_FAILED_MESSAGE =
    "Couldn't save that preference — it may come back.";

/** Why the primary button did nothing, said in the page rather than a title. */
const PARTY_REQUIRED_MESSAGE = "Choose the side you represent first.";

/** Why the durable refusals are unavailable, for the pre-chat-id case. */
const SUPPRESSION_UNAVAILABLE_MESSAGE =
    "Available once this conversation has been saved.";

export interface ProposalChipProps {
    proposal: LegalProposal;
    /** Null until the conversation exists — suppression needs a chat to bind to. */
    chatId: string | null;
    onRun: (
        proposal: LegalProposal,
        inputs: { represented_party?: string },
    ) => void;
    /** Client-only "not now": hides the chip, remembers nothing. */
    onDismiss: () => void;
    /** Durable "never this capability here". Rejects if the write failed. */
    onDontSuggestHere: (proposal: LegalProposal) => Promise<void>;
    /** Durable "no suggestions in this chat at all". Rejects if the write failed. */
    onMute: () => Promise<void>;
    surface: "chat" | "matter";
}

export function ProposalChip({
    proposal,
    chatId,
    onRun,
    onDismiss,
    onDontSuggestHere,
    onMute,
    surface,
}: ProposalChipProps) {
    const [representedParty, setRepresentedParty] = useState("");
    const [menuOpen, setMenuOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [partyHintShown, setPartyHintShown] = useState(false);
    const [suppressionError, setSuppressionError] = useState<string | null>(
        null,
    );

    const selectRef = useRef<HTMLSelectElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuTriggerRef = useRef<HTMLButtonElement>(null);
    const menuItemRef = useRef<HTMLButtonElement>(null);
    const messageId = useId();

    const needsParty = proposal.intake?.includes("represented_party") ?? false;
    const runLabel = proposal.runLabel ?? "Run review";
    // Suppression is stored per chat; without one there is nothing to write to.
    const canSuppress = chatId !== null && !busy;

    // Two independent message slots under the chip: a failed suppression write
    // and the party hint answer different questions and can be true at once, so
    // neither hides the other. The container is a polite live region, so a new
    // sentence is announced without interrupting the answer streaming above it.
    const partyHint =
        partyHintShown && needsParty && !representedParty
            ? PARTY_REQUIRED_MESSAGE
            : null;
    const partyHintId = `${messageId}-party`;

    // "shown" fires once per proposal, not once per render. A proposal without
    // an id (a bare lexical detection) is keyed by capability so a re-render
    // still can't double-count it.
    const shownKey = proposal.proposalId ?? `cap:${proposal.capabilityId}`;
    const shownRef = useRef<string | null>(null);
    useEffect(() => {
        if (shownRef.current === shownKey) return;
        shownRef.current = shownKey;
        recordProposalMetric("shown", surface, proposal.capabilityId);
    }, [shownKey, surface, proposal.capabilityId]);

    // Popover behaviour: focus moves in on open, Escape and an outside press
    // close it, and Escape returns focus to the trigger it came from.
    useEffect(() => {
        if (!menuOpen) return;
        menuItemRef.current?.focus();

        function handleKeyDown(event: KeyboardEvent) {
            if (event.key !== "Escape") return;
            setMenuOpen(false);
            menuTriggerRef.current?.focus();
        }
        function handlePointerDown(event: Event) {
            const target = event.target as Node | null;
            if (!target) return;
            if (menuRef.current?.contains(target)) return;
            if (menuTriggerRef.current?.contains(target)) return;
            setMenuOpen(false);
        }

        document.addEventListener("keydown", handleKeyDown);
        document.addEventListener("pointerdown", handlePointerDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.removeEventListener("pointerdown", handlePointerDown);
        };
    }, [menuOpen]);

    function toggleMenu() {
        if (menuOpen) {
            setMenuOpen(false);
            menuTriggerRef.current?.focus();
            return;
        }
        setMenuOpen(true);
    }

    function run() {
        if (needsParty && !representedParty) {
            // The button stays enabled so keyboard and screen-reader users can
            // reach the explanation at all; the hint is in the live region.
            setPartyHintShown(true);
            selectRef.current?.focus();
            return;
        }
        recordProposalMetric("confirmed", surface, proposal.capabilityId);
        onRun(
            proposal,
            representedParty ? { represented_party: representedParty } : {},
        );
    }

    function dismiss() {
        // Client-only: the chip hides for this turn and nothing is remembered,
        // so it is counted apart from the two durable refusals.
        recordProposalMetric("not_now", surface, proposal.capabilityId);
        onDismiss();
    }

    async function dontSuggestHere() {
        setMenuOpen(false);
        setBusy(true);
        setSuppressionError(null);
        try {
            await onDontSuggestHere(proposal);
        } catch {
            setSuppressionError(SUPPRESSION_FAILED_MESSAGE);
            setBusy(false);
            return;
        }
        // Matches the backend's `capability_proposal.dismissed` audit event;
        // "suppressed" stays reserved for the whole-chat mute below.
        recordProposalMetric("dismissed", surface, proposal.capabilityId);
        setBusy(false);
        onDismiss();
    }

    async function mute() {
        setMenuOpen(false);
        setBusy(true);
        setSuppressionError(null);
        try {
            await onMute();
        } catch {
            setSuppressionError(SUPPRESSION_FAILED_MESSAGE);
            setBusy(false);
            return;
        }
        recordProposalMetric("suppressed", surface, proposal.capabilityId);
        setBusy(false);
        onDismiss();
    }

    return (
        <div
            role="status"
            aria-live="polite"
            // Default atomic=true would re-read the whole chip whenever a
            // message appears; only the new sentence should be announced.
            aria-atomic="false"
            className="mb-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-command-muted)] px-3 py-2 text-sm backdrop-blur-md"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-[var(--app-text)]">
                    <Library
                        className="h-3.5 w-3.5 shrink-0 text-[var(--app-warm)]"
                        aria-hidden
                    />
                    <span className="truncate" title={proposal.confirmPrompt}>
                        {proposal.confirmPrompt}
                    </span>
                </span>
                <div className="flex shrink-0 items-center gap-2">
                    {needsParty && (
                        <label className="flex items-center gap-1.5 text-xs text-[var(--app-text-muted)]">
                            <span>Your side</span>
                            <select
                                ref={selectRef}
                                value={representedParty}
                                onChange={(e) => {
                                    setRepresentedParty(e.target.value);
                                    if (e.target.value)
                                        setPartyHintShown(false);
                                }}
                                className="rounded-md border border-[var(--app-border)] bg-transparent px-1.5 py-1 text-xs text-[var(--app-text)]"
                            >
                                <option value="">Choose…</option>
                                {REPRESENTED_PARTY_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    <button
                        type="button"
                        onClick={run}
                        disabled={busy}
                        aria-describedby={partyHint ? partyHintId : undefined}
                        className="rounded-md bg-[var(--app-active-strong)] px-2.5 py-1 text-xs font-medium text-[var(--app-active-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {runLabel}
                    </button>
                    <button
                        type="button"
                        onClick={() => void dontSuggestHere()}
                        disabled={!canSuppress}
                        title={
                            chatId === null
                                ? SUPPRESSION_UNAVAILABLE_MESSAGE
                                : undefined
                        }
                        className="rounded-md px-1.5 py-1 text-xs text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Don&apos;t suggest this here
                    </button>
                    <div className="relative">
                        <button
                            ref={menuTriggerRef}
                            type="button"
                            onClick={toggleMenu}
                            disabled={!canSuppress}
                            aria-label={
                                chatId === null
                                    ? `More suggestion options — ${SUPPRESSION_UNAVAILABLE_MESSAGE}`
                                    : "More suggestion options"
                            }
                            title={
                                chatId === null
                                    ? SUPPRESSION_UNAVAILABLE_MESSAGE
                                    : undefined
                            }
                            aria-haspopup="true"
                            aria-expanded={menuOpen}
                            className="rounded-md p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <MoreHorizontal
                                className="h-3.5 w-3.5"
                                aria-hidden
                            />
                        </button>
                        {menuOpen && (
                            <div
                                ref={menuRef}
                                className="absolute bottom-full right-0 z-10 mb-1 block w-56 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-1 shadow-[var(--app-elevated-shadow)]"
                            >
                                <button
                                    ref={menuItemRef}
                                    type="button"
                                    onClick={() => void mute()}
                                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--app-text)] transition-colors hover:bg-[var(--app-hover)]"
                                >
                                    Mute suggestions in this chat
                                </button>
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={dismiss}
                        aria-label="Not now"
                        className="rounded-md p-1 text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)]"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </div>
            </div>
            {suppressionError && (
                <p
                    id={`${messageId}-suppression`}
                    className="mt-1.5 text-xs text-[var(--app-text-muted)]"
                >
                    {suppressionError}
                </p>
            )}
            {partyHint && (
                <p
                    id={partyHintId}
                    className="mt-1.5 text-xs text-[var(--app-text-muted)]"
                >
                    {partyHint}
                </p>
            )}
        </div>
    );
}
