// backend/src/lib/operationSideEffects.test.ts
//
// runApprovedOperationSideEffect is the routing that fixes the silent-non-send:
// when an agent operation is approved via POST /operations/:id/approve (the path
// a reloaded send_email / send_for_signature / calendar card uses), email,
// signature, case-write, and calendar ops MUST be dispatched to their
// subsystems. Highlight/assemble ops do their work inside approveAgentOperation;
// these are wired here instead. Pure routing logic (handlers injected) so it is
// unit-testable.
import assert from "node:assert/strict";
import {
    runApprovedOperationSideEffect,
    type ApprovedOperationSendHandlers,
} from "./operationSideEffects";

/** Handlers that record nothing and succeed; override the one under test. */
function handlers(
    overrides: Partial<ApprovedOperationSendHandlers> = {},
): ApprovedOperationSendHandlers {
    return {
        sendEmail: async () => ({ ok: true }),
        sendSignature: async () => ({ ok: true }),
        caseWrite: async () => ({ ok: true }),
        calendarWrite: async () => ({ ok: true }),
        ...overrides,
    };
}

async function main() {
    // Every email tool routes to the email sender (and nothing else).
    for (const tool of [
        "send_email",
        "reply_to_email",
        "auto_draft_email",
        "auto_ack_email",
    ]) {
        let emailedOp = "";
        let others = false;
        const r = await runApprovedOperationSideEffect(
            { tool_name: tool, id: "op-1" },
            handlers({
                sendEmail: async (id) => {
                    emailedOp = id;
                    return { ok: true };
                },
                sendSignature: async () => ((others = true), { ok: true }),
                caseWrite: async () => ((others = true), { ok: true }),
                calendarWrite: async () => ((others = true), { ok: true }),
            }),
        );
        assert.deepEqual(r, { kind: "email" }, `${tool} routes to email`);
        assert.equal(emailedOp, "op-1");
        assert.equal(others, false);
    }

    // An email send refused surfaces as a structured error.
    {
        const r = await runApprovedOperationSideEffect(
            { tool_name: "send_email", id: "op-1b" },
            handlers({
                sendEmail: async () => ({
                    ok: false,
                    status: 403,
                    detail: "You do not have permission to send this email.",
                }),
            }),
        );
        assert.deepEqual(r, {
            kind: "error",
            status: 403,
            detail: "You do not have permission to send this email.",
        });
    }

    // send_for_signature routes to the signature sender.
    {
        let signedOp = "";
        const r = await runApprovedOperationSideEffect(
            { tool_name: "send_for_signature", id: "op-2" },
            handlers({
                sendSignature: async (id) => {
                    signedOp = id;
                    return { ok: true };
                },
            }),
        );
        assert.deepEqual(r, { kind: "signature" });
        assert.equal(signedOp, "op-2");
    }

    // A signature send failure surfaces as a structured error.
    {
        const r = await runApprovedOperationSideEffect(
            { tool_name: "send_for_signature", id: "op-3" },
            handlers({
                sendSignature: async () => ({
                    ok: false,
                    status: 503,
                    detail: "Email connector is not configured",
                }),
            }),
        );
        assert.deepEqual(r, {
            kind: "error",
            status: 503,
            detail: "Email connector is not configured",
        });
    }

    // Case-write tools route to the caseWrite handler.
    for (const tool of ["update_case_insurance", "record_case_expense"]) {
        let caseWroteOp = "";
        const r = await runApprovedOperationSideEffect(
            { tool_name: tool, id: "op-5" },
            handlers({
                caseWrite: async (id) => {
                    caseWroteOp = id;
                    return { ok: true };
                },
            }),
        );
        assert.deepEqual(r, { kind: "case_write" }, `${tool} routes to caseWrite`);
        assert.equal(caseWroteOp, "op-5");
    }

    // Calendar write tools route to the calendarWrite handler (and nothing else).
    for (const tool of ["create_event", "update_event", "delete_event"]) {
        let calOp = "";
        let others = false;
        const r = await runApprovedOperationSideEffect(
            { tool_name: tool, id: "op-cal" },
            handlers({
                sendEmail: async () => ((others = true), { ok: true }),
                sendSignature: async () => ((others = true), { ok: true }),
                caseWrite: async () => ((others = true), { ok: true }),
                calendarWrite: async (id) => {
                    calOp = id;
                    return { ok: true };
                },
            }),
        );
        assert.deepEqual(
            r,
            { kind: "calendar" },
            `${tool} routes to calendarWrite`,
        );
        assert.equal(calOp, "op-cal");
        assert.equal(others, false, `${tool} touches no other subsystem`);
    }

    // A calendar apply failure surfaces as a structured error (e.g. 503 when the
    // calendar connector is not configured) so the route can relay the status.
    {
        const r = await runApprovedOperationSideEffect(
            { tool_name: "create_event", id: "op-cal-err" },
            handlers({
                calendarWrite: async () => ({
                    ok: false,
                    status: 503,
                    detail: "calendar connector is not configured.",
                }),
            }),
        );
        assert.deepEqual(r, {
            kind: "error",
            status: 503,
            detail: "calendar connector is not configured.",
        });
    }

    // Document operations are NOT routed to a subsystem — they do their work
    // inside approveAgentOperation.
    for (const tool of [
        "edit_document",
        "assemble_document",
        "apply_document_highlights",
        "generate_docx",
    ]) {
        let touched = false;
        const mark = async () => ((touched = true), { ok: true as const });
        const r = await runApprovedOperationSideEffect(
            { tool_name: tool, id: "op-4" },
            {
                sendEmail: mark,
                sendSignature: mark,
                caseWrite: mark,
                calendarWrite: mark,
            },
        );
        assert.deepEqual(r, { kind: "none" }, `${tool} is not a send op`);
        assert.equal(touched, false);
    }

    console.log("operationSideEffects.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
