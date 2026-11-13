import crypto from "node:crypto";

import type { createServerSupabase } from "./supabase";
import {
    DOCUMENT_QA_UNAVAILABLE,
    DocumentLayoutQaError,
    type DocumentLayoutQaReport,
    type LayoutQaStatus,
    analyzePdfLayout,
    verifyDocxLayout,
    verifyPdfLayout,
} from "./documentLayoutQa";
import { extractDocxTextView } from "./docxLayout";
import { describeSupabaseError } from "./documentVersions";
import { downloadFile } from "./storage";

type Db = ReturnType<typeof createServerSupabase>;

export interface VersionLayoutQaRow {
    id: string;
    document_id: string;
    storage_path: string;
    pdf_storage_path: string | null;
    source: string | null;
    layout_qa_status: LayoutQaStatus | null;
    layout_qa_report: DocumentLayoutQaReport | null;
    layout_qa_checked_at: string | null;
}

export interface ExportableVersionResult {
    version: VersionLayoutQaRow;
    status: "source" | "passed";
    report: DocumentLayoutQaReport | null;
}

function normalizedFileType(value: string | null | undefined): string {
    return (value ?? "").trim().toLowerCase().replace(/^\./, "");
}

function isUploadSource(source: string | null): boolean {
    return source === "upload" || source === "user_upload";
}

function minimalFailureReport(
    artifactType: "docx" | "pdf",
    code: string,
    bytes?: Buffer,
): DocumentLayoutQaReport {
    return {
        schema_version: 1,
        artifact_type: artifactType,
        sha256: bytes
            ? crypto.createHash("sha256").update(bytes).digest("hex")
            : "",
        checked_at: new Date().toISOString(),
        status: "failed",
        failure_code:
            code === "DOCUMENT_LAYOUT_QA_FAILED"
                ? "DOCUMENT_LAYOUT_QA_FAILED"
                : "DOCUMENT_QA_UNAVAILABLE",
    };
}

export function layoutQaVersionValues(
    report: DocumentLayoutQaReport,
): Record<string, unknown> {
    return {
        layout_qa_status: report.status === "passed" ? "passed" : "failed",
        layout_qa_report: report,
        layout_qa_checked_at: report.checked_at,
    };
}

export function sourceLayoutQaVersionValues(): Record<string, unknown> {
    return {
        layout_qa_status: "source",
        layout_qa_report: null,
        layout_qa_checked_at: null,
    };
}

export async function verifyDerivedArtifact(params: {
    bytes: Buffer;
    fileType: string;
    pdfRenditionBytes?: Buffer | null;
    trackedViews?: boolean;
    expectedText?: string;
}): Promise<DocumentLayoutQaReport | null> {
    const fileType = normalizedFileType(params.fileType);
    if (fileType !== "docx" && fileType !== "pdf") return null;
    if (fileType === "pdf") {
        return verifyPdfLayout(params.bytes, {
            expectedText: params.expectedText,
        });
    }

    const report = await verifyDocxLayout(params.bytes, {
        trackedViews: params.trackedViews,
    });
    if (params.pdfRenditionBytes) {
        const hasTrackedViews =
            params.trackedViews ??
            ((report.inspection?.trackedInsertionCount ?? 0) +
                (report.inspection?.trackedDeletionCount ?? 0) >
                0);
        const expectedText = await extractDocxTextView(
            params.bytes,
            hasTrackedViews ? "all" : "accepted",
        );
        const rendition = await analyzePdfLayout(params.pdfRenditionBytes, {
            expectedText,
        });
        report.rendition_pdf = rendition;
        if (rendition.status !== "passed") {
            report.status = "failed";
            report.failure_code = "DOCUMENT_LAYOUT_QA_FAILED";
            throw new DocumentLayoutQaError(
                "DOCUMENT_LAYOUT_QA_FAILED",
                "The generated PDF rendition failed layout verification.",
                report,
            );
        }
    }
    return report;
}

async function persistStatus(params: {
    db: Db;
    versionId: string;
    status: LayoutQaStatus;
    report: DocumentLayoutQaReport | null;
    checkedAt: string | null;
}): Promise<void> {
    const { error } = await params.db
        .from("document_versions")
        .update({
            layout_qa_status: params.status,
            layout_qa_report: params.report,
            layout_qa_checked_at: params.checkedAt,
        })
        .eq("id", params.versionId);
    if (error) {
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            `Document QA state could not be persisted. ${describeSupabaseError(error)}`,
            params.report,
        );
    }
}

export async function ensureVersionExportable(params: {
    db: Db;
    documentId: string;
    versionId?: string | null;
    fileType?: string | null;
}): Promise<ExportableVersionResult> {
    let targetVersionId = params.versionId ?? null;
    let fileType = normalizedFileType(params.fileType);
    if (!targetVersionId || !fileType) {
        const { data: document, error } = await params.db
            .from("documents")
            .select("id, current_version_id, file_type")
            .eq("id", params.documentId)
            .single();
        if (error || !document) {
            throw new DocumentLayoutQaError(
                DOCUMENT_QA_UNAVAILABLE,
                "The document version could not be resolved for layout verification.",
            );
        }
        targetVersionId = targetVersionId ?? String(document.current_version_id ?? "");
        fileType = fileType || normalizedFileType(document.file_type as string | null);
    }
    if (!targetVersionId) {
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            "The document has no active version to verify.",
        );
    }

    const { data, error } = await params.db
        .from("document_versions")
        .select(
            "id, document_id, storage_path, pdf_storage_path, source, layout_qa_status, layout_qa_report, layout_qa_checked_at",
        )
        .eq("id", targetVersionId)
        .eq("document_id", params.documentId)
        .single();
    if (error || !data) {
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            `The document QA record could not be loaded. ${describeSupabaseError(error)}`,
        );
    }
    const version = data as VersionLayoutQaRow;
    if (version.layout_qa_status === "passed") {
        return { version, status: "passed", report: version.layout_qa_report };
    }
    if (version.layout_qa_status === "failed") {
        throw new DocumentLayoutQaError(
            version.layout_qa_report?.failure_code ?? "DOCUMENT_LAYOUT_QA_FAILED",
            "This document version failed layout verification and cannot be exported.",
            version.layout_qa_report,
        );
    }
    if (isUploadSource(version.source) || version.layout_qa_status === "source") {
        if (version.layout_qa_status !== "source") {
            await persistStatus({
                db: params.db,
                versionId: version.id,
                status: "source",
                report: null,
                checkedAt: null,
            });
            version.layout_qa_status = "source";
        }
        return { version, status: "source", report: null };
    }
    if (fileType !== "docx" && fileType !== "pdf") {
        await persistStatus({
            db: params.db,
            versionId: version.id,
            status: "source",
            report: null,
            checkedAt: null,
        });
        version.layout_qa_status = "source";
        return { version, status: "source", report: null };
    }

    const [raw, rendition] = await Promise.all([
        downloadFile(version.storage_path),
        fileType === "docx" && version.pdf_storage_path
            ? downloadFile(version.pdf_storage_path)
            : Promise.resolve(null),
    ]);
    if (!raw) {
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            "The document bytes could not be loaded for layout verification.",
        );
    }

    try {
        const report = await verifyDerivedArtifact({
            bytes: Buffer.from(raw),
            fileType,
            pdfRenditionBytes: rendition ? Buffer.from(rendition) : null,
        });
        if (!report) return { version, status: "source", report: null };
        await persistStatus({
            db: params.db,
            versionId: version.id,
            status: "passed",
            report,
            checkedAt: report.checked_at,
        });
        version.layout_qa_status = "passed";
        version.layout_qa_report = report;
        version.layout_qa_checked_at = report.checked_at;
        return { version, status: "passed", report };
    } catch (cause) {
        const qaError =
            cause instanceof DocumentLayoutQaError
                ? cause
                : new DocumentLayoutQaError(
                      DOCUMENT_QA_UNAVAILABLE,
                      "Document layout verification is temporarily unavailable.",
                      null,
                      { cause },
                  );
        const report =
            qaError.report ??
            minimalFailureReport(
                fileType as "docx" | "pdf",
                qaError.code,
                Buffer.from(raw),
            );
        await persistStatus({
            db: params.db,
            versionId: version.id,
            status: "failed",
            report,
            checkedAt: report.checked_at,
        }).catch(() => {});
        throw qaError;
    }
}


export async function ensureVersionPdfRenditionExportable(params: {
    db: Db;
    documentId: string;
    versionId: string;
    fileType?: string | null;
}): Promise<{
    bytes: Buffer;
    report: DocumentLayoutQaReport;
    expectedText?: string;
}> {
    const verified = await ensureVersionExportable({
        db: params.db,
        documentId: params.documentId,
        versionId: params.versionId,
        fileType: params.fileType,
    });
    const version = verified.version;
    if (!version.pdf_storage_path) {
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            "The document has no PDF rendition to verify.",
        );
    }
    const raw = await downloadFile(version.pdf_storage_path);
    if (!raw) {
        throw new DocumentLayoutQaError(
            DOCUMENT_QA_UNAVAILABLE,
            "The PDF rendition bytes could not be loaded for layout verification.",
        );
    }
    const bytes = Buffer.from(raw);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const cachedReport = version.layout_qa_report;
    const cachedRenditionDigest =
        cachedReport?.artifact_type === "pdf"
            ? cachedReport.sha256
            : cachedReport?.rendition_pdf?.sha256;
    if (
        cachedReport?.status === "passed" &&
        cachedRenditionDigest === digest
    ) {
        return { bytes, report: cachedReport };
    }
    if (
        cachedReport?.status === "failed" &&
        cachedRenditionDigest === digest
    ) {
        throw new DocumentLayoutQaError(
            cachedReport.failure_code ?? "DOCUMENT_LAYOUT_QA_FAILED",
            "This PDF rendition failed layout verification and cannot be used.",
            cachedReport,
        );
    }

    if (verified.status === "passed") {
        const mismatch = minimalFailureReport(
            "pdf",
            "DOCUMENT_LAYOUT_QA_FAILED",
            bytes,
        );
        await persistStatus({
            db: params.db,
            versionId: version.id,
            status: "failed",
            report: mismatch,
            checkedAt: mismatch.checked_at,
        });
        throw new DocumentLayoutQaError(
            "DOCUMENT_LAYOUT_QA_FAILED",
            "The verified PDF rendition no longer matches its stored QA hash.",
            mismatch,
        );
    }

    let expectedText: string | undefined;
    if (normalizedFileType(params.fileType) === "docx") {
        const source = await downloadFile(version.storage_path);
        if (!source) {
            throw new DocumentLayoutQaError(
                DOCUMENT_QA_UNAVAILABLE,
                "The source DOCX could not be loaded for rendition verification.",
            );
        }
        expectedText = await extractDocxTextView(Buffer.from(source), "all");
    }

    try {
        const report = await verifyPdfLayout(bytes, { expectedText });
        await persistStatus({
            db: params.db,
            versionId: version.id,
            status: "source",
            report,
            checkedAt: report.checked_at,
        });
        return { bytes, report, expectedText };
    } catch (cause) {
        const qaError =
            cause instanceof DocumentLayoutQaError
                ? cause
                : new DocumentLayoutQaError(
                      DOCUMENT_QA_UNAVAILABLE,
                      "PDF rendition verification is temporarily unavailable.",
                      null,
                      { cause },
                  );
        const report =
            qaError.report ??
            minimalFailureReport("pdf", qaError.code, bytes);
        await persistStatus({
            db: params.db,
            versionId: version.id,
            status: "source",
            report,
            checkedAt: report.checked_at,
        }).catch(() => {});
        throw qaError;
    }
}
