"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Library, RotateCcw } from "lucide-react";
import { API_BASE } from "@/app/lib/apiBase";
import { exportCapabilityResultDocx } from "@/app/lib/cocoLegalApi";
import { recordProposalMetric } from "@/app/lib/assistantReliabilityTelemetry";
import type {
    CapabilityResultEvent,
    CapabilityResultFinding,
    CapabilityResultFlag,
    CapabilityResultSection,
} from "../../shared/types";
import { RiskBadge, type UnifiedRiskBand } from "../RiskBadge";
import { EscalationDraft } from "../EscalationDraft";
import { CapabilityFooterActions } from "../CapabilityFooterActions";

/**
 * The generic in-chat capability result card.
 *
 * Everything it renders comes from the persisted `capability_result` event,
 * which the backend validator already bounded and shaped — so this component
 * only decides layout, never trust. Sections render in the order the
 * capability declared them; an unknown kind renders nothing rather than
 * guessing, so a future section type degrades to a gap instead of a crash.
 */

/**
 * Fallback for results recorded before the backend emitted `band` on each
 * finding. It must agree with the backend's `toUnifiedBand` traffic-light arm
 * — RED is HIGH there, and a card that called the same RED "Critical" in a row
 * and "High" in the header was claiming two severities for one word. ORANGE,
 * which the traffic-light scheme lacks, sits with high. `grey` means "not
 * assessed" and gets NO badge at all: a grey pill next to a real red one reads
 * as a fifth severity.
 */
const LEGACY_FLAG_TO_BAND: Record<
    CapabilityResultFlag,
    UnifiedRiskBand | null
> = {
    GREEN: "low",
    YELLOW: "medium",
    ORANGE: "high",
    RED: "high",
    grey: null,
};

export interface CapabilityResultCardProps {
    event: CapabilityResultEvent;
    /** Null until the conversation is persisted — the export route needs both. */
    chatId: string | null;
    messageId: string | null;
    /** Re-send the same run. Wired by the parent to `handleChat`. */
    onRetry?: (retry: NonNullable<CapabilityResultEvent["retry"]>) => void;
    /** Which surface the card is rendered on (telemetry only). */
    surface?: "chat" | "matter";
}

/** Compact markdown for card prose — no citations, no math. */
function Md({ text }: { text: string }) {
    return (
        <div className="prose prose-sm max-w-none text-zinc-800 dark:prose-invert dark:text-zinc-200">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
    );
}

/** `filename, p. 12 — "quoted text"`, skipping the parts that are absent. */
function citationText(
    citation: CapabilityResultFinding["citation"],
): string | null {
    if (!citation) return null;
    let out = citation.filename;
    if (citation.page !== null) out += `, p. ${citation.page}`;
    if (citation.quote) out += ` — "${citation.quote}"`;
    return out;
}

function FindingRow({ finding }: { finding: CapabilityResultFinding }) {
    // The band the backend resolved wins; the flag map is only for events
    // persisted before that field existed.
    const band =
        finding.band !== undefined
            ? finding.band
            : finding.flag
              ? LEGACY_FLAG_TO_BAND[finding.flag]
              : null;
    const cite = citationText(finding.citation);
    return (
        <div className="flex items-start gap-2 rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2 text-xs dark:border-zinc-900 dark:bg-zinc-900/30">
            {band && (
                <span className="mt-0.5 shrink-0">
                    <RiskBadge band={band} compact />
                </span>
            )}
            <span className="mt-0.5 w-32 shrink-0 font-medium text-zinc-500">
                {finding.label}
            </span>
            <div className="min-w-0 flex-1">
                <Md text={finding.value_md} />
                {cite && (
                    <div className="mt-1 text-[11px] text-zinc-500">{cite}</div>
                )}
            </div>
        </div>
    );
}

function SectionBlock({ section }: { section: CapabilityResultSection }) {
    return (
        <div className="mt-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {section.label}
            </div>
            {section.kind === "text" && section.text_md && (
                <Md text={section.text_md} />
            )}
            {section.kind === "list" && section.items && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-800 dark:text-zinc-200">
                    {section.items.map((item, i) => (
                        <li key={i}>{item}</li>
                    ))}
                </ul>
            )}
            {section.kind === "table" && section.columns && (
                <div className="overflow-x-auto">
                    <table className="min-w-full border border-zinc-200 text-left text-xs dark:border-zinc-800">
                        <thead className="bg-zinc-50 dark:bg-zinc-900">
                            <tr>
                                {section.columns.map((column, i) => (
                                    <th
                                        key={i}
                                        scope="col"
                                        className="border-b border-zinc-200 px-2 py-1.5 font-semibold text-zinc-600 dark:border-zinc-800 dark:text-zinc-300"
                                    >
                                        {column}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {(section.rows ?? []).map((row, ri) => (
                                <tr key={ri}>
                                    {row.map((cell, ci) => (
                                        <td
                                            key={ci}
                                            className="border-b border-zinc-100 px-2 py-1.5 align-top text-zinc-800 dark:border-zinc-900 dark:text-zinc-200"
                                        >
                                            {cell}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {section.kind === "findings" && section.findings && (
                <div className="space-y-1.5">
                    {section.findings.map((finding, i) => (
                        <FindingRow key={i} finding={finding} />
                    ))}
                </div>
            )}
        </div>
    );
}

/** Plain-markdown rendering of the whole card, for the Copy action. */
function toMarkdown(event: CapabilityResultEvent): string {
    const parts: string[] = [`# ${event.title}`];
    if (event.overall) {
        parts.push(
            `**Overall:** ${event.overall.native_label} (${event.overall.band})`,
        );
    }
    if (event.summary_md) parts.push(event.summary_md);
    for (const section of event.sections) {
        parts.push(`## ${section.label}`);
        if (section.kind === "text" && section.text_md) {
            parts.push(section.text_md);
        } else if (section.kind === "list" && section.items) {
            parts.push(section.items.map((i) => `- ${i}`).join("\n"));
        } else if (section.kind === "table" && section.columns) {
            parts.push(
                [
                    `| ${section.columns.join(" | ")} |`,
                    `| ${section.columns.map(() => "---").join(" | ")} |`,
                    ...(section.rows ?? []).map((r) => `| ${r.join(" | ")} |`),
                ].join("\n"),
            );
        } else if (section.kind === "findings" && section.findings) {
            parts.push(
                section.findings
                    .map((f) => {
                        const flag = f.flag ? ` [${f.flag}]` : "";
                        const cite = citationText(f.citation);
                        return `- **${f.label}**${flag}: ${f.value_md}${
                            cite ? ` (${cite})` : ""
                        }`;
                    })
                    .join("\n"),
            );
        }
    }
    if (event.escalation) {
        parts.push(
            `## Escalation`,
            `Subject: ${event.escalation.subject}`,
            event.escalation.body,
        );
    }
    return parts.join("\n\n");
}

export function CapabilityResultCard({
    event,
    chatId,
    messageId,
    onRetry,
    surface = "chat",
}: CapabilityResultCardProps) {
    const [exported, setExported] = useState<{
        filename: string;
        href: string | null;
    } | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);

    const failed = event.status === "failed";
    const retry = event.retry;

    // One counter per rendered result, not per re-render.
    const countedRef = useRef<string | null>(null);
    useEffect(() => {
        if (countedRef.current === event.result_id) return;
        countedRef.current = event.result_id;
        recordProposalMetric(
            failed ? "result_failed" : "result_rendered",
            surface,
            event.capability_id,
        );
    }, [event.result_id, event.capability_id, failed, surface]);

    if (failed) {
        return (
            <div className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-950 md:mx-10">
                <span className="text-zinc-600 dark:text-zinc-300">
                    The run recorded no result.
                </span>
                {onRetry && retry && (
                    <button
                        type="button"
                        onClick={() => onRetry(retry)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                        Try again
                    </button>
                )}
            </div>
        );
    }

    // The export route is addressed by chat + message + result; without all
    // three there is nothing to POST to, so the button is hidden rather than
    // shown broken.
    const canExport = chatId !== null && messageId !== null;

    async function handleExport() {
        if (!chatId || !messageId || exporting) return;
        setExporting(true);
        setExportError(null);
        try {
            const out = await exportCapabilityResultDocx(
                chatId,
                messageId,
                event.result_id,
            );
            // Only backend-relative URLs are linked: an absolute URL from a
            // tool-shaped payload must never become a live link here.
            const href = out.download_url.startsWith("/")
                ? `${API_BASE}${out.download_url}`
                : null;
            setExported({ filename: out.filename, href });
            recordProposalMetric("docx_exported", surface, event.capability_id);
        } catch (err) {
            setExportError(
                err instanceof Error ? err.message : "Export failed.",
            );
        } finally {
            setExporting(false);
        }
    }

    function handleCopy() {
        void navigator.clipboard.writeText(toMarkdown(event)).catch(() => {
            /* clipboard denied — nothing to recover, and nothing to break */
        });
    }

    return (
        <div className="mx-4 mb-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 md:mx-10">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 dark:bg-zinc-900">
                        <Library className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {event.title}
                    </div>
                </div>
                {event.overall && (
                    <RiskBadge
                        band={event.overall.band}
                        nativeLabel={event.overall.native_label}
                    />
                )}
            </div>

            {event.summary_md && (
                <div className="mt-3">
                    <Md text={event.summary_md} />
                </div>
            )}

            {event.sections.map((section) => (
                <SectionBlock key={section.id} section={section} />
            ))}

            {event.escalation && (
                <div className="mt-4">
                    <EscalationDraft
                        defaultSubject={event.escalation.subject}
                        defaultBody={event.escalation.body}
                    />
                </div>
            )}

            <CapabilityFooterActions
                onExportDocx={canExport ? () => void handleExport() : undefined}
                onCopy={handleCopy}
                disabled={{ exportDocx: exporting }}
            />

            {exported && (
                <div className="mt-2 text-xs text-zinc-500">
                    Exported ·{" "}
                    {exported.href ? (
                        <a
                            href={exported.href}
                            className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
                        >
                            {exported.filename}
                        </a>
                    ) : (
                        exported.filename
                    )}
                </div>
            )}
            {exportError && (
                <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    {exportError}
                </div>
            )}
        </div>
    );
}
