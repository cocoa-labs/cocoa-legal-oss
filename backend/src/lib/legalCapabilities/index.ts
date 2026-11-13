// backend/src/lib/legalCapabilities/index.ts

import type { LegalCapability, LegalPractice } from "./types";

/**
 * The in-memory capability registry. Capabilities register themselves at
 * module-load by calling `registerCapability` from each capability's
 * own module file. The registry is intentionally a singleton — there is
 * exactly one set of installed capabilities per backend process.
 */

const registry = new Map<string, LegalCapability>();

export function registerCapability(capability: LegalCapability): void {
    if (registry.has(capability.id)) {
        throw new Error(
            `LegalCapability already registered: ${capability.id}`,
        );
    }
    registry.set(capability.id, capability);
}

export function getCapability(id: string): LegalCapability | null {
    return registry.get(id) ?? null;
}

export function allCapabilities(): LegalCapability[] {
    return Array.from(registry.values());
}

export function capabilitiesByPractice(
    practice: LegalPractice,
): LegalCapability[] {
    return allCapabilities().filter((c) => c.practice === practice);
}

/**
 * Snapshot accessor — also exported as the canonical name for callers
 * that prefer the constant form (e.g. workflow gallery, system prompt
 * builder). Returns a fresh array each call.
 */
export function LEGAL_CAPABILITIES(): LegalCapability[] {
    return allCapabilities();
}

export type CapabilityRunTarget = "chat" | "modal";

/**
 * Where a confirmed suggestion runs: "chat" when the capability declares
 * an outputSpec, "modal" for tabular packs (launched through the gallery
 * modal), null when the capability cannot be launched from a chip at all.
 */
export function runTargetFor(
    cap: Pick<LegalCapability, "outputSpec" | "workflow">,
): CapabilityRunTarget | null {
    if (cap.outputSpec) return "chat";
    if (cap.workflow.type === "tabular") return "modal";
    return null;
}

/**
 * Test-only: reset the registry between test cases. Throws if called
 * outside a test runner so production code can't accidentally drop the
 * registry.
 */
export function clearRegistryForTests(): void {
    if (process.env.NODE_ENV === "production") {
        throw new Error("clearRegistryForTests called in production");
    }
    registry.clear();
}
