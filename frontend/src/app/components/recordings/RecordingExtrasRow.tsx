"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
    AlertCircle,
    Check,
    Download,
    Image as ImageIcon,
    Loader2,
    Mail,
    RefreshCw,
    Send,
    Volume2,
    X,
} from "lucide-react";
import {
    approveEmail,
    cancelEmail,
    draftRecordingEmail,
    generateRecordingTimelineImage,
    generateRecordingVoiceBriefing,
} from "@/app/lib/cocoLegalApi";
import { useDocumentObjectUrl } from "@/app/hooks/useDocumentObjectUrl";
import type { Recording } from "@/app/components/shared/types";

interface Props {
    recording: Recording;
    /** Extras are gated until the recording is fully processed. */
    disabled: boolean;
    onRecordingChange: (recording: Recording) => void;
}

const CARD_CLASS =
    "flex min-h-[9rem] flex-col rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3";

const GENERATE_BTN_CLASS =
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-command)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-50";

function CardHeader({
    icon: Icon,
    label,
}: {
    icon: typeof Volume2;
    label: string;
}) {
    return (
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
            <Icon className="h-3.5 w-3.5" />
            {label}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Voice briefing
// ---------------------------------------------------------------------------

function VoiceBriefingCard({ recording, disabled, onRecordingChange }: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const docId = recording.voice_briefing_document_id;
    const { url, loading, error: mediaError } = useDocumentObjectUrl(
        docId,
        "audio/mpeg",
    );

    const generate = useCallback(
        async (force: boolean) => {
            setBusy(true);
            setError(null);
            try {
                const result = await generateRecordingVoiceBriefing(
                    recording.id,
                    force,
                );
                onRecordingChange(result.recording);
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not generate the voice briefing.",
                );
            } finally {
                setBusy(false);
            }
        },
        [recording.id, onRecordingChange],
    );

    return (
        <div className={CARD_CLASS}>
            <CardHeader icon={Volume2} label="Voice briefing" />
            {docId ? (
                <div className="flex flex-1 flex-col gap-2">
                    {loading && (
                        <p className="flex items-center gap-1.5 text-xs text-[var(--app-text-muted)]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading audio…
                        </p>
                    )}
                    {mediaError && (
                        <p className="text-xs text-red-600">{mediaError}</p>
                    )}
                    {url && (
                        <audio
                            controls
                            src={url}
                            className="w-full"
                            aria-label="Voice briefing playback"
                        />
                    )}
                    <button
                        type="button"
                        onClick={() => void generate(true)}
                        disabled={busy}
                        className="mt-auto inline-flex items-center gap-1 self-start text-[11px] font-medium text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)] disabled:opacity-50"
                    >
                        {busy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                            <RefreshCw className="h-3 w-3" />
                        )}
                        Regenerate
                    </button>
                </div>
            ) : (
                <div className="flex flex-1 flex-col justify-between gap-2">
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        An audio recap you can listen to on the go.
                    </p>
                    <button
                        type="button"
                        onClick={() => void generate(false)}
                        disabled={disabled || busy}
                        title={
                            disabled
                                ? "Available once the recording is ready"
                                : undefined
                        }
                        className={GENERATE_BTN_CLASS}
                    >
                        {busy ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Generating…
                            </>
                        ) : (
                            <>
                                <Volume2 className="h-3.5 w-3.5" />
                                Generate voice briefing
                            </>
                        )}
                    </button>
                </div>
            )}
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Timeline image
// ---------------------------------------------------------------------------

function TimelineImageCard({ recording, disabled, onRecordingChange }: Props) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const docId = recording.timeline_image_document_id;
    const { url, loading, error: mediaError } = useDocumentObjectUrl(docId);
    const downloadName = `${
        (recording.title || "recording").replace(/[^\w .-]+/g, "").trim() ||
        "recording"
    } - timeline.png`;

    const generate = useCallback(
        async (force: boolean) => {
            setBusy(true);
            setError(null);
            try {
                const result = await generateRecordingTimelineImage(
                    recording.id,
                    force,
                );
                onRecordingChange(result.recording);
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not generate the timeline image.",
                );
            } finally {
                setBusy(false);
            }
        },
        [recording.id, onRecordingChange],
    );

    return (
        <div className={CARD_CLASS}>
            <CardHeader icon={ImageIcon} label="Timeline image" />
            {docId ? (
                <div className="flex flex-1 flex-col gap-2">
                    {loading && (
                        <p className="flex items-center gap-1.5 text-xs text-[var(--app-text-muted)]">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading image…
                        </p>
                    )}
                    {mediaError && (
                        <p className="text-xs text-red-600">{mediaError}</p>
                    )}
                    {url && (
                        // eslint-disable-next-line @next/next/no-img-element -- blob object URL, not an optimizable remote asset
                        <img
                            src={url}
                            alt={`Timeline for ${recording.title || "recording"}`}
                            className="w-full rounded-md border border-[var(--app-border)]"
                        />
                    )}
                    <div className="mt-auto flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => void generate(true)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)] disabled:opacity-50"
                        >
                            {busy ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                                <RefreshCw className="h-3 w-3" />
                            )}
                            Regenerate
                        </button>
                        {url && (
                            <a
                                href={url}
                                download={downloadName}
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)]"
                            >
                                <Download className="h-3 w-3" />
                                Download
                            </a>
                        )}
                    </div>
                </div>
            ) : (
                <div className="flex flex-1 flex-col justify-between gap-2">
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        A visual timeline of the key moments discussed.
                    </p>
                    <button
                        type="button"
                        onClick={() => void generate(false)}
                        disabled={disabled || busy}
                        title={
                            disabled
                                ? "Available once the recording is ready"
                                : undefined
                        }
                        className={GENERATE_BTN_CLASS}
                    >
                        {busy ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Generating…
                            </>
                        ) : (
                            <>
                                <ImageIcon className="h-3.5 w-3.5" />
                                Generate timeline image
                            </>
                        )}
                    </button>
                </div>
            )}
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Split a comma / newline / semicolon separated recipient string into a list. */
function parseRecipients(raw: string): string[] {
    return raw
        .split(/[,\n;]/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * A failed approve/cancel whose message signals the draft is no longer pending
 * (already sent / cancelled / not found) → we surface a neutral "View in Inbox"
 * hint instead of a scary error, and do NOT fetch email status to confirm.
 */
function looksAlreadyResolved(message: string): boolean {
    return /not pending|no longer|already|not found|cannot be|can no longer/i.test(
        message,
    );
}

type EmailPhase = "sent" | "resolved" | null;

function EmailCard({ recording, disabled, onRecordingChange }: Props) {
    const emailId = recording.email_id;
    const [showForm, setShowForm] = useState(false);
    const [to, setTo] = useState("");
    const [cc, setCc] = useState("");
    const [subject, setSubject] = useState("");
    const [note, setNote] = useState("");
    const [includeTimeline, setIncludeTimeline] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Session-local terminal states. On a fresh reload with an email_id we show
    // "pending" (no status fetch), per the brief.
    const [phase, setPhase] = useState<EmailPhase>(null);

    const inputCls =
        "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-command)] px-2 py-1.5 text-xs text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300";

    const draft = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            // Omit empty recipient lists so the backend applies its default
            // ("to" falls back to the caller's own address).
            const toList = parseRecipients(to);
            const ccList = parseRecipients(cc);
            const result = await draftRecordingEmail(recording.id, {
                to: toList.length ? toList : undefined,
                cc: ccList.length ? ccList : undefined,
                subject: subject.trim() || undefined,
                note: note.trim() || undefined,
                include_timeline_image: includeTimeline,
            });
            setShowForm(false);
            onRecordingChange(result.recording);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not draft the email.",
            );
        } finally {
            setBusy(false);
        }
    }, [recording.id, to, cc, subject, note, includeTimeline, onRecordingChange]);

    const approve = useCallback(async () => {
        if (!emailId) return;
        setBusy(true);
        setError(null);
        try {
            const { email } = await approveEmail(emailId);
            // Approve returns the row as-is when it isn't pending, so reflect
            // what actually happened rather than assuming "sent": only a real
            // "sent" is a success; anything else is already-resolved.
            setPhase(email.status === "sent" ? "sent" : "resolved");
        } catch (err) {
            const message =
                err instanceof Error
                    ? err.message
                    : "Could not send the email.";
            if (looksAlreadyResolved(message)) {
                setPhase("resolved");
            } else {
                setError(message);
            }
        } finally {
            setBusy(false);
        }
    }, [emailId]);

    const cancel = useCallback(async () => {
        if (!emailId) return;
        setBusy(true);
        setError(null);
        try {
            await cancelEmail(emailId);
            // Back to the "Draft email" state — clear the link locally.
            setPhase(null);
            onRecordingChange({ ...recording, email_id: null });
        } catch (err) {
            const message =
                err instanceof Error
                    ? err.message
                    : "Could not cancel the draft.";
            if (looksAlreadyResolved(message)) {
                setPhase("resolved");
            } else {
                setError(message);
            }
        } finally {
            setBusy(false);
        }
    }, [emailId, recording, onRecordingChange]);

    let body: React.ReactNode;
    if (phase === "sent") {
        body = (
            <div className="flex flex-1 flex-col justify-center gap-2">
                <span className="inline-flex items-center gap-1 self-start rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                    <Check className="h-3.5 w-3.5" />
                    Sent
                </span>
            </div>
        );
    } else if (phase === "resolved") {
        body = (
            <div className="flex flex-1 flex-col justify-center gap-2">
                <p className="text-xs text-[var(--app-text-subtle)]">
                    This draft was already sent or cancelled.
                </p>
                <Link
                    href="/inbox"
                    className="inline-flex items-center gap-1 self-start text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                    <Mail className="h-3.5 w-3.5" />
                    View in Inbox
                </Link>
            </div>
        );
    } else if (emailId) {
        body = (
            <div className="flex flex-1 flex-col justify-between gap-2">
                <p className="text-xs text-[var(--app-text-muted)]">
                    Email draft pending approval.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void approve()}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                    >
                        {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Send className="h-3.5 w-3.5" />
                        )}
                        Approve &amp; send
                    </button>
                    <button
                        type="button"
                        onClick={() => void cancel()}
                        disabled={busy}
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-command)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-50"
                    >
                        Cancel draft
                    </button>
                </div>
            </div>
        );
    } else if (showForm) {
        body = (
            <div className="flex flex-1 flex-col gap-1.5">
                <input
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="To (defaults to you)"
                    aria-label="Recipients"
                    className={inputCls}
                />
                <input
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    placeholder="Cc (optional)"
                    aria-label="Cc"
                    className={inputCls}
                />
                <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Subject (optional)"
                    aria-label="Subject"
                    className={inputCls}
                />
                <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Note (optional)"
                    aria-label="Note"
                    rows={2}
                    className={`${inputCls} resize-none`}
                />
                <label className="mt-0.5 flex items-center gap-2 text-xs text-[var(--app-text-muted)]">
                    <input
                        type="checkbox"
                        checked={includeTimeline}
                        onChange={(e) => setIncludeTimeline(e.target.checked)}
                        className="h-3.5 w-3.5 accent-amber-600"
                    />
                    Include timeline image
                </label>
                <div className="mt-1 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void draft()}
                        disabled={busy}
                        className={GENERATE_BTN_CLASS}
                    >
                        {busy ? (
                            <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Drafting…
                            </>
                        ) : (
                            <>
                                <Mail className="h-3.5 w-3.5" />
                                Create draft
                            </>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowForm(false)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)] disabled:opacity-50"
                    >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                    </button>
                </div>
            </div>
        );
    } else {
        body = (
            <div className="flex flex-1 flex-col justify-between gap-2">
                <p className="text-xs text-[var(--app-text-subtle)]">
                    Email the summary, transcript PDF, and timeline image
                    (drafts for your approval — never sends on its own).
                </p>
                <button
                    type="button"
                    onClick={() => setShowForm(true)}
                    disabled={disabled}
                    title={
                        disabled
                            ? "Available once the recording is ready"
                            : undefined
                    }
                    className={GENERATE_BTN_CLASS}
                >
                    <Mail className="h-3.5 w-3.5" />
                    Draft email
                </button>
            </div>
        );
    }

    return (
        <div className={CARD_CLASS}>
            <CardHeader icon={Mail} label="Email" />
            {body}
            {error && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                </p>
            )}
        </div>
    );
}

/**
 * The detail page's three on-demand extras: a voice briefing, a timeline image,
 * and an approval-gated email — each generated lazily and disabled (with a
 * tooltip) until the recording is fully processed.
 */
export function RecordingExtrasRow({
    recording,
    disabled,
    onRecordingChange,
}: Props) {
    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <VoiceBriefingCard
                recording={recording}
                disabled={disabled}
                onRecordingChange={onRecordingChange}
            />
            <TimelineImageCard
                recording={recording}
                disabled={disabled}
                onRecordingChange={onRecordingChange}
            />
            <EmailCard
                recording={recording}
                disabled={disabled}
                onRecordingChange={onRecordingChange}
            />
        </div>
    );
}
