import {
    DOCUMENT_LAYOUT_QA_FAILED,
    DOCUMENT_QA_UNAVAILABLE,
    DocumentLayoutQaError,
    type DocumentLayoutQaReport,
} from "../documentLayoutQa";
import { verifyDerivedArtifact } from "../documentLayoutGate";
import {
    renderSectionsToDocxBuffer,
    type DocxRendererMode,
    type DocxSection,
} from "../docxAssembly";

export const DOCUMENT_RENDER_FAILED = "DOCUMENT_RENDER_FAILED" as const;

export class DocumentRenderError extends Error {
    readonly code = DOCUMENT_RENDER_FAILED;
    readonly retryable = false;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "DocumentRenderError";
    }
}

export interface SanitizedLayoutSummary {
    status: "passed" | "failed" | "unavailable";
    failure_code: string | null;
    reasons: string[];
    affected_pages: number[];
    page_count: number | null;
    text_coverage: number | null;
    analyzer_version: number | null;
    missing_token_count: number | null;
}

export interface DocumentRenderAttempt {
    attempt: number;
    renderer_mode: DocxRendererMode;
    checked_at: string;
    retryable: boolean;
    summary: SanitizedLayoutSummary;
    report: DocumentLayoutQaReport | null;
}

export function summarizeLayoutReport(
    report: DocumentLayoutQaReport | null,
    failureCode?: string | null,
): SanitizedLayoutSummary {
    const pdfReports = [
        report?.pdf,
        report?.rendition_pdf,
        ...(report?.views?.map((view) => view.pdf) ?? []),
    ].filter((pdf): pdf is NonNullable<typeof pdf> => !!pdf);
    const reasons = [
        ...new Set(pdfReports.flatMap((pdf) => pdf.failure_reasons ?? [])),
    ];
    const affectedPages = [
        ...new Set(pdfReports.flatMap((pdf) => pdf.affected_pages ?? [])),
    ].sort((a, b) => a - b);
    const coverages = pdfReports
        .map((pdf) => pdf.expected_token_coverage)
        .filter((value) => Number.isFinite(value));
    const pageCounts = pdfReports
        .map((pdf) => pdf.page_count)
        .filter((value) => Number.isFinite(value));
    const analyzerVersions = pdfReports
        .map((pdf) => pdf.analyzer_version)
        .filter((value) => Number.isFinite(value));
    const missingTokenCounts = pdfReports
        .map((pdf) => pdf.missing_token_count)
        .filter((value): value is number => Number.isFinite(value));
    const code = failureCode ?? report?.failure_code ?? null;
    return {
        status:
            report?.status === "passed"
                ? "passed"
                : code === DOCUMENT_QA_UNAVAILABLE
                  ? "unavailable"
                  : "failed",
        failure_code: code,
        reasons,
        affected_pages: affectedPages,
        page_count: pageCounts.length ? Math.max(...pageCounts) : null,
        text_coverage: coverages.length ? Math.min(...coverages) : null,
        analyzer_version: analyzerVersions.length
            ? Math.max(...analyzerVersions)
            : null,
        missing_token_count: missingTokenCounts.length
            ? Math.max(...missingTokenCounts)
            : null,
    };
}

type Renderer = typeof renderSectionsToDocxBuffer;
type Verifier = typeof verifyDerivedArtifact;

export async function renderDocumentWithRecovery(params: {
    title: string;
    sections: DocxSection[];
    landscape?: boolean;
    render?: Renderer;
    verify?: Verifier;
    sleep?: (ms: number) => Promise<void>;
    onAttempt?: (attempt: DocumentRenderAttempt) => Promise<void> | void;
}): Promise<{
    buffer: Buffer;
    report: DocumentLayoutQaReport;
    rendererMode: DocxRendererMode;
}> {
    const render = params.render ?? renderSectionsToDocxBuffer;
    const verify = params.verify ?? verifyDerivedArtifact;
    const sleep =
        params.sleep ??
        ((ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let attemptNumber = 0;

    const renderBuffer = async (mode: DocxRendererMode) => {
        const rendered = await render(params.title, params.sections, {
            landscape: params.landscape,
            mode,
        });
        if ("error" in rendered) {
            throw new DocumentRenderError(
                `The ${mode} DOCX renderer failed: ${rendered.error}`,
            );
        }
        return rendered.buffer;
    };

    const verifyBuffer = async (
        mode: DocxRendererMode,
        buffer: Buffer,
    ): Promise<DocumentLayoutQaReport> => {
        let lastError: DocumentLayoutQaError | null = null;
        for (let retry = 0; retry < 3; retry += 1) {
            attemptNumber += 1;
            let report: DocumentLayoutQaReport;
            try {
                const verifiedReport = await verify({
                    bytes: buffer,
                    fileType: "docx",
                    trackedViews: false,
                });
                if (!verifiedReport) {
                    throw new DocumentLayoutQaError(
                        DOCUMENT_QA_UNAVAILABLE,
                        "Document layout verification returned no result.",
                    );
                }
                report = verifiedReport;
            } catch (cause) {
                const error =
                    cause instanceof DocumentLayoutQaError
                        ? cause
                        : new DocumentLayoutQaError(
                              DOCUMENT_QA_UNAVAILABLE,
                              "Document layout verification was unavailable.",
                              null,
                              { cause },
                          );
                lastError = error;
                await params.onAttempt?.({
                    attempt: attemptNumber,
                    renderer_mode: mode,
                    checked_at:
                        error.report?.checked_at ?? new Date().toISOString(),
                    retryable: error.retryable,
                    summary: summarizeLayoutReport(error.report, error.code),
                    report: error.report,
                });
                if (error.code !== DOCUMENT_QA_UNAVAILABLE || retry === 2) {
                    throw error;
                }
                await sleep(350 * 2 ** retry);
                continue;
            }

            // Persisting the successful QA result is outside the verifier catch.
            // If this callback fails (for example, a database write is down), it
            // must remain a persistence failure instead of being mislabeled and
            // retried as a transient converter outage.
            await params.onAttempt?.({
                attempt: attemptNumber,
                renderer_mode: mode,
                checked_at: report.checked_at,
                retryable: false,
                summary: summarizeLayoutReport(report),
                report,
            });
            return report;
        }
        throw lastError;
    };

    const standardBuffer = await renderBuffer("standard");
    try {
        const report = await verifyBuffer("standard", standardBuffer);
        return { buffer: standardBuffer, report, rendererMode: "standard" };
    } catch (error) {
        if (
            !(error instanceof DocumentLayoutQaError) ||
            error.code !== DOCUMENT_LAYOUT_QA_FAILED
        ) {
            throw error;
        }
    }

    const compatibilityBuffer = await renderBuffer("compatibility");
    const report = await verifyBuffer("compatibility", compatibilityBuffer);
    return {
        buffer: compatibilityBuffer,
        report,
        rendererMode: "compatibility",
    };
}
