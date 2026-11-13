// backend/src/lib/jsonExtract.ts
//
// Tiny dependency-free util shared by the LLM-output parsers. Lives in its own
// module so both chatTools.ts (the `generate_template` dispatch) and
// authoringExecute.ts (`generateTemplateDraft`) can import it WITHOUT forming a
// circular import: chatTools.ts now imports generateTemplateDraft from
// authoringExecute.ts, so authoringExecute.ts must not import back from
// chatTools.ts.

/**
 * Pull the first balanced JSON object out of a possibly-decorated LLM string.
 * Models asked for "ONLY JSON" still sometimes wrap the payload in prose or a
 * ```json fence, so we (1) strip a leading/trailing code fence, then (2) slice
 * from the first `{` to the last `}`. Returns the trimmed candidate; the caller
 * still owns the JSON.parse (and its try/catch) so a malformed body surfaces as
 * a parse error rather than being silently swallowed here.
 */
export function extractJsonObject(raw: string): string {
    let s = (raw ?? "").trim();
    // Strip a fenced block: ```json\n...\n``` or ```\n...\n```
    const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
    if (fence) s = fence[1].trim();
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
        return s.slice(first, last + 1).trim();
    }
    return s;
}
