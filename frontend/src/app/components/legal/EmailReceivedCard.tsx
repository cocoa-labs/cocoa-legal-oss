"use client";

import { Inbox, ArrowUpRight } from "lucide-react";
import { EmailAttachmentList } from "./EmailAttachmentList";
import { useRouter } from "next/navigation";
import type { AssistantEvent } from "../shared/types";

type EmailReceived = Extract<AssistantEvent, { type: "email_received" }>;

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
 * Compact "email received" card rendered in the assistant stream when an inbound
 * reply lands on a thread Quill started. It pairs with the EmailApprovalCard for
 * the parked auto-draft reply (this shows what arrived; that shows the proposed
 * response). "View full email" opens the inbox thread view.
 */
export function EmailReceivedCard({ event }: { event: EmailReceived }) {
    const router = useRouter();
    const when = formatReceived(event.received_at);

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 font-sans">
            <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 ring-1 ring-amber-200">
                    <Inbox className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-semibold text-[var(--app-text-strong)]">
                    Email received
                </span>
                {when && (
                    <span className="ml-auto text-[11px] text-[var(--app-text-subtle)]">
                        {when}
                    </span>
                )}
            </div>

            <dl className="mt-3 space-y-1 text-sm">
                <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-medium text-[var(--app-text-subtle)]">
                        From
                    </dt>
                    <dd className="min-w-0 break-words text-[var(--app-text-strong)]">
                        {event.from_address || "Unknown sender"}
                    </dd>
                </div>
                <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-medium text-[var(--app-text-subtle)]">
                        Subject
                    </dt>
                    <dd className="min-w-0 break-words font-medium text-[var(--app-text-strong)]">
                        {event.subject || "(no subject)"}
                    </dd>
                </div>
            </dl>

            {event.body_preview && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-3 py-2 text-xs leading-5 text-[var(--app-text-muted)]">
                    {event.body_preview}
                </pre>
            )}

            <EmailAttachmentList emailId={event.email_id} inbound fallback={event.attachments} />

            <div className="mt-3">
                <button
                    type="button"
                    onClick={() => router.push(`/inbox/${event.email_id}`)}
                    className="inline-flex items-center gap-1.5 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                >
                    View full email
                    <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
}
