"use client";

import { Download, ImageIcon, Loader2, Mail, Pencil, RefreshCw } from "lucide-react";
import { useDocumentObjectUrl } from "@/app/hooks/useDocumentObjectUrl";

/**
 * Artifact card for an image the agent generated or edited (the `image_generated`
 * event). Rendered in the message body below the prose — alongside the doc
 * download cards, NOT inside the PreResponseWrapper reasoning trace, which
 * unmounts its children when it collapses and so used to hide the image.
 *
 * Fetches the image by document_id as an authenticated blob (shared
 * useDocumentObjectUrl) and renders it image-first with a caption footer
 * carrying Download / Edit / Regenerate / Attach-to-email. Actions are shown
 * only when their handler is provided (the doc-review chat passes none, so it
 * degrades to Download only).
 */
export function GeneratedImageCard({
    documentId,
    filename,
    kind,
    onEdit,
    onRegenerate,
    onAttachToEmail,
}: {
    documentId: string;
    filename: string;
    kind: "generate" | "edit";
    onEdit?: () => void;
    onRegenerate?: () => void;
    onAttachToEmail?: () => void;
}) {
    const { url, loading, error } = useDocumentObjectUrl(documentId);

    const actionClass =
        "inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 disabled:opacity-50";

    return (
        <figure className="w-full max-w-3xl overflow-hidden rounded-xl border border-gray-200 bg-gray-50 font-sans shadow-sm">
            {/* Reserve height while the blob loads so the card grows
                placeholder → image rather than nothing → image. */}
            {!url && (
                <div className="flex min-h-[220px] items-center justify-center bg-gray-100">
                    {loading && (
                        <p className="flex items-center gap-1.5 text-xs text-gray-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading image…
                        </p>
                    )}
                    {error && (
                        <p className="px-4 text-xs text-red-600">{error}</p>
                    )}
                </div>
            )}
            {url && (
                // eslint-disable-next-line @next/next/no-img-element -- blob object URL, not an optimizable remote asset
                <img src={url} alt={filename} className="block w-full" />
            )}

            <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-gray-200 bg-white px-4 py-2.5">
                <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-gray-500">
                    <ImageIcon className="h-3.5 w-3.5 shrink-0" />
                    <span className="shrink-0">
                        {kind === "edit" ? "Edited image" : "Generated image"}
                    </span>
                    <span className="min-w-0 truncate font-normal text-gray-400">
                        · {filename}
                    </span>
                </span>

                {url && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        <a
                            href={url}
                            download={filename}
                            className={actionClass}
                        >
                            <Download className="h-3.5 w-3.5" />
                            Download
                        </a>
                        {onEdit && (
                            <button
                                type="button"
                                onClick={onEdit}
                                className={actionClass}
                            >
                                <Pencil className="h-3.5 w-3.5" />
                                Edit
                            </button>
                        )}
                        {onRegenerate && (
                            <button
                                type="button"
                                onClick={onRegenerate}
                                className={actionClass}
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                Regenerate
                            </button>
                        )}
                        {onAttachToEmail && (
                            <button
                                type="button"
                                onClick={onAttachToEmail}
                                className={actionClass}
                            >
                                <Mail className="h-3.5 w-3.5" />
                                Attach to email
                            </button>
                        )}
                    </div>
                )}
            </figcaption>
        </figure>
    );
}
