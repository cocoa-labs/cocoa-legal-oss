import JSZip from "jszip";
import { sanitizeHtmlForConversion } from "./htmlSanitize";
import { convertWithLibreOffice } from "./libreoffice";

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Mammoth and LibreOffice both look
 * up entries by exact string and miss those files, producing empty output
 * or conversion failures. Rewrite any such entries to the canonical
 * forward-slash form before handing the buffer off.
 *
 * Safe to call on non-ZIP input — returns the buffer unchanged if
 * JSZip can't parse it.
 */
export async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return buffer;
  }
  const renames: [string, string][] = [];
  zip.forEach((relativePath) => {
    if (relativePath.includes("\\")) {
      renames.push([relativePath, relativePath.replace(/\\/g, "/")]);
    }
  });
  if (renames.length === 0) return buffer;
  for (const [oldPath, newPath] of renames) {
    const entry = zip.file(oldPath);
    if (!entry) continue;
    const content = await entry.async("nodebuffer");
    zip.remove(oldPath);
    zip.file(newPath, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Wrap sanitized body HTML in a minimal styled document chrome. The
 * <style> block is OUR controlled CSS (no user input interpolated into
 * it), so the only injection point is `${body}` — which sanitize-html
 * has already cleaned.
 */
function wrapSanitizedBody(sanitizedBody: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.5;max-width:800px;margin:2em auto;padding:0 1em;}
      pre,code{font-family:Menlo,Consolas,monospace;background:#f4f4f4;padding:0.2em 0.4em;border-radius:3px;}
      pre{padding:1em;overflow-x:auto;}
      blockquote{border-left:4px solid #ddd;padding-left:1em;color:#555;margin-left:0;}
      table{border-collapse:collapse;margin:1em 0;}
      th,td{border:1px solid #ccc;padding:0.5em 1em;}
      h1,h2,h3,h4{margin-top:1.5em;}
    </style></head><body>${sanitizedBody}</body></html>`;
}

/**
 * Convert any LibreOffice-readable buffer to PDF. LibreOffice's own import
 * filters detect the input format from the bytes — DOCX, DOC, ODT, RTF, XLS,
 * XLSX, ODS, CSV, PPT, PPTX, ODP, HTML, TXT and EPUB are all supported.
 * `convertWithLibreOffice` defaults its `--convert-to` target to PDF on its
 * own, so everything we pass it from here describes the INPUT.
 *
 * We still pass `inputExtension` when we know it. Detection is by content, but
 * `convertWithLibreOffice` names the temp file it hands soffice after that
 * hint, and a correctly-named file makes the filter choice deterministic
 * instead of leaving it to a sniff. Omitting the hint is safe — the converter
 * falls back to its own magic-byte probe.
 *
 * Special case: Markdown. LibreOffice has no native Markdown importer.
 * Callers should pass `ext === "md"` so we can pre-render to HTML via
 * `marked` and then hand the HTML buffer to LibreOffice.
 *
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function convertToPdf(
  buffer: Buffer,
  ext?: string,
): Promise<Buffer> {
  const normalizedExt = (ext ?? "").toLowerCase().replace(/^\./, "");

  // Markdown → sanitized HTML → LibreOffice. marked produces HTML that
  // includes any raw inline HTML the user wrote; sanitize-html strips
  // <script>, <iframe>, external <img>/<link>/<style>/etc. before
  // LibreOffice ever sees it. Closes both the SSRF surface (LibreOffice
  // fetching external URLs while rendering) and the </style> template-
  // breakage edge case.
  if (normalizedExt === "md") {
    const { marked } = await import("marked");
    const renderedBody = await marked.parse(buffer.toString("utf-8"));
    const sanitized = sanitizeHtmlForConversion(renderedBody);
    const html = wrapSanitizedBody(sanitized);
    // Markdown reaches LibreOffice as HTML, so the hint describes what we
    // actually hand it, not what the caller passed.
    return convertWithLibreOffice(Buffer.from(html, "utf-8"), {
      inputExtension: "html",
    });
  }

  // Direct HTML upload → sanitize before LibreOffice. Same SSRF
  // mitigation as Markdown — user-supplied HTML cannot reference
  // external resources by the time LibreOffice imports it.
  if (normalizedExt === "html" || normalizedExt === "htm") {
    const sanitized = sanitizeHtmlForConversion(buffer.toString("utf-8"));
    const html = wrapSanitizedBody(sanitized);
    // `htm` normalizes to `html`: the sanitized wrapper we built above is what
    // soffice opens, whichever spelling the upload used.
    return convertWithLibreOffice(Buffer.from(html, "utf-8"), {
      inputExtension: "html",
    });
  }

  // normalizeDocxZipPaths is a safe no-op on non-ZIP buffers — it returns
  // the input untouched. So we can apply it uniformly to every input.
  const normalized = await normalizeDocxZipPaths(buffer);
  // No `ext` from the caller (docxToPdf, and any legacy call site) → say
  // nothing and let the converter sniff, rather than asserting a format.
  return convertWithLibreOffice(
    normalized,
    normalizedExt ? { inputExtension: normalizedExt } : {},
  );
}

/**
 * @deprecated Prefer `convertToPdf(buffer, ext)`. Kept as a one-line alias
 * so existing call sites that only handled DOCX/DOC don't break — the new
 * function is fully backward-compatible when called without an `ext`
 * (DOCX/DOC happen to be the formats most callers pass).
 */
export const docxToPdf = (buffer: Buffer): Promise<Buffer> =>
  convertToPdf(buffer);

export function convertedPdfKey(userId: string, docId: string): string {
  return `converted-pdfs/${userId}/${docId}.pdf`;
}
