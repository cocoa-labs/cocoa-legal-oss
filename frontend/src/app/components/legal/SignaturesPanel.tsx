"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    FileSignature,
    RefreshCw,
    Loader2,
    ChevronRight,
    ArrowLeft,
    ChevronDown,
} from "lucide-react";
import {
    listSignatures,
    type SignatureEnvelopeSummary,
    type SignerRef,
} from "@/app/lib/cocoLegalApi";
import { SignatureStatusCard } from "./SignatureStatusCard";

/** Envelope statuses that are still in flight (awaiting someone's action). */
const PENDING_STATUSES = new Set(["sent", "partially_signed", "pending_approval"]);
/** Envelope statuses that ended without full execution. */
const OTHER_STATUSES = new Set(["declined", "cancelled", "expired"]);

export interface GroupedEnvelopes {
    pending: SignatureEnvelopeSummary[];
    completed: SignatureEnvelopeSummary[];
    other: SignatureEnvelopeSummary[];
}

/** The timestamp an envelope is sorted by (sent time, else creation time). */
function envelopeSortTime(item: SignatureEnvelopeSummary): number {
    const raw = item.envelope.sent_at ?? item.envelope.created_at;
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : 0;
}

/**
 * Bucket signature summaries into pending / completed / other and sort each
 * bucket newest-first by sent_at (falling back to created_at). Pure: no React,
 * no fetching — shared by the panel and the global summary context so counts
 * and ordering stay consistent.
 */
export function groupEnvelopes(
    items: SignatureEnvelopeSummary[],
): GroupedEnvelopes {
    const pending: SignatureEnvelopeSummary[] = [];
    const completed: SignatureEnvelopeSummary[] = [];
    const other: SignatureEnvelopeSummary[] = [];

    for (const item of items) {
        const status = item.envelope.status;
        if (status === "completed") completed.push(item);
        else if (PENDING_STATUSES.has(status)) pending.push(item);
        else if (OTHER_STATUSES.has(status)) other.push(item);
        // draft / unknown statuses are intentionally left out of all buckets.
    }

    const byNewest = (a: SignatureEnvelopeSummary, b: SignatureEnvelopeSummary) =>
        envelopeSortTime(b) - envelopeSortTime(a);
    pending.sort(byNewest);
    completed.sort(byNewest);
    other.sort(byNewest);

    return { pending, completed, other };
}

/** Count of signer-role parties and how many of them have signed. */
export function signerProgress(signers: SignerRef[]): {
    signed: number;
    total: number;
} {
    const roleSigners = signers.filter((s) => (s.role ?? "signer") === "signer");
    const signed = roleSigners.filter((s) => s.status === "signed").length;
    return { signed, total: roleSigners.length };
}

/** Human label + tone for an envelope status. */
function statusBadge(status: string): { label: string; cls: string } {
    switch (status) {
        case "completed":
            return { label: "Completed", cls: "bg-green-100 text-green-800" };
        case "partially_signed":
            return { label: "Partially signed", cls: "bg-blue-100 text-blue-800" };
        case "sent":
            return { label: "Awaiting signatures", cls: "bg-amber-100 text-amber-800" };
        case "pending_approval":
            return { label: "Pending approval", cls: "bg-amber-100 text-amber-800" };
        case "declined":
            return { label: "Declined", cls: "bg-red-100 text-red-700" };
        case "cancelled":
            return { label: "Cancelled", cls: "bg-gray-100 text-gray-600" };
        case "expired":
            return { label: "Expired", cls: "bg-gray-100 text-gray-600" };
        default:
            return { label: status, cls: "bg-gray-100 text-gray-600" };
    }
}

function envelopeTitle(item: SignatureEnvelopeSummary): string {
    return (
        item.envelope.subject ||
        item.envelope.document_name ||
        "Signature request"
    );
}

function formatWhen(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function EnvelopeRow({
    item,
    onOpen,
}: {
    item: SignatureEnvelopeSummary;
    onOpen: () => void;
}) {
    const badge = statusBadge(item.envelope.status);
    const { signed, total } = signerProgress(item.signers);
    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3 text-left transition-colors hover:bg-[var(--app-hover)]"
            >
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-[var(--app-text-strong)]">
                        {envelopeTitle(item)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--app-text-subtle)]">
                        {total > 0 && (
                            <span>
                                {signed} of {total} signed
                            </span>
                        )}
                        {total > 0 && <span aria-hidden>·</span>}
                        <span>
                            {formatWhen(
                                item.envelope.sent_at ?? item.envelope.created_at,
                            )}
                        </span>
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

/**
 * Sender-side signature dashboard. Lists every envelope the user has sent —
 * grouped into Pending / Completed (and a collapsed Other) — with live status,
 * per-signer progress ("N of M signed"), and the ability to open one to watch
 * progress, place an in-app countersignature, cancel a non-terminal request,
 * and grab the executed PDF + certificate once complete (via
 * SignatureStatusCard).
 *
 * Pass `projectId` to scope to a single matter (used by the per-matter
 * Signatures tab); omit it for the global hub at /signatures.
 */
export function SignaturesPanel({ projectId }: { projectId?: string }) {
    const [items, setItems] = useState<SignatureEnvelopeSummary[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [otherOpen, setOtherOpen] = useState(false);

    // Scope change (matter tab ↔ global hub): reset to the list and clear the
    // prior matter's data DURING render (guarded prev-tracking per react.dev
    // "adjusting state when props change") rather than in the effect below —
    // the old envelopes are gone before they can paint against the new scope.
    const [scope, setScope] = useState(projectId);
    if (scope !== projectId) {
        setScope(projectId);
        setItems(null);
        setSelectedId(null);
    }

    // Promise-chain shape (not async/await) on purpose: the effect below
    // calls load() directly, and this form makes it checkable that every
    // setState lives in a settlement callback — nothing synchronous ever
    // runs in the effect body. Errors are handled here, so load() never
    // rejects (same contract the old try/catch version had).
    const load = useCallback(
        () =>
            listSignatures(projectId)
                .then((res) => {
                    setItems(res.envelopes);
                    setLoadError(null);
                })
                .catch((err: unknown) => {
                    setLoadError(
                        err instanceof Error
                            ? err.message
                            : "Could not load your signature requests.",
                    );
                    setItems((prev) => prev ?? []);
                }),
        [projectId],
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

    const grouped = useMemo(
        () => (items ? groupEnvelopes(items) : null),
        [items],
    );

    const selectedItem = useMemo(
        () => items?.find((i) => i.envelope.id === selectedId) ?? null,
        [items, selectedId],
    );

    // Detail view for one envelope.
    if (selectedId) {
        return (
            <div className="mx-auto flex h-full w-full max-w-3xl flex-col font-sans">
                <button
                    type="button"
                    onClick={() => {
                        setSelectedId(null);
                        void load();
                    }}
                    className="mb-3 inline-flex items-center gap-1.5 self-start text-xs font-medium text-[var(--app-text-muted)] hover:text-[var(--app-text-strong)]"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    All signatures
                </button>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <SignatureStatusCard
                        envelopeId={selectedId}
                        initialSigners={selectedItem?.signers}
                        onCancelled={() => void load()}
                    />
                </div>
            </div>
        );
    }

    const isEmpty = grouped !== null && items !== null && items.length === 0;

    return (
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col font-sans">
            <div className="flex items-center gap-2.5 px-1 pb-3 pt-1">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-800 ring-1 ring-purple-200">
                    <FileSignature className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-base font-semibold text-[var(--app-text-strong)]">
                        Signatures
                    </h1>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                        {projectId
                            ? "Documents sent for signature in this matter"
                            : "Documents you've sent for signature"}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={refreshing}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--app-text-strong)] transition-colors hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                    {refreshing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Refresh
                </button>
            </div>

            {loadError && (
                <p className="px-1 pb-2 text-xs text-red-600">{loadError}</p>
            )}

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
                        <FileSignature className="h-6 w-6 text-[var(--app-text-subtle)]" />
                        <p className="text-sm font-medium text-[var(--app-text-muted)]">
                            {projectId
                                ? "No signature requests in this matter"
                                : "No signature requests yet"}
                        </p>
                        <p className="max-w-xs text-xs text-[var(--app-text-subtle)]">
                            Open a document and choose &ldquo;Send for
                            signature&rdquo; to route it for signing.
                        </p>
                    </div>
                ) : (
                    <div className="px-1 pb-4">
                        <SectionHeading
                            label="Pending"
                            count={grouped.pending.length}
                        />
                        {grouped.pending.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                                Nothing awaiting signatures.
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {grouped.pending.map((item) => (
                                    <EnvelopeRow
                                        key={item.envelope.id}
                                        item={item}
                                        onOpen={() =>
                                            setSelectedId(item.envelope.id)
                                        }
                                    />
                                ))}
                            </ul>
                        )}

                        <SectionHeading
                            label="Completed"
                            count={grouped.completed.length}
                        />
                        {grouped.completed.length === 0 ? (
                            <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                                No completed signatures yet.
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {grouped.completed.map((item) => (
                                    <EnvelopeRow
                                        key={item.envelope.id}
                                        item={item}
                                        onOpen={() =>
                                            setSelectedId(item.envelope.id)
                                        }
                                    />
                                ))}
                            </ul>
                        )}

                        {grouped.other.length > 0 && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setOtherOpen((v) => !v)}
                                    className="mt-3 flex w-full items-center gap-1 px-1 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text-muted)]"
                                >
                                    <ChevronDown
                                        className={`h-3.5 w-3.5 transition-transform ${
                                            otherOpen ? "" : "-rotate-90"
                                        }`}
                                    />
                                    Other
                                    <span className="font-normal">
                                        {grouped.other.length}
                                    </span>
                                </button>
                                {otherOpen && (
                                    <ul className="space-y-2">
                                        {grouped.other.map((item) => (
                                            <EnvelopeRow
                                                key={item.envelope.id}
                                                item={item}
                                                onOpen={() =>
                                                    setSelectedId(
                                                        item.envelope.id,
                                                    )
                                                }
                                            />
                                        ))}
                                    </ul>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
