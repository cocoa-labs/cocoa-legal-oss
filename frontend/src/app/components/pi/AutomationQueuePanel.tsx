"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, RefreshCw, Zap } from "lucide-react";
import {
    forceAutomationPoll,
    getAutomationStatus,
    listAutomationRuns,
    type AutomationRun,
    type AutomationStatusOut,
} from "@/app/lib/cocoLegalApi";
import { groupRuns } from "./piShared";
import { AutomationRunCard } from "./AutomationRunCard";

function SectionHeading({ label, count }: { label: string; count: number }) {
    return (
        <div className="px-1 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
            {label}
            <span className="ml-1.5 font-normal text-[var(--app-text-subtle)]">
                {count}
            </span>
        </div>
    );
}

function RunList({
    runs,
    onOpen,
}: {
    runs: AutomationRun[];
    onOpen: (run: AutomationRun) => void;
}) {
    return (
        <ul className="space-y-2">
            {runs.map((run) => (
                <AutomationRunCard
                    key={run.id}
                    run={run}
                    onOpen={() => onOpen(run)}
                />
            ))}
        </ul>
    );
}

/**
 * The automation approval queue: env/queue status up top (enabled,
 * drafts-only, per-status counts) with an authed "Poll now", then the runs
 * grouped for review order — triage first, staged next, in-flight work, and
 * terminal runs collapsed (the SignaturesPanel "Other" pattern). Manual
 * refresh, matching the inbox's on-demand model.
 */
export function AutomationQueuePanel() {
    const router = useRouter();
    const [runs, setRuns] = useState<AutomationRun[] | null>(null);
    const [status, setStatus] = useState<AutomationStatusOut | null>(null);
    const [schemaReady, setSchemaReady] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [polling, setPolling] = useState(false);
    const [lastPoll, setLastPoll] = useState<{
        ingested: number;
        processed: number;
    } | null>(null);
    const [terminalOpen, setTerminalOpen] = useState(false);

    const load = useCallback(
        () =>
            Promise.all([
                listAutomationRuns({ limit: 100 }),
                getAutomationStatus(),
            ])
                .then(([runsRes, statusRes]) => {
                    setRuns(runsRes.runs);
                    setStatus(statusRes);
                    setSchemaReady(
                        runsRes.schema_ready !== false &&
                            statusRes.schema_ready !== false,
                    );
                    setLoadError(null);
                })
                .catch((err: unknown) => {
                    setLoadError(
                        err instanceof Error
                            ? err.message
                            : "Could not load the automation queue.",
                    );
                    setRuns((prev) => prev ?? []);
                }),
        [],
    );

    useEffect(() => {
        void load();
    }, [load]);

    const handleRefresh = useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [refreshing, load]);

    const handlePoll = useCallback(async () => {
        if (polling) return;
        setPolling(true);
        setLoadError(null);
        try {
            const res = await forceAutomationPoll();
            setLastPoll({ ingested: res.ingested, processed: res.processed });
            await load();
        } catch (err) {
            setLoadError(
                err instanceof Error
                    ? err.message
                    : "Could not poll the mailbox.",
            );
        } finally {
            setPolling(false);
        }
    }, [polling, load]);

    const grouped = useMemo(() => (runs ? groupRuns(runs) : null), [runs]);

    const openRun = useCallback(
        (run: AutomationRun) => router.push(`/automation/${run.id}`),
        [router],
    );

    const isEmpty = runs !== null && runs.length === 0;

    return (
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col font-sans">
            {/* Header */}
            <div className="flex items-center gap-2.5 px-1 pb-3 pt-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200">
                    <Zap className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-[var(--app-text-strong)]">
                        Automation
                    </h1>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        Inbound mail staged for your review — nothing executes
                        without approval
                    </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {lastPoll !== null && !polling && (
                        <span className="text-xs font-medium text-[var(--app-text-muted)]">
                            {lastPoll.ingested === 0 &&
                            lastPoll.processed === 0
                                ? "Nothing new"
                                : `${lastPoll.ingested} ingested · ${lastPoll.processed} processed`}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={handlePoll}
                        disabled={polling}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {polling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Zap className="h-3.5 w-3.5" />
                        )}
                        {polling ? "Polling…" : "Poll now"}
                    </button>
                    <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={refreshing}
                        title="Reload the queue"
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {refreshing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </div>

            {/* Status strip */}
            {status && (
                <div className="flex flex-wrap items-center gap-1.5 px-1 pb-3">
                    <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                            status.enabled
                                ? "bg-green-100 text-green-800"
                                : "bg-gray-100 text-gray-600"
                        }`}
                    >
                        {status.enabled
                            ? "Automation on"
                            : "Automation off"}
                    </span>
                    {status.draftsOnly && (
                        <span
                            className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-900"
                            title="Approval stages case writes but acknowledgement emails stay as pending drafts"
                        >
                            Drafts only
                        </span>
                    )}
                    <span className="text-[11px] text-[var(--app-text-subtle)]">
                        {status.counts.staged} staged ·{" "}
                        {status.counts.triage} in triage ·{" "}
                        {status.counts.approved} approved
                    </span>
                </div>
            )}

            {!schemaReady && (
                <p className="px-1 pb-2 text-xs text-amber-700">
                    The automation tables have not been migrated yet — the
                    queue will populate once migration 023 is applied.
                </p>
            )}

            {loadError && (
                <p className="px-1 pb-2 text-xs text-red-600">{loadError}</p>
            )}

            {/* Queue */}
            <div className="min-h-0 flex-1 overflow-y-auto">
                {grouped === null ? (
                    <div className="space-y-2 px-1">
                        {[0, 1, 2].map((i) => (
                            <div
                                key={i}
                                className="h-16 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                            />
                        ))}
                    </div>
                ) : isEmpty ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--app-border)] px-6 py-12 text-center">
                        <Zap className="h-6 w-6 text-[var(--app-text-subtle)]" />
                        <p className="text-sm font-medium text-[var(--app-text-muted)]">
                            No automation runs yet
                        </p>
                        <p className="max-w-xs text-xs text-[var(--app-text-subtle)]">
                            Inbound carrier correspondence and vendor invoices
                            will queue here for your review. Use “Poll now” to
                            check the mailbox.
                        </p>
                    </div>
                ) : (
                    <div className="px-1 pb-4">
                        <SectionHeading
                            label="Needs attention"
                            count={grouped.triage.length}
                        />
                        {grouped.triage.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                                Nothing in triage.
                            </p>
                        ) : (
                            <RunList runs={grouped.triage} onOpen={openRun} />
                        )}

                        <SectionHeading
                            label="Ready for review"
                            count={grouped.staged.length}
                        />
                        {grouped.staged.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                                Nothing staged for approval.
                            </p>
                        ) : (
                            <RunList runs={grouped.staged} onOpen={openRun} />
                        )}

                        {grouped.working.length > 0 && (
                            <>
                                <SectionHeading
                                    label="In progress"
                                    count={grouped.working.length}
                                />
                                <RunList
                                    runs={grouped.working}
                                    onOpen={openRun}
                                />
                            </>
                        )}

                        {grouped.terminal.length > 0 && (
                            <>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setTerminalOpen((v) => !v)
                                    }
                                    className="mt-3 flex w-full items-center gap-1 px-1 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text-muted)]"
                                >
                                    <ChevronDown
                                        className={`h-3.5 w-3.5 transition-transform ${
                                            terminalOpen ? "" : "-rotate-90"
                                        }`}
                                    />
                                    Done
                                    <span className="font-normal">
                                        {grouped.terminal.length}
                                    </span>
                                </button>
                                {terminalOpen && (
                                    <RunList
                                        runs={grouped.terminal}
                                        onOpen={openRun}
                                    />
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
