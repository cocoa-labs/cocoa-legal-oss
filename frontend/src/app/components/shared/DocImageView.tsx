"use client";

import { Loader2 } from "lucide-react";
import { useDocumentObjectUrl } from "@/app/hooks/useDocumentObjectUrl";

/**
 * Viewer for an image document (a generated image saved into a matter, file_type
 * png/jpg/...). Fetches the bytes by document_id as an authenticated blob via the
 * shared useDocumentObjectUrl hook (the same path GeneratedImageCard uses) and
 * renders a centered <img>. This is what the doc-review workspace / DocPanel route
 * to instead of the DOCX viewer, which can't parse image bytes.
 */
export function DocImageView({
    documentId,
    filename,
    rounded = true,
    bordered = true,
}: {
    documentId: string;
    filename: string;
    rounded?: boolean;
    bordered?: boolean;
}) {
    const { url, loading, error } = useDocumentObjectUrl(documentId);

    return (
        <div
            className={`flex h-full w-full items-center justify-center overflow-auto bg-[var(--app-panel)] p-6 ${
                rounded ? "rounded-lg" : ""
            } ${bordered ? "border border-[var(--app-border)]" : ""}`}
        >
            {loading && (
                <p className="flex items-center gap-2 text-sm text-[var(--app-text-subtle)]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading image…
                </p>
            )}
            {error && (
                <p className="text-sm text-[var(--app-danger,#dc2626)]">
                    This image couldn&apos;t be loaded. Try re-opening it.
                </p>
            )}
            {url && (
                // eslint-disable-next-line @next/next/no-img-element -- blob object URL, not an optimizable remote asset
                <img
                    src={url}
                    alt={filename}
                    className="max-h-full max-w-full object-contain"
                />
            )}
        </div>
    );
}
