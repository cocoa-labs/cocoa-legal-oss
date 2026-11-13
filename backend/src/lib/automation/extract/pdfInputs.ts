// backend/src/lib/automation/extract/pdfInputs.ts
//
// Loads an inbound email's PDF attachments for the extraction stage: the
// raw bytes (base64) become native PDF inputs for completeStructured, and
// the per-page text — recovered via documentExtraction's pdfjs extractor,
// whose output carries a "[Page N]" marker per page — becomes the evidence
// the deterministic citation verifier checks quotes against.
//
// Guardrails: any PDF over 30 MB or 90 pages is skipped (reported in
// `unprocessed`, never thrown), and non-PDF attachments are reported as
// "not processed in v1". One bad attachment must never sink the run — but
// a storage/extraction failure is recorded per-file so the review surface
// can say exactly what the model did NOT see.

import type { createServerSupabase } from "../../supabase";
import type { PdfDocumentInput } from "../../llm/structured";
import { loadActiveVersion } from "../../documentVersions";
import { downloadFile } from "../../storage";
import { extractDocumentText } from "../../documentExtraction";
import type { EmailAttachmentRef, EmailMessage } from "../../email/store";

type Db = ReturnType<typeof createServerSupabase>;

/** PDFs above these caps are skipped (reported, not thrown). */
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
export const MAX_PDF_PAGES = 90;

export interface RunDocuments {
    /** Native PDF inputs for completeStructured, in attachment order. */
    documents: PdfDocumentInput[];
    /**
     * Per-document per-page text, keyed by document id; insertion order
     * matches `documents` (so the first key is the first loaded PDF —
     * stage.ts uses that as the proposal's source_document_id). Page i's
     * text is at index i-1; pages pdfjs found no text on are "".
     */
    pageTexts: Map<string, string[]>;
    /** Attachments the model will NOT see, and why. */
    unprocessed: { filename: string; reason: string }[];
}

/** True when an attachment ref looks like a PDF (content type or extension). */
export function isPdfAttachment(ref: {
    filename: string;
    content_type?: string | null;
}): boolean {
    const type = (ref.content_type ?? "").toLowerCase();
    if (type.includes("application/pdf")) return true;
    return /\.pdf$/i.test(ref.filename ?? "");
}

const PAGE_MARKER = /\[Page (\d+)\]\n?/g;

/**
 * Split extractPdfText/extractDocumentText output — "[Page N]\n<text>"
 * blocks joined by blank lines — into a page-indexed array (page 1 at
 * index 0). Pages missing from the output become "" so indices stay
 * aligned with the PDF's real page numbers. Text without any marker (an
 * extractor fallback) is treated as a single page; empty text → [].
 */
export function splitPageMarkedText(text: string): string[] {
    const raw = text ?? "";
    const matches = [...raw.matchAll(PAGE_MARKER)];
    if (matches.length === 0) {
        const whole = raw.trim();
        return whole ? [whole] : [];
    }
    const pages: string[] = [];
    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const pageNumber = Number.parseInt(match[1], 10);
        if (!Number.isFinite(pageNumber) || pageNumber < 1) continue;
        const start = (match.index ?? 0) + match[0].length;
        const end =
            i + 1 < matches.length ? matches[i + 1].index : raw.length;
        while (pages.length < pageNumber - 1) pages.push("");
        pages[pageNumber - 1] = raw.slice(start, end).trim();
    }
    return pages;
}

/** Injectable seams so tests never touch R2/pdfjs. */
export interface LoadRunDocumentsDeps {
    loadActiveVersionFn?: typeof loadActiveVersion;
    downloadFileFn?: typeof downloadFile;
    extractTextFn?: typeof extractDocumentText;
}

async function loadOnePdf(
    db: Db,
    ref: EmailAttachmentRef,
    out: RunDocuments,
    deps: LoadRunDocumentsDeps,
): Promise<void> {
    const load = deps.loadActiveVersionFn ?? loadActiveVersion;
    const download = deps.downloadFileFn ?? downloadFile;
    const extract = deps.extractTextFn ?? extractDocumentText;

    const active = await load(ref.document_id, db, ref.version_id ?? null);
    if (!active) {
        out.unprocessed.push({
            filename: ref.filename,
            reason: "stored document version not found",
        });
        return;
    }
    const bytes = await download(active.storage_path);
    if (!bytes) {
        out.unprocessed.push({
            filename: ref.filename,
            reason: "document bytes unavailable in storage",
        });
        return;
    }
    if (bytes.byteLength > MAX_PDF_BYTES) {
        out.unprocessed.push({
            filename: ref.filename,
            reason: `PDF exceeds ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB cap`,
        });
        return;
    }
    // Encode BEFORE text extraction: pdfjs transfers the buffer to its
    // worker, detaching the underlying ArrayBuffer — reading `bytes` after
    // extract() throws "Cannot perform Construct on a detached ArrayBuffer".
    const base64 = Buffer.from(bytes).toString("base64");
    const text = await extract({
        fileType: "pdf",
        rawBuf: bytes,
        pdfRenditionBuf: null,
    });
    const pages = splitPageMarkedText(text);
    if (pages.length > MAX_PDF_PAGES) {
        out.unprocessed.push({
            filename: ref.filename,
            reason: `PDF exceeds ${MAX_PDF_PAGES}-page cap`,
        });
        return;
    }
    out.documents.push({
        data: base64,
        filename: ref.filename,
    });
    out.pageTexts.set(ref.document_id, pages);
}

/**
 * Load every processable PDF attachment on an inbound email. Per-attachment
 * failures land in `unprocessed` with a reason; only a systemic failure
 * (e.g. the documents table unreachable) propagates, and the pipeline turns
 * that into a retry.
 */
export async function loadRunDocuments(
    db: Db,
    email: Pick<EmailMessage, "attachments">,
    deps: LoadRunDocumentsDeps = {},
): Promise<RunDocuments> {
    const out: RunDocuments = {
        documents: [],
        pageTexts: new Map(),
        unprocessed: [],
    };
    for (const ref of email.attachments ?? []) {
        if (!isPdfAttachment(ref)) {
            out.unprocessed.push({
                filename: ref.filename,
                reason: "not a PDF — not processed in v1",
            });
            continue;
        }
        await loadOnePdf(db, ref, out, deps);
    }
    return out;
}
