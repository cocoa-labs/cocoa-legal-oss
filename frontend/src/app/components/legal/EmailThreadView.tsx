"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Inbox,
    Mail,
    Loader2,
    ArrowUpRight,
    MessageSquare,
} from "lucide-react";
import {
    getEmail,
    type EmailThreadOut,
} from "@/app/lib/cocoaLegalApi";
import { EmailAttachmentList } from "./EmailAttachmentList";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import type { CocoaLegalMessage } from "@/app/components/shared/types";

function formatWhen(iso: string | null): string {
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
 * Read-only thread view for a single email and the whole back-and-forth on its
 * Gmail thread (outbound + inbound, oldest first). Reached from the Inbox for
 * messages that aren't tied to a Quill conversation; chat-linked messages
 * deep-link straight into the Assistant instead. "Discuss with Quill" starts a
 * fresh conversation seeded with the email.
 */
export function EmailThreadView({ emailId }: { emailId: string }) {
    const router = useRouter();
    const { handleNewChat } = useAssistantChat();
    const [data, setData] = useState<EmailThreadOut | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getEmail(emailId)
            .then((res) => {
                if (!cancelled) setData(res);
            })
            .catch((err) => {
                if (!cancelled)
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Could not load this email.",
                    );
            });
        return () => {
            cancelled = true;
        };
    }, [emailId]);

    const focal = data?.email ?? null;
    const messages = data?.thread.messages ?? [];

    const discussWithQuill = useCallback(async () => {
        if (!focal || starting) return;
        setStarting(true);
        try {
            const seed: CocoaLegalMessage = {
                role: "user",
                content:
                    `Help me reply to this email.\n\n` +
                    `From: ${focal.from_address ?? "unknown"}\n` +
                    `Subject: ${focal.subject ?? "(no subject)"}\n\n` +
                    `${focal.body_text ?? ""}`,
            };
            const chatId = await handleNewChat(seed);
            if (chatId) router.push(`/assistant/chat/${chatId}`);
            else setStarting(false);
        } catch {
            setError("Could not start a conversation about this email.");
            setStarting(false);
        }
    }, [focal, starting, handleNewChat, router]);

    if (error) {
        return <p className="px-1 py-6 text-sm text-red-600">{error}</p>;
    }
    if (!data || !focal) {
        return (
            <div className="space-y-2 px-1 py-2">
                {[0, 1].map((i) => (
                    <div
                        key={i}
                        className="h-24 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                    />
                ))}
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col font-sans">
            {/* Header */}
            <div className="flex items-start gap-2.5 px-1 pb-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 ring-1 ring-amber-200">
                    <Inbox className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-base font-semibold text-[var(--app-text-strong)]">
                        {focal.subject || "(no subject)"}
                    </h1>
                    <p className="truncate text-xs text-[var(--app-text-subtle)]">
                        {focal.from_address || "Unknown sender"}
                    </p>
                </div>
                {focal.chat_id ? (
                    <button
                        type="button"
                        onClick={() =>
                            router.push(`/assistant/chat/${focal.chat_id}`)
                        }
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                    >
                        Open in Assistant
                        <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => void discussWithQuill()}
                        disabled={starting}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                    >
                        {starting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <MessageSquare className="h-3.5 w-3.5" />
                        )}
                        Discuss with Quill
                    </button>
                )}
            </div>

            {/* Thread (oldest first) */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-4">
                {messages.map((m) => {
                    const outbound = m.direction === "outbound";
                    return (
                        <div
                            key={m.id}
                            className={
                                outbound
                                    ? "rounded-lg border border-blue-200 bg-blue-50/60 p-3"
                                    : "rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3"
                            }
                        >
                            <div className="flex items-center gap-2">
                                <div
                                    className={
                                        outbound
                                            ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 ring-1 ring-blue-200"
                                            : "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800 ring-1 ring-amber-200"
                                    }
                                >
                                    <Mail className="h-3.5 w-3.5" />
                                </div>
                                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--app-text-strong)]">
                                    {outbound
                                        ? `To ${m.to_addresses.join(", ") || "—"}`
                                        : m.from_address || "Unknown sender"}
                                </span>
                                <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">
                                    {formatWhen(
                                        m.received_at ??
                                            m.sent_at ??
                                            m.created_at,
                                    )}
                                </span>
                            </div>

                            {m.body_text ? (
                                <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-3 py-2 text-xs leading-5 text-[var(--app-text-muted)]">
                                    {m.body_text}
                                </pre>
                            ) : (
                                <p className="mt-2 text-xs italic text-[var(--app-text-subtle)]">
                                    (no message body)
                                </p>
                            )}

                            <EmailAttachmentList emailId={m.id} inbound={m.direction === "inbound"} manifest={m.attachment_manifest} fallback={m.attachments} />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
