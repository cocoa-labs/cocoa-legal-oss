"use client";

import { useEffect, useRef, useState } from "react";
import {
    Building2,
    FileText,
    Loader2,
    Sparkles,
    Upload,
    X,
} from "lucide-react";
import { listTemplates, uploadStandaloneDocument } from "@/app/lib/cocoaLegalApi";
import { DOCUMENT_ACCEPT_ATTR } from "@/app/lib/uploadTypes";
import type { DocTemplate } from "../shared/types";
import { DOC_TYPE_LABELS } from "./builtinTemplates";
import { NewTemplateModal } from "./NewTemplateModal";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Called with the chosen (or freshly created) template id. */
    onPick: (templateId: string) => void;
    /** Optional doc_type filter passed to listTemplates. */
    docType?: string;
}

/** Source-bucket metadata: section ordering, heading copy, and badge style. */
const SOURCE_BUCKETS: {
    kind: DocTemplate["source_kind"];
    heading: string;
    badge: string;
    badgeClass: string;
}[] = [
    {
        kind: "firm_parameterized",
        heading: "Firm",
        badge: "Firm",
        badgeClass: "border-violet-200 bg-violet-50 text-violet-700",
    },
    {
        kind: "cocoa_seed",
        heading: "Cocoa Legal defaults",
        badge: "Cocoa Legal",
        badgeClass: "border-gray-200 bg-gray-50 text-gray-600",
    },
    {
        kind: "ai_generated",
        heading: "AI-generated",
        badge: "AI",
        badgeClass: "border-amber-200 bg-amber-50 text-amber-700",
    },
];

function docTypeLabel(docType: string): string {
    return DOC_TYPE_LABELS[docType] ?? docType;
}

export function TemplatePickerModal({ open, onClose, onPick, docType }: Props) {
    const [templates, setTemplates] = useState<DocTemplate[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Nested "Generate with AI" modal. When opened via upload, we seed it with
    // the uploaded sample's document_id so the AI parameterizes from it.
    const [generateOpen, setGenerateOpen] = useState(false);
    const [sampleDocumentId, setSampleDocumentId] = useState<
        string | undefined
    >(undefined);

    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) {
            setGenerateOpen(false);
            setSampleDocumentId(undefined);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError("");
        listTemplates(docType)
            .then((rows) => {
                if (!cancelled) setTemplates(rows);
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Could not load templates.",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, docType]);

    if (!open) return null;

    function handleClose() {
        if (uploading) return;
        onClose();
    }

    async function handleFileSelected(
        e: React.ChangeEvent<HTMLInputElement>,
    ) {
        const file = e.target.files?.[0];
        if (fileInputRef.current) fileInputRef.current.value = "";
        if (!file) return;
        setUploading(true);
        setError("");
        try {
            const doc = await uploadStandaloneDocument(file);
            setSampleDocumentId(doc.id);
            setGenerateOpen(true);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not upload that document.",
            );
        } finally {
            setUploading(false);
        }
    }

    const isEmpty = !loading && templates.length === 0;

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="flex h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex items-center justify-between px-6 pb-3 pt-5 shrink-0">
                    <div className="min-w-0">
                        <h2 className="font-serif text-2xl text-gray-900">
                            Choose a template
                        </h2>
                        <p className="mt-1 text-sm text-gray-500">
                            Start from a saved template, generate one with AI, or
                            parameterize an existing document.
                        </p>
                    </div>
                    <button
                        onClick={handleClose}
                        disabled={uploading}
                        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex items-center gap-2 border-b border-gray-100 px-6 pb-4 shrink-0">
                    <button
                        type="button"
                        onClick={() => {
                            setSampleDocumentId(undefined);
                            setGenerateOpen(true);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700"
                    >
                        <Sparkles className="h-3.5 w-3.5" />
                        Generate with AI
                    </button>
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                    >
                        {uploading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Upload className="h-3.5 w-3.5" />
                        )}
                        {uploading ? "Uploading..." : "Upload & parameterize"}
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={DOCUMENT_ACCEPT_ATTR}
                        className="hidden"
                        onChange={handleFileSelected}
                    />
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4">
                    {loading && (
                        <div className="flex h-full items-center justify-center text-gray-400">
                            <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                    )}

                    {error && (
                        <p className="mb-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                            {error}
                        </p>
                    )}

                    {isEmpty && !error && (
                        <div className="flex h-full flex-col items-center justify-center text-center">
                            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-200 bg-gray-50">
                                <FileText className="h-6 w-6 text-gray-400" />
                            </div>
                            <p className="text-sm font-medium text-gray-700">
                                No templates yet
                            </p>
                            <p className="mt-1 max-w-sm text-sm text-gray-500">
                                Generate your first reusable template with AI, or
                                upload an existing document to parameterize it.
                            </p>
                            <button
                                type="button"
                                onClick={() => {
                                    setSampleDocumentId(undefined);
                                    setGenerateOpen(true);
                                }}
                                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700"
                            >
                                <Sparkles className="h-3.5 w-3.5" />
                                Generate with AI
                            </button>
                        </div>
                    )}

                    {!loading &&
                        !isEmpty &&
                        SOURCE_BUCKETS.map((bucket) => {
                            const rows = templates.filter(
                                (t) => t.source_kind === bucket.kind,
                            );
                            if (rows.length === 0) return null;
                            return (
                                <div key={bucket.kind} className="mb-6">
                                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
                                        {bucket.heading}
                                    </p>
                                    <div className="space-y-2">
                                        {rows.map((t) => (
                                            <button
                                                key={t.id}
                                                type="button"
                                                onClick={() => onPick(t.id)}
                                                className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50"
                                            >
                                                <div className="flex min-w-0 items-center gap-3">
                                                    {bucket.kind ===
                                                    "firm_parameterized" ? (
                                                        <Building2 className="h-4 w-4 shrink-0 text-gray-400" />
                                                    ) : (
                                                        <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                                                    )}
                                                    <div className="min-w-0">
                                                        <p className="truncate text-sm font-medium text-gray-800">
                                                            {t.title}
                                                        </p>
                                                        <p className="truncate text-xs text-gray-500">
                                                            {docTypeLabel(
                                                                t.doc_type,
                                                            )}
                                                            {t.jurisdiction
                                                                ? ` · ${t.jurisdiction}`
                                                                : ""}
                                                        </p>
                                                    </div>
                                                </div>
                                                <span
                                                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${bucket.badgeClass}`}
                                                >
                                                    {bucket.badge}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                </div>
            </div>

            <NewTemplateModal
                open={generateOpen}
                onClose={() => setGenerateOpen(false)}
                onCreated={(id) => {
                    setGenerateOpen(false);
                    onPick(id);
                }}
                initialSampleDocumentId={sampleDocumentId}
                initialDocType={docType}
            />
        </div>
    );
}
