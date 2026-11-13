import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    approveAgentOperation,
    getAgentOperation,
    isAssembleKickoff,
    listAgentOperations,
    undoAgentOperation,
} from "../lib/operations";
import { getUserApiKeys } from "../lib/userSettings";
import { runApprovedOperationSideEffect } from "../lib/operationSideEffects";
import { applyCaseWriteOperation } from "../lib/automation/caseWrites";
import { getEmailByOperationId } from "../lib/email/store";
import { sendEmailNow } from "../lib/email/send";
import { EmailAttachmentError } from "../lib/email/attachments";
import { getCalendarWriteByOperationId } from "../lib/calendar/store";
import { applyCalendarWriteNow } from "../lib/calendar/apply";
import { getEnvelopeWithSignersByOperationId } from "../lib/signatures/store";
import { renderAndSendEnvelope } from "./signatures";
import { ConnectorNotConfiguredError } from "../lib/connectors/types";
import { BetaPolicyError } from "../lib/betaPolicy";

export const operationsRouter = Router();

// GET /operations?matter_id=&project_id=&document_id=&chat_id=&limit=
operationsRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    try {
        const operations = await listAgentOperations({
            db,
            userId,
            userEmail,
            projectId:
                typeof req.query.project_id === "string"
                    ? req.query.project_id
                    : null,
            matterId:
                typeof req.query.matter_id === "string"
                    ? req.query.matter_id
                    : null,
            documentId:
                typeof req.query.document_id === "string"
                    ? req.query.document_id
                    : null,
            chatId:
                typeof req.query.chat_id === "string"
                    ? req.query.chat_id
                    : null,
            limit:
                typeof req.query.limit === "string"
                    ? Number.parseInt(req.query.limit, 10)
                    : undefined,
        });
        res.json({ operations });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to load operations",
        });
    }
});

// GET /operations/:operationId
operationsRouter.get("/:operationId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    try {
        const operation = await getAgentOperation({
            db,
            operationId: req.params.operationId,
            userId,
            userEmail,
        });
        if (!operation)
            return void res.status(404).json({ detail: "Operation not found" });
        res.json({ operation });
    } catch (err) {
        res.status(500).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to load operation",
        });
    }
});

// POST /operations/:operationId/approve
operationsRouter.post("/:operationId/approve", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    try {
        // Fetch the approving user's API keys so the assemble_document branch
        // drafts + QAs under THEIR credentials (mirrors the wizard route in
        // routes/templates.ts). Critical for BYOK-only users: without their key
        // every section draft hits an auth error and is swallowed to "",
        // producing an assembled doc with all substantive sections blank. Model
        // is left undefined — there is no per-request picker on the approve
        // path, so resolveAvailableMainModel(undefined, apiKeys) picks a model
        // the user's keys can reach. Other approve branches ignore these.
        const apiKeys = await getUserApiKeys(userId, db);
        const operation = await approveAgentOperation({
            db,
            operationId: req.params.operationId,
            userId,
            userEmail,
            apiKeys,
        });
        if (!operation)
            return void res.status(404).json({ detail: "Operation not found" });
        // assemble_document approvals kick off a DETACHED background job and
        // return a kickoff payload ({ status: "assembling", job_id,
        // operation_id }) instead of a finished AgentOperation. Relay it
        // unchanged so the frontend can start polling GET /templates/jobs/:job_id
        // immediately — the heavy work no longer blocks this request.
        if (isAssembleKickoff(operation)) {
            return void res.json(operation);
        }
        // RE-APPROVAL of an assemble op. The already-approved guard in
        // approveAgentOperation early-returns the full AgentOperation (NOT a
        // kickoff) when the op is already approved/running/terminal — and it
        // deliberately does NOT launch a second worker. But the frontend's
        // approveAssembleOperation reads `.job_id` off the top level, so an
        // AgentOperation shape would dead-end the card. Normalize ANY
        // assemble_document result to the kickoff shape so a retry / double-
        // approval re-attaches to the poll and renders the job's CURRENT state
        // (which may already be `ready`). No second worker is started here — we
        // only echo back the job id the existing row already carries.
        if (operation.tool_name === "assemble_document") {
            const jobId =
                typeof operation.arguments?.authoring_job_id === "string"
                    ? (operation.arguments.authoring_job_id as string)
                    : null;
            return void res.json({
                status: "assembling",
                job_id: jobId,
                operation_id: operation.id,
            });
        }

        // Email / signature operations: approving here (the path a RELOADED
        // send_email / send_for_signature card uses, since it persists only an
        // operation_created event) must actually perform the send. Highlight /
        // assemble ops do their work inside approveAgentOperation; these send
        // subsystems are dispatched below. Without this, the operation was marked
        // approved but the email / signing links never went out — a silent
        // non-send. Each sender is status-guarded, so a double-approve is a no-op.
        try {
            const dispatch = await runApprovedOperationSideEffect(operation, {
                sendEmail: async (operationId) => {
                    const email = await getEmailByOperationId(db, operationId);
                    if (!email) return { ok: true };
                    if (email.status === "pending_approval") {
                        await sendEmailNow(db, email.id, {
                            approvedBy: userId,
                            approvedByEmail: userEmail,
                        });
                    }
                    return { ok: true };
                },
                sendSignature: async (operationId) => {
                    const env = await getEnvelopeWithSignersByOperationId(
                        db,
                        operationId,
                    );
                    if (!env) return { ok: true };
                    if (env.envelope.status === "pending_approval") {
                        return renderAndSendEnvelope(db, {
                            envelope: env.envelope,
                            signers: env.signers,
                            approverUserId: userId,
                            approverEmail: userEmail ?? "",
                        });
                    }
                    return { ok: true };
                },
                // Case-write ops (update_case_insurance / record_case_expense,
                // staged by the PI automation pipeline). Task 4a wires the
                // routing only — applyCaseWriteOperation is a deliberate 501
                // stub until the 4b pipeline lands the real appliers, so an
                // approval today surfaces as an explicit error, never a
                // silent "approved but nothing happened".
                caseWrite: (operationId) =>
                    applyCaseWriteOperation(db, operationId),
                // Calendar-write ops (create_event / update_event /
                // delete_event drafted in chat). A reloaded card approves here;
                // owner-gated, then applyCalendarWriteNow commits to Google.
                // Status-guarded, so a double-approve is a no-op.
                calendarWrite: async (operationId) => {
                    const write = await getCalendarWriteByOperationId(
                        db,
                        operationId,
                    );
                    if (!write) return { ok: true };
                    if (write.status === "pending_approval") {
                        await applyCalendarWriteNow(db, write.id, {
                            approvedBy: userId,
                        });
                    }
                    return { ok: true };
                },
            });
            if (dispatch.kind === "error") {
                return void res.status(dispatch.status).json({
                    detail: dispatch.detail,
                    ...(dispatch.code ? { code: dispatch.code } : {}),
                });
            }
            if (
                dispatch.kind === "email" ||
                dispatch.kind === "signature" ||
                dispatch.kind === "case_write" ||
                dispatch.kind === "calendar"
            ) {
                // A send ran and flipped the operation to succeeded / failed —
                // return the freshly-reconciled row so the card reflects the real
                // outcome, not just "approved". Doc ops fall through unchanged.
                const fresh = await getAgentOperation({
                    db,
                    operationId: operation.id,
                    userId,
                    userEmail,
                });
                return void res.json({ operation: fresh ?? operation });
            }
        } catch (sideErr) {
            if (sideErr instanceof EmailAttachmentError) {
                return void res
                    .status(
                        sideErr.code === "EMAIL_ATTACHMENT_FORBIDDEN"
                            ? 403
                            : 422,
                    )
                    .json({ code: sideErr.code, detail: sideErr.message });
            }
            if (sideErr instanceof BetaPolicyError) {
                return void res.status(sideErr.status).json({ code: sideErr.code, detail: sideErr.message });
            }
            if (sideErr instanceof ConnectorNotConfiguredError) {
                return void res.status(503).json({ detail: sideErr.message });
            }
            throw sideErr;
        }

        res.json({ operation });
    } catch (err) {
        res.status(400).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to approve operation",
        });
    }
});

// POST /operations/:operationId/undo
operationsRouter.post("/:operationId/undo", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    try {
        const operation = await undoAgentOperation({
            db,
            operationId: req.params.operationId,
            userId,
            userEmail,
        });
        if (!operation)
            return void res.status(404).json({ detail: "Operation not found" });
        res.json({ operation });
    } catch (err) {
        res.status(400).json({
            detail:
                err instanceof Error
                    ? err.message
                    : "Failed to undo operation",
        });
    }
});
