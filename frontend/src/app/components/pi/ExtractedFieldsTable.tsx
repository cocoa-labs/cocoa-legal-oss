"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, FileText, Loader2, Mail } from "lucide-react";
import { getDocumentUrl, type AutomationRun } from "@/app/lib/cocoaLegalApi";
import {
    flattenExtractedFields,
    runSourceDocumentId,
    type FlattenedField,
} from "./piShared";
import { ConfidenceMeter } from "./AutomationRunCard";

const QUOTE_TRUNCATE_AT = 90;

function VerifiedBadge({ verified }: { verified: boolean | null }) {
    if (verified === true) {
        return (
            <span
                className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800"
                title="The quote was found verbatim in the cited source"
            >
                <Check className="h-3 w-3" />
                Verified
            </span>
        );
    }
    if (verified === false) {
        return (
            <span
                className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
                title="The quote could not be grounded in the cited source"
            >
                <AlertTriangle className="h-3 w-3" />
                Unverified
            </span>
        );
    }
    return <span className="text-[10px] text-[var(--app-text-subtle)]">—</span>;
}

/**
 * One row per extracted field (claims arrays flattened with a claim index):
 * name, value, per-field confidence, the citation-verifier's verdict, the
 * verbatim quote (truncated, expandable), and a source link that opens the
 * cited PDF in the viewer or jumps to the inbound email in the inbox.
 */
export function ExtractedFieldsTable({ run }: { run: AutomationRun }) {
    const router = useRouter();
    const fields = flattenExtractedFields(run);
    const sourceDocumentId = runSourceDocumentId(run);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [openingDoc, setOpeningDoc] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Open the cited PDF in a new tab via a fresh signed URL (inbox flow).
    const openSourceDocument = useCallback(async () => {
        if (!sourceDocumentId || openingDoc) return;
        setOpeningDoc(true);
        try {
            const { url } = await getDocumentUrl(sourceDocumentId, null);
            window.open(url, "_blank", "noopener,noreferrer");
        } catch {
            setError("Could not open the source document.");
        } finally {
            setOpeningDoc(false);
        }
    }, [sourceDocumentId, openingDoc]);

    const toggleQuote = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    if (fields.length === 0) {
        return (
            <p className="px-1 py-2 text-xs text-[var(--app-text-subtle)]">
                Nothing has been extracted for this run yet.
            </p>
        );
    }

    const sourceCell = (row: FlattenedField) => {
        if (row.field.source === "pdf") {
            const pageLabel =
                row.field.page !== null ? `PDF p.${row.field.page}` : "PDF";
            if (!sourceDocumentId) {
                return (
                    <span className="text-[11px] text-[var(--app-text-subtle)]">
                        {pageLabel}
                    </span>
                );
            }
            return (
                <button
                    type="button"
                    onClick={() => void openSourceDocument()}
                    disabled={openingDoc}
                    title="Open the cited document"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)] disabled:opacity-60"
                >
                    {openingDoc ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                        <FileText className="h-3 w-3 text-amber-600" />
                    )}
                    {pageLabel}
                </button>
            );
        }
        if (!run.email_id) {
            return (
                <span className="text-[11px] text-[var(--app-text-subtle)]">
                    Email
                </span>
            );
        }
        return (
            <button
                type="button"
                onClick={() => router.push(`/inbox/${run.email_id}`)}
                title="Open the source email"
                className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-panel-strong)] px-2 py-1 text-[11px] font-medium text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-hover)]"
            >
                <Mail className="h-3 w-3 text-amber-600" />
                Email
            </button>
        );
    };

    return (
        <div>
            {error && (
                <p className="px-1 pb-2 text-xs text-red-600">{error}</p>
            )}
            <div className="overflow-x-auto rounded-lg border border-[var(--app-border)]">
                <table className="w-full text-left text-xs">
                    <thead>
                        <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-strong)] text-[var(--app-text-subtle)]">
                            <th className="px-3 py-2 font-semibold">Field</th>
                            <th className="px-3 py-2 font-semibold">Value</th>
                            <th className="px-3 py-2 font-semibold">
                                Confidence
                            </th>
                            <th className="px-3 py-2 font-semibold">
                                Grounding
                            </th>
                            <th className="px-3 py-2 font-semibold">Quote</th>
                            <th className="px-3 py-2 font-semibold">Source</th>
                        </tr>
                    </thead>
                    <tbody className="bg-[var(--app-panel)]">
                        {fields.map((row) => {
                            const isExpanded = expanded.has(row.path);
                            const quote = row.field.quote.trim();
                            const truncated =
                                !isExpanded &&
                                quote.length > QUOTE_TRUNCATE_AT;
                            return (
                                <tr
                                    key={row.path}
                                    className="border-b border-[var(--app-border)] align-top last:border-b-0"
                                >
                                    <td className="whitespace-nowrap px-3 py-2 font-medium text-[var(--app-text-strong)]">
                                        {row.label}
                                        {row.claimIndex !== null && (
                                            <span className="ml-1 text-[10px] font-normal text-[var(--app-text-subtle)]">
                                                claim {row.claimIndex + 1}
                                            </span>
                                        )}
                                    </td>
                                    <td className="max-w-[200px] break-words px-3 py-2 text-[var(--app-text-muted)]">
                                        {row.field.value || "—"}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                        <ConfidenceMeter
                                            value={row.field.confidence}
                                        />
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                        <VerifiedBadge
                                            verified={row.verified}
                                        />
                                    </td>
                                    <td className="max-w-[260px] px-3 py-2 text-[var(--app-text-subtle)]">
                                        {quote ? (
                                            <>
                                                <span className="italic">
                                                    “
                                                    {truncated
                                                        ? `${quote.slice(0, QUOTE_TRUNCATE_AT)}…`
                                                        : quote}
                                                    ”
                                                </span>
                                                {quote.length >
                                                    QUOTE_TRUNCATE_AT && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            toggleQuote(
                                                                row.path,
                                                            )
                                                        }
                                                        className="ml-1 font-medium text-[var(--app-text-muted)] underline decoration-dotted hover:text-[var(--app-text-strong)]"
                                                    >
                                                        {isExpanded
                                                            ? "less"
                                                            : "more"}
                                                    </button>
                                                )}
                                            </>
                                        ) : (
                                            "—"
                                        )}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                        {sourceCell(row)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
