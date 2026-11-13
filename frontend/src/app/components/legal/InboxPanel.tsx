"use client";

import { useCallback, useEffect, useState } from "react";
import { EmailAttachmentList } from "./EmailAttachmentList";
import { useRouter } from "next/navigation";
import {
    Inbox,
    Mail,
    RefreshCw,
    Loader2,
    FileSignature,
    ChevronRight,
} from "lucide-react";
import {
    listEmails,
    refreshInbound,
    type EmailRecord,
} from "@/app/lib/cocoLegalApi";

function formatReceived(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

/**
 * On-demand inbound inbox. Lists ingested inbound agent emails (sender,
 * subject, received time, attachment chips) and offers a "Check for new mail"
 * button that asks the backend to pull the connected mailbox and ingest any
 * new messages before reloading the list.
 *
 * Self-contained: it owns its own data fetching and has no required props, so
 * it can be dropped into any host (a dedicated page, a tab, a drawer).
 */
export function InboxPanel() {
    const router = useRouter();
    const [emails, setEmails] = useState<EmailRecord[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [lastIngested, setLastIngested] = useState<number | null>(null);
    const [navigatingId, setNavigatingId] = useState<string | null>(null);

    // Open an inbox item: jump into the Quill conversation it belongs to when the
    // thread is linked to one, otherwise open the read-only thread view.
    const openEmail = useCallback(
        (email: EmailRecord) => {
            setNavigatingId(email.id);
            if (email.chat_id) {
                // Carry the inbound id so the conversation can surface this reply
                // and auto-draft a response on arrival (see the chat page).
                router.push(
                    `/assistant/chat/${email.chat_id}?inbound=${encodeURIComponent(email.id)}`,
                );
            } else {
                router.push(`/inbox/${email.id}`);
            }
        },
        [router],
    );

    const load = useCallback(async () => {
        try {
            const res = await listEmails("inbound");
            setEmails(res.emails);
            setLoadError(null);
        } catch (err) {
            setLoadError(
                err instanceof Error
                    ? err.message
                    : "Could not load your inbox.",
            );
            setEmails((prev) => prev ?? []);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const handleRefresh = useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        setLoadError(null);
        try {
            const res = await refreshInbound();
            setLastIngested(res.ingested);
            await load();
        } catch (err) {
            setLoadError(
                err instanceof Error
                    ? err.message
                    : "Could not check for new mail.",
            );
        } finally {
            setRefreshing(false);
        }
    }, [refreshing, load]);


    return (
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col font-sans">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-1 pb-3 pt-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 ring-1 ring-amber-200">
                    <Inbox className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-[var(--app-text-strong)]">
                        Inbox
                    </h1>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        Inbound mail ingested for your matters
                    </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {lastIngested !== null && !refreshing && (
                        <span className="text-xs font-medium text-[var(--app-text-muted)]">
                            {lastIngested === 0
                                ? "No new mail"
                                : `${lastIngested} new`}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {refreshing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        {refreshing ? "Checking…" : "Check for new mail"}
                    </button>
                </div>
            </div>

            {loadError && (
                <p className="px-1 pb-2 text-xs text-red-600">{loadError}</p>
            )}

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {emails === null ? (
                    <div className="space-y-2 px-1">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-16 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                            />
                        ))}
                    </div>
                ) : emails.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-6 py-12 text-center">
                        <Mail className="h-6 w-6 text-[var(--app-text-subtle)]" />
                        <p className="text-sm font-medium text-[var(--app-text-muted)]">
                            No inbound mail yet
                        </p>
                        <p className="max-w-xs text-xs text-[var(--app-text-subtle)]">
                            Use “Check for new mail” to pull the connected
                            mailbox for newly received messages.
                        </p>
                    </div>
                ) : (
                    <ul className="space-y-2 px-1 pb-4">
                        {emails.map((email) => (
                            <li
                                key={email.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => openEmail(email)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        openEmail(email);
                                    }
                                }}
                                className="cursor-pointer rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 transition-colors hover:bg-[var(--app-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                            >
                                <div className="flex items-baseline gap-2">
                                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text-strong)]">
                                        {email.subject || "(no subject)"}
                                    </span>
                                    <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">
                                        {formatReceived(
                                            email.received_at ??
                                                email.created_at,
                                        )}
                                    </span>
                                    {navigatingId === email.id ? (
                                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--app-text-subtle)]" />
                                    ) : (
                                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                                    )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--app-text-muted)]">
                                    <Mail className="h-3 w-3 shrink-0 text-[var(--app-text-subtle)]" />
                                    <span className="truncate">
                                        {email.from_address || "Unknown sender"}
                                    </span>
                                </div>

                                <EmailAttachmentList emailId={email.id} inbound={email.direction === "inbound"} manifest={email.attachment_manifest} fallback={email.attachments} />

                                {email.signature_envelope_id && (
                                    <div className="mt-2 inline-flex items-center gap-1 rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                                        <FileSignature className="h-3 w-3" />
                                        Linked to a signature request
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
