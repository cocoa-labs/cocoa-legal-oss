/**
 * Dependency-free MIME builder for outbound Gmail messages.
 *
 * Produces a base64url-encoded RFC822 string suitable for the `raw` field of
 * Gmail's `users.messages.send`. Supports multiple recipients, RFC2047-encoded
 * subjects, text/html alternative bodies, inline images (multipart/related),
 * file attachments (multipart/mixed), and reply threading headers. No
 * nodemailer — the MIME string is assembled by hand so the connector layer
 * stays free of heavy transitive deps.
 */
import { randomUUID } from "node:crypto";
import type { EmailAttachment, SendEmailInput } from "../types";

/** Standard EOL for MIME headers/bodies. */
const CRLF = "\r\n";

/** base64url-encode a Buffer (RFC 4648 §5: '+/' → '-_', no padding). */
export function base64url(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/**
 * RFC2047-encode a header value when it contains non-ASCII characters,
 * otherwise return it unchanged. Uses the UTF-8 "B" (base64) encoding form.
 */
function encodeHeaderWord(value: string): string {
    if (/^[\x00-\x7F]*$/.test(value)) {
        return value;
    }
    const encoded = Buffer.from(value, "utf8").toString("base64");
    return `=?UTF-8?B?${encoded}?=`;
}

/** Safe dual filename parameters for old and RFC 5987-aware mail clients. */
function filenameParameters(filename: string): string {
    const clean = filename.replace(/[\r\n\0]/g, "").trim() || "attachment";
    const fallback = clean
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]/g, "_")
        .replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(clean).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function contentTypeNameParameters(filename: string): string {
    const parameters = filenameParameters(filename);
    return parameters.replace(/^filename=/, "name=").replace(/; filename\*=/, "; name*=");
}

/** Join a list of addresses into a single header value (comma-separated). */
function joinAddresses(addresses: string[]): string {
    return addresses.map((addr) => addr.trim()).filter(Boolean).join(", ");
}

/** Split a string into 76-char lines, as required for base64 MIME bodies. */
function chunk76(value: string): string {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 76) {
        parts.push(value.slice(i, i + 76));
    }
    return parts.join(CRLF);
}

/** Encode a UTF-8 string as a 76-column base64 MIME body. */
function encodeBody(value: string): string {
    return chunk76(Buffer.from(value, "utf8").toString("base64"));
}

/** Generate an RFC822 Message-ID rooted at the sender's domain. */
function generateMessageId(from: string): string {
    const at = from.lastIndexOf("@");
    const domain =
        at >= 0 ? from.slice(at + 1).replace(/>.*$/, "").trim() : "localhost";
    return `<${randomUUID()}@${domain || "localhost"}>`;
}

/** Render a single header line. */
function header(name: string, value: string): string {
    return `${name}: ${value}`;
}

/**
 * Build a base64url-encoded RFC822 message for Gmail `users.messages.send`.
 *
 * Body selection:
 *  - text only        → text/plain
 *  - html only        → text/html
 *  - both             → multipart/alternative
 * Inline images (attachments carrying a contentId) wrap the body in a
 * multipart/related block. File attachments wrap the whole thing in a
 * multipart/mixed envelope. Nesting when both are present:
 *   multipart/mixed > multipart/related > multipart/alternative.
 */
export function buildRawMessage(input: SendEmailInput & { from: string }): string {
    const messageId = generateMessageId(input.from);
    const hasText = typeof input.text === "string" && input.text.length > 0;
    const hasHtml = typeof input.html === "string" && input.html.length > 0;

    // Split attachments into inline images (Content-ID, referenced by the HTML
    // as cid:) and downloadable files. Inline images need an HTML body to point
    // at them, so without HTML they are demoted to normal file attachments —
    // never emit a multipart/related whose cid nothing references.
    const allAttachments = input.attachments ?? [];
    const inlineImages = hasHtml
        ? allAttachments.filter((a) => a.contentId)
        : [];
    const files = hasHtml
        ? allAttachments.filter((a) => !a.contentId)
        : allAttachments;
    const hasInline = inlineImages.length > 0;
    const hasFiles = files.length > 0;

    const topHeaders: string[] = [];
    topHeaders.push(header("From", input.from));
    topHeaders.push(header("To", joinAddresses(input.to ?? [])));
    if (input.cc && input.cc.length > 0) {
        topHeaders.push(header("Cc", joinAddresses(input.cc)));
    }
    if (input.bcc && input.bcc.length > 0) {
        topHeaders.push(header("Bcc", joinAddresses(input.bcc)));
    }
    // Address headers are emitted raw (same discipline as From/To above);
    // trim like joinAddresses does and skip a blank value entirely.
    const replyTo = input.replyTo?.trim();
    if (replyTo) {
        topHeaders.push(header("Reply-To", replyTo));
    }
    topHeaders.push(header("Subject", encodeHeaderWord(input.subject ?? "")));
    topHeaders.push(header("MIME-Version", "1.0"));
    topHeaders.push(header("Message-ID", messageId));
    topHeaders.push(header("Date", new Date().toUTCString()));
    if (input.inReplyTo) {
        topHeaders.push(header("In-Reply-To", input.inReplyTo));
        topHeaders.push(header("References", input.inReplyTo));
    }

    /** Render a text or html leaf part (header block + base64 body). */
    function renderBodyPart(contentType: string, body: string): string {
        const partHeaders = [
            header("Content-Type", `${contentType}; charset="UTF-8"`),
            header("Content-Transfer-Encoding", "base64"),
        ];
        return `${partHeaders.join(CRLF)}${CRLF}${CRLF}${encodeBody(body)}`;
    }

    /**
     * Render the body (single part or multipart/alternative). Returns the
     * header lines to merge into the enclosing block plus the rendered body.
     */
    function renderBody(): { headers: string[]; body: string } {
        if (hasText && hasHtml) {
            const altBoundary = `alt_${randomUUID()}`;
            const segments = [
                `--${altBoundary}`,
                renderBodyPart("text/plain", input.text as string),
                `--${altBoundary}`,
                renderBodyPart("text/html", input.html as string),
                `--${altBoundary}--`,
            ];
            return {
                headers: [
                    header(
                        "Content-Type",
                        `multipart/alternative; boundary="${altBoundary}"`,
                    ),
                ],
                body: segments.join(CRLF),
            };
        }
        if (hasHtml) {
            return {
                headers: [
                    header("Content-Type", `text/html; charset="UTF-8"`),
                    header("Content-Transfer-Encoding", "base64"),
                ],
                body: encodeBody(input.html as string),
            };
        }
        // Default to text/plain (empty string when no body supplied).
        return {
            headers: [
                header("Content-Type", `text/plain; charset="UTF-8"`),
                header("Content-Transfer-Encoding", "base64"),
            ],
            body: encodeBody(input.text ?? ""),
        };
    }

    /** Render one inline image part (Content-ID + inline disposition). */
    function renderInlinePart(img: EmailAttachment): string {
        const partHeaders = [
            header(
                "Content-Type",
                `${img.contentType}; ${contentTypeNameParameters(img.filename)}`,
            ),
            header("Content-Transfer-Encoding", "base64"),
            // Angle brackets on the wire; the HTML references cid:<id> without them.
            header("Content-ID", `<${img.contentId}>`),
            header(
                "Content-Disposition",
                `inline; ${filenameParameters(img.filename)}`,
            ),
        ];
        return `${partHeaders.join(CRLF)}${CRLF}${CRLF}${chunk76(
            img.content.toString("base64"),
        )}`;
    }

    /** Render one downloadable file attachment part. */
    function renderAttachmentPart(att: EmailAttachment): string {
        const attHeaders = [
            header(
                "Content-Type",
                `${att.contentType}; ${contentTypeNameParameters(att.filename)}`,
            ),
            header("Content-Transfer-Encoding", "base64"),
            header(
                "Content-Disposition",
                `attachment; ${filenameParameters(att.filename)}`,
            ),
        ];
        return `${attHeaders.join(CRLF)}${CRLF}${CRLF}${chunk76(
            att.content.toString("base64"),
        )}`;
    }

    /**
     * The content block delivered to recipients: the body (single part or
     * multipart/alternative), wrapped in multipart/related when inline images
     * are present so the HTML can reference them by cid.
     */
    function renderContent(): { headers: string[]; body: string } {
        const body = renderBody();
        if (!hasInline) return body;
        const relBoundary = `rel_${randomUUID()}`;
        const bodyBlock = `${body.headers.join(CRLF)}${CRLF}${CRLF}${body.body}`;
        // RFC 2387 `type` hint = the root part's own content type.
        const rootType = body.headers[0]
            .replace(/^Content-Type:\s*/i, "")
            .split(";")[0]
            .trim();
        const segments = [`--${relBoundary}`, bodyBlock];
        for (const img of inlineImages) {
            segments.push(`--${relBoundary}`, renderInlinePart(img));
        }
        segments.push(`--${relBoundary}--`);
        return {
            headers: [
                header(
                    "Content-Type",
                    `multipart/related; boundary="${relBoundary}"; type="${rootType}"`,
                ),
            ],
            body: segments.join(CRLF),
        };
    }

    let raw: string;

    if (hasFiles) {
        const mixedBoundary = `mixed_${randomUUID()}`;
        const content = renderContent();

        // First part of the mixed envelope is the content block (the body, or
        // the related block wrapping the body + inline images).
        const contentPart = `${content.headers.join(CRLF)}${CRLF}${CRLF}${content.body}`;
        const segments: string[] = [`--${mixedBoundary}`, contentPart];

        for (const att of files) {
            segments.push(`--${mixedBoundary}`, renderAttachmentPart(att));
        }
        segments.push(`--${mixedBoundary}--`);

        const headers = [
            ...topHeaders,
            header(
                "Content-Type",
                `multipart/mixed; boundary="${mixedBoundary}"`,
            ),
        ];
        raw = `${headers.join(CRLF)}${CRLF}${CRLF}${segments.join(CRLF)}`;
    } else {
        const content = renderContent();
        const headers = [...topHeaders, ...content.headers];
        raw = `${headers.join(CRLF)}${CRLF}${CRLF}${content.body}`;
    }

    return base64url(Buffer.from(raw, "utf8"));
}
