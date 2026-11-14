"use client";

import { useEffect, useMemo, useState } from "react";
import {
    Check,
    FileText,
    Loader2,
    Search,
    Sparkles,
    X,
} from "lucide-react";
import { createTemplate, generateTemplate } from "@/app/lib/cocoaLegalApi";
import type {
    DocTemplateSection,
    DocTemplateVariable,
} from "../shared/types";
import { TemplateVariableEditor } from "./TemplateVariableEditor";
import { BUILTIN_TEMPLATES, DOC_TYPE_LABELS } from "./builtinTemplates";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Called with the saved template id after Generate (and any Save). */
    onCreated: (templateId: string) => void;
    /** When set, the AI parameterizes from this uploaded sample document. */
    initialSampleDocumentId?: string;
    /** Pre-select the doc_type (e.g. when launched from a typed picker). */
    initialDocType?: string;
}

type Step = "define" | "generate" | "review";

type Generated = {
    template_id: string;
    title: string;
    skeleton: DocTemplateSection[];
    variableSchema: DocTemplateVariable[];
};

/** Local slug derivation — mirrors the firm get-or-create key on the server. */
function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
}

/** Human label for a doc_type, falling back to the raw value. */
function docTypeLabel(docType: string): string {
    return DOC_TYPE_LABELS[docType] ?? docType;
}

/** First ~160 chars of a section body, single-lined, for the preview. */
function bodySnippet(bodyMd: string | undefined): string {
    const text = (bodyMd ?? "").replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export function NewTemplateModal({
    open,
    onClose,
    onCreated,
    initialSampleDocumentId,
    initialDocType,
}: Props) {
    const [step, setStep] = useState<Step>("define");
    const [docType, setDocType] = useState<string>(
        initialDocType ?? BUILTIN_TEMPLATES[0]?.doc_type ?? "",
    );
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [jurisdiction, setJurisdiction] = useState("");
    const [useLegalResearch, setUseLegalResearch] = useState(true);

    const [generated, setGenerated] = useState<Generated | null>(null);
    const [reviewTitle, setReviewTitle] = useState("");
    const [reviewSchema, setReviewSchema] = useState<DocTemplateVariable[]>([]);
    const [edited, setEdited] = useState(false);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const stepMeta = useMemo(
        () => [
            { id: "define" as const, label: "Define" },
            { id: "generate" as const, label: "Generate" },
            { id: "review" as const, label: "Review" },
        ],
        [],
    );

    // Reset all internal state whenever the modal (re)opens.
    useEffect(() => {
        if (!open) return;
        setStep("define");
        setDocType(initialDocType ?? BUILTIN_TEMPLATES[0]?.doc_type ?? "");
        setTitle("");
        setDescription("");
        setJurisdiction("");
        setUseLegalResearch(true);
        setGenerated(null);
        setReviewTitle("");
        setReviewSchema([]);
        setEdited(false);
        setLoading(false);
        setError("");
    }, [open, initialDocType]);

    // The effective title: explicit input, else the doc_type's label.
    const effectiveTitle = title.trim() || docTypeLabel(docType);
    const canGenerate =
        docType.trim().length > 0 &&
        (description.trim().length > 0 || effectiveTitle.length > 0);

    if (!open) return null;

    function handleClose() {
        if (loading) return;
        onClose();
    }

    async function handleGenerate() {
        if (!canGenerate || loading) return;
        setLoading(true);
        setError("");
        try {
            const result = await generateTemplate({
                doc_type: docType,
                title: effectiveTitle,
                description: description.trim() || undefined,
                sample_document_id: initialSampleDocumentId,
                jurisdiction: jurisdiction.trim() || undefined,
            });
            setGenerated({
                template_id: result.template_id,
                title: result.title,
                skeleton: result.skeleton ?? [],
                variableSchema: result.variableSchema ?? [],
            });
            setReviewTitle(result.title);
            setReviewSchema(result.variableSchema ?? []);
            setEdited(false);
            setStep("review");
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not generate template.",
            );
        } finally {
            setLoading(false);
        }
    }

    // "Save changes" — persists a NEW VERSION of the template the Generate
    // step already created. The slug is ALWAYS derived from the generated
    // title (the value v1 was persisted under), never from the edited
    // `reviewTitle`: the server get-or-creates on (firm, slug), so a stable
    // slug versions the existing row instead of orphaning v1 under a new one.
    // The edited title still rides along as the display `title` (best-effort,
    // since there is no backend rename endpoint to move the slug).
    async function handleSave() {
        if (!generated || loading) return;
        setLoading(true);
        setError("");
        try {
            const saved = await createTemplate({
                slug: slugify(generated.title),
                title: reviewTitle.trim() || generated.title,
                docType,
                jurisdiction: jurisdiction.trim() || undefined,
                description: description.trim() || undefined,
                skeleton: generated.skeleton,
                variableSchema: reviewSchema,
            });
            onCreated(saved.template_id);
            onClose();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not save template changes.",
            );
        } finally {
            setLoading(false);
        }
    }

    // "Done" — the v1 from Generate is already saved; just hand it back.
    function handleDone() {
        if (!generated) return;
        onCreated(generated.template_id);
        onClose();
    }

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="flex h-[640px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex items-center justify-between px-6 pb-2 pt-5 shrink-0">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs text-gray-400">
                            <span>Templates</span>
                            <span>&gt;</span>
                            <span>Generate with AI</span>
                        </div>
                        <div className="mt-4 flex items-center gap-2">
                            {stepMeta.map((item, index) => {
                                const active = item.id === step;
                                const complete =
                                    stepMeta.findIndex((s) => s.id === step) >
                                    index;
                                return (
                                    <div
                                        key={item.id}
                                        className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                                            active
                                                ? "border-gray-900 bg-gray-900 text-white"
                                                : complete
                                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                                  : "border-gray-200 text-gray-500"
                                        }`}
                                    >
                                        {complete ? (
                                            <Check className="h-3 w-3" />
                                        ) : (
                                            <span>{index + 1}</span>
                                        )}
                                        {item.label}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    <button
                        onClick={handleClose}
                        disabled={loading}
                        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 pb-5 pt-4">
                    {step === "define" && (
                        <div className="space-y-5">
                            {initialSampleDocumentId && (
                                <div className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                                    <FileText className="h-3.5 w-3.5 shrink-0" />
                                    Parameterizing from your uploaded sample —
                                    Cocoa Legal will turn it into a reusable
                                    template.
                                </div>
                            )}

                            <div>
                                <label className="mb-2 block text-sm font-medium text-gray-500">
                                    Document type
                                </label>
                                <select
                                    value={docType}
                                    onChange={(e) => setDocType(e.target.value)}
                                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:border-gray-400 focus:outline-none"
                                >
                                    {BUILTIN_TEMPLATES.map((t) => (
                                        <option key={t.doc_type} value={t.doc_type}>
                                            {t.title}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-gray-500">
                                    Template name
                                </label>
                                <input
                                    type="text"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder={docTypeLabel(docType)}
                                    className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-gray-500">
                                    House style & notes
                                </label>
                                <textarea
                                    rows={5}
                                    value={description}
                                    onChange={(e) =>
                                        setDescription(e.target.value)
                                    }
                                    placeholder="Describe what this document is and your firm's house style, e.g. landlord-favorable commercial lease, defined-term heavy, include an arbitration clause and a confidentiality rider."
                                    className="w-full resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-6 text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-gray-500">
                                    Jurisdiction
                                </label>
                                <input
                                    type="text"
                                    value={jurisdiction}
                                    onChange={(e) =>
                                        setJurisdiction(e.target.value)
                                    }
                                    placeholder="e.g. New York, England & Wales"
                                    className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                />
                            </div>

                            <label className="flex items-center gap-2 text-sm text-gray-600">
                                <input
                                    type="checkbox"
                                    checked={useLegalResearch}
                                    onChange={(e) =>
                                        setUseLegalResearch(e.target.checked)
                                    }
                                    className="h-3.5 w-3.5 rounded border-gray-300 accent-black"
                                />
                                Use enterprise legal research while generating
                            </label>
                        </div>
                    )}

                    {step === "generate" && (
                        <div className="flex min-h-[360px] flex-col items-start justify-center">
                            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-gray-50">
                                {useLegalResearch ? (
                                    <Search className="h-5 w-5 text-gray-700" />
                                ) : (
                                    <Sparkles className="h-5 w-5 text-gray-700" />
                                )}
                            </div>
                            <h2 className="font-serif text-2xl text-gray-900">
                                Draft a reusable template
                            </h2>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-gray-500">
                                Cocoa Legal will draft the section skeleton and a
                                variable intake schema from your brief
                                {initialSampleDocumentId
                                    ? " and your uploaded sample"
                                    : ""}
                                . You can edit the schema and title before
                                committing a new version.
                            </p>
                            <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                                <p className="font-medium text-gray-800">
                                    {effectiveTitle}
                                </p>
                                {description.trim() && (
                                    <p className="mt-1">{description.trim()}</p>
                                )}
                                <p className="mt-2 text-xs text-gray-400">
                                    {docTypeLabel(docType)}
                                    {jurisdiction.trim()
                                        ? ` - ${jurisdiction.trim()}`
                                        : ""}
                                </p>
                            </div>
                        </div>
                    )}

                    {step === "review" && generated && (
                        <div className="space-y-5">
                            <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                                Saved a first version. Edit the intake schema (or
                                the display name) below and Save changes to
                                commit a new version of this same template, or
                                just click Done.
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-gray-500">
                                    Template name
                                </label>
                                <input
                                    type="text"
                                    value={reviewTitle}
                                    onChange={(e) => {
                                        setReviewTitle(e.target.value);
                                        setEdited(true);
                                    }}
                                    className="w-full rounded-md border border-gray-200 px-3 py-2 font-serif text-lg text-gray-800 placeholder-gray-300 focus:border-gray-400 focus:outline-none"
                                />
                            </div>

                            <div>
                                <p className="mb-2 text-sm font-medium text-gray-500">
                                    Section outline
                                </p>
                                {generated.skeleton.length === 0 ? (
                                    <p className="rounded-md border border-dashed border-gray-200 px-3 py-6 text-center text-sm text-gray-400">
                                        No sections were generated.
                                    </p>
                                ) : (
                                    <div className="space-y-2">
                                        {generated.skeleton.map((section) => {
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

                            <div>
                                <p className="mb-2 text-sm font-medium text-gray-500">
                                    Intake variables
                                </p>
                                <TemplateVariableEditor
                                    value={reviewSchema}
                                    onChange={(next) => {
                                        setReviewSchema(next);
                                        setEdited(true);
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {error && (
                        <p className="mt-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                            {error}
                        </p>
                    )}
                </div>

                <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 shrink-0">
                    <button
                        type="button"
                        onClick={() => {
                            if (step === "define") handleClose();
                            else if (step === "generate") setStep("define");
                            else setStep("generate");
                        }}
                        disabled={loading}
                        className="rounded-lg px-4 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-50"
                    >
                        {step === "define" ? "Cancel" : "Back"}
                    </button>

                    {step === "define" && (
                        <button
                            type="button"
                            onClick={() => setStep("generate")}
                            disabled={!canGenerate}
                            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            Continue
                        </button>
                    )}

                    {step === "generate" && (
                        <button
                            type="button"
                            onClick={handleGenerate}
                            disabled={loading || !canGenerate}
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            {loading && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {loading ? "Generating..." : "Generate template"}
                        </button>
                    )}

                    {step === "review" && generated && (
                        <div className="flex items-center gap-2">
                            {edited && (
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={loading}
                                    className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                                >
                                    {loading && (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    )}
                                    {loading ? "Saving..." : "Save changes"}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleDone}
                                disabled={loading}
                                className={`rounded-lg px-5 py-2 text-sm font-medium transition-colors disabled:opacity-40 ${
                                    edited
                                        ? "border border-gray-200 text-gray-600 hover:bg-gray-50"
                                        : "bg-gray-900 text-white hover:bg-gray-700"
                                }`}
                            >
                                Done
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
