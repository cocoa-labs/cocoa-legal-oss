"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertOctagon, Check, FileText, Loader2, X } from "lucide-react";
import {
    getTemplate,
    getTemplateSchema,
    startAuthorDocument,
} from "@/app/lib/cocoLegalApi";
import { useAuthoringJob } from "@/app/hooks/useAuthoringJob";
import type {
    DocTemplateVariable,
    DraftQAFinding,
} from "../shared/types";
import { TemplatePickerModal } from "./TemplatePickerModal";
import { DynamicVariableForm } from "./DynamicVariableForm";
import { AssemblyProgressBlock } from "./AssemblyProgressBlock";
import { DraftQABlock } from "./DraftQABlock";
import { AuthoringCard } from "./AuthoringCard";
import { mapJobQaStatus, type QaStatus } from "./qaShared";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Matter scope; omit for the standalone (no-project) draft. */
    projectId?: string;
    /** Existing chat to attach the assembled doc / provenance to. */
    chatId?: string;
    /** Deep-link entry: skip the picker and start filling this template. */
    initialTemplateId?: string;
    /**
     * Fired once the document is produced (Open and Done both call it). The QA
     * fields carry the four-guardrail result so a host (e.g. the authoring
     * workspace) can render its own findings rail without re-running QA. They're
     * optional and back-compatible — callers that only want the doc handle (the
     * download-only TemplateList / InitialView entry points) can ignore them.
     */
    onDrafted?: (result: {
        documentId: string;
        versionId: string;
        filename: string;
        qaStatus?: QaStatus | null;
        qaFindings?: DraftQAFinding[];
    }) => void;
    /** Open the produced document in a viewer/workspace. */
    onOpenDocument?: (args: {
        documentId: string;
        versionId?: string;
        filename: string;
    }) => void;
}

type Step = "pick" | "fill" | "generate" | "review";

/** The terminal result captured off the assembly job's `result` payload. */
interface DraftResult {
    documentId: string;
    versionId: string;
    versionNumber?: number | null;
    downloadUrl?: string;
    filename: string;
}

const STEP_META: { id: Step; label: string }[] = [
    { id: "pick", label: "Template" },
    { id: "fill", label: "Details" },
    { id: "generate", label: "Generate" },
    { id: "review", label: "Review" },
];

/**
 * Seed the initial intake values from each variable's `default` (the variable
 * schema may carry one), so prefilled fields render populated and count toward
 * the advisory validity gate immediately.
 */
function seedDefaults(
    schema: DocTemplateVariable[],
): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const variable of schema) {
        if (variable.default !== undefined) {
            values[variable.name] = variable.default;
        }
    }
    return values;
}

/**
 * Derive the top-level jurisdiction passed to `startAuthorDocument` (and thus
 * the QA jurisdiction guardrail) from the filled values: the value of the first
 * `jurisdiction`-typed variable, when present and non-empty.
 */
function deriveJurisdiction(
    schema: DocTemplateVariable[],
    values: Record<string, unknown>,
): string | undefined {
    const field = schema.find((v) => v.type === "jurisdiction");
    if (!field) return undefined;
    const raw = values[field.name];
    const str = typeof raw === "string" ? raw.trim() : "";
    return str.length > 0 ? str : undefined;
}

/**
 * The drafting wizard: pick a template → fill its variables → assemble the
 * document → review the result + QA. Chrome and stepper mirror NewWorkflowModal.
 * Assembly runs as a detached background job: the Generate step calls
 * `startAuthorDocument` to stage the job, then drives progress (assembling → qa)
 * and the terminal result off `useAuthoringJob(jobId)` polling — no SSE. The
 * wizard submit IS the approval (no gate).
 */
export function NewDraftModal({
    open,
    onClose,
    projectId,
    chatId,
    initialTemplateId,
    onDrafted,
    onOpenDocument,
}: Props) {
    const [step, setStep] = useState<Step>("pick");
    const [templateId, setTemplateId] = useState<string | null>(null);
    const [templateTitle, setTemplateTitle] = useState<string>("");

    // Intake schema + values.
    const [schema, setSchema] = useState<DocTemplateVariable[]>([]);
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [schemaLoading, setSchemaLoading] = useState(false);
    const [formValid, setFormValid] = useState(false);

    // Assembly job / result state. The Generate step stages a background job
    // and stores its id here; useAuthoringJob(jobId) polls it to completion.
    const [jobId, setJobId] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);
    const [result, setResult] = useState<DraftResult | null>(null);
    const [qaFindings, setQaFindings] = useState<DraftQAFinding[]>([]);
    const [qaStatus, setQaStatus] = useState<QaStatus | null>(null);
    const [error, setError] = useState("");

    // The template id whose schema is currently loaded into `schema`/`values`.
    // Guards the fetch effect so navigating Back from generate/review doesn't
    // refetch + reseed (which would wipe the user's filled-in values).
    const loadedSchemaForRef = useRef<string | null>(null);

    const { job, error: jobPollError } = useAuthoringJob(jobId);

    const stepMeta = useMemo(() => STEP_META, []);

    // Reset everything whenever the modal is toggled. Dropping `jobId` to null
    // tears down any in-flight poll (useAuthoringJob stops on a null id). When
    // deep-linked to a template, skip straight to the fill step.
    useEffect(() => {
        loadedSchemaForRef.current = null;
        if (!open) {
            setStep("pick");
            setTemplateId(null);
            setTemplateTitle("");
            setSchema([]);
            setValues({});
            setSchemaLoading(false);
            setFormValid(false);
            setJobId(null);
            setStarting(false);
            setResult(null);
            setQaFindings([]);
            setQaStatus(null);
            setError("");
            return;
        }
        if (initialTemplateId) {
            setTemplateId(initialTemplateId);
            setStep("fill");
        } else {
            setTemplateId(null);
            setStep("pick");
        }
        setSchema([]);
        setValues({});
        setFormValid(false);
        setJobId(null);
        setStarting(false);
        setResult(null);
        setQaFindings([]);
        setQaStatus(null);
        setError("");
    }, [open, initialTemplateId]);

    // Load the schema (+ title) once per chosen template. Keyed off
    // `templateId` (not `step`) and guarded by `loadedSchemaForRef` so coming
    // Back to the fill step from generate/review keeps the user's inputs rather
    // than refetching and reseeding from defaults.
    useEffect(() => {
        if (!open || !templateId) return;
        if (loadedSchemaForRef.current === templateId) return;
        let cancelled = false;
        setSchemaLoading(true);
        setError("");
        Promise.all([getTemplateSchema(templateId), getTemplate(templateId)])
            .then(([schemaRes, templateRes]) => {
                if (cancelled) return;
                const vars = schemaRes.variableSchema ?? [];
                setSchema(vars);
                setValues(seedDefaults(vars));
                setTemplateTitle(templateRes.template.title);
                loadedSchemaForRef.current = templateId;
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
                if (!cancelled) setSchemaLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, templateId]);

    // React to the polled assembly job: on `ready`, capture the result + QA and
    // advance to Review; on `failed`/`stalled`, surface an error so the Generate
    // step never hangs on a spinner. Guarded by `open` + a matching `job_id`.
    // Must stay above the `!open` early return: a hook after a conditional
    // return changes the hook count between renders and crashes the component.
    useEffect(() => {
        if (!open || !job || job.job_id !== jobId) return;
        if (job.status === "ready" && job.result) {
            setResult({
                documentId: job.result.document_id,
                versionId: job.result.version_id,
                downloadUrl: job.result.download_url || undefined,
                filename: job.result.filename || "Document",
            });
            setQaFindings(job.qa_findings ?? []);
            setQaStatus(mapJobQaStatus(job.qa_status) ?? "passed");
            setError("");
            setStep("review");
        } else if (job.status === "failed") {
            setError(job.error || "The document could not be assembled.");
        } else if (job.stalled) {
            setError(
                job.error ||
                    "Assembly is taking longer than expected and may have stalled. Please try again.",
            );
        }
    }, [open, job, jobId]);

    if (!open) return null;

    function handleClose() {
        // Drop the job id so any in-flight poll is torn down immediately; the
        // open-toggle effect does the full reset once `open` flips false.
        setJobId(null);
        onClose();
    }

    function handlePick(picked: string) {
        // New template id → the fetch effect (guarded by loadedSchemaForRef)
        // reloads the schema and reseeds defaults for it.
        setTemplateId(picked);
        setFormValid(false);
        setStep("fill");
    }

    /**
     * Stage the background assembly job and switch to the Generate step. The
     * heavy work runs detached; `useAuthoringJob(jobId)` then polls it, and the
     * job-watch effect above captures the terminal result / surfaces failures.
     */
    async function handleGenerate() {
        if (!templateId || starting) return;

        setStep("generate");
        setStarting(true);
        setError("");
        setJobId(null);
        setResult(null);
        setQaFindings([]);
        setQaStatus(null);

        const jurisdiction = deriveJurisdiction(schema, values);

        try {
            const { job_id } = await startAuthorDocument({
                templateId,
                variables: values,
                jurisdiction,
                projectId,
                chat_id: chatId,
            });
            setJobId(job_id);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "The document could not be assembled.",
            );
        } finally {
            setStarting(false);
        }
    }

    function finishWith(alsoOpen: boolean) {
        // alsoOpen → also route into the document viewer.
        if (result) {
            if (alsoOpen) {
                onOpenDocument?.({
                    documentId: result.documentId,
                    versionId: result.versionId,
                    filename: result.filename,
                });
            }
            onDrafted?.({
                documentId: result.documentId,
                versionId: result.versionId,
                filename: result.filename,
                qaStatus,
                qaFindings,
            });
        }
        handleClose();
    }

    const blocked = qaStatus === "blocked";

    // Generate-step phase, derived from the polled job. While `qa` is running
    // we swap the spinner label to "Running checks…"; otherwise "Assembling…".
    // `generateError` is any kickoff/failed/stalled error — or a hard poll
    // failure — shown on the Generate step so it presents a retry instead of an
    // endless spinner.
    const generateError =
        step === "generate" ? error || jobPollError || "" : "";
    const inQaPhase = !generateError && job?.status === "qa";
    const progressLabel = inQaPhase
        ? "Running checks…"
        : "Assembling document…";

    // Step 1 — the picker is a full modal with its own overlay/chrome, so it
    // replaces the wizard shell (rather than nesting inside it). Picking a
    // template advances to the fill step, which renders the shell below.
    if (step === "pick") {
        return (
            <TemplatePickerModal
                open
                onClose={handleClose}
                onPick={handlePick}
            />
        );
    }

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div className="flex h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex items-center justify-between px-6 pb-2 pt-5 shrink-0">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs text-gray-400">
                            <span>Authoring</span>
                            <span>&gt;</span>
                            <span>Draft a document</span>
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
                        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 pb-5 pt-4">
                    {/* Step 2 — Fill the template's variables. */}
                    {step === "fill" && (
                        <div className="space-y-5">
                            <div>
                                <h2 className="font-serif text-2xl text-gray-900">
                                    {templateTitle || "Fill in the details"}
                                </h2>
                                <p className="mt-1 text-sm text-gray-500">
                                    Provide the values Quill will use to
                                    assemble your draft.
                                </p>
                            </div>
                            {schemaLoading ? (
                                <div className="flex h-48 items-center justify-center text-gray-400">
                                    <Loader2 className="h-5 w-5 animate-spin" />
                                </div>
                            ) : schema.length === 0 ? (
                                <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                                    This template has no fillable fields — you
                                    can generate it directly.
                                </p>
                            ) : (
                                <DynamicVariableForm
                                    schema={schema}
                                    values={values}
                                    onChange={setValues}
                                    onValidityChange={setFormValid}
                                />
                            )}
                        </div>
                    )}

                    {/* Step 3 — Background assembly progress (polled), or a
                        failed/stalled error with a retry. */}
                    {step === "generate" && (
                        <div className="flex min-h-[360px] flex-col items-start justify-center">
                            <div
                                className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl border ${
                                    generateError
                                        ? "border-red-200 bg-red-50"
                                        : "border-gray-200 bg-gray-50"
                                }`}
                            >
                                {generateError ? (
                                    <AlertOctagon className="h-5 w-5 text-red-600" />
                                ) : (
                                    <FileText className="h-5 w-5 text-gray-700" />
                                )}
                            </div>
                            {generateError ? (
                                <>
                                    <h2 className="font-serif text-2xl text-gray-900">
                                        Assembly didn&rsquo;t finish
                                    </h2>
                                    <p className="mt-2 max-w-xl text-sm leading-6 text-red-600">
                                        {generateError}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={handleGenerate}
                                        disabled={starting}
                                        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                                    >
                                        {starting && (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        )}
                                        Try again
                                    </button>
                                </>
                            ) : (
                                <>
                                    <h2 className="font-serif text-2xl text-gray-900">
                                        Assembling your draft
                                    </h2>
                                    <p className="mt-2 max-w-xl text-sm leading-6 text-gray-500">
                                        Quill is assembling{" "}
                                        {templateTitle || "your document"} from
                                        the template and running the
                                        four-guardrail QA pass.
                                    </p>
                                    <div className="mt-5">
                                        <AssemblyProgressBlock
                                            isStreaming
                                            label={progressLabel}
                                        />
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* Step 4 — Review the produced document + QA. */}
                    {step === "review" && result && (
                        <div className="space-y-4">
                            {blocked && (
                                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                    <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" />
                                    <div>
                                        <p className="font-medium">
                                            This draft has blocking issues.
                                        </p>
                                        <p className="mt-0.5 text-xs leading-5 text-red-600">
                                            QA flagged a material deviation.
                                            Review the findings below before
                                            sending or relying on this draft.
                                        </p>
                                    </div>
                                </div>
                            )}
                            <AuthoringCard
                                documentId={result.documentId}
                                filename={result.filename}
                                versionId={result.versionId}
                                versionNumber={
                                    result.versionNumber ?? undefined
                                }
                                downloadUrl={result.downloadUrl}
                                qaStatus={qaStatus ?? undefined}
                                qaFindings={qaFindings}
                                onOpen={
                                    onOpenDocument
                                        ? (args) => onOpenDocument(args)
                                        : undefined
                                }
                            />
                            {qaStatus && (
                                <DraftQABlock
                                    findings={qaFindings}
                                    status={qaStatus}
                                />
                            )}
                        </div>
                    )}

                    {error && step !== "generate" && (
                        <p className="mt-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
                            {error}
                        </p>
                    )}
                </div>

                <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4 shrink-0">
                    <button
                        type="button"
                        onClick={() => {
                            if (step === "fill") {
                                // Back to the picker unless deep-linked.
                                if (initialTemplateId) handleClose();
                                else setStep("pick");
                            } else if (step === "generate") {
                                // Abandon the in-flight job (poll tears down)
                                // and return to the fill step to re-edit.
                                setJobId(null);
                                setError("");
                                setStep("fill");
                            } else if (step === "review") {
                                finishWith(false);
                            }
                        }}
                        className="rounded-lg px-4 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100"
                    >
                        {step === "fill"
                            ? initialTemplateId
                                ? "Cancel"
                                : "Back"
                            : step === "generate"
                              ? "Cancel"
                              : "Done"}
                    </button>

                    {step === "fill" && (
                        <button
                            type="button"
                            onClick={handleGenerate}
                            disabled={
                                schemaLoading ||
                                (schema.length > 0 && !formValid)
                            }
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            Generate
                        </button>
                    )}
                    {step === "generate" && !generateError && (
                        <button
                            type="button"
                            disabled
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white opacity-60"
                        >
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {inQaPhase ? "Running checks…" : "Assembling…"}
                        </button>
                    )}
                    {step === "review" && (
                        <button
                            type="button"
                            onClick={() => finishWith(true)}
                            disabled={!onOpenDocument}
                            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                        >
                            Open document
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
