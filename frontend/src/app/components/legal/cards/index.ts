import type { ComponentType } from "react";
import {
    CapabilityResultCard,
    type CapabilityResultCardProps,
} from "./CapabilityResultCard";

export { CapabilityResultCard };
export type { CapabilityResultCardProps };

/**
 * Per-capability card registry.
 *
 * Every capability renders through the generic card today — the result event
 * is already a validated, section-shaped contract, so a bespoke card is only
 * worth writing when a capability needs a layout the generic one cannot
 * express. This registry is the seam for that: add an entry keyed by registry
 * id, and `resolveCapabilityResultCard` picks it up with no call-site change.
 */
const CAPABILITY_RESULT_CARDS: Record<
    string,
    ComponentType<CapabilityResultCardProps>
> = {};

export function resolveCapabilityResultCard(
    capabilityId: string,
): ComponentType<CapabilityResultCardProps> {
    return CAPABILITY_RESULT_CARDS[capabilityId] ?? CapabilityResultCard;
}
