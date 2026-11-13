"use client";

import { useState } from "react";
import { Send, Copy, Check } from "lucide-react";

export interface EscalationDraftProps {
    /** Pre-filled subject line, e.g. "Escalation: RED NDA from Acme". */
    defaultSubject: string;
    /** Pre-filled body — markdown rendered as plain text in v1. */
    defaultBody: string;
    /** Optional suggested recipient(s) drawn from the playbook. */
    defaultRecipients?: string[];
    /** Optional onSend hook — in v1 this opens the user's mail client. */
    onSend?: (args: {
        subject: string;
        body: string;
        recipients: string[];
    }) => void;
}

export function EscalationDraft({
    defaultSubject,
    defaultBody,
    defaultRecipients = [],
    onSend,
}: EscalationDraftProps) {
    const [subject, setSubject] = useState(defaultSubject);
    const [body, setBody] = useState(defaultBody);
    const [recipients, setRecipients] = useState<string>(
        defaultRecipients.join(", "),
    );
    const [copied, setCopied] = useState(false);

    function copy() {
        const text = `To: ${recipients}\nSubject: ${subject}\n\n${body}`;
        void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }

    function send() {
        const list = recipients
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
        if (onSend) {
            onSend({ subject, body, recipients: list });
        } else {
            const to = list.join(",");
            const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
                subject,
            )}&body=${encodeURIComponent(body)}`;
            window.open(url, "_blank", "noopener");
        }
    }

    return (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
            <div className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                Escalation drafted — review and send
            </div>
            <div className="grid gap-2 text-sm">
                <label className="grid gap-1">
                    <span className="text-xs text-amber-800 dark:text-amber-300">
                        To
                    </span>
                    <input
                        className="rounded border border-amber-200 bg-white px-2 py-1 dark:border-amber-900 dark:bg-amber-950"
                        value={recipients}
                        onChange={(e) => setRecipients(e.target.value)}
                        placeholder="counsel@firm.com, partner@firm.com"
                    />
                </label>
                <label className="grid gap-1">
                    <span className="text-xs text-amber-800 dark:text-amber-300">
                        Subject
                    </span>
                    <input
                        className="rounded border border-amber-200 bg-white px-2 py-1 dark:border-amber-900 dark:bg-amber-950"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                    />
                </label>
                <label className="grid gap-1">
                    <span className="text-xs text-amber-800 dark:text-amber-300">
                        Body
                    </span>
                    <textarea
                        className="min-h-[120px] rounded border border-amber-200 bg-white px-2 py-1 font-mono text-xs dark:border-amber-900 dark:bg-amber-950"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                    />
                </label>
            </div>
            <div className="mt-3 flex gap-2">
                <button
                    onClick={send}
                    className="inline-flex items-center gap-1 rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                >
                    <Send className="h-3.5 w-3.5" /> Send
                </button>
                <button
                    onClick={copy}
                    className="inline-flex items-center gap-1 rounded border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-900 dark:text-amber-200 dark:hover:bg-amber-950"
                >
                    {copied ? (
                        <>
                            <Check className="h-3.5 w-3.5" /> Copied
                        </>
                    ) : (
                        <>
                            <Copy className="h-3.5 w-3.5" /> Copy
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
