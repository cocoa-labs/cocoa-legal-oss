// backend/src/lib/systemPrompt/substitute.ts
import type { PlaybookEntry } from "../playbooks";
import type { TemplateVariable } from "../templates";

/**
 * Matches a `{{playbook:key}}` placeholder. The key is any run of
 * characters that isn't `}` or whitespace, e.g. `nda.standard_positions`.
 */
const PLACEHOLDER_RE = /\{\{playbook:([^}\s]+)\}\}/g;

/**
 * Matches the `{{representedParty}}` placeholder. Unlike a playbook key this
 * is a single fixed token — the represented side of a CRE matter (the value
 * comes from the review's `represented_party` column on the tabular path, or
 * a neutral default everywhere else).
 */
const REPRESENTED_PARTY_RE = /\{\{representedParty\}\}/g;

/**
 * The neutral fallback for `{{representedParty}}` when no concrete side is
 * supplied (e.g. chat, which has no review selection, or a CRE review whose
 * `represented_party` was never set). Chosen so the prompt reads naturally
 * and NEVER leaks the literal `{{representedParty}}` token to the model.
 */
export const DEFAULT_REPRESENTED_PARTY = "the party you represent";

/**
 * Tracks which absent keys we've already warned about, so a missing key
 * referenced across many fragments / tabular columns logs exactly once
 * per process rather than once per occurrence. Reset in tests via
 * `__resetSubstituteWarnings`.
 */
const warnedMissingKeys = new Set<string>();

function isPlaybookEntry(v: unknown): v is PlaybookEntry {
    return (
        typeof v === "object" &&
        v !== null &&
        "value_json" in (v as Record<string, unknown>)
    );
}

/**
 * Render a single resolved value into prompt text:
 *  - string  → the raw string (no JSON quoting)
 *  - null/undefined → "" (so an unset value never injects the literal
 *    "null"/"undefined" into the prompt)
 *  - anything else (object, array, number, boolean) → JSON.stringify
 */
function renderValue(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
}

/**
 * Replace every `{{playbook:key}}` placeholder in `template` with the
 * corresponding entry's value from `entries`.
 *
 * Value resolution:
 *  - If the entry is a full `PlaybookEntry`, its `value_json` is used.
 *  - Otherwise the raw value is used as-is.
 *  - String values inline verbatim; objects/arrays/numbers/booleans are
 *    JSON-stringified; null/undefined collapse to an empty string.
 *
 * Absent-key fallback (documented behavior): if a referenced key is not
 * present in `entries`, the placeholder is replaced with an empty string
 * AND a one-time `console.warn` is emitted for that key. We deliberately
 * do NOT leave the literal `{{playbook:key}}` in the prompt (that would
 * leak template syntax to the model) and we deliberately do NOT silently
 * blank it without a trace (that would hide a missing-seed bug). The warn
 * is deduped per key per process so a key referenced across many columns
 * logs once.
 *
 * Also replaces the `{{representedParty}}` placeholder (the represented side
 * of a CRE matter) with `representedParty` when a non-empty value is given,
 * else the neutral `DEFAULT_REPRESENTED_PARTY`. The literal placeholder is
 * NEVER left in the output — an absent value resolves to the default, so the
 * model never sees `{{representedParty}}`. The chat path leaves the value
 * undefined (it has no review selection) and so always gets the default; the
 * tabular path passes the review's persisted side.
 *
 * Pure with respect to its inputs (the only side effect is the dedup'd
 * warn); callers may treat it as a string→string transform.
 */
export function substitute(
    template: string,
    entries: Record<string, PlaybookEntry | unknown>,
    representedParty?: string | null,
): string {
    const hasPlaybook = template.includes("{{playbook:");
    const hasRepresentedParty = template.includes("{{representedParty}}");
    if (!hasPlaybook && !hasRepresentedParty) return template;

    let out = template;
    if (hasPlaybook) {
        out = out.replace(PLACEHOLDER_RE, (_match, key: string) => {
            if (!(key in entries)) {
                if (!warnedMissingKeys.has(key)) {
                    warnedMissingKeys.add(key);
                    console.warn(
                        `[substitute] no playbook entry for key "${key}"; ` +
                            `replacing {{playbook:${key}}} with empty string. ` +
                            `Seed a default value for this key.`,
                    );
                }
                return "";
            }
            const raw = entries[key];
            return renderValue(isPlaybookEntry(raw) ? raw.value_json : raw);
        });
    }
    if (hasRepresentedParty) {
        const side = representedParty?.trim()
            ? representedParty.trim()
            : DEFAULT_REPRESENTED_PARTY;
        out = out.replace(REPRESENTED_PARTY_RE, side);
    }
    return out;
}

/**
 * Collect the distinct playbook keys referenced by `{{playbook:key}}`
 * placeholders across one or more template strings. Used by callers that
 * must pre-resolve the firm's entries (e.g. the tabular extraction path)
 * before substituting. Order-stable, deduped.
 */
export function extractPlaybookKeys(templates: string | string[]): string[] {
    const texts = Array.isArray(templates) ? templates : [templates];
    const keys = new Set<string>();
    for (const text of texts) {
        if (!text || !text.includes("{{playbook:")) continue;
        for (const m of text.matchAll(PLACEHOLDER_RE)) keys.add(m[1]);
    }
    return [...keys];
}

/**
 * Test-only: clear the one-time missing-key warning dedup set so each
 * test case observes warnings independently.
 */
export function __resetSubstituteWarnings(): void {
    warnedMissingKeys.clear();
}

/**
 * Matches a template-authoring variable placeholder in either supported form:
 *  - `{{var:name}}` (colon)  — capture group 1
 *  - `{{var.name}}` (dot)    — capture group 2
 * `name` is any run of characters that isn't `}` or whitespace (e.g. a
 * dotted/namespaced variable name). Distinct from the playbook placeholder
 * above: this resolves a per-document wizard value, not a firm playbook entry.
 */
const VAR_RE = /\{\{var:([^}\s]+)\}\}|\{\{var\.([^}\s]+)\}\}/g;

/**
 * Replace every `{{var.name}}` / `{{var:name}}` placeholder in `template`
 * with the supplied wizard value from `vars`.
 *
 * Resolution:
 *  - string → inlined verbatim.
 *  - null/undefined OR a name with no entry → "" (the literal `{{var.*}}`
 *    token must NEVER survive into an assembled section body; a blank is the
 *    documented behavior for an unfilled optional variable).
 *  - anything else (number/boolean/etc.) → `String(value)` (a plain coercion,
 *    NOT JSON.stringify — these are human-facing form values, so `3` renders
 *    as `3`, not `"3"`).
 *
 * Fast-path: templates with no `{{var` substring are returned untouched.
 * Pure string→string transform (no side effects).
 */
export function substituteVariables(
    template: string,
    vars: Record<string, unknown>,
): string {
    if (!template.includes("{{var")) return template;
    return template.replace(VAR_RE, (_m, a: string | undefined, b: string | undefined) => {
        const key = (a ?? b) as string;
        const v = vars[key];
        if (v === null || v === undefined) return "";
        return typeof v === "string" ? v : String(v);
    });
}

/**
 * Validate a set of filled wizard `values` against a template's
 * `TemplateVariable[]` schema, BEFORE assembly. Returns every problem at once
 * (not fail-fast) so the wizard can surface all field errors in one pass.
 *
 * Rules:
 *  - A variable hidden by an unmet `dependsOn` is skipped entirely (no
 *    required check, no type check) — mirrors the wizard's `isVisible` so a
 *    conditionally-shown required field can't pass the client gate yet 400
 *    here. The visibility test is the SAME strict equality the frontend uses:
 *    `values[dependsOn.name] === dependsOn.equals`. A missing controller value
 *    is `undefined`, which never `===` a concrete `equals`, so the dependent
 *    field stays skipped — exactly as the frontend hides it.
 *  - A `required` variable that is undefined/null/"" is an error.
 *  - An empty optional variable is skipped (no type check on a blank).
 *  - `enum`            → value must be one of `enum_options` (compared as strings).
 *  - `number` / `money`→ must be numeric after stripping `$` and `,`.
 *  - `date`            → must be `Date.parse`-able.
 *  - `boolean`         → must be an actual boolean.
 *  - other types (party/jurisdiction/text/multiline/duration) → presence-only.
 *
 * The error strings name the offending variable so callers can map them back
 * to a field. Pure with respect to its inputs.
 */
export function validateVariables(
    schema: TemplateVariable[],
    values: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const v of schema) {
        // Skip fields hidden by an unmet dependsOn — same visibility rule as
        // the frontend's isVisible (strict ===). Don't enforce required, don't
        // type-check: a hidden field carries no answer the user could give.
        if (v.dependsOn && values[v.dependsOn.name] !== v.dependsOn.equals) {
            continue;
        }
        const val = values[v.name];
        const empty = val === undefined || val === null || val === "";
        if (v.required && empty) {
            errors.push(`required variable "${v.name}" is missing`);
            continue;
        }
        if (empty) continue;
        switch (v.type) {
            case "enum":
                if (v.enum_options && !v.enum_options.includes(String(val))) {
                    errors.push(
                        `variable "${v.name}" must be one of ${v.enum_options.join(", ")}`,
                    );
                }
                break;
            case "number":
            case "money":
                if (Number.isNaN(Number(String(val).replace(/[$,]/g, "")))) {
                    errors.push(`variable "${v.name}" must be numeric`);
                }
                break;
            case "date":
                if (Number.isNaN(Date.parse(String(val)))) {
                    errors.push(`variable "${v.name}" must be a date`);
                }
                break;
            case "boolean":
                if (typeof val !== "boolean") {
                    errors.push(`variable "${v.name}" must be a boolean`);
                }
                break;
        }
    }
    return { ok: errors.length === 0, errors };
}
