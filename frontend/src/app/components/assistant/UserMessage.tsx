"use client";

import { useEffect, useState } from "react";
import { AlertCircle, File, FileText, Image as ImageIcon, Library, Sparkles } from "lucide-react";
import { fetchChatImageAttachment } from "@/app/lib/cocoLegalApi";
import type {
    CapabilityRunRecord,
    CocoLegalMessageAttachment,
} from "../shared/types";

interface Props {
    content: string;
    files?: CocoLegalMessageAttachment[];
    workflow?: { id: string; title: string };
    /** Set when this turn was a confirmed capability run (proposal chip). */
    capabilityRun?: CapabilityRunRecord | null;
    variant?: "default" | "command";
}

function ImageAttachmentPreview({
    attachment,
}: {
    attachment: Extract<CocoLegalMessageAttachment, { kind: "image" }>;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | null = null;
        fetchChatImageAttachment(attachment.attachment_id)
            .then((blob) => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setUrl(objectUrl);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [attachment.attachment_id]);

    if (failed) {
        return (
            <div className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 py-0.5 pl-2 pr-2.5 text-xs text-red-500">
                <AlertCircle className="h-2.5 w-2.5 shrink-0" />
                <span className="max-w-[140px] truncate">
                    {attachment.filename}
                </span>
            </div>
        );
    }

    return (
        <div className="group relative h-24 w-32 overflow-hidden rounded-lg border border-black/10 bg-black/5 shadow-sm">
            {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={url}
                    alt={attachment.filename}
                    className="h-full w-full object-cover"
                />
            ) : (
                <div className="flex h-full w-full items-center justify-center">
                    <ImageIcon className="h-5 w-5 animate-pulse text-gray-400" />
                </div>
            )}
            <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-2 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                {attachment.filename}
            </div>
        </div>
    );
}

export function UserMessage({
    content,
    files,
    workflow,
    capabilityRun,
    variant = "default",
}: Props) {
    const hasFiles = files && files.length > 0;
    const isCommand = variant === "command";

    return (
        <div className="w-full flex justify-end">
            <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${
                    isCommand
                        ? "border border-[var(--app-border)] bg-[var(--app-command-muted)] text-[var(--app-text-strong)] shadow-[var(--app-elevated-shadow)] backdrop-blur-md"
                        : "bg-gray-100 text-gray-900"
                }`}
            >
                <p
                    className={`text-sm whitespace-pre-wrap ${
                        isCommand ? "text-[var(--app-text-strong)]" : "text-gray-900"
                    }`}
                >
                    {content}
                </p>
                {(workflow || hasFiles || capabilityRun) && (
                    <div className="flex flex-wrap justify-end gap-1.5 mt-3">
                        {capabilityRun && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs border border-[var(--app-border)] bg-[var(--app-command-muted)] text-[var(--app-text-muted)]">
                                <Sparkles className="h-2.5 w-2.5 shrink-0" />
                                <span className="max-w-[200px] truncate">
                                    Capability run ·{" "}
                                    {capabilityRun.capability_id}
                                </span>
                            </div>
                        )}
                        {workflow && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-blue-600 text-white shadow border border-blue-600">
                                <Library className="h-2.5 w-2.5 shrink-0" />
                                <span className="max-w-[140px] truncate">{workflow.title}</span>
                            </div>
                        )}
                        {hasFiles && files.map((f, i) => {
                            if (f.kind === "image") {
                                return (
                                    <ImageAttachmentPreview
                                        key={`${f.attachment_id}-${i}`}
                                        attachment={f}
                                    />
                                );
                            }
                            const ext = f.filename.split(".").pop()?.toLowerCase();
                            const isPdf = ext === "pdf";
                            return (
                                <div
                                    key={i}
                                    className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs text-white shadow border border-black bg-black"
                                >
                                    {isPdf
                                        ? <FileText className="h-2.5 w-2.5 shrink-0 text-red-400" />
                                        : <File className="h-2.5 w-2.5 shrink-0 text-blue-400" />
                                    }
                                    <span className="max-w-[140px] truncate">{f.filename}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
