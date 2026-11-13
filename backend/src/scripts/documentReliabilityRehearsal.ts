/**
 * Destructive integration rehearsal for disposable Supabase/R2 resources.
 *
 * Guardrails:
 * - refuses to start without an explicit opt-in and synthetic user id;
 * - creates its own project, document UUIDs, version UUIDs, and object paths;
 * - records every created object path/row id before use;
 * - deletes only those recorded fixture resources in finally.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServerSupabase } from "../lib/supabase";
import { renderSectionsToDocxBuffer } from "../lib/docxAssembly";
import { extractDocxBodyText } from "../lib/docxTrackedChanges";
import { deleteFile, downloadFile, uploadFile } from "../lib/storage";
import { runEditDocument } from "../lib/chatTools";
import { getProjectActionState } from "../lib/documentActionState";
import { reconcileProjectTasks } from "../lib/matterTasks";

if (process.env.ALLOW_DOCUMENT_RELIABILITY_REHEARSAL !== "true") {
    throw new Error(
        "Refusing to run. Set ALLOW_DOCUMENT_RELIABILITY_REHEARSAL=true only for disposable local Supabase/R2 resources.",
    );
}
const configuredUserId = process.env.REHEARSAL_SYNTHETIC_USER_ID?.trim();
if (!configuredUserId || !configuredUserId.startsWith("synthetic-")) {
    throw new Error(
        "REHEARSAL_SYNTHETIC_USER_ID must be set and start with 'synthetic-'.",
    );
}
const userId: string = configuredUserId;

const db = createServerSupabase();
const runId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const orgId = crypto.randomUUID();
const matterId = crypto.randomUUID();
const documentIds = [crypto.randomUUID(), crypto.randomUUID()];
const versionIds = [crypto.randomUUID(), crypto.randomUUID()];
const objectPaths: string[] = [];

async function cleanup() {
    await Promise.all(objectPaths.map((key) => deleteFile(key).catch(() => {})));
    await db.from("matter_tasks").delete().eq("project_id", projectId);
    await db.from("email_messages").delete().eq("project_id", projectId);
    await db.from("signature_envelopes").delete().eq("project_id", projectId);
    await db.from("agent_operations").delete().eq("project_id", projectId);
    await db.from("projects").delete().eq("id", projectId);
    await db.from("matters").delete().eq("id", matterId);
    await db.from("organizations").delete().eq("id", orgId);
}

async function main() {
    const rendered = await renderSectionsToDocxBuffer("Parenting Plan", [
        {
            heading: "Parenting Time",
            content:
                "Weekday parenting time begins at 5:00 p.m. The parties will exchange the child at school.",
        },
        {
            pageBreak: true,
            content:
                "IN WITNESS WHEREOF\n\n{{coco-sign:0}}\nParent A\nBy: ____________________\nDate: __________\n\n{{coco-sign:1}}\nParent B\nBy: ____________________\nDate: __________",
        },
    ]);
    if ("error" in rendered) throw new Error(rendered.error);

    await db.from("organizations").insert({
        id: orgId,
        name: `[synthetic rehearsal org ${runId}]`,
        created_by_user_id: userId,
    });
    await db.from("organization_memberships").insert({
        organization_id: orgId,
        user_id: userId,
        email: `${userId}@synthetic.invalid`,
        role: "owner",
        status: "active",
        accepted_at: new Date().toISOString(),
    });
    await db.from("projects").insert({
        id: projectId,
        user_id: userId,
        org_id: orgId,
        name: `[synthetic rehearsal ${runId}]`,
    });
    await db.from("matters").insert({
        id: matterId,
        organization_id: orgId,
        project_id: projectId,
        name: `[synthetic rehearsal ${runId}]`,
        created_by_user_id: userId,
    });
    await db.from("projects").update({ matter_id: matterId }).eq("id", projectId);
    await db.from("matter_memberships").insert({
        matter_id: matterId,
        user_id: userId,
        email: `${userId}@synthetic.invalid`,
        role: "owner",
        status: "active",
        accepted_at: new Date().toISOString(),
    });
    await db.from("organization_beta_policies").upsert({
        organization_id: orgId,
        data_policy_accepted_at: new Date().toISOString(),
        data_policy_accepted_by_user_id: userId,
        allowed_recipient_domains: ["synthetic.invalid"],
    });
    for (let index = 0; index < documentIds.length; index += 1) {
        const documentId = documentIds[index];
        const versionId = versionIds[index];
        const path = `rehearsals/${runId}/${documentId}/v1.docx`;
        objectPaths.push(path);
        await uploadFile(
            path,
            rendered.buffer.buffer.slice(
                rendered.buffer.byteOffset,
                rendered.buffer.byteOffset + rendered.buffer.byteLength,
            ) as ArrayBuffer,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        await db.from("documents").insert({
            id: documentId,
            project_id: projectId,
            org_id: orgId,
            matter_id: matterId,
            user_id: userId,
            filename: "Parenting Plan.docx",
            file_type: "docx",
            status: "ready",
            size_bytes: rendered.buffer.byteLength,
        });
        await db.from("document_versions").insert({
            id: versionId,
            document_id: documentId,
            storage_path: path,
            source: "upload",
            version_number: 1,
            display_name: "Parenting Plan.docx",
            created_by_user_id: userId,
        });
        await db
            .from("documents")
            .update({ current_version_id: versionId })
            .eq("id", documentId);
    }

    const firstBefore = await downloadFile(objectPaths[0]);
    assert.ok(firstBefore);
    const initialEdits = [
        {
            find: "Weekday parenting time begins at 5:00 p.m.",
            replace: "Weekday parenting time begins at 6:00 p.m.",
            context_before: "",
            context_after:
                "The parties will exchange the child at school.",
            reason: "Synthetic displayed-copy rehearsal",
        },
    ];
    const edit = await runEditDocument({
        documentId: documentIds[1],
        sourceVersionId: versionIds[1],
        userId,
        edits: initialEdits,
        db,
        toolName: "edit_displayed_document",
        toolCallId: `${runId}-edit-displayed`,
        projectId,
    });
    assert.equal(edit.ok, true, edit.ok ? undefined : edit.error);
    if (!edit.ok) return;
    objectPaths.push(edit.storage_path);
    assert.notEqual(edit.storage_path, objectPaths[1]);

    const [firstAfter, secondAfter] = await Promise.all([
        downloadFile(objectPaths[0]),
        downloadFile(edit.storage_path),
    ]);
    assert.ok(firstAfter && secondAfter);
    assert.deepEqual(Buffer.from(firstAfter), Buffer.from(firstBefore));
    assert.match(await extractDocxBodyText(Buffer.from(secondAfter)), /6:00 p\.m\./);

    const replay = await runEditDocument({
        documentId: documentIds[1],
        sourceVersionId: versionIds[1],
        userId,
        edits: initialEdits,
        db,
        toolName: "edit_displayed_document",
        toolCallId: `${runId}-edit-displayed`,
        projectId,
    });
    assert.equal(replay.ok, true, replay.ok ? undefined : replay.error);
    if (!replay.ok) return;
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.version_id, edit.version_id);
    assert.equal(replay.storage_path, edit.storage_path);

    const sequential = await runEditDocument({
        documentId: documentIds[1],
        sourceVersionId: edit.version_id,
        userId,
        edits: [
            {
                find: "Weekday parenting time begins at 6:00 p.m.",
                replace: "Weekday parenting time begins at 6:30 p.m.",
                context_before: "",
                context_after:
                    "The parties will exchange the child at school.",
                reason: "Synthetic parent-chain rehearsal",
            },
        ],
        db,
        toolName: "edit_displayed_document",
        toolCallId: `${runId}-sequential-edit`,
        projectId,
    });
    assert.equal(
        sequential.ok,
        true,
        sequential.ok ? undefined : sequential.error,
    );
    if (!sequential.ok) return;
    objectPaths.push(sequential.storage_path);
    const { data: sequentialVersion } = await db
        .from("document_versions")
        .select("parent_version_id")
        .eq("id", sequential.version_id)
        .single();
    assert.equal(sequentialVersion?.parent_version_id, edit.version_id);

    const stale = await runEditDocument({
        documentId: documentIds[1],
        sourceVersionId: versionIds[1],
        userId,
        edits: [
            {
                find: "5:00 p.m.",
                replace: "7:00 p.m.",
                context_before: "",
                context_after: "",
            },
        ],
        db,
        toolName: "edit_displayed_document",
        toolCallId: `${runId}-stale-version`,
        projectId,
    });
    assert.equal(stale.ok, false);
    if (stale.ok) throw new Error("Historical edit unexpectedly succeeded");
    assert.equal(stale.error_code, "DISPLAYED_VERSION_NOT_CURRENT");
    assert.deepEqual(stale.resolution?.choices, [
        "edit current",
        "fork from displayed",
        "create a copy",
    ]);

    // Exercise the transactional compare-and-swap directly. Both candidate
    // objects exist, but exactly one version becomes visible and the losing
    // unreferenced object remains on our fixture cleanup list.
    const sequentialBytes = await downloadFile(sequential.storage_path);
    assert.ok(sequentialBytes);
    const operationIds = [crypto.randomUUID(), crypto.randomUUID()];
    const resultVersionIds = [crypto.randomUUID(), crypto.randomUUID()];
    const candidatePaths = resultVersionIds.map(
        (versionId) => `rehearsals/${runId}/${documentIds[1]}/${versionId}.docx`,
    );
    objectPaths.push(...candidatePaths);
    await Promise.all(
        candidatePaths.map((path) =>
            uploadFile(
                path,
                sequentialBytes,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
        ),
    );
    const { error: operationInsertError } = await db
        .from("agent_operations")
        .insert(
            operationIds.map((id, index) => ({
                id,
                org_id: orgId,
                matter_id: matterId,
                project_id: projectId,
                actor_user_id: userId,
                tool_name: "edit_displayed_document",
                action_type: "document_edit",
                status: "running",
                approval_status: "not_required",
                mutating: true,
                source_document_id: documentIds[1],
                source_version_id: sequential.version_id,
                result_document_id: documentIds[1],
                idempotency_key: `${runId}-cas-${index}`,
            })),
        );
    assert.equal(operationInsertError, null);
    const casResults = await Promise.all(
        operationIds.map((operationId, index) =>
            db.rpc("commit_document_edit", {
                p_operation_id: operationId,
                p_document_id: documentIds[1],
                p_expected_version_id: sequential.version_id,
                p_result_version_id: resultVersionIds[index],
                p_storage_path: candidatePaths[index],
                p_display_name: "Parenting Plan.docx",
                p_created_by_user_id: userId,
                p_chat_message_id: null,
                p_branch_chat_id: null,
                p_edits: [],
            }),
        ),
    );
    assert.equal(casResults.filter((result) => !result.error).length, 1);
    const conflict = casResults.find((result) => result.error)?.error;
    assert.match(String(conflict?.message ?? conflict), /DOCUMENT_VERSION_CONFLICT/);

    // Matter-wide truth: V2 was sent and replied to, its signer completed, and
    // an exact-evidence task reconciles once. The current CAS result is newer,
    // so action state must preserve V2 history while showing current freshness.
    const emailId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const envelopeId = crypto.randomUUID();
    const signerId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const evidenceAt = new Date().toISOString();
    await db.from("email_messages").insert([
        {
            id: emailId,
            org_id: orgId,
            matter_id: matterId,
            project_id: projectId,
            user_id: userId,
            direction: "outbound",
            status: "sent",
            from_address: "quill@synthetic.invalid",
            to_addresses: ["recipient@synthetic.invalid"],
            subject: "Synthetic Parenting Plan",
            provider_thread_id: `${runId}-thread`,
            sent_at: evidenceAt,
            attachments: [{ document_id: documentIds[1], version_id: edit.version_id, filename: "Parenting Plan.docx" }],
        },
        {
            id: replyId,
            org_id: orgId,
            matter_id: matterId,
            project_id: projectId,
            user_id: userId,
            direction: "inbound",
            status: "received",
            from_address: "recipient@synthetic.invalid",
            to_addresses: ["quill@synthetic.invalid"],
            subject: "Re: Synthetic Parenting Plan",
            provider_thread_id: `${runId}-thread`,
            received_at: evidenceAt,
        },
    ]);
    await db.from("signature_envelopes").insert({
        id: envelopeId,
        org_id: orgId,
        matter_id: matterId,
        project_id: projectId,
        user_id: userId,
        document_id: documentIds[1],
        source_version_id: edit.version_id,
        status: "completed",
        subject: "Synthetic nonbinding signature",
        completed_at: evidenceAt,
    });
    await db.from("signature_signers").insert({
        id: signerId,
        envelope_id: envelopeId,
        name: "Synthetic Signer",
        email: "signer@synthetic.invalid",
        status: "signed",
        viewed_at: evidenceAt,
        signed_at: evidenceAt,
    });
    await db.from("matter_tasks").insert({
        id: taskId,
        org_id: orgId,
        matter_id: matterId,
        project_id: projectId,
        title: "Send synthetic V2",
        email_message_id: emailId,
        completion_rule: { type: "email_sent" },
        created_by_user_id: userId,
    });
    assert.equal(await reconcileProjectTasks(db, projectId), 1);
    const actionState = await getProjectActionState(db, projectId);
    const displayedState = actionState.documents.find(
        (document) => document.document_id === documentIds[1],
    );
    assert.ok(displayedState);
    assert.equal(displayedState.delivery.sent_versions[0]?.replies.length, 1);
    assert.equal(displayedState.delivery.newer_version_available, true);
    assert.equal(displayedState.signature.versions[0]?.signers[0]?.status, "signed");
    assert.equal(actionState.tasks.find((task) => task.id === taskId)?.status, "completed");

    const reopenedAt = new Date(Date.now() + 1_000).toISOString();
    await db.from("matter_tasks").update({
        status: "open",
        completed_at: null,
        completion_evidence_type: null,
        completion_evidence_id: null,
        completion_evidence_at: null,
        reopened_at: reopenedAt,
        revision: 3,
    }).eq("id", taskId);
    assert.equal(await reconcileProjectTasks(db, projectId), 0);
    console.info("Document reliability rehearsal passed", {
        project_id: projectId,
        displayed_document_id: documentIds[1],
        result_version_id: sequential.version_id,
    });
}

main()
    .finally(cleanup)
    .catch((error) => {
        console.error(
            "Document reliability rehearsal failed",
            error instanceof Error ? error.message : "unknown error",
        );
        process.exitCode = 1;
    });
