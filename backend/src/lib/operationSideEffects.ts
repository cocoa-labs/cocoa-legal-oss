// backend/src/lib/operationSideEffects.ts
//
// When an agent operation is approved via POST /operations/:id/approve, the
// approval must actually perform the side effect it represents. Document
// operations (highlights, assemble) do their work inside approveAgentOperation.
// Email and signature operations have their own send subsystems
// (sendEmailNow / renderAndSendEnvelope), so the operations route wires them in
// through this routing function.
//
// This fixes a silent non-send: a send_email / send_for_signature drafted in
// chat persists only an `operation_created` event, so on a fresh page load the
// pending item renders as the generic operation card whose Approve hits
// /operations/:id/approve. Before this, that path marked the operation approved
// but never sent the email or the signing links.
//
// Routing only — the senders are injected so this stays unit-testable and the
// send implementations stay where they live (lib for email; the signatures
// route for renderAndSendEnvelope).

import type { AgentOperation } from "./operations";

/**
 * Tool names whose approval should send an outbound email. auto_ack_email is
 * the automation pipeline's acknowledgement draft (staged by 4b) — approving
 * it dispatches through the same owner-/status-guarded email send path.
 */
const EMAIL_SEND_TOOLS = new Set([
    "send_email",
    "reply_to_email",
    "auto_draft_email",
    "auto_ack_email",
]);

/**
 * Tool names whose approval applies a case write (PI automation): staged
 * insurance/policy facts and vendor-invoice expenses. Routed to the caseWrite
 * handler — in task 4a that is a 501 stub (lib/automation/caseWrites.ts); the
 * 4b pipeline implements the real appliers.
 */
const CASE_WRITE_TOOLS = new Set([
    "update_case_insurance",
    "record_case_expense",
]);

/**
 * Tool names whose approval applies a calendar write. A create_event /
 * update_event / delete_event drafted in chat persists only an
 * operation_created event, so a reloaded card approves via
 * /operations/:id/approve — which must actually commit the write to Google
 * (applyCalendarWriteNow), mirroring the email path.
 */
const CALENDAR_WRITE_TOOLS = new Set([
    "create_event",
    "update_event",
    "delete_event",
]);

/** A sender either succeeds or returns a status + detail to relay to the client. */
export type SendOutcome =
    | { ok: true }
    | { ok: false; status: number; detail: string; code?: string };

export interface ApprovedOperationSendHandlers {
    /** Send the outbound email tied to this operation (owner- and status-guarded). */
    sendEmail: (operationId: string) => Promise<SendOutcome>;
    /** Dispatch the signing links for the envelope tied to this operation. */
    sendSignature: (operationId: string) => Promise<SendOutcome>;
    /** Apply the staged case write this operation describes (PI automation). */
    caseWrite: (operationId: string) => Promise<SendOutcome>;
    /** Apply the drafted calendar write this operation describes (to Google). */
    calendarWrite: (operationId: string) => Promise<SendOutcome>;
}

export type SideEffectResult =
    | { kind: "email" }
    | { kind: "signature" }
    | { kind: "case_write" }
    | { kind: "calendar" }
    | { kind: "none" }
    | { kind: "error"; status: number; detail: string; code?: string };

/**
 * Route a just-approved operation to the send subsystem its tool implies.
 * Returns which side effect ran, or a structured error to relay to the client.
 */
export async function runApprovedOperationSideEffect(
    operation: Pick<AgentOperation, "tool_name" | "id">,
    handlers: ApprovedOperationSendHandlers,
): Promise<SideEffectResult> {
    if (EMAIL_SEND_TOOLS.has(operation.tool_name)) {
        const result = await handlers.sendEmail(operation.id);
        return result.ok
            ? { kind: "email" }
            : {
                  kind: "error",
                  status: result.status,
                  detail: result.detail,
                  ...(result.code ? { code: result.code } : {}),
              };
    }
    if (operation.tool_name === "send_for_signature") {
        const result = await handlers.sendSignature(operation.id);
        return result.ok
            ? { kind: "signature" }
            : {
                  kind: "error",
                  status: result.status,
                  detail: result.detail,
                  ...(result.code ? { code: result.code } : {}),
              };
    }
    if (CASE_WRITE_TOOLS.has(operation.tool_name)) {
        const result = await handlers.caseWrite(operation.id);
        return result.ok
            ? { kind: "case_write" }
            : {
                  kind: "error",
                  status: result.status,
                  detail: result.detail,
                  ...(result.code ? { code: result.code } : {}),
              };
    }
    if (CALENDAR_WRITE_TOOLS.has(operation.tool_name)) {
        const result = await handlers.calendarWrite(operation.id);
        return result.ok
            ? { kind: "calendar" }
            : {
                  kind: "error",
                  status: result.status,
                  detail: result.detail,
                  ...(result.code ? { code: result.code } : {}),
              };
    }
    return { kind: "none" };
}
