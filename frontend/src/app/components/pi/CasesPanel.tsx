"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    Briefcase,
    ChevronRight,
    FileSpreadsheet,
    Loader2,
    Plus,
    Search,
} from "lucide-react";
import {
    createCase,
    listCases,
    PI_CASE_STATUSES,
    type PiCase,
    type PiCaseStatus,
} from "@/app/lib/cocoaLegalApi";
import {
    caseOriginLabel,
    caseStatusBadge,
    formatDateOnly,
} from "./piShared";
import { CsvImportWizard } from "./CsvImportWizard";

const PAGE_SIZE = 50;

function CaseRow({ piCase, onOpen }: { piCase: PiCase; onOpen: () => void }) {
    const badge = caseStatusBadge(piCase.status);
    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-left transition-colors hover:bg-[var(--app-hover)]"
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold text-[var(--app-text-strong)]">
                            {piCase.client_name}
                        </span>
                        {piCase.needs_review && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                                <AlertTriangle className="h-3 w-3" />
                                Needs review
                            </span>
                        )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--app-text-subtle)]">
                        <span>{piCase.case_number || "No case number"}</span>
                        <span aria-hidden>·</span>
                        <span>DOL {formatDateOnly(piCase.date_of_loss)}</span>
                        <span aria-hidden>·</span>
                        <span>{caseOriginLabel(piCase.origin)}</span>
                    </div>
                </div>
                <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}
                >
                    {badge.label}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-text-subtle)]" />
            </button>
        </li>
    );
}

/** Inline "new case" form (client name required; the rest optional). */
function NewCaseForm({
    onCreated,
    onClose,
}: {
    onCreated: (created: PiCase) => void;
    onClose: () => void;
}) {
    const [clientName, setClientName] = useState("");
    const [caseNumber, setCaseNumber] = useState("");
    const [dateOfLoss, setDateOfLoss] = useState("");
    const [status, setStatus] = useState<PiCaseStatus>("open");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = useCallback(async () => {
        if (saving || !clientName.trim()) return;
        setSaving(true);
        setError(null);
        try {
            const created = await createCase({
                client_name: clientName.trim(),
                ...(caseNumber.trim() ? { case_number: caseNumber.trim() } : {}),
                ...(dateOfLoss.trim() ? { date_of_loss: dateOfLoss.trim() } : {}),
                status,
            });
            onCreated(created);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Could not create this case.",
            );
            setSaving(false);
        }
    }, [saving, clientName, caseNumber, dateOfLoss, status, onCreated]);

    const inputCls =
        "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300";

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                void submit();
            }}
            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4"
        >
            <span className="text-sm font-semibold text-[var(--app-text-strong)]">
                New case
            </span>
            <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <div>
                    <label
                        htmlFor="pi-new-client"
                        className="mb-1 block text-[11px] font-medium text-[var(--app-text-muted)]"
                    >
                        Client name <span className="text-red-600">*</span>
                    </label>
                    <input
                        id="pi-new-client"
                        value={clientName}
                        onChange={(e) => setClientName(e.target.value)}
                        placeholder="Jane Doe"
                        className={inputCls}
                    />
                </div>
                <div>
                    <label
                        htmlFor="pi-new-number"
                        className="mb-1 block text-[11px] font-medium text-[var(--app-text-muted)]"
                    >
                        Case number
                    </label>
                    <input
                        id="pi-new-number"
                        value={caseNumber}
                        onChange={(e) => setCaseNumber(e.target.value)}
                        placeholder="2026-0042"
                        className={inputCls}
                    />
                </div>
                <div>
                    <label
                        htmlFor="pi-new-dol"
                        className="mb-1 block text-[11px] font-medium text-[var(--app-text-muted)]"
                    >
                        Date of loss
                    </label>
                    <input
                        id="pi-new-dol"
                        value={dateOfLoss}
                        onChange={(e) => setDateOfLoss(e.target.value)}
                        placeholder="MM/DD/YYYY"
                        className={inputCls}
                    />
                </div>
                <div>
                    <label
                        htmlFor="pi-new-status"
                        className="mb-1 block text-[11px] font-medium text-[var(--app-text-muted)]"
                    >
                        Status
                    </label>
                    <select
                        id="pi-new-status"
                        value={status}
                        onChange={(e) =>
                            setStatus(e.target.value as PiCaseStatus)
                        }
                        className={inputCls}
                    >
                        {PI_CASE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {caseStatusBadge(s).label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

            <div className="mt-3 flex items-center gap-2">
                <button
                    type="submit"
                    disabled={saving || !clientName.trim()}
                    className="inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                    {saving ? (
                        <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Creating…
                        </>
                    ) : (
                        <>
                            <Plus className="h-3.5 w-3.5" />
                            Create case
                        </>
                    )}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                >
                    Cancel
                </button>
            </div>
        </form>
    );
}

/**
 * Personal Injury case list: search (client name / case number), status
 * filter chips, a needs-review toggle, and an offset-paged list. "New case"
 * expands an inline form; "Import CSV" opens the CasePeer import wizard.
 * Self-contained (owns its fetching), like InboxPanel / SignaturesPanel.
 */
export function CasesPanel() {
    const router = useRouter();
    const [cases, setCases] = useState<PiCase[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<PiCaseStatus | null>(null);
    const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [showNewCase, setShowNewCase] = useState(false);
    const [showImport, setShowImport] = useState(false);
    // Bumped to force a reload with the current filters (post create/import).
    const [reloadKey, setReloadKey] = useState(0);

    // Debounced by 300ms so a keystroke burst issues one request; the
    // sequence guard drops stale responses that resolve out of order.
    const requestSeq = useRef(0);
    useEffect(() => {
        const seq = ++requestSeq.current;
        const timer = window.setTimeout(
            () => {
                listCases({
                    search: search.trim() || undefined,
                    status: statusFilter ?? undefined,
                    needsReview: needsReviewOnly ? true : undefined,
                    limit: PAGE_SIZE,
                })
                    .then((rows) => {
                        if (seq !== requestSeq.current) return;
                        setCases(rows);
                        setHasMore(rows.length === PAGE_SIZE);
                        setLoadError(null);
                    })
                    .catch((err: unknown) => {
                        if (seq !== requestSeq.current) return;
                        setLoadError(
                            err instanceof Error
                                ? err.message
                                : "Could not load your cases.",
                        );
                        setCases((prev) => prev ?? []);
                    });
            },
            search.trim() ? 300 : 0,
        );
        return () => window.clearTimeout(timer);
    }, [search, statusFilter, needsReviewOnly, reloadKey]);

    const loadMore = useCallback(async () => {
        if (loadingMore || !cases) return;
        setLoadingMore(true);
        try {
            const rows = await listCases({
                search: search.trim() || undefined,
                status: statusFilter ?? undefined,
                needsReview: needsReviewOnly ? true : undefined,
                limit: PAGE_SIZE,
                offset: cases.length,
            });
            setCases((prev) => [...(prev ?? []), ...rows]);
            setHasMore(rows.length === PAGE_SIZE);
        } catch (err) {
            setLoadError(
                err instanceof Error
                    ? err.message
                    : "Could not load more cases.",
            );
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, cases, search, statusFilter, needsReviewOnly]);

    const filterChipCls = (active: boolean) =>
        `rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            active
                ? "border-amber-300 bg-amber-100 text-amber-900"
                : "border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
        }`;

    return (
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col font-sans">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-1 pb-3 pt-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-800 ring-1 ring-sky-200">
                    <Briefcase className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-[var(--app-text-strong)]">
                        Cases
                    </h1>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        Personal Injury matters, policies and expenses
                    </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            setShowImport((v) => !v);
                            setShowNewCase(false);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                    >
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                        Import CSV
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setShowNewCase((v) => !v);
                            setShowImport(false);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New case
                    </button>
                </div>
            </div>

            {/* Search + filters */}
            <div className="px-1 pb-3">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--app-text-subtle)]" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by client name or case number"
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] py-1.5 pl-8 pr-3 text-xs text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                    />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => setStatusFilter(null)}
                        className={filterChipCls(statusFilter === null)}
                    >
                        All
                    </button>
                    {PI_CASE_STATUSES.map((s) => (
                        <button
                            key={s}
                            type="button"
                            onClick={() =>
                                setStatusFilter((prev) =>
                                    prev === s ? null : s,
                                )
                            }
                            className={filterChipCls(statusFilter === s)}
                        >
                            {caseStatusBadge(s).label}
                        </button>
                    ))}
                    <span
                        aria-hidden
                        className="mx-0.5 h-4 w-px bg-[var(--app-border)]"
                    />
                    <button
                        type="button"
                        onClick={() => setNeedsReviewOnly((v) => !v)}
                        className={filterChipCls(needsReviewOnly)}
                    >
                        Needs review
                    </button>
                </div>
            </div>

            {showImport && (
                <div className="px-1 pb-3">
                    <CsvImportWizard
                        onClose={() => setShowImport(false)}
                        onImported={() => setReloadKey((k) => k + 1)}
                    />
                </div>
            )}

            {showNewCase && (
                <div className="px-1 pb-3">
                    <NewCaseForm
                        onCreated={(created) => {
                            setShowNewCase(false);
                            setReloadKey((k) => k + 1);
                            router.push(`/cases/${created.id}`);
                        }}
                        onClose={() => setShowNewCase(false)}
                    />
                </div>
            )}

            {loadError && (
                <p className="px-1 pb-2 text-xs text-red-600">{loadError}</p>
            )}

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {cases === null ? (
                    <div className="space-y-2 px-1">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-16 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                            />
                        ))}
                    </div>
                ) : cases.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-6 py-12 text-center">
                        <Briefcase className="h-6 w-6 text-[var(--app-text-subtle)]" />
                        <p className="text-sm font-medium text-[var(--app-text-muted)]">
                            {search.trim() ||
                            statusFilter !== null ||
                            needsReviewOnly
                                ? "No cases match these filters"
                                : "No cases yet"}
                        </p>
                        <p className="max-w-xs text-xs text-[var(--app-text-subtle)]">
                            Create a case by hand or import your CasePeer CSV
                            export to get started.
                        </p>
                    </div>
                ) : (
                    <>
                        <ul className="space-y-2 px-1 pb-2">
                            {cases.map((piCase) => (
                                <CaseRow
                                    key={piCase.id}
                                    piCase={piCase}
                                    onOpen={() =>
                                        router.push(`/cases/${piCase.id}`)
                                    }
                                />
                            ))}
                        </ul>
                        {hasMore && (
                            <div className="px-1 pb-4">
                                <button
                                    type="button"
                                    onClick={() => void loadMore()}
                                    disabled={loadingMore}
                                    className="flex h-8 w-full items-center justify-center rounded-md text-xs font-medium text-[var(--app-text-subtle)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text)] disabled:opacity-60"
                                >
                                    {loadingMore ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        "Load more"
                                    )}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
