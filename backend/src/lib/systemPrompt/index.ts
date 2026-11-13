import { QUILL_PERSONA } from "./quill-persona";
import { LEGAL_METHODOLOGY } from "./legal-methodology";
import { capabilitiesPreamble } from "./capabilities-preamble";
import { capabilityFragments } from "./capability-fragments";
import { substitute } from "./substitute";

export interface SystemPromptContext {
    firmId?: string;
    /**
     * Playbook entries the caller pre-resolved (async) for this turn,
     * keyed by playbook key. When present together with `firmId`, the
     * builder emits the capability preamble + fragments and substitutes
     * any `{{playbook:key}}` placeholders with these values. The builder
     * itself stays synchronous; resolution happens in the route.
     */
    resolvedPlaybook?: Record<string, unknown>;
    projectId?: string;
    attachedDocs?: { filename: string; first_chars?: string }[];
    recentTools?: string[];
    /**
     * Email of the signed-in user this turn. When present, buildMessages
     * appends a short identity line so the agent resolves "me"/"email me"
     * to this address. Not consumed by buildSystemPrompt (keeps its
     * empty-ctx invariant byte-stable); injected one layer up.
     */
    userEmail?: string;
    /**
     * Pre-formatted "current date and time" grounding line for this turn (see
     * temporalContext.ts). When present, buildMessages appends it under a
     * "## Current date and time" heading so the agent has an authoritative
     * "now" for relative-time reasoning. Like `userEmail`, it is consumed by
     * buildMessages — NOT by buildSystemPrompt — so the empty-ctx output stays
     * byte-stable. The route computes it from the server clock + the user's
     * timezone.
     */
    currentDateLine?: string;
    /**
     * Pre-formatted body of the calling user's private memory for this turn
     * (bullet lines from memory.ts formatMemoryLines). When present,
     * buildMessages appends it under a "## What you remember" heading behind a
     * reference-only guard. Like `userEmail`/`currentDateLine` it is consumed
     * by buildMessages — NOT by buildSystemPrompt — so the empty-ctx output
     * stays byte-stable. Resolved per turn in resolveSystemPromptCtx.
     */
    personalMemory?: string;
    /**
     * Pre-formatted body of the shared firm memory for this turn (Phase 2).
     * Same consumption/invariant discipline as `personalMemory`; appended
     * under "## Firm knowledge (shared, firm-approved)".
     */
    firmMemory?: string;
    /**
     * Provenance-linked rolling summary of episodes older than the exact
     * replay window in this saved conversation. Reference-only: it may inform
     * an answer but can never authorize a tool action.
     */
    conversationSummary?: string;
    /**
     * Capability ids this turn should steer on — the ones whose intent
     * signals matched, plus any the user explicitly confirmed a run for
     * (see selectRelevantCapabilities). Only these capabilities'
     * systemPromptFragments are emitted; when omitted, every registered
     * capability's fragment is emitted (the legacy behaviour). The
     * capability preamble is never scoped — one line per capability is
     * cheap and advertises what exists.
     */
    activeCapabilityIds?: string[];
}

/**
 * The legacy/base composition: persona + "\n\n" + methodology. This is the
 * exact byte string the empty-ctx call must always return — independent of
 * whether the capability registry is populated. `index.test.ts` pins it to
 * the legacy snapshot.
 */
const BASE_PROMPT = QUILL_PERSONA + "\n\n" + LEGAL_METHODOLOGY;

export function buildSystemPrompt(ctx: SystemPromptContext): string {
    // INVARIANT: with no firm context, return EXACTLY today's composition.
    // Emission of capability content is gated on the ctx flag below — NOT
    // on allCapabilities().length — so populating the registry (a later
    // phase) never changes this empty-ctx output. Do not read the registry
    // on this path.
    if (!ctx.firmId || !ctx.resolvedPlaybook) {
        return BASE_PROMPT;
    }

    // Firm-aware path: append the capability preamble + fragments (same
    // concatenation shape the legacy refactor used) and substitute any
    // {{playbook:key}} placeholders with the firm's resolved entries.
    const preamble = capabilitiesPreamble();
    const fragments = capabilityFragments(ctx.activeCapabilityIds);
    const suffix = preamble || fragments ? preamble + fragments : "";
    return substitute(BASE_PROMPT + suffix, ctx.resolvedPlaybook);
}
