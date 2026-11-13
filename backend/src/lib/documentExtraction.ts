// Shared document-extraction module. Single source of truth for "given
// a document with bytes and an optional PDF rendition, return its text /
// markdown / structure tree." Replaces ad-hoc `pdf | docx | else`
// ternaries scattered across the routes/tools.
//
// Routing rule:
//   - file_type === "pdf"            → use rawBuf with pdfjs.
//   - file_type === "docx"           → use rawBuf with mammoth / the
//                                      docx tracked-change-aware
//                                      extractor.
//   - else (Tier 2)                  → use pdfRenditionBuf with pdfjs.
//                                      If null, return "" and emit a
//                                      structured warning so callers
//                                      can flag the result.
//
// Why this fixes the catastrophic tabular-cell hallucination: before,
// every Tier 2 file_type fell through to a mammoth extractor that
// throws on non-DOCX bytes; the catch returned "" and the LLM ran
// against an empty document. Now, the same call goes through the PDF
// rendition that was generated at upload, returning real text.

import { extractPdfText } from "./chatTools";
import { extractDocxBodyText } from "./docxTrackedChanges";
import { normalizeDocxZipPaths } from "./convert";

// ---------------------------------------------------------------------------
// Internal extractors (moved from tabular.ts so all extraction lives in one
// module; tabular.ts now imports the public extract* functions below).
// ---------------------------------------------------------------------------

async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// Public extraction API
// ---------------------------------------------------------------------------

export interface ExtractionInputs {
    /** Lowercase file extension stored on the document row (e.g. "pdf", "xlsx"). */
    fileType: string;
    /** Bytes from active.storage_path — the original uploaded file. */
    rawBuf: ArrayBuffer;
    /**
     * Bytes from active.pdf_storage_path — the LibreOffice-converted PDF
     * rendition. Null when no rendition was generated (e.g., a PDF
     * upload where storage_path === pdf_storage_path, OR a Tier 2
     * upload where conversion failed at upload time). For PDFs, the
     * caller may pass null safely; we'll use rawBuf.
     */
    pdfRenditionBuf: ArrayBuffer | null;
}

/**
 * Plain-text extraction for LLM consumption (`read_document`).
 *
 * Native PDF/DOCX reading preserves the existing format-native extractor
 * so tracked-change-aware anchors still work for DOCX edits. Tier 2
 * extracts from the PDF rendition so the LLM sees the rendered content
 * of XLSX / PPTX / MD / HTML / TXT instead of garbage from a mammoth
 * fallback on non-DOCX bytes.
 */
export async function extractDocumentText(
    inputs: ExtractionInputs,
): Promise<string> {
    const ft = inputs.fileType.toLowerCase();
    if (ft === "pdf") {
        return extractPdfText(inputs.rawBuf);
    }
    if (ft === "docx") {
        // Preserve the existing accepted-view extractor (mammoth-with-
        // tracked-changes-flattening). On empty result OR throw, fall
        // back to mammoth raw text — same legacy behavior. Both are
        // wrapped because JSZip throws on malformed buffers.
        let text = "";
        try {
            text = await extractDocxBodyText(Buffer.from(inputs.rawBuf));
        } catch {
            text = "";
        }
        if (text) return text;
        try {
            const mammoth = await import("mammoth");
            const result = await mammoth.extractRawText({
                buffer: Buffer.from(inputs.rawBuf),
            });
            return result.value;
        } catch {
            return "";
        }
    }
    // Tier 2: extract from the PDF rendition.
    if (inputs.pdfRenditionBuf) {
        return extractPdfText(inputs.pdfRenditionBuf);
    }
    console.warn(
        `[documentExtraction] No PDF rendition available for file_type="${ft}"; returning empty text. Upload-time conversion likely failed.`,
    );
    return "";
}

/**
 * Markdown extraction for tabular-review cell prompts.
 *
 * Same Tier 1 / Tier 2 routing as extractDocumentText. Returns markdown
 * because tabular column prompts query the LLM with markdown-formatted
 * document context (existing convention).
 */
export async function extractDocumentMarkdown(
    inputs: ExtractionInputs,
): Promise<string> {
    const ft = inputs.fileType.toLowerCase();
    if (ft === "pdf") {
        return extractPdfMarkdown(inputs.rawBuf);
    }
    if (ft === "docx") {
        return extractDocxMarkdown(inputs.rawBuf);
    }
    if (inputs.pdfRenditionBuf) {
        return extractPdfMarkdown(inputs.pdfRenditionBuf);
    }
    console.warn(
        `[documentExtraction] No PDF rendition available for file_type="${ft}"; returning empty markdown. Tabular cell will be flagged as error.`,
    );
    return "";
}

// ---------------------------------------------------------------------------
// Structure tree (TOC) extraction
// ---------------------------------------------------------------------------

interface StructureNode {
    id: string;
    title: string;
    level: number;
    page_number: number | null;
    children: unknown[];
}

async function extractPdfOutline(
    content: ArrayBuffer,
): Promise<StructureNode[] | null> {
    const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
    );
    const pdf = await (
        pdfjsLib as unknown as {
            getDocument: (opts: unknown) => {
                promise: Promise<{
                    numPages: number;
                    getOutline: () => Promise<{ title?: string }[]>;
                }>;
            };
        }
    ).getDocument({ data: new Uint8Array(content) }).promise;
    if (pdf.numPages <= 5) return null;
    const outline = await pdf.getOutline();
    if (outline?.length) {
        return outline.map((item, i) => ({
            id: `h1-${i}`,
            title: item.title ?? `Item ${i + 1}`,
            level: 1,
            page_number: null,
            children: [],
        }));
    }
    return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
    }));
}

async function extractDocxStructure(
    content: ArrayBuffer,
): Promise<StructureNode[] | null> {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
    });
    const lines = result.value.split("\n").filter((l) => l.trim());
    const nodes: StructureNode[] = lines.slice(0, 30).map((line, i) => ({
        id: `h1-${i}`,
        title: line.slice(0, 100),
        level: 1,
        page_number: null,
        children: [],
    }));
    return nodes.length ? nodes : null;
}

/**
 * Structure-tree (outline / TOC) extraction for the doc-review sidebar.
 *
 * PDFs use their own outline (or page fallback). DOCX uses mammoth
 * raw-text first-30-lines (legacy heuristic). Tier 2 uses the PDF
 * rendition's outline so xlsx/pptx/md/etc. all get a meaningful TOC
 * instead of the silent null we returned before.
 */
export async function extractDocumentStructureTree(
    inputs: ExtractionInputs,
): Promise<unknown[] | null> {
    const ft = inputs.fileType.toLowerCase();
    try {
        if (ft === "pdf") {
            return await extractPdfOutline(inputs.rawBuf);
        }
        if (ft === "docx") {
            return await extractDocxStructure(inputs.rawBuf);
        }
        if (inputs.pdfRenditionBuf) {
            return await extractPdfOutline(inputs.pdfRenditionBuf);
        }
        return null;
    } catch {
        return null;
    }
}
