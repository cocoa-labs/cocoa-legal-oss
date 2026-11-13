"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
    AlertTriangle,
    Check,
    ExternalLink,
    Link2,
    Loader2,
    Mail,
    Pencil,
    Receipt,
    RotateCcw,
    Search,
    ShieldCheck,
    X,
    Zap,
} from "lucide-react";
import {
    approveAutomationRun,
    getAutomationRun,
    getAutomationStatus,
    listCases,
    reassignAutomationRun,
    rejectAutomationRun,
    retryAutomationRun,
    type AutomationRunDetail,
    type AutomationStatusOut,
    type PiCase,
} from "@/app/lib/cocoLegalApi";
import {
    formatCents,
    formatWhen,
    runNeedsCaseConfirm,
    runStatusBadge,
    runSummary,
    workflowKindLabel,
} from "./piShared";
import { ConfidenceMeter } from "./AutomationRunCard";
import { ExtractedFieldsTable } from "./ExtractedFieldsTable";

type ActionPanel = "none" | "approve" | "edit" | "reject" | "reassign";

/** Editable slice of one staged policy upsert (merged back by index). */
interface PolicyEditState {
    carrier: string;
    claim_number: string;
    policy_number: string;
    coverage_type: string;
    limits: string;
    adjuster_name: string;
    adjuster_email: string;
    adjuster_phone: string;
}

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function policyEditsFromProposal(
    proposal: Record<string, unknown>,
): PolicyEditState[] {
    const upserts = (proposal as { policy_upserts?: unknown }).policy_upserts;
    if (!Array.isArray(upserts)) return [];
    return upserts.map((raw) => {
        const upsert =
            raw && typeof raw === "object" && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : {};
        const limits = upsert.policy_limits as
            | { raw_text?: unknown }
            | undefined;
        const adjuster = (upsert.adjuster ?? {}) as Record<string, unknown>;
        return {
            carrier: str(upsert.carrier),
            claim_number: str(upsert.claim_number),
            policy_number: str(upsert.policy_number),
            coverage_type: str(upsert.coverage_type),
            limits: str(limits?.raw_text),
            adjuster_name: str(adjuster.name),
            adjuster_email: str(adjuster.email),
            adjuster_phone: str(adjuster.phone),
        };
    });
}

/** Build the per-index shallow overrides the approve endpoint merges. */
function policyUpsertsPayload(
    edits: PolicyEditState[],
): Record<string, unknown>[] {
    return edits.map((edit) => {
        const adjuster: Record<string, string> = {};
        if (edit.adjuster_name.trim())
            adjuster.name = edit.adjuster_name.trim();
        if (edit.adjuster_email.trim())
            adjuster.email = edit.adjuster_email.trim();
        if (edit.adjuster_phone.trim())
            adjuster.phone = edit.adjuster_phone.trim();
        return {
            carrier: edit.carrier.trim(),
            claim_number: edit.claim_number.trim() || null,
            policy_number: edit.policy_number.trim() || null,
            coverage_type: edit.coverage_type.trim() || null,
            policy_limits: edit.limits.trim()
                ? { raw_text: edit.limits.trim() }
                : {},
            adjuster,
        };
    });
}

const inputCls =
    "w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs text-[var(--app-text-strong)] placeholder:text-[var(--app-text-subtle)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300";

const actionBtnCls =
    "inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60";

const primaryBtnCls =
    "inline-flex items-center gap-1.5 rounded border border-gray-900 bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400";

function SectionHeading({ label }: { label: string }) {
    return (
        <div className="px-1 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
            {label}
        </div>
    );
}

/** Checkbox gate for approving a needs_case_confirm match (409 contract). */
function ConfirmCaseCheckbox({
    checked,
    onChange,
    caseName,
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    caseName: string | null;
}) {
    return (
        <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-amber-600"
            />
            <span>
                The matched case{caseName ? ` (${caseName})` : ""} is correct.
                This match was below the auto-confirm threshold, so approval
                requires an explicit confirmation — or reassign the run first.
            </span>
        </label>
    );
}

/**
 * Review surface for one automation run: source email, case match, the
 * extracted fields with citations, the staged proposal, the acknowledgement
 * draft, and the per-state actions (approve / edit-then-approve / reject /
 * reassign / retry). Every action surfaces the backend `{ detail }` inline
 * and reloads the run — a 409 lost race re-renders against fresh state.
 */
export function AutomationRunDetailPanel({ runId }: { runId: string }) {
    const router = useRouter();
    const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
    const [autoStatus, setAutoStatus] = useState<AutomationStatusOut | null>(
        null,
    );
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [panel, setPanel] = useState<ActionPanel>("none");
    const [confirmCase, setConfirmCase] = useState(false);
    const [policyEdits, setPolicyEdits] = useState<PolicyEditState[]>([]);
    const [amountText, setAmountText] = useState("");
    const [rejectReason, setRejectReason] = useState("");
    const [caseSearch, setCaseSearch] = useState("");
    const [caseResults, setCaseResults] = useState<PiCase[] | null>(null);
    const [reassignTarget, setReassignTarget] = useState<PiCase | null>(null);

    const load = useCallback(
        () =>
            getAutomationRun(runId)
                .then((res) => {
                    setDetail(res);
                    setLoadError(null);
                })
                .catch((err: unknown) => {
                    setLoadError(
                        err instanceof Error
                            ? err.message
                            : "Could not load this run.",
                    );
                }),
        [runId],
    );

    useEffect(() => {
        void load();
        getAutomationStatus()
            .then(setAutoStatus)
            .catch(() => setAutoStatus(null));
    }, [load]);

    // Reassign case search (debounced; stale responses dropped by cleanup).
    useEffect(() => {
        if (panel !== "reassign") return;
        let cancelled = false;
        const timer = window.setTimeout(() => {
            listCases({ search: caseSearch.trim() || undefined, limit: 10 })
                .then((rows) => {
                    if (!cancelled) setCaseResults(rows);
                })
                .catch(() => {
                    if (!cancelled) setCaseResults([]);
                });
        }, 300);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [panel, caseSearch]);

    const run = detail?.run ?? null;
    const needsCaseConfirm = run ? runNeedsCaseConfirm(run) : false;
    const summary = run ? runSummary(run) : null;

    const openPanel = useCallback(
        (next: ActionPanel) => {
            setPanel((prev) => (prev === next ? "none" : next));
            setActionError(null);
            setNotice(null);
            setConfirmCase(false);
            if (next === "edit" && run) {
                setPolicyEdits(policyEditsFromProposal(run.proposal));
                const cents = (run.proposal as { amount_cents?: unknown })
                    .amount_cents;
                setAmountText(
                    typeof cents === "number" ? (cents / 100).toFixed(2) : "",
                );
            }
            if (next === "reassign") {
                setCaseSearch("");
                setCaseResults(null);
                setReassignTarget(null);
            }
            if (next === "reject") setRejectReason("");
        },
        [run],
    );

    /** Shared action wrapper: busy state, `{ detail }` surfacing, and an
     * unconditional reload so a 409 lost race lands on fresh state. */
    const runAction = useCallback(
        async (action: () => Promise<string | null>) => {
            if (busy) return;
            setBusy(true);
            setActionError(null);
            setNotice(null);
            try {
                const message = await action();
                setNotice(message);
                setPanel("none");
            } catch (err) {
                setActionError(
                    err instanceof Error
                        ? err.message
                        : "That action failed.",
                );
            } finally {
                await load();
                setBusy(false);
            }
        },
        [busy, load],
    );

    const approve = useCallback(
        (withEdits: boolean) =>
            runAction(async () => {
                if (!run) return null;
                let edits;
                if (withEdits) {
                    if (run.workflow_kind === "claim_correspondence") {
                        edits = {
                            policyUpserts: policyUpsertsPayload(policyEdits),
                        };
                    } else {
                        const amount = Number.parseFloat(amountText);
                        if (!Number.isFinite(amount) || amount < 0) {
                            throw new Error(
                                "Enter a valid amount before approving.",
                            );
                        }
                        edits = { amountCents: Math.round(amount * 100) };
                    }
                }
                const res = await approveAutomationRun(run.id, {
                    ...(needsCaseConfirm ? { confirmCase: true } : {}),
                    ...(edits ? { edits } : {}),
                });
                if (!run.ack_email_id) return "Approved — case updated.";
                return res.sent
                    ? "Approved — case updated and the acknowledgement was sent."
                    : "Approved — case updated; the acknowledgement stays a pending draft.";
            }),
        [runAction, run, needsCaseConfirm, policyEdits, amountText],
    );

    const reject = useCallback(
        () =>
            runAction(async () => {
                if (!run) return null;
                await rejectAutomationRun(
                    run.id,
                    rejectReason.trim() || undefined,
                );
                return "Rejected — staged writes cancelled.";
            }),
        [runAction, run, rejectReason],
    );

    const retry = useCallback(
        () =>
            runAction(async () => {
                if (!run) return null;
                await retryAutomationRun(run.id);
                return "Requeued — the pipeline will reprocess this email.";
            }),
        [runAction, run],
    );

    const reassign = useCallback(
        () =>
            runAction(async () => {
                if (!run || !reassignTarget) return null;
                await reassignAutomationRun(run.id, reassignTarget.id);
                return `Reassigned to ${reassignTarget.client_name}.`;
            }),
        [runAction, run, reassignTarget],
    );

    const invoiceProposal = useMemo(() => {
        if (!run || run.workflow_kind !== "vendor_invoice") return null;
        const p = run.proposal as {
            amount_cents?: unknown;
            currency?: unknown;
            vendor?: unknown;
            invoice_number?: unknown;
            payment_portal_url?: unknown;
            flagged_above_threshold?: unknown;
            flag_threshold_usd?: unknown;
        };
        if (typeof p.amount_cents !== "number") return null;
        return {
            amountCents: p.amount_cents,
            currency: typeof p.currency === "string" ? p.currency : "USD",
            vendor: typeof p.vendor === "string" ? p.vendor : null,
            invoiceNumber:
                typeof p.invoice_number === "string" ? p.invoice_number : null,
            portalUrl:
                typeof p.payment_portal_url === "string" &&
                p.payment_portal_url
                    ? p.payment_portal_url
                    : null,
            flagged: p.flagged_above_threshold === true,
            flagThresholdUsd:
                typeof p.flag_threshold_usd === "number"
                    ? p.flag_threshold_usd
                    : null,
        };
    }, [run]);

    if (loadError) {
        return <p className="px-1 py-6 text-sm text-red-600">{loadError}</p>;
    }
    if (!detail || !run) {
        return (
            <div className="space-y-2 px-1 py-2">
                {[0, 1].map((i) => (
                    <div
                        key={i}
                        className="h-24 animate-pulse rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]"
                    />
                ))}
            </div>
        );
    }

    const badge = runStatusBadge(run.status);
    const isStaged = run.status === "staged";
    const isTriage = run.status === "triage";
    const isFailed = run.status === "failed";
    const canReassign = isStaged || isTriage;
    const approveDisabled = busy || (needsCaseConfirm && !confirmCase);

    return (
        <div className="flex h-full w-full flex-col font-sans">
            {/* Header */}
            <div className="flex items-start gap-2.5 px-1 pb-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200">
                    <Zap className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-base font-semibold text-[var(--app-text-strong)]">
                        {detail.email?.subject ||
                            workflowKindLabel(run.workflow_kind)}
                    </h1>
                    <p className="truncate text-xs text-[var(--app-text-subtle)]">
                        {workflowKindLabel(run.workflow_kind)}
                        {detail.email?.from_address &&
                            ` · from ${detail.email.from_address}`}
                        {detail.email?.received_at &&
                            ` · ${formatWhen(detail.email.received_at)}`}
                    </p>
                </div>
                <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}
                >
                    {badge.label}
                </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pb-4">
                {/* Match + confidence overview */}
                <div className="mx-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        {detail.case ? (
                            <button
                                type="button"
                                onClick={() =>
                                    router.push(`/cases/${detail.case?.id}`)
                                }
                                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)]"
                            >
                                <Link2 className="h-3 w-3 text-sky-600" />
                                {detail.case.client_name}
                                {detail.case.case_number &&
                                    ` · ${detail.case.case_number}`}
                            </button>
                        ) : (
                            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                                No matched case
                            </span>
                        )}
                        {run.match_method && (
                            <span className="text-[11px] text-[var(--app-text-subtle)]">
                                matched via {run.match_method.replace(/_/g, " ")}
                                {run.match_confidence !== null &&
                                    ` (${Math.round(run.match_confidence * 100)}%)`}
                            </span>
                        )}
                        {needsCaseConfirm && isStaged && (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                                Case match needs confirmation
                            </span>
                        )}
                        <span className="ml-auto">
                            <ConfidenceMeter value={run.confidence} />
                        </span>
                    </div>
                    {summary && (
                        <p className="mt-2 text-xs leading-5 text-[var(--app-text-muted)]">
                            {summary}
                        </p>
                    )}
                    {isTriage && run.triage_reason && (
                        <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                                In triage: {run.triage_reason}. Reassign it to
                                the right case, retry the pipeline, or reject
                                it.
                            </span>
                        </div>
                    )}
                    {run.error && !isTriage && (
                        <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{run.error}</span>
                        </div>
                    )}
                    {run.status === "rejected" && run.triage_reason && (
                        <p className="mt-2 text-xs text-[var(--app-text-subtle)]">
                            Rejection reason: {run.triage_reason}
                        </p>
                    )}
                </div>

                {/* Invoice proposal */}
                {invoiceProposal && (
                    <>
                        <SectionHeading label="Staged expense" />
                        <div className="mx-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <Receipt className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text-strong)]">
                                    {invoiceProposal.vendor ?? "Unknown vendor"}
                                    {invoiceProposal.invoiceNumber &&
                                        ` · ${invoiceProposal.invoiceNumber}`}
                                </span>
                                <span className="shrink-0 text-sm font-semibold text-[var(--app-text-strong)]">
                                    {formatCents(
                                        invoiceProposal.amountCents,
                                        invoiceProposal.currency,
                                    )}
                                </span>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                                {invoiceProposal.portalUrl && (
                                    <a
                                        href={invoiceProposal.portalUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                                    >
                                        <ExternalLink className="h-3 w-3 text-sky-600" />
                                        Payment portal
                                    </a>
                                )}
                                {invoiceProposal.flagged && (
                                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                                        <AlertTriangle className="h-3 w-3" />
                                        Above the
                                        {invoiceProposal.flagThresholdUsd !==
                                            null &&
                                            ` $${invoiceProposal.flagThresholdUsd.toLocaleString()}`}{" "}
                                        review threshold
                                    </span>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {/* Extracted fields */}
                <SectionHeading label="Extracted fields" />
                <div className="mx-1">
                    <ExtractedFieldsTable run={run} />
                </div>

                {/* Acknowledgement draft */}
                {detail.ackEmail && (
                    <>
                        <SectionHeading label="Acknowledgement draft" />
                        <div className="mx-1 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
                            <div className="flex items-center gap-2">
                                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 ring-1 ring-blue-200">
                                    <Mail className="h-3.5 w-3.5" />
                                </div>
                                <span className="text-sm font-semibold text-gray-800">
                                    {detail.ackEmail.status === "sent"
                                        ? "Acknowledgement sent"
                                        : "Acknowledgement ready"}
                                </span>
                                <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                                    <ShieldCheck className="h-3 w-3" />
                                    {detail.ackEmail.status === "sent"
                                        ? "Sent"
                                        : autoStatus?.draftsOnly
                                          ? "Stays pending on approval (drafts-only)"
                                          : "Sends on approval"}
                                </span>
                            </div>
                            <dl className="mt-3 space-y-1 text-sm">
                                <div className="flex gap-2">
                                    <dt className="w-16 shrink-0 font-medium text-gray-500">
                                        To
                                    </dt>
                                    <dd className="min-w-0 break-words text-gray-900">
                                        {detail.ackEmail.to_addresses.length > 0
                                            ? detail.ackEmail.to_addresses.join(
                                                  ", ",
                                              )
                                            : "—"}
                                    </dd>
                                </div>
                                {detail.ackEmail.reply_to_address && (
                                    <div className="flex gap-2">
                                        <dt className="w-16 shrink-0 font-medium text-gray-500">
                                            Reply-To
                                        </dt>
                                        <dd className="min-w-0 break-words text-gray-900">
                                            {detail.ackEmail.reply_to_address}
                                        </dd>
                                    </div>
                                )}
                                <div className="flex gap-2">
                                    <dt className="w-16 shrink-0 font-medium text-gray-500">
                                        Subject
                                    </dt>
                                    <dd className="min-w-0 break-words font-medium text-gray-900">
                                        {detail.ackEmail.subject || "—"}
                                    </dd>
                                </div>
                            </dl>
                            {detail.ackEmail.body_text && (
                                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-blue-100 bg-white px-3 py-2 text-xs leading-5 text-gray-700">
                                    {detail.ackEmail.body_text}
                                </pre>
                            )}
                        </div>
                    </>
                )}

                {/* Outcome banners */}
                {actionError && (
                    <p className="mx-1 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                        {actionError}
                    </p>
                )}
                {notice && (
                    <p className="mx-1 mt-3 inline-flex items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                        <Check className="h-3.5 w-3.5" />
                        {notice}
                    </p>
                )}

                {/* Actions */}
                {(isStaged || isTriage || isFailed) && (
                    <>
                        <SectionHeading label="Actions" />
                        <div className="mx-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
                            <div className="flex flex-wrap items-center gap-2">
                                {isStaged && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                openPanel("approve")
                                            }
                                            disabled={busy}
                                            className={primaryBtnCls}
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                            Approve
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => openPanel("edit")}
                                            disabled={busy}
                                            className={actionBtnCls}
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                            Edit &amp; approve
                                        </button>
                                    </>
                                )}
                                {(isTriage || isFailed) && (
                                    <button
                                        type="button"
                                        onClick={() => void retry()}
                                        disabled={busy}
                                        className={actionBtnCls}
                                    >
                                        {busy ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <RotateCcw className="h-3.5 w-3.5" />
                                        )}
                                        Retry
                                    </button>
                                )}
                                {canReassign && (
                                    <button
                                        type="button"
                                        onClick={() => openPanel("reassign")}
                                        disabled={busy}
                                        className={actionBtnCls}
                                    >
                                        <Link2 className="h-3.5 w-3.5" />
                                        Reassign case
                                    </button>
                                )}
                                {(isStaged || isTriage) && (
                                    <button
                                        type="button"
                                        onClick={() => openPanel("reject")}
                                        disabled={busy}
                                        className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60"
                                    >
                                        Reject
                                    </button>
                                )}
                            </div>

                            {/* Approve confirm */}
                            {panel === "approve" && (
                                <div className="mt-3 space-y-2 border-t border-[var(--app-border)] pt-3">
                                    {needsCaseConfirm && (
                                        <ConfirmCaseCheckbox
                                            checked={confirmCase}
                                            onChange={setConfirmCase}
                                            caseName={
                                                detail.case?.client_name ??
                                                null
                                            }
                                        />
                                    )}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-medium text-amber-900">
                                            Approve this run and apply the
                                            staged case writes?
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void approve(false)
                                            }
                                            disabled={approveDisabled}
                                            className="inline-flex items-center gap-1.5 rounded border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm ring-2 ring-amber-200 hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            {busy ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <ShieldCheck className="h-3.5 w-3.5" />
                                            )}
                                            Confirm approve
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setPanel("none")}
                                            disabled={busy}
                                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                                        >
                                            Back
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Edit-then-approve */}
                            {panel === "edit" && (
                                <div className="mt-3 space-y-3 border-t border-[var(--app-border)] pt-3">
                                    {run.workflow_kind ===
                                    "claim_correspondence" ? (
                                        policyEdits.length === 0 ? (
                                            <p className="text-xs text-[var(--app-text-subtle)]">
                                                This run staged no policy
                                                writes to edit.
                                            </p>
                                        ) : (
                                            policyEdits.map((edit, i) => (
                                                <div
                                                    key={i}
                                                    className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-3"
                                                >
                                                    {policyEdits.length >
                                                        1 && (
                                                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-subtle)]">
                                                            Claim {i + 1}
                                                        </p>
                                                    )}
                                                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                                        {(
                                                            [
                                                                ["carrier", "Carrier", true],
                                                                ["claim_number", "Claim number", false],
                                                                ["policy_number", "Policy number", false],
                                                                ["coverage_type", "Coverage type", false],
                                                                ["limits", "Policy limits", false],
                                                                ["adjuster_name", "Adjuster name", false],
                                                                ["adjuster_email", "Adjuster email", false],
                                                                ["adjuster_phone", "Adjuster phone", false],
                                                            ] as const
                                                        ).map(
                                                            ([
                                                                key,
                                                                label,
                                                                required,
                                                            ]) => (
                                                                <div key={key}>
                                                                    <label
                                                                        htmlFor={`pi-edit-${i}-${key}`}
                                                                        className="mb-1 block text-[11px] font-medium text-[var(--app-text-muted)]"
                                                                    >
                                                                        {label}
                                                                        {required && (
                                                                            <span className="ml-0.5 text-red-600">
                                                                                *
                                                                            </span>
                                                                        )}
                                                                    </label>
                                                                    <input
                                                                        id={`pi-edit-${i}-${key}`}
                                                                        value={
                                                                            edit[
                                                                                key
                                                                            ]
                                                                        }
                                                                        onChange={(
                                                                            e,
                                                                        ) =>
                                                                            setPolicyEdits(
                                                                                (
                                                                                    prev,
                                                                                ) =>
                                                                                    prev.map(
                                                                                        (
                                                                                            p,
                                                                                            j,
                                                                                        ) =>
                                                                                            j ===
                                                                                            i
                                                                                                ? {
                                                                                                      ...p,
                                                                                                      [key]: e
                                                                                                          .target
                                                                                                          .value,
                                                                                                  }
                                                                                                : p,
                                                                                    ),
                                                                            )
                                                                        }
                                                                        className={
                                                                            inputCls
                                                                        }
                                                                    />
                                                                </div>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                            ))
                                        )
                                    ) : (
                                        <div className="max-w-xs">
                                            <label
                                                htmlFor="pi-edit-amount"
                                                className="mb-1 block text-[11px] font-medium text-[var(--app-text-muted)]"
                                            >
                                                Amount (
                                                {(
                                                    invoiceProposal?.currency ??
                                                    "USD"
                                                ).toUpperCase()}
                                                )
                                            </label>
                                            <input
                                                id="pi-edit-amount"
                                                value={amountText}
                                                onChange={(e) =>
                                                    setAmountText(
                                                        e.target.value,
                                                    )
                                                }
                                                inputMode="decimal"
                                                placeholder="0.00"
                                                className={inputCls}
                                            />
                                        </div>
                                    )}

                                    {needsCaseConfirm && (
                                        <ConfirmCaseCheckbox
                                            checked={confirmCase}
                                            onChange={setConfirmCase}
                                            caseName={
                                                detail.case?.client_name ??
                                                null
                                            }
                                        />
                                    )}

                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void approve(true)}
                                            disabled={
                                                approveDisabled ||
                                                (run.workflow_kind ===
                                                    "claim_correspondence" &&
                                                    policyEdits.some(
                                                        (p) =>
                                                            !p.carrier.trim(),
                                                    ))
                                            }
                                            className={primaryBtnCls}
                                        >
                                            {busy ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <Check className="h-3.5 w-3.5" />
                                            )}
                                            Approve with edits
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setPanel("none")}
                                            disabled={busy}
                                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Reject */}
                            {panel === "reject" && (
                                <div className="mt-3 space-y-2 border-t border-[var(--app-border)] pt-3">
                                    <label
                                        htmlFor="pi-reject-reason"
                                        className="block text-[11px] font-medium text-[var(--app-text-muted)]"
                                    >
                                        Reason (optional)
                                    </label>
                                    <textarea
                                        id="pi-reject-reason"
                                        value={rejectReason}
                                        onChange={(e) =>
                                            setRejectReason(e.target.value)
                                        }
                                        rows={2}
                                        placeholder="Why is this being rejected?"
                                        className={inputCls}
                                    />
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void reject()}
                                            disabled={busy}
                                            className="inline-flex items-center gap-1.5 rounded border border-red-600 bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-60"
                                        >
                                            {busy ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <X className="h-3.5 w-3.5" />
                                            )}
                                            Confirm reject
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setPanel("none")}
                                            disabled={busy}
                                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                                        >
                                            Back
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Reassign */}
                            {panel === "reassign" && (
                                <div className="mt-3 space-y-2 border-t border-[var(--app-border)] pt-3">
                                    <div className="relative">
                                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--app-text-subtle)]" />
                                        <input
                                            value={caseSearch}
                                            onChange={(e) =>
                                                setCaseSearch(e.target.value)
                                            }
                                            placeholder="Search cases by client or case number"
                                            className={`${inputCls} pl-8`}
                                        />
                                    </div>
                                    {caseResults === null ? (
                                        <p className="text-[11px] text-[var(--app-text-subtle)]">
                                            Searching…
                                        </p>
                                    ) : caseResults.length === 0 ? (
                                        <p className="text-[11px] text-[var(--app-text-subtle)]">
                                            No cases match that search.
                                        </p>
                                    ) : (
                                        <ul className="max-h-48 space-y-1 overflow-y-auto">
                                            {caseResults.map((piCase) => (
                                                <li key={piCase.id}>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setReassignTarget(
                                                                piCase,
                                                            )
                                                        }
                                                        className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                                                            reassignTarget?.id ===
                                                            piCase.id
                                                                ? "border-amber-300 bg-amber-50 text-amber-900"
                                                                : "border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)] hover:bg-[var(--app-hover)]"
                                                        }`}
                                                    >
                                                        <span className="min-w-0 flex-1 truncate font-medium">
                                                            {
                                                                piCase.client_name
                                                            }
                                                        </span>
                                                        <span className="shrink-0 text-[11px]">
                                                            {piCase.case_number ||
                                                                "no case #"}
                                                        </span>
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void reassign()}
                                            disabled={busy || !reassignTarget}
                                            className={primaryBtnCls}
                                        >
                                            {busy ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <Link2 className="h-3.5 w-3.5" />
                                            )}
                                            Reassign
                                            {reassignTarget
                                                ? ` to ${reassignTarget.client_name}`
                                                : ""}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setPanel("none")}
                                            disabled={busy}
                                            className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                                        >
                                            Back
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
