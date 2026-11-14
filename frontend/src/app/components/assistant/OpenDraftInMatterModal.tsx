"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, FolderPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import {
    useDirectoryData,
    invalidateDirectoryCache,
} from "../shared/useDirectoryData";
import { ProjectPicker } from "../shared/ProjectPicker";
import { createProject, moveDocumentToProject } from "@/app/lib/cocoaLegalApi";
import { matterDocReviewHref } from "@/app/lib/matterRoutes";

export interface OpenDraftDoc {
    documentId: string;
    versionId?: string | null;
    filename: string;
}

interface Props {
    open: boolean;
    doc: OpenDraftDoc | null;
    onClose: () => void;
}

/**
 * "Open document" from the authoring wizard (standalone entry points) files the
 * generated draft into a matter, then opens it in the matter-scoped Doc Review
 * interface. The user picks an existing matter or names a new one; on confirm we
 * set the document's project_id and route to
 * `/projects/:id/doc-review?doc=<id>` so the draft is the active document with
 * Quill ready.
 */
export function OpenDraftInMatterModal({ open, doc, onClose }: Props) {
    const router = useRouter();
    const { loading, projects } = useDirectoryData(open);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setSelectedId(null);
        setNewName("");
        setBusy(false);
        setError(null);
    }, [open]);

    if (!open || !doc) return null;

    // A new-matter name takes precedence over a picked existing matter.
    const trimmedName = newName.trim();
    const canContinue = (!!trimmedName || !!selectedId) && !busy;

    async function handleContinue() {
        if (!doc || busy) return;
        setBusy(true);
        setError(null);
        try {
            const matterId = trimmedName
                ? (await createProject(trimmedName)).id
                : selectedId;
            if (!matterId) return;
            await moveDocumentToProject(doc.documentId, matterId);
            // The directory list now has a new matter / re-filed doc.
            invalidateDirectoryCache();
            onClose();
            router.push(matterDocReviewHref(matterId, doc.documentId));
        } catch (e) {
            setError(
                e instanceof Error
                    ? e.message
                    : "Couldn't open the document in a matter.",
            );
        } finally {
            setBusy(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/10 backdrop-blur-xs">
            <div className="flex h-[600px] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>Authoring</span>
                        <span>›</span>
                        <span>Open in a matter</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="px-5 pb-2">
                    <p className="text-sm text-gray-600">
                        File{" "}
                        <span className="font-medium text-gray-900">
                            {doc.filename}
                        </span>{" "}
                        into a matter to open it in Doc Review, where you can
                        refine it and work through it with Quill.
                    </p>
                </div>

                {/* New matter */}
                <div className="px-4 pt-2 pb-1">
                    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                        <FolderPlus className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Create a new matter…"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-gray-700 placeholder:text-gray-400 outline-none"
                        />
                    </div>
                    <p className="px-1 pt-1.5 text-xs text-gray-400">
                        or choose an existing matter below
                    </p>
                </div>

                {/* Existing matters */}
                <ProjectPicker
                    projects={projects}
                    loading={loading}
                    selectedId={selectedId}
                    onSelect={(id) => {
                        setSelectedId(id);
                        if (id) setNewName("");
                    }}
                />

                {/* Footer */}
                <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
                    <span className="truncate text-xs text-red-500">
                        {error}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            onClick={onClose}
                            className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleContinue}
                            disabled={!canContinue}
                            className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                        >
                            {busy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                "Open in matter"
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
