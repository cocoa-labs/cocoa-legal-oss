// backend/src/lib/signatures/emailTemplates.ts
//
// Branded, inline-styled HTML (+ plain-text fallback) for the e-signature
// emails. Shares the firm-wide branded shell (email/branding.ts) — same
// wordmark, palette, card, and CTA button as every other Quill email — but
// keeps its own e-sign-specific footer. EVERY caller-supplied string is
// HTML-escaped before it enters the markup (subject/message/document name are
// user-controlled).

import {
    shell as brandedShell,
    button,
    heading,
    escapeHtml,
    MUTED,
} from "../email/branding";

// Re-exported so existing importers (and tests) keep importing it from here.
export { escapeHtml };

/** e-sign-specific footer. */
const ESIGN_FOOTER = "Electronic signature request sent with Coco Legal";

/**
 * Controlled-beta labels. Signature wording follows beta mode
 * (`signatures_nonbinding`): every e-sign email carries the label in beta mode
 * and says nothing either way outside it, matching the signer page.
 */
const NONBINDING_REQUEST_NOTICE =
    "Controlled beta: this is a nonbinding test signature, not for legal execution. Use synthetic or redacted documents only.";
const NONBINDING_COMPLETION_NOTICE =
    "Controlled beta: these are nonbinding test signatures, not a legal execution.";

function noticeHtml(notice: string | null): string {
    return notice
        ? `<p style="margin:0 0 16px 0;padding:10px 12px;border-radius:8px;background:#fef3c7;color:#78350f;font-size:13px;font-weight:600;">${escapeHtml(notice)}</p>`
        : "";
}

function noticeText(notice: string | null): string {
    return notice ? `${notice}\n\n` : "";
}

/** Wrap body HTML in the shared branded shell with the e-sign footer. */
function shell(innerHtml: string): string {
    return brandedShell(innerHtml, { mode: "full", footerHtml: ESIGN_FOOTER });
}

/** Signing-request email — branded HTML + the existing plain-text fallback. */
export function signRequestEmail(input: {
    subject: string;
    message: string;
    link: string;
    /** The envelope's `signatures_nonbinding` flag (true in beta mode). */
    nonbinding: boolean;
}): { text: string; html: string } {
    const notice = input.nonbinding ? NONBINDING_REQUEST_NOTICE : null;
    const text =
        noticeText(notice) +
        `${input.message || "You have a document to sign."}\n\n` +
        `Review and sign here: ${input.link}\n\n` +
        "This link is personal to you; please do not forward it.";
    const html = shell(
        heading("Please review & sign") +
            noticeHtml(notice) +
            `<p style="margin:0 0 4px 0;color:${MUTED};font-size:13px;">Document</p>` +
            `<p style="margin:0 0 16px 0;font-weight:600;">${escapeHtml(input.subject)}</p>` +
            (input.message
                ? `<p style="margin:0 0 18px 0;white-space:pre-wrap;">${escapeHtml(input.message)}</p>`
                : "") +
            button(input.link, "Review & Sign") +
            `<p style="margin:16px 0 0 0;color:${MUTED};font-size:13px;">This link is personal to you; please do not forward it.</p>`,
    );
    return { text, html };
}

/** Completion email — branded HTML + plain-text fallback (attachments added by caller). */
export function completionEmail(input: {
    documentName: string;
    /** The envelope's `signatures_nonbinding` flag (true in beta mode). */
    nonbinding: boolean;
}): { text: string; html: string } {
    const notice = input.nonbinding ? NONBINDING_COMPLETION_NOTICE : null;
    const text =
        noticeText(notice) +
        `The document "${input.documentName}" has been fully executed.\n\n` +
        "Attached are the executed PDF and the Certificate of Completion.";
    const html = shell(
        heading("Document fully executed") +
            noticeHtml(notice) +
            `<p style="margin:0 0 16px 0;">The document <strong>${escapeHtml(input.documentName)}</strong> has been signed by all parties.</p>` +
            `<p style="margin:0 0 4px 0;">Attached:</p>` +
            `<ul style="margin:0 0 4px 18px;padding:0;">` +
            `<li>Executed PDF (with embedded signatures)</li>` +
            `<li>Certificate of Completion</li></ul>`,
    );
    return { text, html };
}

/**
 * Completion "documents ready" email for an external signer — branded HTML +
 * plain-text fallback. Attachment-FREE on purpose: a single-recipient, link-only
 * message matches the deliverable profile of the signing invite (which lands in
 * the inbox), whereas the attachment-laden, multi-recipient owner copy gets
 * spam-filed by consumer mailboxes. The link points at the signer's
 * `/sign/<token>` page, which serves the executed PDF + certificate for download
 * once the envelope is completed.
 */
export function completionReadyEmail(input: {
    documentName: string;
    link: string;
    /** The envelope's `signatures_nonbinding` flag (true in beta mode). */
    nonbinding: boolean;
}): { text: string; html: string } {
    const notice = input.nonbinding ? NONBINDING_COMPLETION_NOTICE : null;
    const text =
        noticeText(notice) +
        `The document "${input.documentName}" has been signed by all parties.\n\n` +
        `Download your executed copy and Certificate of Completion here: ${input.link}\n\n` +
        "This link is personal to you; please do not forward it.";
    const html = shell(
        heading("Your signed documents are ready") +
            noticeHtml(notice) +
            `<p style="margin:0 0 4px 0;color:${MUTED};font-size:13px;">Document</p>` +
            `<p style="margin:0 0 16px 0;font-weight:600;">${escapeHtml(input.documentName)}</p>` +
            `<p style="margin:0 0 18px 0;">Signed by all parties. Your executed copy and the Certificate of Completion are ready to download.</p>` +
            button(input.link, "Download documents") +
            `<p style="margin:16px 0 0 0;color:${MUTED};font-size:13px;">This link is personal to you; please do not forward it.</p>`,
    );
    return { text, html };
}
