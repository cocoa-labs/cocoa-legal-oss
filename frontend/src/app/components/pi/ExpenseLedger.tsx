"use client";

import { useCallback, useState } from "react";
import {
    Check,
    ExternalLink,
    FileText,
    Loader2,
    Receipt,
} from "lucide-react";
import {
    getDocumentUrl,
    updateCaseExpense,
    type PiCaseExpense,
} from "@/app/lib/cocoaLegalApi";
import { expenseStatusBadge, formatCents, formatWhen } from "./piShared";

/** Statuses from which the operator can still record a payment. */
const MARK_PAID_FROM = new Set(["pending_approval", "approved"]);

/**
 * Expenses ledger for one case: vendor, invoice number, amount, status, the
 * vendor portal deep-link (payment happens in the portal, by a human), the
 * invoice PDF, and a "Mark paid" action that records paid_at / paid_by.
 * Row mutations PATCH through updateCaseExpense and report back via
 * onChange so the parent's detail snapshot stays current.
 */
export function ExpenseLedger({
    caseId,
    expenses,
    onChange,
}: {
    caseId: string;
    expenses: PiCaseExpense[];
    onChange: (updated: PiCaseExpense) => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);
    const [openingId, setOpeningId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const markPaid = useCallback(
        async (expense: PiCaseExpense) => {
            if (busyId) return;
            setBusyId(expense.id);
            setError(null);
            try {
                const updated = await updateCaseExpense(caseId, expense.id, {
                    status: "paid",
                });
                onChange(updated);
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : "Could not mark that expense paid.",
                );
            } finally {
                setBusyId(null);
            }
        },
        [busyId, caseId, onChange],
    );

    // Open the invoice PDF in a new tab via a fresh signed URL (the inbox
    // attachment flow).
    const openInvoice = useCallback(async (documentId: string) => {
        setOpeningId(documentId);
        try {
            const { url } = await getDocumentUrl(documentId, null);
            window.open(url, "_blank", "noopener,noreferrer");
        } catch {
            setError("Could not open that invoice.");
        } finally {
            setOpeningId(null);
        }
    }, []);

    if (expenses.length === 0) {
        return (
            <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                No expenses recorded on this case.
            </p>
        );
    }

    return (
        <div>
            {error && (
                <p className="px-1 pb-2 text-xs text-red-600">{error}</p>
            )}
            <ul className="space-y-2">
                {expenses.map((expense) => {
                    const badge = expenseStatusBadge(expense.status);
                    return (
                        <li
                            key={expense.id}
                            className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-3"
                        >
                            <div className="flex items-center gap-2">
                                <Receipt className="h-3.5 w-3.5 shrink-0 text-[var(--app-text-subtle)]" />
                                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-text-strong)]">
                                    {expense.vendor}
                                </span>
                                <span className="shrink-0 text-sm font-semibold text-[var(--app-text-strong)]">
                                    {formatCents(
                                        expense.amount_cents,
                                        expense.currency,
                                    )}
                                </span>
                                <span
                                    className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${badge.cls}`}
                                >
                                    {badge.label}
                                </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 pl-5 text-[11px] text-[var(--app-text-subtle)]">
                                <span>
                                    {expense.invoice_number
                                        ? `Invoice ${expense.invoice_number}`
                                        : "No invoice number"}
                                </span>
                                {expense.status === "paid" &&
                                    expense.paid_at && (
                                        <>
                                            <span aria-hidden>·</span>
                                            <span>
                                                Paid{" "}
                                                {formatWhen(expense.paid_at)}
                                                {expense.paid_by
                                                    ? ` by ${expense.paid_by}`
                                                    : ""}
                                            </span>
                                        </>
                                    )}
                            </div>

                            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                                {expense.payment_portal_url && (
                                    <a
                                        href={expense.payment_portal_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
                                    >
                                        <ExternalLink className="h-3 w-3 text-sky-600" />
                                        Payment portal
                                    </a>
                                )}
                                {expense.document_id && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void openInvoice(
                                                expense.document_id as string,
                                            )
                                        }
                                        disabled={
                                            openingId === expense.document_id
                                        }
                                        className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                                    >
                                        {openingId === expense.document_id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <FileText className="h-3 w-3 text-amber-600" />
                                        )}
                                        Invoice PDF
                                    </button>
                                )}
                                {MARK_PAID_FROM.has(expense.status) && (
                                    <button
                                        type="button"
                                        onClick={() => void markPaid(expense)}
                                        disabled={busyId === expense.id}
                                        className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-1 text-[11px] font-medium text-green-800 transition-colors hover:bg-green-100 disabled:opacity-60"
                                    >
                                        {busyId === expense.id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : (
                                            <Check className="h-3 w-3" />
                                        )}
                                        Mark paid
                                    </button>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
