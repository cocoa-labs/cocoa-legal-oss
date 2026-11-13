"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    Briefcase,
    Check,
    ChevronRight,
    FileText,
    Loader2,
    Paperclip,
    Zap,
} from "lucide-react";
import {
    getCase,
    getDocumentUrl,
    updateCase,
    PI_CASE_STATUSES,
    type PiCaseDetailOut,
    type PiCasePolicy,
    type PiCaseStatus,
} from "@/app/lib/cocoLegalApi";
import {
    caseOriginLabel,
    caseStatusBadge,
    formatDateOnly,
    formatWhen,
    runStatusBadge,
    workflowKindLabel,
} from "./piShared";
import { ExpenseLedger } from "./ExpenseLedger";

function SectionHeading({ label, count }: { label: string; count?: number }) {
    return (
        <div className="px-1 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
            {label}
            {count !== undefined && (
                <span className="ml-1.5 font-normal text-[var(--app-text-subtle)]">
                    {count}
                </span>
            )}
        </div>
    );
}

function adjusterText(policy: PiCasePolicy): string {
    const adjuster = policy.adjuster ?? {};
    const parts = [adjuster.name, adjuster.email, adjuster.phone].filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    return parts.length > 0 ? parts.join(" · ") : "—";
}

function policyLimitsText(policy: PiCasePolicy): string {
    const raw = (policy.policy_limits as { raw_text?: unknown })?.raw_text;
    return typeof raw === "string" && raw.trim() ? raw : "—";
}

/**
 * Full case view: overview (status editable, needs-review confirmation),
 * policies, the expenses ledger, filed documents, and the case's automation
 * history linking into the queue. Owns its fetching (getCase) like the other
 * detail panels; row-level mutations patch the local snapshot in place.
 */
export function CaseDetailPanel({ caseId }: { caseId: string }) {
    const router = useRouter();
    const [data, setData] = useState<PiCaseDetailOut | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [patchError, setPatchError] = useState<string | null>(null);
    const [savingStatus, setSavingStatus] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [openingId, setOpeningId] = useState<string | null>(null);

    const load = useCallback(
        () =>
            getCase(caseId)
                .then((res) => {
                    setData(res);
                    setError(null);
                })
                .catch((err: unknown) => {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Could not load this case.",
                    );
                }),
        [caseId],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const changeStatus = useCallback(
        async (status: PiCaseStatus) => {
            if (!data || savingStatus) return;
            setSavingStatus(true);
            setPatchError(null);
            try {
                const updated = await updateCase(data.case.id, { status });
                setData((prev) =>
                    prev ? { ...prev, case: updated } : prev,
                );
            } catch (err) {
                setPatchError(
                    err instanceof Error
                        ? err.message
                        : "Could not update the status.",
                );
            } finally {
                setSavingStatus(false);
            }
        },
        [data, savingStatus],
    );

    const confirmCase = useCallback(async () => {
        if (!data || confirming) return;
        setConfirming(true);
        setPatchError(null);
        try {
            const updated = await updateCase(data.case.id, {
                needs_review: false,
            });
            setData((prev) => (prev ? { ...prev, case: updated } : prev));
        } catch (err) {
            setPatchError(
                err instanceof Error
                    ? err.message
                    : "Could not confirm this case.",
            );
        } finally {
            setConfirming(false);
        }
    }, [data, confirming]);

    // Open a document in a new tab via a fresh signed URL (inbox flow).
    const openDocument = useCallback(async (documentId: string) => {
        setOpeningId(documentId);
        try {
            const { url } = await getDocumentUrl(documentId, null);
            window.open(url, "_blank", "noopener,noreferrer");
        } catch {
            setPatchError("Could not open that document.");
        } finally {
            setOpeningId(null);
        }
    }, []);

    if (error) {
        return <p className="px-1 py-6 text-sm text-red-600">{error}</p>;
    }
    if (!data) {
        return (
            <div className="space-y-2 px-1 py-2">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-24 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                    />
                ))}
            </div>
        );
    }

    const piCase = data.case;

    return (
        <div className="flex h-full w-full flex-col font-sans">
            {/* Header */}
            <div className="flex items-start gap-2.5 px-1 pb-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-800 ring-1 ring-sky-200">
                    <Briefcase className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-base font-semibold text-[var(--app-text-strong)]">
                        {piCase.client_name}
                    </h1>
                    <p className="truncate text-xs text-[var(--app-text-subtle)]">
                        {piCase.case_number || "No case number"} · DOL{" "}
                        {formatDateOnly(piCase.date_of_loss)}
                    </p>
                </div>
                <label className="sr-only" htmlFor="pi-case-status">
                    Case status
                </label>
                <div className="flex shrink-0 items-center gap-1.5">
                    {savingStatus && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--app-text-subtle)]" />
                    )}
                    <select
                        id="pi-case-status"
                        value={piCase.status}
                        disabled={savingStatus}
                        onChange={(e) =>
                            void changeStatus(e.target.value as PiCaseStatus)
                        }
                        className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-60"
                    >
                        {PI_CASE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {caseStatusBadge(s).label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {patchError && (
                <p className="px-1 pb-2 text-xs text-red-600">{patchError}</p>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto pb-4">
                {/* Overview */}
                <div className="mx-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span
                            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${caseStatusBadge(piCase.status).cls}`}
                        >
                            {caseStatusBadge(piCase.status).label}
                        </span>
                        <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-text-muted)]">
                            {caseOriginLabel(piCase.origin)}
                        </span>
                        <span className="text-[11px] text-[var(--app-text-subtle)]">
                            Created {formatWhen(piCase.created_at)}
                        </span>
                    </div>
                    {piCase.needs_review && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700" />
                            <span className="min-w-0 flex-1 text-xs text-amber-900">
                                This case was created automatically and needs a
                                human to confirm it.
                            </span>
                            <button
                                type="button"
                                onClick={() => void confirmCase()}
                                disabled={confirming}
                                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-60"
                            >
                                {confirming ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Check className="h-3.5 w-3.5" />
                                )}
                                Confirm case
                            </button>
                        </div>
                    )}
                </div>

                {/* Policies */}
                <SectionHeading
                    label="Policies"
                    count={data.policies.length}
                />
                {data.policies.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                        No insurance policies on file yet.
                    </p>
                ) : (
                    <div className="mx-1 overflow-x-auto rounded-lg border border-[var(--app-border)]">
                        <table className="w-full text-left text-xs">
                            <thead>
                                <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-strong)] text-[var(--app-text-subtle)]">
                                    <th className="px-3 py-2 font-semibold">
                                        Carrier
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Claim #
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Policy #
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Coverage
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Limits
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Adjuster
                                    </th>
                                    <th className="px-3 py-2 font-semibold">
                                        Source
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="bg-[var(--app-panel)]">
                                {data.policies.map((policy) => (
                                    <tr
                                        key={policy.id}
                                        className="border-b border-[var(--app-border)] last:border-b-0"
                                    >
                                        <td className="px-3 py-2 font-medium text-[var(--app-text-strong)]">
                                            {policy.carrier}
                                        </td>
                                        <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                            {policy.claim_number || "—"}
                                        </td>
                                        <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                            {policy.policy_number || "—"}
                                        </td>
                                        <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                            {policy.coverage_type || "—"}
                                        </td>
                                        <td className="max-w-[200px] px-3 py-2 text-[var(--app-text-muted)]">
                                            <span className="line-clamp-2">
                                                {policyLimitsText(policy)}
                                            </span>
                                        </td>
                                        <td className="px-3 py-2 text-[var(--app-text-muted)]">
                                            {adjusterText(policy)}
                                        </td>
                                        <td className="px-3 py-2">
                                            {policy.source_document_id ? (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        void openDocument(
                                                            policy.source_document_id as string,
                                                        )
                                                    }
                                                    disabled={
                                                        openingId ===
                                                        policy.source_document_id
                                                    }
                                                    title="Open the source document"
                                                    className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                                                >
                                                    {openingId ===
                                                    policy.source_document_id ? (
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                    ) : (
                                                        <Paperclip className="h-3 w-3 text-amber-600" />
                                                    )}
                                                    Document
                                                </button>
                                            ) : (
                                                <span className="text-[var(--app-text-subtle)]">
                                                    —
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* Expenses */}
                <SectionHeading
                    label="Expenses"
                    count={data.expenses.length}
                />
                <div className="mx-1">
                    <ExpenseLedger
                        caseId={piCase.id}
                        expenses={data.expenses}
                        onChange={(updated) =>
                            setData((prev) =>
                                prev
                                    ? {
                                          ...prev,
                                          expenses: prev.expenses.map((e) =>
                                              e.id === updated.id
                                                  ? updated
                                                  : e,
                                          ),
                                      }
                                    : prev,
                            )
                        }
                    />
                </div>

                {/* Documents */}
                <SectionHeading
                    label="Documents"
                    count={data.documents.length}
                />
                {data.documents.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                        No documents filed to this case yet.
                    </p>
                ) : (
                    <ul className="mx-1 space-y-2">
                        {data.documents.map((doc) => (
                            <li key={doc.id}>
                                <button
                                    type="button"
                                    onClick={() => void openDocument(doc.id)}
                                    disabled={openingId === doc.id}
                                    className="flex w-full items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-left transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                                >
                                    {openingId === doc.id ? (
                                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--app-text-subtle)]" />
                                    ) : (
                                        <FileText className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                                    )}
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--app-text-strong)]">
                                        {doc.filename}
                                    </span>
                                    <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">
                                        {formatWhen(doc.created_at)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {/* Automation history */}
                <SectionHeading
                    label="Automation history"
                    count={data.runs.length}
                />
                {data.runs.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                        No automation runs have touched this case.
                    </p>
                ) : (
                    <ul className="mx-1 space-y-2">
                        {data.runs.map((run) => {
                            const badge = runStatusBadge(run.status);
                            return (
                                <li key={run.id}>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            router.push(
                                                `/automation/${run.id}`,
                                            )
                                        }
                                        className="flex w-full items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-left transition-colors hover:bg-[var(--app-hover)]"
                                    >
                                        <Zap className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--app-text-strong)]">
                                            {workflowKindLabel(
                                                run.workflow_kind,
                                            )}
                                        </span>
                                        {run.confidence !== null && (
                                            <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">
                                                {Math.round(
                                                    run.confidence * 100,
                                                )}
                                                % confidence
                                            </span>
                                        )}
                                        <span className="shrink-0 text-[11px] text-[var(--app-text-subtle)]">
                                            {formatWhen(run.created_at)}
                                        </span>
                                        <span
                                            className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}
                                        >
                                            {badge.label}
                                        </span>
                                        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-text-subtle)]" />
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
