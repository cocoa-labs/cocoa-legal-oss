// Strict HTML sanitizer used on user-supplied Markdown and direct .html /
// .htm uploads BEFORE handing them to LibreOffice for PDF conversion.
//
// Why: LibreOffice's HTML importer fetches external resources (<img src>,
// <link href>, <iframe src>) while rendering, which gives any markdown
// or html upload an SSRF reach to internal services from the conversion
// host — cloud metadata, RFC1918 hosts, etc. We strip that surface.
//
// Policy (strict, per project owner directive):
//   - Allow: standard formatting tags (h1-h6, p, ul/ol/li, blockquote,
//     pre/code, strong/em, table elements, hr, br, img, a).
//   - Strip entirely: script, iframe, embed, object, link, style, meta,
//     base, form, input, button, and any unknown tag. All `on*` event
//     attributes are stripped.
//   - <img>: ONLY `data:` URIs are allowed. External http/https/file
//     URLs are stripped from src attributes (the tag remains and renders
//     as a broken placeholder).
//   - <a>: http, https, mailto allowed. file, javascript, data, etc.
//     stripped.
//   - Comments preserved as text (sanitize-html default).
//
// As a side effect, this also fixes the `</style>` template-breakage
// bug — sanitize-html's parser ensures any inline `<style>` block is
// removed and won't leak closing tokens that escape the wrapper template.

import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS: string[] = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "sub",
    "sup",
    "small",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "kbd",
    "samp",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
    "img",
    "a",
    "span",
    "div",
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
        a: ["href", "title", "name"],
        img: ["src", "alt", "title", "width", "height"],
        th: ["align", "scope", "colspan", "rowspan"],
        td: ["align", "colspan", "rowspan"],
        col: ["span", "width"],
        colgroup: ["span", "width"],
        // All other tags: no attributes (strips class, id, style, on*).
    },
    // Per-tag scheme allowlists. Anything not listed is stripped.
    allowedSchemesByTag: {
        img: ["data"],                       // only inline base64 images
        a: ["http", "https", "mailto"],
    },
    allowedSchemes: ["http", "https", "mailto", "data"],
    // Reject protocol-relative URLs (//evil.com/...) entirely.
    allowProtocolRelative: false,
    // Strip script and style content (not just the tags themselves).
    disallowedTagsMode: "discard",
    nonTextTags: ["script", "style", "textarea", "noscript", "title"],
    // Trim long runs of whitespace introduced by tag-stripping.
    parseStyleAttributes: false,
};

/**
 * Sanitize an HTML string for safe handoff to LibreOffice. Returns the
 * sanitized HTML; never throws on malformed input.
 */
export function sanitizeHtmlForConversion(html: string): string {
    return sanitizeHtml(html, SANITIZE_OPTIONS);
}
