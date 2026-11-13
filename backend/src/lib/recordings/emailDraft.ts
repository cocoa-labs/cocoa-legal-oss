// backend/src/lib/recordings/emailDraft.ts
//
// Wire a ready recording's summary into the EXISTING draft-then-approve email
// rails. This module drafts ONLY — it never sends. The flow is a deterministic
// mirror of the send_email chat-tool handler (chatTools.ts ~4211): a paired
// createAgentOperation (requiresApproval: true) + createPendingEmail, linked by
// the operation id. The email then leaves solely through the human-approval
// route the send_email card already uses (POST /email/:id/approve →
// sendEmailNow); nothing here calls the connector.
//
// Divergences from send_email, all intentional:
//   * The body is assembled deterministically from the recording (no model
//     call) — the summary already exists. bodyHtml is left unset exactly as
//     send_email leaves it when the model supplies no html.
//   * The single attachment is the recording's transcript PDF, and because we
//     KNOW its exact version and content type we PIN both on the ref
//     (version_id = the document's current_version_id, content_type
//     "application/pdf") — the send_email handler can only fill {document_id,
//     filename} from chat context, so it omits them. Both extra fields are
//     honored at send time (email/send.ts loadActiveVersion + content_type).
//
// The guard (loadReadyRecording) is T8's shared one, so a not-found / not-ready
// recording throws the same RecordingArtifactError the routes map to 404 / 409.

import { randomUUID } from "node:crypto";
import type { createServerSupabase } from "../supabase";
import { createAgentOperation } from "../operations";
import {
    createPendingEmail,
    getEmail,
    type EmailAttachmentRef,
} from "../email/store";
import { loadReadyRecording, RecordingArtifactError } from "./artifacts";
import { getRecording, updateRecording } from "./store";
import { persistTranscriptPdf } from "./transcriptPdf";
import { generateTimelineImage } from "./timelineImage";
import type { ActionItem, Recording } from "./types";

type Db = ReturnType<typeof createServerSupabase>;

/** Caller-supplied overrides for the drafted email. All optional — an empty
 * input drafts to the caller's own address with a default subject. */
export interface DraftRecordingEmailInput {
    to?: string[];
    cc?: string[];
    subject?: string;
    /** A short lead-in paragraph placed above the summary in the body. */
    note?: string;
    /**
     * Embed the recording's timeline image inline in the email (and attach it).
     * Defaults ON (undefined ⇒ true, matching the compose dialog's default-
     * checked box). When on and the image is missing it is auto-generated.
     */
    includeTimelineImage?: boolean;
    /** Re-draft even when a still-pending email is already linked. */
    force?: boolean;
}

/** Injectable collaborators; every default is the real implementation. */
export interface DraftRecordingEmailDeps {
    getRecordingFn?: typeof getRecording;
    getEmailFn?: typeof getEmail;
    persistTranscriptPdfFn?: typeof persistTranscriptPdf;
    createAgentOperationFn?: typeof createAgentOperation;
    createPendingEmailFn?: typeof createPendingEmail;
    updateRecordingFn?: typeof updateRecording;
    generateTimelineImageFn?: typeof generateTimelineImage;
}

export interface DraftRecordingEmailResult {
    emailId: string;
    /** The recording after linking (reloaded so its email_id is set). */
    recording: Recording;
    /** false when a still-pending linked draft was reused (no new work). */
    created: boolean;
}

/**
 * Render one action item as a plain-text checklist line: `- [ ] text` (or
 * `- [x] text` when done), with a `(owner, due)` suffix built from whichever of
 * owner / due are present. Neither present → no suffix.
 */
function formatActionItemLine(item: ActionItem): string {
    const box = item.done ? "[x]" : "[ ]";
    const meta: string[] = [];
    const owner = item.owner?.trim();
    const due = item.due?.trim();
    if (owner) meta.push(owner);
    if (due) meta.push(due);
    const suffix = meta.length ? ` (${meta.join(", ")})` : "";
    return `- ${box} ${item.text}${suffix}`;
}

/**
 * Pure: the plain-text email body. An optional `note` paragraph leads, then the
 * recording's summary_md as-is (it is already human-readable Markdown), then an
 * "Action items:" block when any exist. Blocks are separated by a blank line and
 * the whole is newline-terminated. This is the body_text; there is no html body
 * (mirrors send_email leaving bodyHtml unset absent a model-supplied one).
 */
export function buildRecordingEmailBody(
    recording: Recording,
    note?: string,
): string {
    const blocks: string[] = [];

    const trimmedNote = note?.trim();
    if (trimmedNote) blocks.push(trimmedNote);

    const summary = recording.summary_md?.trim();
    if (summary) blocks.push(summary);

    if (recording.action_items.length > 0) {
        blocks.push(
            ["Action items:", ...recording.action_items.map(formatActionItemLine)].join(
                "\n",
            ),
        );
    }

    return blocks.join("\n\n").trim() + "\n";
}

/**
 * Draft (but never send) an email carrying a recording's summary + transcript
 * PDF, through the existing agent-operation + pending-email rails.
 *
 * 1. Guard via loadReadyRecording (tenancy + ready + summary present).
 * 2. Idempotence: a still-pending linked email is reused (created: false)
 *    unless `force`; a prior sent / cancelled / failed / missing one is replaced.
 * 3. Ensure the transcript PDF exists (regenerate via persistTranscriptPdf when
 *    absent), then pin the attachment to its current version.
 * 4. Create the send_email-shaped operation (requiresApproval: true) + the
 *    pending email, link email_id onto the recording, and return the reload.
 */
export async function draftRecordingEmail(params: {
    db: Db;
    recordingId: string;
    userId: string;
    /** The caller's own address — the default recipient when `to` is empty. */
    userEmail: string;
    input: DraftRecordingEmailInput;
    deps?: DraftRecordingEmailDeps;
}): Promise<DraftRecordingEmailResult> {
    const { db, recordingId, userId, userEmail, input } = params;
    const deps = params.deps ?? {};
    const getRecordingFn = deps.getRecordingFn ?? getRecording;

    const recording = await loadReadyRecording({
        db,
        recordingId,
        userId,
        getRecordingFn,
    });

    // --- Idempotence: reuse a still-pending linked draft unless forced. ------
    if (recording.email_id && !input.force) {
        const existing = await (deps.getEmailFn ?? getEmail)(
            db,
            recording.email_id,
        );
        if (existing && existing.status === "pending_approval") {
            return { emailId: existing.id, recording, created: false };
        }
        // Otherwise (sent / cancelled / failed / missing) fall through and cut
        // a fresh draft, replacing the stale email_id below.
    }

    // --- Transcript attachment: ensure the PDF, pin its current version. -----
    let transcriptDocumentId = recording.transcript_document_id;
    if (!transcriptDocumentId) {
        // The pipeline persists this before `ready`, but a row can predate that
        // guarantee — regenerate and store it (same shape the pipeline used).
        const persisted = await (
            deps.persistTranscriptPdfFn ?? persistTranscriptPdf
        )({ db, recording });
        transcriptDocumentId = persisted.documentId;
        await (deps.updateRecordingFn ?? updateRecording)(db, recording.id, {
            transcript_document_id: transcriptDocumentId,
        });
    }

    const { data: docRow, error: docErr } = await db
        .from("documents")
        .select("current_version_id, filename")
        .eq("id", transcriptDocumentId)
        .maybeSingle();
    if (docErr) throw docErr;
    const versionId =
        (docRow as { current_version_id?: string | null } | null)
            ?.current_version_id ?? null;
    if (!versionId) {
        throw new RecordingArtifactError(
            "not_ready",
            "Transcript document is not available.",
        );
    }
    // The attachment filename is the transcript document's own stored filename
    // (persistGeneratedArtifact wrote "<sanitized title> - transcript.pdf"), so
    // the recipient sees exactly the document's name.
    const filename =
        (docRow as { filename?: string | null }).filename?.trim() ||
        "transcript.pdf";
    const attachment: EmailAttachmentRef = {
        document_id: transcriptDocumentId,
        version_id: versionId,
        filename,
        content_type: "application/pdf",
    };
    const attachments: EmailAttachmentRef[] = [attachment];

    // --- Resolve the send fields. -------------------------------------------
    const to = input.to?.length ? input.to : [userEmail];
    const cc = input.cc ?? [];
    const title = recording.title;
    const subject =
        input.subject?.trim() || `Recording summary: ${title}`;
    const bodyText = buildRecordingEmailBody(recording, input.note);

    // --- Optional timeline image (default ON): embed inline + attach. --------
    // Auto-generate when missing (generateTimelineImage is idempotent). A paid
    // gpt-image-2 failure must NOT sink the summary email — on any error we log
    // and fall back to a transcript-only draft.
    if (input.includeTimelineImage !== false) {
        try {
            const gen = await (
                deps.generateTimelineImageFn ?? generateTimelineImage
            )({ db, recordingId: recording.id, userId });

            let timelineVersionId: string | null | undefined = gen.versionId;
            if (!timelineVersionId) {
                // The idempotent short-circuit returns no versionId — resolve the
                // current version the same way the transcript ref does above.
                const { data: tlRow } = await db
                    .from("documents")
                    .select("current_version_id")
                    .eq("id", gen.documentId)
                    .maybeSingle();
                timelineVersionId =
                    (tlRow as { current_version_id?: string | null } | null)
                        ?.current_version_id ?? null;
            }

            const safeTitle =
                (title || "recording").replace(/[^\w .-]+/g, "").trim() ||
                "recording";
            attachments.push({
                document_id: gen.documentId,
                version_id: timelineVersionId,
                filename: `${safeTitle} - timeline.png`,
                content_type: "image/png",
                inline: true,
                content_id: randomUUID(),
            });
        } catch (err) {
            console.warn(
                `[recordings] timeline image unavailable for ${recording.id}; drafting transcript-only:`,
                err instanceof Error ? err.message : err,
            );
        }
    }

    // --- Operation (mirror of send_email verbatim-in-shape). -----------------
    // send_email itself carries no human-readable label field, so the required
    // summary lives in metadata (CreateAgentOperationInput has no summary param);
    // arguments/toolName/actionType/mutating/requiresApproval + the project/chat
    // linkage are the send_email handler's exactly.
    const operation = await (
        deps.createAgentOperationFn ?? createAgentOperation
    )({
        db,
        userId,
        projectId: recording.project_id ?? null,
        chatId: recording.chat_id ?? null,
        toolName: "send_email",
        actionType: "send_email",
        mutating: true,
        requiresApproval: true,
        arguments: {
            to,
            subject,
            attachment_count: attachments.length,
        },
        metadata: {
            summary: `Email recording summary "${title}" to ${to.join(", ")}`,
            recording_id: recording.id,
        },
    });

    // --- Pending email draft (leaves only via the approval route). -----------
    const email = await (deps.createPendingEmailFn ?? createPendingEmail)(db, {
        userId,
        projectId: recording.project_id ?? null,
        chatId: recording.chat_id ?? null,
        agentOperationId: operation?.id ?? null,
        to,
        cc,
        subject,
        bodyText,
        attachments,
    });
    if (!email) {
        throw new Error(
            "Email could not be drafted because the email store is unavailable.",
        );
    }

    // --- Link + return the reload. ------------------------------------------
    await (deps.updateRecordingFn ?? updateRecording)(db, recording.id, {
        email_id: email.id,
    });
    const reloaded = await getRecordingFn(db, recording.id, userId);

    return {
        emailId: email.id,
        recording: reloaded ?? { ...recording, email_id: email.id },
        created: true,
    };
}
