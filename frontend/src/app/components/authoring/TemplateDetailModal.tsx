"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, MapPin, Scale, Trash2, X } from "lucide-react";
import { deleteTemplate, getTemplate } from "@/app/lib/cocoLegalApi";
import type { DocTemplate, DocTemplateVersion } from "../shared/types";
import { DOC_TYPE_LABELS } from "./builtinTemplates";
import { TemplateVariableEditor } from "./TemplateVariableEditor";

interface Props {
    open: boolean;
    templateId: string | null;
    onClose: () => void;
    /** Bubble the "Use template" action up so the parent opens NewDraftModal. */
    onUseTemplate: (templateId: string) => void;
    /** Fired after a firm-owned template is archived from this modal. */
    onDeleted?: () => void;
}

/** A coco_seed template is a shared default — not deletable. */
function isFirmOwned(t: DocTemplate): boolean {
    return (
        t.source_kind === "firm_parameterized" ||
        t.source_kind === "ai_generated"
    );
}

/** First ~220 chars of a section body, single-lined, for the read snippet. */
function bodySnippet(bodyMd: string | undefined): string {
    const text = (bodyMd ?? "").replace(/\s+/g, " ").trim();
    return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

export function TemplateDetailModal({
    open,
    templateId,
    onClose,
    onUseTemplate,
    onDeleted,
}: Props) {
    // Closed (or no template selected — the only caller derives `open` from
    // `templateId !== null`, so they travel together) → render nothing. The
    // keyed inner component below then mounts FRESH per open/template, which
    // is what used to be done by resetting state in an effect: the remount
    // wipes template/version/error/deleting with no extra render pass.
    if (!open || !templateId) return null;
    return (
        <TemplateDetailModalContent
            key={templateId}
            templateId={templateId}
            onClose={onClose}
            onUseTemplate={onUseTemplate}
            onDeleted={onDeleted}
        />
    );
}

function TemplateDetailModalContent({
    templateId,
    onClose,
    onUseTemplate,
    onDeleted,
}: Omit<Props, "open" | "templateId"> & { templateId: string }) {
    const [template, setTemplate] = useState<DocTemplate | null>(null);
    const [version, setVersion] = useState<DocTemplateVersion | null>(null);
    // The fetch below starts on mount, so the spinner state is simply the
    // initial state — no synchronous setLoading(true) inside the effect.
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getTemplate(templateId)
            .then((res) => {
                if (cancelled) return;
                setTemplate(res.template);
                setVersion(res.version);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not load this template.",
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [templateId]);

    async function handleDelete() {
        if (!template || deleting) return;
        setDeleting(true);
        try {
            await deleteTemplate(template.id);
            onDeleted?.();
            onClose();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not archive this template.",
            );
            setDeleting(false);
        }
    }

    const docTypeLabel = template
        ? (DOC_TYPE_LABELS[template.doc_type] ?? template.doc_type)
        : "";
    const sections = version?.skeleton ?? [];
    const schema = version?.variableSchema ?? [];
    const firmOwned = template ? isFirmOwned(template) : false;

    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="flex h-[600px] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 shrink-0">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>Templates</span>
                        <span>›</span>
                        <span className="truncate max-w-[220px]">
                            {template?.title ?? "Template"}
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 min-h-0 overflow-y-auto border-t border-gray-200 px-5 py-4">
                    {loading ? (
                        <div className="flex h-full items-center justify-center">
                            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                        </div>
                    ) : error ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                            <p className="text-sm text-gray-600">{error}</p>
                        </div>
                    ) : template ? (
                        <div className="space-y-6">
                            {/* Title + meta */}
                            <div>
                                <h2 className="font-serif text-2xl text-gray-900">
                                    {template.title}
                                </h2>
                                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500">
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-600">
                                        {docTypeLabel}
                                    </span>
                                    {template.practice && (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Scale className="h-3.5 w-3.5 text-gray-400" />
                                            {template.practice}
                                        </span>
                                    )}
                                    {template.jurisdiction && (
                                        <span className="inline-flex items-center gap-1.5">
                                            <MapPin className="h-3.5 w-3.5 text-gray-400" />
                                            {template.jurisdiction}
                                        </span>
                                    )}
                                </div>
                                {template.description && (
                                    <p className="mt-3 text-sm leading-6 text-gray-600">
                                        {template.description}
                                    </p>
                                )}
                            </div>

                            {/* Sections */}
                            <div>
                                <p className="mb-2 text-xs font-medium text-gray-700">
                                    Sections
                                </p>
                                {sections.length === 0 ? (
                                    <p className="rounded-md border border-dashed border-gray-200 px-3 py-6 text-center text-sm text-gray-400">
                                        No sections defined.
                                    </p>
                                ) : (
                                    <div className="space-y-2">
                                        {sections.map((section) => {
                                            const aiDrafted =
                                                !section.body_md?.trim();
                                            return (
                                                <div
                                                    key={section.id}
                                                    className="rounded-lg border border-gray-200 p-3"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <p className="min-w-0 truncate text-sm font-medium text-gray-800">
                                                            {section.heading ||
                                                                "Untitled section"}
                                                        </p>
                                                        {aiDrafted && (
                                                            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                                                                AI-drafted per
                                                                document
                                                            </span>
                                                        )}
                                                    </div>
                                                    {!aiDrafted && (
                                                        <p className="mt-1 text-xs leading-5 text-gray-500">
                                                            {bodySnippet(
                                                                section.body_md,
                                                            )}
                                                        </p>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* Variable schema (read-only) */}
                            <div>
                                <p className="mb-2 text-xs font-medium text-gray-700">
                                    Intake variables
                                </p>
                                <TemplateVariableEditor
                                    value={schema}
                                    onChange={() => {}}
                                    readOnly
                                />
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* Footer */}
                <div className="border-t border-gray-200 px-5 py-3 flex items-center justify-between shrink-0">
                    {firmOwned ? (
                        <button
                            onClick={handleDelete}
                            disabled={deleting}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {deleting ? "Archiving…" : "Delete"}
                        </button>
                    ) : (
                        <span />
                    )}
                    <button
                        onClick={() => {
                            if (!template) return;
                            onUseTemplate(template.id);
                            onClose();
                        }}
                        disabled={loading || !template}
                        className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
                    >
                        Use template
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
