import crypto from "node:crypto";

import { convertToPdf } from "./convert";
import {
    acceptAllTrackedChangesInBody,
    rejectAllTrackedChangesInBody,
} from "./docxTrackedChanges";
import {
    DocumentReflowError,
    extractDocxTextView,
    inspectDocxLayout,
    type DocxLayoutInspection,
} from "./docxLayout";
import { DocumentConverterError } from "./libreoffice";

export const DOCUMENT_LAYOUT_QA_FAILED = "DOCUMENT_LAYOUT_QA_FAILED" as const;
export const DOCUMENT_QA_UNAVAILABLE = "DOCUMENT_QA_UNAVAILABLE" as const;

export type DocumentLayoutQaErrorCode =
    | typeof DOCUMENT_LAYOUT_QA_FAILED
    | typeof DOCUMENT_QA_UNAVAILABLE;

export type LayoutQaStatus = "source" | "unverified" | "passed" | "failed";

export interface PdfLayoutQaReport {
    analyzer_version: number;
    sha256: string;
    page_count: number;
    text_item_count: number;
    rendered_token_count: number;
    expected_token_count: number;
    expected_token_coverage: number;
    missing_token_count?: number;
    ordered_token_coverage: number;
    expected_text_sha256?: string | null;
    rendered_text_sha256?: string;
    content_digest_match?: boolean | null;
    collision_count: number;
    out_of_bounds_count: number;
    affected_pages: number[];
    failure_reasons: string[];
    status: "passed" | "failed";
}

export interface DocxLayoutQaViewReport {
    view: "stored" | "accepted" | "rejected" | "final";
    sha256: string;
    pdf: PdfLayoutQaReport;
}

export interface DocumentLayoutQaReport {
    schema_version: number;
    artifact_type: "docx" | "pdf";
    sha256: string;
    checked_at: string;
    status: "passed" | "failed";
    inspection?: DocxLayoutInspection;
    views?: DocxLayoutQaViewReport[];
    pdf?: PdfLayoutQaReport;
    rendition_pdf?: PdfLayoutQaReport;
    failure_code?: DocumentLayoutQaErrorCode;
}

export class DocumentLayoutQaError extends Error {
    readonly code: DocumentLayoutQaErrorCode;
    readonly report: DocumentLayoutQaReport | null;
    readonly retryable: boolean;

    constructor(
        code: DocumentLayoutQaErrorCode,
        message: string,
        report: DocumentLayoutQaReport | null = null,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "DocumentLayoutQaError";
        this.code = code;
        this.report = report;
        this.retryable = code === DOCUMENT_QA_UNAVAILABLE;
    }
}

const ANALYZER_VERSION = 4;
const REPORT_SCHEMA_VERSION = 1;
const PAGE_BOUND_TOLERANCE_PT = 2;
const MIN_INTERSECTION_PT = 0.5;
const COLLISION_AREA_RATIO = 0.3;
const DIFFERENT_BASELINE_RATIO = 0.25;
const SUPERSCRIPT_HEIGHT_RATIO = 0.72;
const SUPERSCRIPT_BASELINE_RATIO = 0.85;

function sha256(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizeForTokens(value: string): string {
    return value
        .normalize("NFKC")
        .replace(/\u00ad/g, "")
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[‐‑‒–—―]/g, "-");
}

function tokenize(value: string): string[] {
    return (
        normalizeForTokens(value).match(
            /[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*|[^\s]/gu,
        ) ?? []
    );
}

/** Keep extractor line boundaries so short fragments cannot merge ordinary spaces. */
export function tokenizePdfRuns(value: string) {
    const normalized = normalizeForTokens(value);
    const tokens: string[] = [];
    const boundaries = new Set<number>();
    let previousEnd = 0;
    for (const match of normalized.matchAll(
        /[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*|[^\s]/gu,
    )) {
        const index = match.index ?? 0;
        if (
            tokens.length &&
            normalized.slice(previousEnd, index).includes("\n")
        )
            boundaries.add(tokens.length);
        tokens.push(match[0]);
        previousEnd = index + match[0].length;
    }
    return { tokens, boundaries };
}

/**
 * PDF extractors insert whitespace where Writer wraps a table-cell word, URL,
 * regulatory identifier, or multi-digit item number mid-token. Rejoin only
 * when adjacent fragments exactly concatenate to an expected token and the
 * complete set of boundary merges improves exact token coverage. This global
 * check handles related splits without turning ordinary phrases such as
 * "in to" into a different expected word such as "into".
 */
export function rejoinWrappedLongTokens(
    expected: string[],
    actual: string[],
    lineBoundaries?: ReadonlySet<number>,
): string[] {
    const isStructuredIdentifier = (token: string) =>
        /^(?:[A-Za-z]+\d+|\d+(?:\.\d+)*)$/.test(token);
    const expectedTokens = new Set(expected);
    const expectedCounts = new Map<string, number>();
    const actualCounts = new Map<string, number>();
    for (const token of expected) {
        expectedCounts.set(token, (expectedCounts.get(token) ?? 0) + 1);
    }
    for (const token of actual) {
        actualCounts.set(token, (actualCounts.get(token) ?? 0) + 1);
    }
    const deficientTokens = new Set(
        expected.filter(
            (token) =>
                (actualCounts.get(token) ?? 0) <
                (expectedCounts.get(token) ?? 0),
        ),
    );
    if (deficientTokens.size === 0) return actual;
    let maxLength = 0;
    for (const token of expected) maxLength = Math.max(maxLength, token.length);
    type MergeCandidate = {
        start: number;
        end: number;
        value: string;
        pieces: string[];
    };
    const candidates: MergeCandidate[] = [];
    for (let start = 0; start < actual.length - 1; start += 1) {
        let joined = actual[start];
        for (let end = start + 1; end < actual.length; end += 1) {
            if (lineBoundaries && !lineBoundaries.has(end)) break;
            joined += actual[end];
            if (joined.length > maxLength) break;
            if (!expectedTokens.has(joined)) continue;
            const pieces = actual.slice(start, end + 1);
            const containsExtractorFragment = pieces.some(
                (piece) => !expectedTokens.has(piece),
            );
            const isSplitIdentifier =
                isStructuredIdentifier(joined) &&
                pieces.every((piece) => /^[A-Za-z0-9.]+$/.test(piece));
            if (
                lineBoundaries ||
                ((joined.length >= 6 || isSplitIdentifier) &&
                    (containsExtractorFragment || isSplitIdentifier))
            ) {
                candidates.push({ start, end, value: joined, pieces });
            }
        }
    }
    if (candidates.length === 0) return actual;

    const matchedCount = (counts: ReadonlyMap<string, number>) => {
        let matched = 0;
        for (const [token, expectedCount] of expectedCounts) {
            matched += Math.min(expectedCount, counts.get(token) ?? 0);
        }
        return matched;
    };
    const overlaps = (
        candidate: MergeCandidate,
        selected: readonly MergeCandidate[],
    ) =>
        selected.some(
            (other) =>
                candidate.start <= other.end && other.start <= candidate.end,
        );
    const applyCounts = (
        counts: ReadonlyMap<string, number>,
        candidate: MergeCandidate,
    ) => {
        const next = new Map(counts);
        for (const piece of candidate.pieces) {
            next.set(piece, (next.get(piece) ?? 0) - 1);
        }
        next.set(candidate.value, (next.get(candidate.value) ?? 0) + 1);
        return next;
    };

    // A useful merge can temporarily move a deficit from a complete word to
    // that word's own split fragments. Search a short chain globally so cases
    // such as `communication` + `s` followed by `communicati` + `on` reconcile
    // together. Every accepted chain must improve exact multiset coverage;
    // ordinary line breaks therefore cannot turn real missing text into a pass.
    const selected: MergeCandidate[] = [];
    let counts = actualCounts;
    while (true) {
        const baseline = matchedCount(counts);
        let bestPlan: MergeCandidate[] = [];
        const search = (
            currentCounts: ReadonlyMap<string, number>,
            plan: MergeCandidate[],
            depth: number,
        ): boolean => {
            const score = matchedCount(currentCounts);
            if (score > baseline) {
                bestPlan = [...plan];
                return true;
            }
            if (depth >= 4 || score < baseline - 2) return false;
            const options = candidates
                .filter(
                    (candidate) =>
                        !overlaps(candidate, selected) &&
                        !overlaps(candidate, plan) &&
                        (currentCounts.get(candidate.value) ?? 0) <
                            (expectedCounts.get(candidate.value) ?? 0),
                )
                .map((candidate) => ({
                    candidate,
                    counts: applyCounts(currentCounts, candidate),
                }))
                .sort(
                    (left, right) =>
                        matchedCount(right.counts) -
                            matchedCount(left.counts) ||
                        right.candidate.value.length -
                            left.candidate.value.length,
                )
                .slice(0, 16);
            for (const option of options) {
                if (
                    search(
                        option.counts,
                        [...plan, option.candidate],
                        depth + 1,
                    )
                ) {
                    return true;
                }
            }
            return false;
        };
        search(counts, [], 0);
        if (bestPlan.length === 0) break;
        for (const candidate of bestPlan) {
            counts = applyCounts(counts, candidate);
            selected.push(candidate);
        }
    }
    if (selected.length === 0) return actual;
    const byStart = new Map(
        selected.map((candidate) => [candidate.start, candidate]),
    );
    const result: string[] = [];
    for (let index = 0; index < actual.length; index += 1) {
        const candidate = byStart.get(index);
        if (candidate) {
            result.push(candidate.value);
            index = candidate.end;
            continue;
        }
        if (!selected.some((item) => index > item.start && index <= item.end)) {
            result.push(actual[index]);
        }
    }
    return result;
}

function orderedTokenCoverage(expected: string[], actual: string[]): number {
    if (expected.length === 0) return 1;
    let expectedIndex = 0;
    for (const token of actual) {
        if (token === expected[expectedIndex]) expectedIndex += 1;
        if (expectedIndex === expected.length) break;
    }
    return expectedIndex / expected.length;
}

function tokenMultisetCoverage(expected: string[], actual: string[]): number {
    if (expected.length === 0) return 1;
    const available = new Map<string, number>();
    for (const token of actual) {
        available.set(token, (available.get(token) ?? 0) + 1);
    }
    let matched = 0;
    for (const token of expected) {
        const count = available.get(token) ?? 0;
        if (count <= 0) continue;
        matched += 1;
        available.set(token, count - 1);
    }
    return matched / expected.length;
}

function missingTokenCount(expected: string[], actual: string[]): number {
    return Math.max(
        0,
        expected.length -
            Math.round(
                tokenMultisetCoverage(expected, actual) * expected.length,
            ),
    );
}

function isDecoration(value: string): boolean {
    const compact = value.replace(/\s/g, "");
    return compact.length >= 2 && /^[._\-–—…·•]+$/u.test(compact);
}

interface TextBox {
    x1: number;
    x2: number;
    y1: number;
    y2: number;
    baseline: number;
    width: number;
    height: number;
}

interface PdfTextItem {
    str?: string;
    width?: number;
    height?: number;
    transform?: number[];
    hasEOL?: boolean;
}

interface PdfPageLike {
    getViewport: (params: { scale: number }) => {
        width: number;
        height: number;
    };
    getTextContent: () => Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocumentLike {
    numPages: number;
    getPage: (pageNumber: number) => Promise<PdfPageLike>;
    destroy?: () => Promise<void>;
}

function itemBox(item: PdfTextItem): TextBox | null {
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) return null;
    const x = Number(transform[4]);
    const baseline = Number(transform[5]);
    const width = Math.abs(Number(item.width ?? 0));
    const height = Math.max(
        Math.abs(Number(item.height ?? 0)),
        Math.hypot(Number(transform[2] ?? 0), Number(transform[3] ?? 0)),
        1,
    );
    if (![x, baseline, width, height].every(Number.isFinite) || width <= 0) {
        return null;
    }
    return {
        x1: x,
        x2: x + width,
        y1: baseline - height * 0.8,
        y2: baseline + height * 0.2,
        baseline,
        width,
        height,
    };
}

function boxesCollide(left: TextBox, right: TextBox): boolean {
    const baselineDelta = Math.abs(left.baseline - right.baseline);
    const smallerHeight = Math.min(left.height, right.height);
    const largerHeight = Math.max(left.height, right.height);
    if (baselineDelta < DIFFERENT_BASELINE_RATIO * smallerHeight) return false;
    if (
        smallerHeight / largerHeight <= SUPERSCRIPT_HEIGHT_RATIO &&
        baselineDelta <= SUPERSCRIPT_BASELINE_RATIO * largerHeight
    ) {
        return false;
    }

    const intersectionWidth =
        Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1);
    const intersectionHeight =
        Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1);
    if (
        intersectionWidth <= MIN_INTERSECTION_PT ||
        intersectionHeight <= MIN_INTERSECTION_PT
    ) {
        return false;
    }
    const intersectionArea = intersectionWidth * intersectionHeight;
    const smallerArea = Math.max(
        1,
        Math.min(left.width * left.height, right.width * right.height),
    );
    return intersectionArea / smallerArea >= COLLISION_AREA_RATIO;
}

export async function analyzePdfLayout(
    bytes: Buffer,
    options: {
        expectedText?: string;
        onRenderedText?: (value: string) => void;
    } = {},
): Promise<PdfLayoutQaReport> {
    let document: PdfDocumentLike | null = null;
    try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
        document = await (
            pdfjs as unknown as {
                getDocument: (params: { data: Uint8Array }) => {
                    promise: Promise<PdfDocumentLike>;
                };
            }
        ).getDocument({ data: new Uint8Array(bytes) }).promise;

        let textItemCount = 0;
        let collisionCount = 0;
        let outOfBoundsCount = 0;
        const affectedPages = new Set<number>();
        const renderedText: string[] = [];

        for (
            let pageNumber = 1;
            pageNumber <= document.numPages;
            pageNumber++
        ) {
            const page = await document.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const boxes: TextBox[] = [];
            let previousTextBox: TextBox | null = null;
            let previousHadEol = true;
            if (pageNumber > 1) renderedText.push("\n");
            for (const item of content.items) {
                const value = typeof item.str === "string" ? item.str : "";
                const box = itemBox(item);
                // PDF.js can carry the line break in an empty text item.
                if (!value && item.hasEOL) previousHadEol = true;
                if (value) {
                    if (renderedText.length > 0) {
                        const sameLine =
                            previousTextBox &&
                            box &&
                            Math.abs(previousTextBox.baseline - box.baseline) <=
                                DIFFERENT_BASELINE_RATIO *
                                    Math.min(
                                        previousTextBox.height,
                                        box.height,
                                    );
                        const gap =
                            previousTextBox && box
                                ? box.x1 - previousTextBox.x2
                                : Number.POSITIVE_INFINITY;
                        const joinsPreviousRun =
                            sameLine &&
                            !previousHadEol &&
                            gap <=
                                Math.max(
                                    0.75,
                                    0.18 *
                                        Math.min(
                                            previousTextBox!.height,
                                            box!.height,
                                        ),
                                );
                        renderedText.push(
                            previousHadEol || !sameLine
                                ? "\n"
                                : joinsPreviousRun
                                  ? ""
                                  : " ",
                        );
                    }
                    renderedText.push(value);
                    previousTextBox = box;
                    previousHadEol = !!item.hasEOL;
                }
                if (!value.trim() || isDecoration(value)) continue;
                if (!box) continue;
                textItemCount += 1;
                if (
                    box.x1 < -PAGE_BOUND_TOLERANCE_PT ||
                    box.x2 > viewport.width + PAGE_BOUND_TOLERANCE_PT ||
                    box.y1 < -PAGE_BOUND_TOLERANCE_PT ||
                    box.y2 > viewport.height + PAGE_BOUND_TOLERANCE_PT
                ) {
                    outOfBoundsCount += 1;
                    affectedPages.add(pageNumber);
                }
                boxes.push(box);
            }
            boxes.sort(
                (left, right) => left.x1 - right.x1 || left.y1 - right.y1,
            );
            for (let i = 0; i < boxes.length; i++) {
                const left = boxes[i];
                for (let j = i + 1; j < boxes.length; j++) {
                    const right = boxes[j];
                    if (right.x1 >= left.x2) break;
                    if (boxesCollide(left, right)) {
                        collisionCount += 1;
                        affectedPages.add(pageNumber);
                    }
                }
            }

            // Large legal packets can span hundreds of pages. PDF.js and the
            // collision scan are CPU-heavy enough that immediately continuing
            // to the next page can starve request handling and worker lease
            // heartbeats for minutes. Yield once per page so health checks and
            // the 30-second ownership heartbeat run while QA remains exact.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const renderedValue = renderedText.join("");
        options.onRenderedText?.(renderedValue);
        const expectedTokens = tokenize(options.expectedText ?? "");
        const extracted = tokenizePdfRuns(renderedValue);
        const renderedTokens = rejoinWrappedLongTokens(
            expectedTokens,
            extracted.tokens,
            extracted.boundaries,
        );
        const coverage = tokenMultisetCoverage(expectedTokens, renderedTokens);
        const orderCoverage = orderedTokenCoverage(
            expectedTokens,
            renderedTokens,
        );
        const failureReasons: string[] = [];
        if (document.numPages < 1) failureReasons.push("NO_PAGES");
        if (collisionCount > 0) failureReasons.push("TEXT_COLLISION");
        if (outOfBoundsCount > 0) failureReasons.push("TEXT_OUT_OF_BOUNDS");
        if (renderedTokens.length === 0) failureReasons.push("TEXT_COLLAPSE");
        if (expectedTokens.length >= 10 && coverage < 1) {
            failureReasons.push("EXPECTED_TEXT_MISSING");
        }
        if (
            expectedTokens.length >= 10 &&
            renderedTokens.length < Math.floor(expectedTokens.length * 0.8) &&
            !failureReasons.includes("TEXT_COLLAPSE")
        ) {
            failureReasons.push("TEXT_COLLAPSE");
        }
        return {
            analyzer_version: ANALYZER_VERSION,
            sha256: sha256(bytes),
            page_count: document.numPages,
            text_item_count: textItemCount,
            rendered_token_count: renderedTokens.length,
            expected_token_count: expectedTokens.length,
            expected_token_coverage: Number(coverage.toFixed(6)),
            missing_token_count: missingTokenCount(
                expectedTokens,
                renderedTokens,
            ),
            ordered_token_coverage: Number(orderCoverage.toFixed(6)),
            expected_text_sha256:
                expectedTokens.length > 0
                    ? sha256(Buffer.from(expectedTokens.join("\u001f"), "utf8"))
                    : null,
            rendered_text_sha256: sha256(
                Buffer.from(renderedTokens.join("\u001f"), "utf8"),
            ),
            content_digest_match:
                expectedTokens.length > 0 ? coverage === 1 : null,
            collision_count: collisionCount,
            out_of_bounds_count: outOfBoundsCount,
            affected_pages: [...affectedPages].sort(
                (left, right) => left - right,
            ),
            failure_reasons: failureReasons,
            status: failureReasons.length === 0 ? "passed" : "failed",
        };
    } catch (cause) {
        const name =
            cause && typeof cause === "object" && "name" in cause
                ? String((cause as { name?: unknown }).name ?? "")
                : "";
        const invalidPdf = /InvalidPDF|Password|MissingPDF/i.test(name);
        throw new DocumentLayoutQaError(
            invalidPdf ? DOCUMENT_LAYOUT_QA_FAILED : DOCUMENT_QA_UNAVAILABLE,
            invalidPdf
                ? "The PDF is invalid or unreadable."
                : "The PDF layout verifier is temporarily unavailable.",
            null,
            { cause },
        );
    } finally {
        await document?.destroy?.().catch(() => {});
    }
}

export async function extractPdfTextForQa(bytes: Buffer): Promise<string> {
    let renderedText = "";
    await analyzePdfLayout(bytes, {
        onRenderedText: (value) => {
            renderedText = value;
        },
    });
    return renderedText;
}

function failedReport(
    report: DocumentLayoutQaReport,
    code: DocumentLayoutQaErrorCode = DOCUMENT_LAYOUT_QA_FAILED,
): never {
    report.status = "failed";
    report.failure_code = code;
    throw new DocumentLayoutQaError(
        code,
        code === DOCUMENT_QA_UNAVAILABLE
            ? "Document layout verification is temporarily unavailable."
            : "The document failed layout verification and was not published.",
        report,
    );
}

export async function verifyPdfLayout(
    bytes: Buffer,
    options: { expectedText?: string } = {},
): Promise<DocumentLayoutQaReport> {
    const checkedAt = new Date().toISOString();
    let pdf: PdfLayoutQaReport;
    try {
        pdf = await analyzePdfLayout(bytes, options);
    } catch (error) {
        if (error instanceof DocumentLayoutQaError) throw error;
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            "The PDF layout verifier is temporarily unavailable.",
            null,
            { cause: error },
        );
    }
    const report: DocumentLayoutQaReport = {
        schema_version: REPORT_SCHEMA_VERSION,
        artifact_type: "pdf",
        sha256: sha256(bytes),
        checked_at: checkedAt,
        status: pdf.status,
        pdf,
    };
    if (pdf.status !== "passed") failedReport(report);
    return report;
}

export async function verifyDocxLayout(
    bytes: Buffer,
    options: { trackedViews?: boolean } = {},
): Promise<DocumentLayoutQaReport> {
    let inspection: DocxLayoutInspection;
    try {
        inspection = await inspectDocxLayout(bytes);
    } catch (error) {
        const failureCode =
            error instanceof DocumentReflowError
                ? DOCUMENT_LAYOUT_QA_FAILED
                : DOCUMENT_QA_UNAVAILABLE;
        const report: DocumentLayoutQaReport = {
            schema_version: REPORT_SCHEMA_VERSION,
            artifact_type: "docx",
            sha256: sha256(bytes),
            checked_at: new Date().toISOString(),
            status: "failed",
            failure_code: failureCode,
        };
        throw new DocumentLayoutQaError(
            failureCode,
            error instanceof DocumentReflowError
                ? "The DOCX package is invalid or cannot be inspected safely."
                : "Document layout verification is temporarily unavailable.",
            report,
            { cause: error },
        );
    }
    const trackedViews =
        options.trackedViews ??
        inspection.trackedInsertionCount + inspection.trackedDeletionCount > 0;
    const candidates: {
        view: DocxLayoutQaViewReport["view"];
        bytes: Buffer;
        textView: "accepted" | "rejected" | "all";
    }[] = [];
    if (trackedViews) {
        candidates.push({ view: "stored", bytes, textView: "all" });
        const [accepted, rejected] = await Promise.all([
            acceptAllTrackedChangesInBody(bytes),
            rejectAllTrackedChangesInBody(bytes),
        ]);
        candidates.push({
            view: "accepted",
            bytes: accepted.bytes,
            textView: "accepted",
        });
        candidates.push({
            view: "rejected",
            bytes: rejected.bytes,
            textView: "rejected",
        });
    } else {
        candidates.push({ view: "final", bytes, textView: "accepted" });
    }

    const report: DocumentLayoutQaReport = {
        schema_version: REPORT_SCHEMA_VERSION,
        artifact_type: "docx",
        sha256: sha256(bytes),
        checked_at: new Date().toISOString(),
        status: "passed",
        inspection,
        views: [],
    };
    try {
        let failedView = false;
        for (const candidate of candidates) {
            const [pdfBytes, expectedText] = await Promise.all([
                convertToPdf(candidate.bytes, "docx"),
                extractDocxTextView(candidate.bytes, candidate.textView),
            ]);
            const pdf = await analyzePdfLayout(pdfBytes, { expectedText });
            report.views!.push({
                view: candidate.view,
                sha256: sha256(candidate.bytes),
                pdf,
            });
            if (pdf.status !== "passed") failedView = true;
        }
        if (failedView) failedReport(report);
    } catch (error) {
        if (error instanceof DocumentLayoutQaError) {
            if (!error.report) {
                report.status = "failed";
                report.failure_code = error.code;
                throw new DocumentLayoutQaError(
                    error.code,
                    error.message,
                    report,
                    {
                        cause: error,
                    },
                );
            }
            throw error;
        }
        if (error instanceof DocumentConverterError) {
            failedReport(report, DOCUMENT_QA_UNAVAILABLE);
        }
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            "Document layout verification is temporarily unavailable.",
            report,
            { cause: error },
        );
    }
    return report;
}

export function layoutQaHttpError(error: unknown): {
    status: number;
    code: DocumentLayoutQaErrorCode;
    detail: string;
    report: DocumentLayoutQaReport | null;
} | null {
    if (!(error instanceof DocumentLayoutQaError)) return null;
    return {
        status: error.retryable ? 503 : 422,
        code: error.code,
        detail: error.message,
        report: error.report,
    };
}

export const _internal = {
    boxesCollide,
    isDecoration,
    itemBox,
    orderedTokenCoverage,
    tokenMultisetCoverage,
    tokenize,
};
