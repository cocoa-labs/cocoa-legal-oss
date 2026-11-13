"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    AlertCircle,
    Check,
    FileText,
    Loader2,
    MessageSquare,
    Search,
    Table2,
    X,
} from "lucide-react";
import {
    createWorkflow,
    generateWorkflow,
} from "@/app/lib/cocoLegalApi";
import type {
    ColumnConfig,
    ColumnFormat,
    CocoLegalWorkflow,
} from "../shared/types";
import { FORMAT_OPTIONS, formatLabel } from "../tabular/columnFormat";
import { PRACTICE_OPTIONS } from "./practices";

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (workflow: CocoLegalWorkflow) => void;
}

type Step = "define" | "generate" | "review";

type SourceSummary = {
    title: string;
    url: string;
    provider: string;
    sourceType: string;
    confidence: number;
};

type GeneratedWorkflow = {
    prompt_md?: string;
    columns_config?: ColumnConfig[];
    summary: string;
    warnings: string[];
    sources: SourceSummary[];
};

const EMPTY_COLUMN: ColumnConfig = {
    index: 0,
    name: "",
    prompt: "",
    format: "text",
};

function normalizeColumns(columns: GeneratedWorkflow["columns_config"]) {
    return (columns?.length ? columns : [EMPTY_COLUMN]).map((column, index) => ({
        ...column,
        index,
        format: column.format ?? "text",
    }));
}

function isNonEmptyColumn(column: ColumnConfig) {
    return column.name.trim().length > 0 && column.prompt.trim().length > 0;
}

export function NewWorkflowModal({ open, onClose, onCreated }: Props) {
    const [step, setStep] = useState<Step>("define");
    const [title, setTitle] = useState("");
    const [type, setType] = useState<"assistant" | "tabular">("assistant");
    const [practice, setPractice] = useState<string>("Finance");
    const [customPractice, setCustomPractice] = useState("");
    const [goal, setGoal] = useState("");
    const [jurisdiction, setJurisdiction] = useState("");
    const [documentType, setDocumentType] = useState("");
    const [targetOutput, setTargetOutput] = useState("");
    const [useLegalResearch, setUseLegalResearch] = useState(true);
    const [generated, setGenerated] = useState<GeneratedWorkflow | null>(null);
    const [promptMd, setPromptMd] = useState("");
    const [columns, setColumns] = useState<ColumnConfig[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const customInputRef = useRef<HTMLInputElement>(null);

    const isOthers = practice === "Others";
    const effectivePractice = isOthers
        ? customPractice.trim()
        : practice.trim();
    const canDefine =
        title.trim().length > 0 &&
        goal.trim().length > 0 &&
        effectivePractice.length > 0;
    const canSave =
        type === "assistant"
            ? promptMd.trim().length > 0
            : columns.length > 0 && columns.every(isNonEmptyColumn);

    const stepMeta = useMemo(
        () => [
            { id: "define" as const, label: "Define" },
            { id: "generate" as const, label: "Generate" },
            { id: "review" as const, label: "Review & Save" },
        ],
        [],
    );

    useEffect(() => {
        if (!open) return;
        setStep("define");
        setTitle("");
        setType("assistant");
        setPractice("Finance");
        setCustomPractice("");
        setGoal("");
        setJurisdiction("");
        setDocumentType("");
        setTargetOutput("");
        setUseLegalResearch(true);
        setGenerated(null);
        setPromptMd("");
        setColumns([]);
        setLoading(false);
        setError("");
    }, [open]);

    useEffect(() => {
        if (isOthers) customInputRef.current?.focus();
    }, [isOthers]);

    if (!open) return null;

    function handleClose() {
        if (loading) return;
        onClose();
    }

    async function handleGenerate() {
        if (!canDefine || loading) return;
        setLoading(true);
        setError("");
        try {
            const result = await generateWorkflow({
                title: title.trim(),
                type,
                practice: effectivePractice,
                goal: goal.trim(),
                jurisdiction: jurisdiction.trim() || null,
                document_type: documentType.trim() || null,
                target_output: targetOutput.trim() || null,
                use_legal_research: useLegalResearch,
            });
            const next: GeneratedWorkflow = {
                ...result,
                columns_config: result.columns_config as ColumnConfig[] | undefined,
            };
            setGenerated(next);
            setPromptMd(next.prompt_md ?? "");
            setColumns(normalizeColumns(next.columns_config));
            setStep("review");
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not generate workflow.",
            );
        } finally {
            setLoading(false);
        }
    }

    async function handleSave() {
        if (!canSave || loading) return;
        setLoading(true);
        setError("");
        try {
            const workflow = await createWorkflow({
                title: title.trim(),
                type,
                practice: effectivePractice,
                prompt_md: type === "assistant" ? promptMd.trim() : undefined,
                columns_config:
                    type === "tabular"
                        ? columns.map((column, index) => ({
                              ...column,
                              index,
                              name: column.name.trim(),
                              prompt: column.prompt.trim(),
                          }))
                        : undefined,
            });
            onCreated(workflow);
            onClose();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not save workflow.",
            );
        } finally {
            setLoading(false);
        }
    }

    function updateColumn(index: number, patch: Partial<ColumnConfig>) {
        setColumns((prev) =>
            prev.map((column, i) =>
                i === index ? { ...column, ...patch } : column,
            ),
        );
    }

    function addColumn() {
        setColumns((prev) => [
            ...prev,
            { ...EMPTY_COLUMN, index: prev.length },
        ]);
    }

    function removeColumn(index: number) {
        setColumns((prev) =>
            prev.length === 1
                ? [{ ...EMPTY_COLUMN }]
                : prev
                      .filter((_, i) => i !== index)
                      .map((column, i) => ({ ...column, index: i })),
        );
    }

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div
                className="flex h-[640px] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            >
                <div className="flex items-center justify-between px-6 pb-2 pt-5 shrink-0">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs text-gray-400">
                            <span>Playbooks</span>
                            <span>&gt;</span>
                            <span>New workflow</span>
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
                            <input
                                type="text"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="Workflow name"
                                className="w-full bg-transparent font-serif text-2xl text-gray-800 placeholder-gray-300 focus:outline-none"
                                autoFocus
                            />

                            <div>
                                <p className="mb-2 text-sm font-medium text-gray-500">
                                    Type
                                </p>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setType("assistant")}
                                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                                            type === "assistant"
                                                ? "border-gray-900 bg-gray-900 text-white"
                                                : "border-gray-200 text-gray-600 hover:bg-gray-50"
                                        }`}
                                    >
                                        <MessageSquare className="h-3 w-3" />
                                        Assistant
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setType("tabular")}
                                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                                            type === "tabular"
                                                ? "border-gray-900 bg-gray-900 text-white"
                                                : "border-gray-200 text-gray-600 hover:bg-gray-50"
                                        }`}
                                    >
                                        <Table2 className="h-3 w-3" />
                                        Tabular
                                    </button>
                                </div>
                            </div>

                            <div>
                                <p className="mb-2 text-sm font-medium text-gray-500">
                                    Practice Area
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {PRACTICE_OPTIONS.map((p) => (
                                        <button
                                            key={p}
                                            type="button"
                                            onClick={() => setPractice(p)}
                                            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                                practice === p
                                                    ? "border-gray-900 bg-gray-900 text-white"
                                                    : "border-gray-200 text-gray-600 hover:bg-gray-50"
                                            }`}
                                        >
                                            {p}
                                        </button>
                                    ))}
                                </div>
                                {isOthers && (
                                    <input
                                        ref={customInputRef}
                                        type="text"
                                        value={customPractice}
                                        onChange={(e) =>
                                            setCustomPractice(e.target.value)
                                        }
                                        placeholder="Enter practice area..."
                                        className="mt-3 w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                    />
                                )}
                            </div>

                            <div>
                                <label className="mb-2 block text-sm font-medium text-gray-500">
                                    Goal / use case
                                </label>
                                <textarea
                                    rows={4}
                                    value={goal}
                                    onChange={(e) => setGoal(e.target.value)}
                                    placeholder="Describe what this workflow should do, e.g. summarize a credit agreement and flag non-market finance terms."
                                    className="w-full resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-6 text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                />
                            </div>

                            <div className="grid gap-3 md:grid-cols-3">
                                <input
                                    value={jurisdiction}
                                    onChange={(e) =>
                                        setJurisdiction(e.target.value)
                                    }
                                    placeholder="Jurisdiction"
                                    className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                />
                                <input
                                    value={documentType}
                                    onChange={(e) =>
                                        setDocumentType(e.target.value)
                                    }
                                    placeholder="Document type"
                                    className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                />
                                <input
                                    value={targetOutput}
                                    onChange={(e) =>
                                        setTargetOutput(e.target.value)
                                    }
                                    placeholder="Target output"
                                    className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
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
                                    <FileText className="h-5 w-5 text-gray-700" />
                                )}
                            </div>
                            <h2 className="font-serif text-2xl text-gray-900">
                                Generate workflow substance
                            </h2>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-gray-500">
                                Coco Legal will draft the reusable{" "}
                                {type === "assistant"
                                    ? "assistant prompt"
                                    : "tabular extraction columns"}{" "}
                                from your brief. You can edit everything before
                                saving.
                            </p>
                            <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                                <p className="font-medium text-gray-800">
                                    {title || "Untitled workflow"}
                                </p>
                                <p className="mt-1">{goal}</p>
                                <p className="mt-2 text-xs text-gray-400">
                                    {effectivePractice}
                                    {jurisdiction ? ` - ${jurisdiction}` : ""}
                                    {documentType ? ` - ${documentType}` : ""}
                                </p>
                            </div>
                        </div>
                    )}

                    {step === "review" && generated && (
                        <div className="space-y-4">
                            <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3">
                                <p className="text-sm font-medium text-emerald-900">
                                    {generated.summary}
                                </p>
                                {generated.sources.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {generated.sources.map((source) => (
                                            <a
                                                key={source.url}
                                                href={source.url}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="max-w-[220px] truncate rounded-md border border-emerald-200 bg-white px-2 py-1 text-xs text-emerald-800 hover:border-emerald-300"
                                                title={source.title}
                                            >
                                                {source.provider}:{" "}
                                                {source.title}
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {generated.warnings.length > 0 && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                                    <div className="mb-1 flex items-center gap-1.5 font-medium">
                                        <AlertCircle className="h-3.5 w-3.5" />
                                        Generation notes
                                    </div>
                                    <ul className="list-disc space-y-1 pl-4">
                                        {generated.warnings.map((warning) => (
                                            <li key={warning}>{warning}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {type === "assistant" ? (
                                <div>
                                    <label className="mb-2 block text-sm font-medium text-gray-500">
                                        Workflow Prompt
                                    </label>
                                    <textarea
                                        rows={18}
                                        value={promptMd}
                                        onChange={(e) =>
                                            setPromptMd(e.target.value)
                                        }
                                        className="w-full resize-none rounded-md border border-gray-200 px-3 py-2 font-serif text-sm leading-6 text-gray-700 focus:border-gray-400 focus:outline-none"
                                    />
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {columns.map((column, index) => (
                                        <div
                                            key={index}
                                            className="rounded-lg border border-gray-200 p-3"
                                        >
                                            <div className="flex items-start gap-2">
                                                <input
                                                    value={column.name}
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            name: e.target.value,
                                                        })
                                                    }
                                                    placeholder="Column name"
                                                    className="min-w-0 flex-1 bg-transparent font-serif text-xl text-gray-800 placeholder-gray-300 focus:outline-none"
                                                />
                                                <select
                                                    value={
                                                        column.format ?? "text"
                                                    }
                                                    onChange={(e) =>
                                                        updateColumn(index, {
                                                            format: e.target
                                                                .value as ColumnFormat,
                                                        })
                                                    }
                                                    className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-600 focus:outline-none"
                                                >
                                                    {FORMAT_OPTIONS.map(
                                                        (option) => (
                                                            <option
                                                                key={
                                                                    option.value
                                                                }
                                                                value={
                                                                    option.value
                                                                }
                                                            >
                                                                {option.label}
                                                            </option>
                                                        ),
                                                    )}
                                                </select>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        removeColumn(index)
                                                    }
                                                    className="rounded-md p-1.5 text-gray-300 hover:bg-gray-100 hover:text-red-500"
                                                >
                                                    <X className="h-4 w-4" />
                                                </button>
                                            </div>
                                            <textarea
                                                rows={4}
                                                value={column.prompt}
                                                onChange={(e) =>
                                                    updateColumn(index, {
                                                        prompt: e.target.value,
                                                    })
                                                }
                                                placeholder={`Prompt for ${formatLabel(column.format ?? "text")}`}
                                                className="mt-3 w-full resize-none rounded-md border border-gray-200 px-3 py-2 text-sm leading-6 text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                                            />
                                        </div>
                                    ))}
                                    <button
                                        type="button"
                                        onClick={addColumn}
                                        className="text-sm text-gray-500 hover:text-gray-900"
                                    >
                                        + Add column
                                    </button>
                                </div>
                            )}
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
                            else setStep(step === "review" ? "generate" : "define");
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
                            disabled={!canDefine}
                            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            Continue
                        </button>
                    )}
                    {step === "generate" && (
                        <button
                            type="button"
                            onClick={handleGenerate}
                            disabled={loading || !canDefine}
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            {loading && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {loading ? "Generating..." : "Generate workflow"}
                        </button>
                    )}
                    {step === "review" && (
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={loading || !canSave}
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            {loading && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {loading ? "Saving..." : "Save workflow"}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
