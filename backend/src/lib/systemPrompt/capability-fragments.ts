import { allCapabilities } from "../legalCapabilities";

/**
 * Concatenates capability systemPromptFragments into a single block, with
 * the capability id as a header. Empty when the registry is empty.
 *
 * `ids` scopes the emission: pass the capability ids the turn actually
 * matched (or forced) and only those contribute their persona + full
 * methodology, in registration order — a single keyword hit no longer
 * injects every registered capability's methodology, which was both prompt
 * bloat and cross-practice steering. An empty array therefore emits
 * nothing, and unknown ids are ignored. Omitting `ids` entirely keeps the
 * legacy "emit every registered capability" behaviour for callers that do
 * not know which capabilities are active.
 */
export function capabilityFragments(ids?: readonly string[]): string {
    const wanted = ids ? new Set(ids) : null;
    const caps = wanted
        ? allCapabilities().filter((c) => wanted.has(c.id))
        : allCapabilities();
    if (caps.length === 0) return "";
    const blocks = caps.map((c) => {
        return [
            `--- CAPABILITY: ${c.id} ---`,
            c.systemPromptFragment.persona_framing,
            "",
            c.systemPromptFragment.methodology,
            "",
        ].join("\n");
    });
    return ["", ...blocks].join("\n");
}
