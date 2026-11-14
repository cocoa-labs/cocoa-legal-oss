// backend/src/lib/email/branding.ts
//
// Shared branded HTML (+ plain-text fallback) for EVERY Quill email — recording
// summaries, chat-composed mail, calendar reminders, PI acknowledgements,
// auto-replies, and e-sign notifications — so the firm speaks with one voice.
// Email clients can't load the app's CSS, so the brand is inline-styled and
// table-based for client robustness (the same palette/shape as the original
// e-sign template, generalized here).
//
// Trust boundary: the SHELL is trusted and is NEVER sanitized — its look
// depends entirely on inline styles a sanitizer would strip. Only the inner
// fragment (model-supplied html or markdown-rendered body) is sanitized, and
// the cid: inline image is injected by the trusted shell AFTER sanitizing (the
// sanitizer allows <img> only with a data: scheme, so a cid: src would be lost
// if passed through it).

import { marked } from "marked";
import { sanitizeHtmlForConversion } from "../htmlSanitize";

export const INK = "#1c1917";
export const CREAM = "#f6f1ea";
export const AMBER = "#b45309";
export const MUTED = "#78716c";
export const BORDER = "#e7e5e0";
export const SERIF = "Georgia, 'Times New Roman', serif";
export const SANS =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Marker embedded in every branded shell — lets the send path detect html that
 * is ALREADY branded (e.g. a pre-rendered e-sign template) and skip re-wrapping.
 */
export const BRAND_SENTINEL = "<!--cocoa-email v1-->";

/**
 * Default firm-wide footer: a confidentiality/privilege notice + sign-off.
 *
 * Carries an explicit AI-assistance disclosure, since every message using this
 * footer was drafted with Quill. The deploying firm owns this language: review
 * it with counsel and override it per firm before relying on it.
 */
export const DEFAULT_EMAIL_FOOTER =
    "CONFIDENTIALITY NOTICE — This email and any attachments are intended solely " +
    "for the named recipient and may contain confidential, privileged, or attorney " +
    "work-product material. If you received this in error, please notify the sender " +
    "and delete all copies; any review, use, disclosure, or distribution is " +
    "prohibited. This message was prepared with the assistance of Quill, an AI " +
    "legal assistant. It does not constitute legal advice and does not create an " +
    "attorney-client relationship. &mdash; Sent by Quill &middot; Cocoa Legal";

/** Escape a string for safe insertion into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export type BrandMode = "full" | "light";

/**
 * Wrap TRUSTED inner HTML in the branded shell.
 *  - "full":  cream page, ❋ Cocoa Legal serif wordmark, white rounded card,
 *             footer. For new / standalone emails.
 *  - "light": the fragment plus a hairline rule, a small "❋ Quill · Cocoa
 *             Legal" sign-off, and the footer — no wordmark/page chrome, so it
 *             reads naturally inside an existing thread.
 * `innerHtml` is trusted and is NOT sanitized here.
 */
export function shell(
    innerHtml: string,
    opts?: { footerHtml?: string; mode?: BrandMode },
): string {
    const footer = opts?.footerHtml ?? DEFAULT_EMAIL_FOOTER;
    const mode = opts?.mode ?? "full";

    if (mode === "light") {
        return (
            `<div style="font-family:${SANS};color:${INK};font-size:15px;line-height:1.55;">` +
            BRAND_SENTINEL +
            innerHtml +
            `<hr style="border:none;border-top:1px solid ${BORDER};margin:20px 0 12px 0;" />` +
            `<div style="font-family:${SERIF};font-size:14px;color:${INK};">&#10042; Quill &middot; Cocoa Legal</div>` +
            `<div style="color:${MUTED};font-size:12px;margin-top:8px;line-height:1.5;">${footer}</div>` +
            `</div>`
        );
    }

    return (
        `<!doctype html><html><body style="margin:0;padding:0;background:${CREAM};">` +
        BRAND_SENTINEL +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:32px 12px;font-family:${SANS};">` +
        `<tr><td align="center">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:14px;">` +
        `<tr><td style="padding:22px 28px 0 28px;font-family:${SERIF};font-size:20px;color:${INK};">&#10042; Cocoa Legal</td></tr>` +
        `<tr><td style="padding:18px 28px 28px 28px;color:${INK};font-size:15px;line-height:1.55;font-family:${SANS};">${innerHtml}</td></tr>` +
        `</table>` +
        `<div style="max-width:560px;margin-top:14px;color:${MUTED};font-size:12px;font-family:${SANS};line-height:1.5;">${footer}</div>` +
        `</td></tr></table></body></html>`
    );
}

/** A prominent amber call-to-action button. */
export function button(href: string, label: string): string {
    return (
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px 0;"><tr>` +
        `<td style="border-radius:8px;background:${AMBER};">` +
        `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;font-family:${SANS};">${escapeHtml(label)}</a>` +
        `</td></tr></table>`
    );
}

/** A serif card heading. */
export function heading(text: string): string {
    return `<h1 style="font-family:${SERIF};font-weight:400;font-size:22px;margin:0 0 14px 0;color:${INK};">${escapeHtml(text)}</h1>`;
}

/**
 * Render Markdown to a sanitized HTML fragment safe to place in the card.
 * marked → sanitizeHtmlForConversion (strips scripts/styles/inline attrs and
 * any non-data <img>). A cid: inline image must therefore be injected AFTER
 * this, by the trusted shell — never routed through the sanitizer.
 */
export async function renderMarkdownToHtml(md: string): Promise<string> {
    const rendered = await marked.parse(md ?? "");
    return sanitizeHtmlForConversion(rendered);
}

export interface InlineImage {
    /** cid (bracket-free) referenced as src="cid:contentId". */
    contentId: string;
    alt?: string;
}

/** One inline image tag (trusted injection; preserves the cid: scheme). */
function inlineImageHtml(img: InlineImage): string {
    return (
        `<img src="cid:${escapeHtml(img.contentId)}" alt="${escapeHtml(img.alt ?? "")}" ` +
        `style="display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid ${BORDER};margin-top:16px;" />`
    );
}

/**
 * Produce the branded { text, html } for an email.
 *  - `text` is ALWAYS the untouched `bodyText` (the plain-text fallback).
 *  - `html`: if `bodyHtml` is already branded (carries the sentinel) it's
 *    returned unchanged (idempotency). Otherwise the inner fragment is chosen —
 *    sanitized `bodyHtml` if supplied, else the markdown-rendered `bodyText` —
 *    inline images are appended, and the whole is wrapped in the shell.
 */
export async function renderBrandedEmail(input: {
    bodyText: string;
    bodyHtml?: string | null;
    mode: BrandMode;
    inlineImages?: InlineImage[];
    footerHtml?: string;
}): Promise<{ text: string; html: string }> {
    const text = input.bodyText ?? "";

    // Already branded (e.g. a pre-rendered e-sign template) → don't re-wrap.
    if (input.bodyHtml && input.bodyHtml.includes(BRAND_SENTINEL)) {
        return { text, html: input.bodyHtml };
    }

    const fragment = input.bodyHtml
        ? sanitizeHtmlForConversion(input.bodyHtml)
        : await renderMarkdownToHtml(text);

    const images = (input.inlineImages ?? []).map(inlineImageHtml).join("");
    const html = shell(fragment + images, {
        mode: input.mode,
        footerHtml: input.footerHtml,
    });
    return { text, html };
}
