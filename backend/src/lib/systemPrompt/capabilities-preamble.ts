import { allCapabilities } from "../legalCapabilities";

/**
 * Optional preamble that tells the agent which legal capabilities are
 * available. Empty string when the registry is empty, so the
 * Foundation-only refactor produces byte-identical output to the
 * legacy SYSTEM_PROMPT.
 */
export function capabilitiesPreamble(): string {
    const caps = allCapabilities();
    if (caps.length === 0) return "";
    const lines = caps.map(
        (c) => `- ${c.title} (${c.id}): ${c.description}`,
    );
    return [
        "",
        "LEGAL CAPABILITIES:",
        "You have these specialized capabilities. Apply the matching methodology when the user's request fits one of them.",
        ...lines,
        "",
    ].join("\n");
}
