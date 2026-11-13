"use client";

import { cn } from "@/lib/utils";

interface Props {
    onConfirm: () => void;
    onCancel: () => void;
    className?: string;
}

/**
 * Per-recording consent gate. Product decision (locked): the acknowledgement is
 * shown every time a capture/upload begins — there is no "remember me", no
 * localStorage, and no state of its own beyond hover. Rendered inline by
 * `RecorderControl` and the upload flows.
 */
export function ConsentConfirm({ onConfirm, onCancel, className }: Props) {
    return (
        <div
            className={cn(
                "flex flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3",
                className,
            )}
        >
            <p className="text-xs text-[var(--app-text-muted)]">
                I have obtained any required consent from participants.
            </p>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onConfirm}
                    className="rounded-md bg-[var(--app-active-strong)] px-3 py-1 text-xs font-medium text-[var(--app-active-foreground)] transition-opacity hover:opacity-90"
                >
                    Confirm
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-md px-3 py-1 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}
