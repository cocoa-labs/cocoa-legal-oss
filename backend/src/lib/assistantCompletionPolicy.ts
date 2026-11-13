import type { LlmFinishReason } from "./llm";

/** A completed interactive turn must end with visible prose for the user. */
export function hasCompleteFinalProse(
    finishReason: LlmFinishReason,
    visibleProse: string,
): boolean {
    return finishReason === "completed" && visibleProse.trim().length > 0;
}

/**
 * Tool execution is permitted only before recovery begins. Once any tool was
 * attempted or any prose was exposed, later attempts are finalization-only so
 * side effects cannot be repeated.
 */
export function mayExecuteToolsOnAttempt(
    toolExecutionAttempted: boolean,
    visibleProse: string,
): boolean {
    return !toolExecutionAttempted && visibleProse.trim().length === 0;
}
