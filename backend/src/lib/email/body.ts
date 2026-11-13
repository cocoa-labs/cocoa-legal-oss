import sanitizeHtml from "sanitize-html";

/** Convert HTML-only mail to complete inert text, without remote fetches. */
export function htmlEmailText(html: string): string {
  return sanitizeHtml(
    html.replace(/<(br\s*\/?|\/p|\/div|\/tr|\/li)>/gi, "\n"),
    {
      allowedTags: [],
      allowedAttributes: {},
    },
  )
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
