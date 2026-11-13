"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
    Check,
    ChevronLeft,
    FileSpreadsheet,
    Loader2,
    Upload,
    X,
} from "lucide-react";
import {
    importCasesCsv,
    type CsvImportDryRunOut,
    type CsvImportExecuteOut,
    type CsvImportRowError,
} from "@/app/lib/cocoLegalApi";
import { formatDateOnly } from "./piShared";

type WizardStep = "file" | "mapping" | "preview" | "results";

/** The case fields with a dedicated pi_cases column (csvImport.ts). */
const MAPPABLE_FIELDS: {
    key: string;
    label: string;
    required: boolean;
    hint: string;
}[] = [
    {
        key: "case_number",
        label: "Case number",
        required: true,
        hint: "The import upserts on it — re-imports update, never duplicate",
    },
    {
        key: "client_name",
        label: "Client name",
        required: true,
        hint: "Required to create a new case",
    },
    {
        key: "date_of_loss",
        label: "Date of loss",
        required: false,
        hint: "MM/DD/YYYY or YYYY-MM-DD",
    },
    {
        key: "status",
        label: "Status",
        required: false,
        hint: "open, settled, closed or provisional",
    },
];

/**
 * Parse the FIRST CSV record (the header row) for the mapping pickers only —
 * quoted fields, "" escapes, commas inside quotes, BOM. The server re-parses
 * the whole file authoritatively; this exists purely to populate dropdowns.
 */
function parseCsvHeader(text: string): string[] {
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const headers: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 1;
                    continue;
                }
                inQuotes = false;
                continue;
            }
            field += ch;
            continue;
        }
        if (ch === '"' && field === "") {
            inQuotes = true;
            continue;
        }
        if (ch === ",") {
            headers.push(field);
            field = "";
            continue;
        }
        if (ch === "\n" || ch === "\r") break;
        field += ch;
    }
    headers.push(field);
    return headers.map((h) => h.trim()).filter((h) => h.length > 0);
}

/** Best-effort initial mapping guess by normalized header name. */
function guessMapping(headers: string[]): Record<string, string> {
    const normalized = headers.map((h) =>
        h.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
    const findHeader = (candidates: string[]): string => {
        for (const candidate of candidates) {
            const index = normalized.indexOf(candidate);
            if (index >= 0) return headers[index];
        }
        return "";
    };
    return {
        case_number: findHeader(["casenumber", "caseno", "case", "matternumber"]),
        client_name: findHeader(["clientname", "client", "claimant", "name"]),
        date_of_loss: findHeader(["dateofloss", "dol", "lossdate", "incidentdate"]),
        status: findHeader(["status", "casestatus"]),
    };
}

function RowErrorsTable({ errors }: { errors: CsvImportRowError[] }) {
    if (errors.length === 0) return null;
    return (
        <div className="overflow-x-auto rounded-lg border border-red-200">
            <table className="w-full text-left text-xs">
                <thead>
                    <tr className="border-b border-red-200 bg-red-50 text-red-800">
                        <th className="px-3 py-2 font-semibold">Row</th>
                        <th className="px-3 py-2 font-semibold">Problem</th>
                    </tr>
                </thead>
                <tbody>
                    {errors.map((e) => (
                        <tr
                            key={e.rowIndex}
                            className="border-b border-red-100 last:border-b-0"
                        >
                            <td className="px-3 py-2 align-top text-[var(--app-text-muted)]">
                                {e.rowIndex}
                            </td>
                            <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                {e.detail}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function SummaryChip({ label, value }: { label: string; value: number }) {
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-text-muted)]">
            {label}
            <span className="font-semibold text-[var(--app-text-strong)]">
                {value}
            </span>
        </span>
    );
}

/**
 * CasePeer CSV import wizard: file pick → column mapping → dry-run preview →
 * import results. The mapping step surfaces header/mapping-level 400
 * `{ detail }` failures inline (both the dry-run and the execute reject with
 * them before anything is written); row-level problems come back inside a 200
 * and render as tables on the preview/results steps. Re-importing the same
 * file is safe — the server upserts on case number, so re-runs report
 * "updated", never duplicates.
 */
export function CsvImportWizard({
    onClose,
    onImported,
}: {
    onClose: () => void;
    /** Called after a successful execute so the cases list can reload. */
    onImported: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [step, setStep] = useState<WizardStep>("file");
    const [file, setFile] = useState<File | null>(null);
    const [headers, setHeaders] = useState<string[]>([]);
    const [mapping, setMapping] = useState<Record<string, string>>({});
    const [fileError, setFileError] = useState<string | null>(null);
    const [mappingError, setMappingError] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [dryRun, setDryRun] = useState<CsvImportDryRunOut | null>(null);
    const [result, setResult] = useState<CsvImportExecuteOut | null>(null);

    const handlePickFile = useCallback(async (picked: File) => {
        setFileError(null);
        try {
            const text = await picked.text();
            const parsed = parseCsvHeader(text);
            if (parsed.length === 0) {
                setFileError(
                    "That file has no header row — the first line must name the columns.",
                );
                return;
            }
            setFile(picked);
            setHeaders(parsed);
            setMapping(guessMapping(parsed));
            setMappingError(null);
            setDryRun(null);
            setStep("mapping");
        } catch {
            setFileError("Could not read that file.");
        }
    }, []);

    /** Only mapped (non-blank) fields go to the server. */
    const effectiveMapping = useMemo(() => {
        const out: Record<string, string> = {};
        for (const [field, header] of Object.entries(mapping)) {
            if (header.trim()) out[field] = header;
        }
        return out;
    }, [mapping]);

    const requiredMapped = MAPPABLE_FIELDS.filter((f) => f.required).every(
        (f) => Boolean(effectiveMapping[f.key]),
    );

    const runPreview = useCallback(async () => {
        if (!file || busy) return;
        setBusy(true);
        setMappingError(null);
        try {
            const res = await importCasesCsv(file, effectiveMapping, true);
            setDryRun(res);
            setPreviewError(null);
            setStep("preview");
        } catch (err) {
            // Header/mapping-level 400 { detail } — belongs on this screen.
            setMappingError(
                err instanceof Error
                    ? err.message
                    : "Could not check this import.",
            );
        } finally {
            setBusy(false);
        }
    }, [file, busy, effectiveMapping]);

    const runImport = useCallback(async () => {
        if (!file || busy) return;
        setBusy(true);
        setPreviewError(null);
        try {
            const res = await importCasesCsv(file, effectiveMapping, false);
            setResult(res);
            setStep("results");
            onImported();
        } catch (err) {
            setPreviewError(
                err instanceof Error
                    ? err.message
                    : "Could not import these cases.",
            );
        } finally {
            setBusy(false);
        }
    }, [file, busy, effectiveMapping, onImported]);

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
            <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 ring-1 ring-sky-200">
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                </div>
                <span className="text-sm font-semibold text-[var(--app-text-strong)]">
                    Import cases from CSV
                </span>
                <span className="text-[11px] text-[var(--app-text-subtle)]">
                    {step === "file" && "Step 1 of 4 · Choose a file"}
                    {step === "mapping" && "Step 2 of 4 · Map columns"}
                    {step === "preview" && "Step 3 of 4 · Preview"}
                    {step === "results" && "Step 4 of 4 · Results"}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    title="Close import"
                    className="ml-auto flex h-6 w-6 items-center justify-center rounded text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-strong)]"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {step === "file" && (
                <div className="mt-3">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={(e) => {
                            const picked = e.target.files?.[0];
                            if (picked) void handlePickFile(picked);
                            e.target.value = "";
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-6 py-8 text-center transition-colors hover:bg-[var(--app-hover)]"
                    >
                        <Upload className="h-5 w-5 text-[var(--app-text-subtle)]" />
                        <span className="text-sm font-medium text-[var(--app-text-muted)]">
                            Choose a CasePeer CSV export
                        </span>
                        <span className="max-w-sm text-xs text-[var(--app-text-subtle)]">
                            The first row must be a header. Re-importing the
                            same file updates existing cases by case number —
                            it never creates duplicates.
                        </span>
                    </button>
                    {fileError && (
                        <p className="mt-2 text-xs text-red-600">{fileError}</p>
                    )}
                </div>
            )}

            {step === "mapping" && (
                <div className="mt-3">
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        {file?.name} · match each case field to a CSV column.
                        Fields left unmapped are skipped.
                    </p>
                    <div className="mt-3 space-y-2.5">
                        {MAPPABLE_FIELDS.map((f) => (
                            <div key={f.key} className="flex items-center gap-3">
                                <label
                                    htmlFor={`pi-import-map-${f.key}`}
                                    className="w-32 shrink-0 text-xs font-medium text-[var(--app-text-muted)]"
                                >
                                    {f.label}
                                    {f.required && (
                                        <span className="ml-0.5 text-red-600">
                                            *
                                        </span>
                                    )}
                                </label>
                                <select
                                    id={`pi-import-map-${f.key}`}
                                    value={mapping[f.key] ?? ""}
                                    onChange={(e) =>
                                        setMapping((prev) => ({
                                            ...prev,
                                            [f.key]: e.target.value,
                                        }))
                                    }
                                    className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs text-[var(--app-text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                                >
                                    <option value="">Not mapped</option>
                                    {headers.map((h) => (
                                        <option key={h} value={h}>
                                            {h}
                                        </option>
                                    ))}
                                </select>
                                <span className="hidden w-56 shrink-0 text-[11px] text-[var(--app-text-subtle)] md:block">
                                    {f.hint}
                                </span>
                            </div>
                        ))}
                    </div>

                    {mappingError && (
                        <p className="mt-3 text-xs text-red-600">
                            {mappingError}
                        </p>
                    )}

                    <div className="mt-4 flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setStep("file")}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                        >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            Back
                        </button>
                        <button
                            type="button"
                            onClick={() => void runPreview()}
                            disabled={busy || !requiredMapped}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {busy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Check className="h-3.5 w-3.5" />
                            )}
                            {busy ? "Checking…" : "Preview import"}
                        </button>
                        {!requiredMapped && (
                            <span className="text-[11px] text-[var(--app-text-subtle)]">
                                Map case number and client name to continue.
                            </span>
                        )}
                    </div>
                </div>
            )}

            {step === "preview" && dryRun && (
                <div className="mt-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <SummaryChip
                            label="Data rows"
                            value={dryRun.summary.total_rows}
                        />
                        <SummaryChip
                            label="Will import"
                            value={dryRun.summary.planned}
                        />
                        <SummaryChip
                            label="Invalid"
                            value={dryRun.summary.invalid}
                        />
                    </div>
                    <p className="mt-2 text-[11px] text-[var(--app-text-subtle)]">
                        Rows matching an existing case number update that case;
                        the rest create new ones. Invalid rows are skipped —
                        the rest of the file still imports.
                    </p>

                    {dryRun.plans.length > 0 && (
                        <div className="mt-3 max-h-64 overflow-x-auto overflow-y-auto rounded-lg border border-[var(--app-border)]">
                            <table className="w-full text-left text-xs">
                                <thead>
                                    <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-strong)] text-[var(--app-text-subtle)]">
                                        <th className="px-3 py-2 font-semibold">
                                            Row
                                        </th>
                                        <th className="px-3 py-2 font-semibold">
                                            Case #
                                        </th>
                                        <th className="px-3 py-2 font-semibold">
                                            Client
                                        </th>
                                        <th className="px-3 py-2 font-semibold">
                                            Date of loss
                                        </th>
                                        <th className="px-3 py-2 font-semibold">
                                            Status
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {dryRun.plans.map((plan) => (
                                        <tr
                                            key={plan.rowIndex}
                                            className="border-b border-[var(--app-border)] last:border-b-0"
                                        >
                                            <td className="px-3 py-2 text-[var(--app-text-subtle)]">
                                                {plan.rowIndex}
                                            </td>
                                            <td className="px-3 py-2 font-medium text-[var(--app-text-strong)]">
                                                {plan.row.caseNumber}
                                            </td>
                                            <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                                {plan.row.clientName ?? "—"}
                                            </td>
                                            <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                                {formatDateOnly(
                                                    plan.row.dateOfLoss,
                                                )}
                                            </td>
                                            <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                                {plan.row.status ?? "—"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {dryRun.errors.length > 0 && (
                        <div className="mt-3">
                            <RowErrorsTable errors={dryRun.errors} />
                        </div>
                    )}

                    {previewError && (
                        <p className="mt-3 text-xs text-red-600">
                            {previewError}
                        </p>
                    )}

                    <div className="mt-4 flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setStep("mapping")}
                            disabled={busy}
                            className="inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                        >
                            <ChevronLeft className="h-3.5 w-3.5" />
                            Back to mapping
                        </button>
                        <button
                            type="button"
                            onClick={() => void runImport()}
                            disabled={busy || dryRun.plans.length === 0}
                            className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                        >
                            {busy ? (
                                <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Importing…
                                </>
                            ) : (
                                <>
                                    <Upload className="h-3.5 w-3.5" />
                                    Import {dryRun.plans.length} row
                                    {dryRun.plans.length === 1 ? "" : "s"}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}

            {step === "results" && result && (
                <div className="mt-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-[11px] font-medium text-green-800">
                            <Check className="h-3 w-3" />
                            Created {result.created}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 text-[11px] font-medium text-blue-800">
                            Updated {result.updated}
                        </span>
                        <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                                result.skipped > 0
                                    ? "bg-red-100 text-red-700"
                                    : "bg-gray-100 text-gray-600"
                            }`}
                        >
                            Skipped {result.skipped}
                        </span>
                    </div>

                    {result.errors.length > 0 && (
                        <div className="mt-3">
                            <RowErrorsTable errors={result.errors} />
                        </div>
                    )}

                    <div className="mt-4">
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
