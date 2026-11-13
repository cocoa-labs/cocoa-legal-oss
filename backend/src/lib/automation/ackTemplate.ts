// backend/src/lib/automation/ackTemplate.ts
//
// Deterministic {{key}} substitution for the automation acknowledgement
// email. This is a hard safety boundary for the pipeline's outbound path:
// the ack body is ALWAYS template text (pi.claims.ack_template +
// pi.claims.signature_block from the playbook) with extracted values
// spliced in — no LLM-generated prose can ever reach an outbound email.
// Keep this module dependency-free and side-effect-free.

/**
 * Replace every `{{key}}` occurrence in `template` with `vars[key]`.
 * Unknown or undefined keys render as the empty string (never the literal
 * braces — a half-substituted ack must not leak template syntax to a
 * carrier). Single pass: substituted values are inserted literally and are
 * never re-expanded, so a value containing `{{...}}` cannot chain.
 */
export function renderAckTemplate(
    template: string,
    vars: Record<string, string | undefined>,
): string {
    return template.replace(
        /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g,
        (_match, key: string) =>
            Object.prototype.hasOwnProperty.call(vars, key)
                ? (vars[key] ?? "")
                : "",
    );
}
