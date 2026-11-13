"use client";

import { FileDown, FilePlus, Mail, Copy, RotateCcw } from "lucide-react";

export interface CapabilityFooterActionsProps {
    onExportDocx?: () => void;
    onOpenAsDoc?: () => void;
    onSendEmail?: () => void;
    onCopy?: () => void;
    onRerun?: () => void;
    /** Disable an action even if the handler is provided (e.g. while
     * loading or after a one-shot action has completed). */
    disabled?: {
        exportDocx?: boolean;
        openAsDoc?: boolean;
        sendEmail?: boolean;
        copy?: boolean;
        rerun?: boolean;
    };
}

export function CapabilityFooterActions(
    props: CapabilityFooterActionsProps,
) {
    return (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
            {props.onExportDocx && (
                <ActionButton
                    icon={<FileDown className="h-3.5 w-3.5" />}
                    label="Export DOCX"
                    onClick={props.onExportDocx}
                    disabled={props.disabled?.exportDocx}
                />
            )}
            {props.onOpenAsDoc && (
                <ActionButton
                    icon={<FilePlus className="h-3.5 w-3.5" />}
                    label="Open as Doc"
                    onClick={props.onOpenAsDoc}
                    disabled={props.disabled?.openAsDoc}
                />
            )}
            {props.onSendEmail && (
                <ActionButton
                    icon={<Mail className="h-3.5 w-3.5" />}
                    label="Send Email"
                    onClick={props.onSendEmail}
                    disabled={props.disabled?.sendEmail}
                />
            )}
            {props.onCopy && (
                <ActionButton
                    icon={<Copy className="h-3.5 w-3.5" />}
                    label="Copy"
                    onClick={props.onCopy}
                    disabled={props.disabled?.copy}
                />
            )}
            {props.onRerun && (
                <ActionButton
                    icon={<RotateCcw className="h-3.5 w-3.5" />}
                    label="Re-run"
                    onClick={props.onRerun}
                    disabled={props.disabled?.rerun}
                />
            )}
        </div>
    );
}

function ActionButton({
    icon,
    label,
    onClick,
    disabled,
}: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            disabled={disabled}
            onClick={onClick}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-900"
        >
            {icon}
            {label}
        </button>
    );
}
