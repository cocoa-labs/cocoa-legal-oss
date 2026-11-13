"use client";

import { Check, Loader2 } from "lucide-react";

interface Props {
    isStreaming?: boolean;
    label?: string;
    sections?: { id: string; heading?: string; status?: "pending" | "done" }[];
}

/**
 * Progress indicator for an in-flight document assembly. Presentational only.
 *
 * The v1 assemble route emits coarse progress, so `sections` is usually
 * undefined and this renders the common case: a `Loader2` spinner + label while
 * streaming, or a completed check when done. When the backend does provide a
 * `sections` list, it renders a per-section checklist instead. Chrome mirrors
 * the inline tool-step rows in AssistantMessage (font-serif, gray-500, small
 * spinner/dot leaders).
 */
export function AssemblyProgressBlock({ isStreaming, label, sections }: Props) {
    if (sections && sections.length > 0) {
        const doneCount = sections.filter((s) => s.status === "done").length;
        return (
            <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-sans">
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">
                        {label ?? "Assembling document…"}
                    </span>
                    <span className="text-xs text-gray-400">
                        {doneCount}/{sections.length}
                    </span>
                </div>
                <ul className="flex flex-col gap-1.5">
                    {sections.map((section) => {
                        const done = section.status === "done";
                        return (
                            <li
                                key={section.id}
                                className="flex items-start gap-2 text-sm text-gray-600"
                            >
                                {done ? (
                                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
                                        <Check className="h-2.5 w-2.5" />
                                    </span>
                                ) : (
                                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                                        <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                                    </span>
                                )}
                                <span
                                    className={`min-w-0 flex-1 leading-snug ${done ? "text-gray-700" : "text-gray-500"}`}
                                >
                                    {section.heading ?? "Untitled section"}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            </div>
        );
    }

    // Coarse single-row state — the common path.
    return (
        <div className="flex items-center text-sm font-serif text-gray-500">
            {isStreaming ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400" />
            ) : (
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-green-400 text-white">
                    <Check className="h-2.5 w-2.5" />
                </span>
            )}
            <span className="ml-2 font-medium">
                {isStreaming
                    ? (label ?? "Assembling document…")
                    : "Document assembled"}
            </span>
        </div>
    );
}
