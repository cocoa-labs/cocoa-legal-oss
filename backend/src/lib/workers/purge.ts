import crypto from "node:crypto";
import { createServerSupabase } from "../supabase";
import { deleteFile } from "../storage";
import { claimWorkerLease, workerInstanceId } from "./leases";

let timer: NodeJS.Timeout | null = null;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function holdIsActive(value: unknown): boolean {
  return typeof value === "string" && new Date(value).getTime() > Date.now();
}

export async function purgeExpiredContentOnce(): Promise<{ documents: number; projects: number }> {
  const db = createServerSupabase();
  const ownerId = workerInstanceId();
  if (!(await claimWorkerLease(db, "lifecycle-purge", ownerId, 3_600)))
    return { documents: 0, projects: 0 };

  const now = new Date().toISOString();
  await db.from("rate_limit_buckets").delete().lt("expires_at", now);
  await db.from("worker_leases").delete().lt("leased_until", now);
  const { data: documents, error } = await db
    .from("documents")
    .select("id, org_id, matter_id, project_id, legal_hold_until")
    .eq("lifecycle_status", "deleted_pending_purge")
    .lte("retention_until", now)
    .limit(250);
  if (error) throw error;
  let documentCount = 0;
  for (const document of documents ?? []) {
    if (holdIsActive(document.legal_hold_until)) continue;
    const [{ data: project }, { data: matter }] = await Promise.all([
      document.project_id
        ? db.from("projects").select("legal_hold_until").eq("id", document.project_id).maybeSingle()
        : Promise.resolve({ data: null }),
      document.matter_id
        ? db.from("matters").select("lifecycle_status, retention_until").eq("id", document.matter_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (holdIsActive(project?.legal_hold_until) || matter?.lifecycle_status === "legal_hold") continue;
    const { data: versions } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path")
      .eq("document_id", document.id);
    const { data: attachmentOriginals, error: attachmentError } = await db.from("inbound_email_attachments")
      .select("raw_storage_path").eq("document_id", document.id);
    if (attachmentError) continue;
    const paths = [...new Set([
      ...(versions ?? []).flatMap((version) => [version.storage_path, version.pdf_storage_path]),
      ...(attachmentOriginals ?? []).map(original => original.raw_storage_path),
    ].filter((path): path is string => typeof path === "string" && Boolean(path)))].sort();
    let objectsPurged = 0;
    for (const path of paths) {
      try { await deleteFile(path); objectsPurged += 1; } catch (storageError) {
        console.warn("[purge] object deletion failed; retaining database row", { documentId: document.id, error: storageError instanceof Error ? storageError.message : String(storageError) });
        objectsPurged = -1;
        break;
      }
    }
    if (objectsPurged < 0) continue;
    const { error: deleteError } = await db.from("documents").delete().eq("id", document.id);
    if (deleteError) continue;
    await db.from("purge_receipts").insert({
      org_id: document.org_id,
      target_type: "document",
      target_id_hash: sha256(String(document.id)),
      database_rows_purged: 1 + (versions?.length ?? 0),
      objects_purged: objectsPurged,
      manifest_sha256: sha256(paths.join("\n")),
    });
    documentCount += 1;
  }

  const { data: projects } = await db
    .from("projects")
    .select("id, org_id, matter_id, legal_hold_until")
    .eq("lifecycle_status", "deleted_pending_purge")
    .lte("retention_until", now)
    .limit(100);
  let projectCount = 0;
  for (const project of projects ?? []) {
    if (holdIsActive(project.legal_hold_until)) continue;
    const { data: projectMatter } = project.matter_id
      ? await db
          .from("matters")
          .select("lifecycle_status")
          .eq("id", project.matter_id)
          .maybeSingle()
      : { data: null };
    if (projectMatter?.lifecycle_status === "legal_hold") continue;
    const { count } = await db.from("documents").select("id", { count: "exact", head: true }).eq("project_id", project.id);
    if ((count ?? 0) > 0) continue;

    const [{ data: recordings }, { data: envelopes }, { data: attachments }] =
      await Promise.all([
        db
          .from("recordings")
          .select("audio_storage_key")
          .eq("project_id", project.id),
        db
          .from("signature_envelopes")
          .select("id, original_pdf_path, executed_pdf_path, certificate_path")
          .eq("project_id", project.id),
        db
          .from("chat_attachments")
          .select("storage_path")
          .eq("project_id", project.id),
      ]);
    const envelopeIds = (envelopes ?? []).map((envelope) => String(envelope.id));
    const { data: signers } = envelopeIds.length
      ? await db
          .from("signature_signers")
          .select("signature_image_path")
          .in("envelope_id", envelopeIds)
      : { data: [] };
    const { data: emails, error: emailError } = await db.from("email_messages").select("id").eq("project_id", project.id);
    if (emailError) continue;
    const emailIds = (emails ?? []).map(email => email.id);
    const { data: emailAttachments, error: emailAttachmentError } = emailIds.length
      ? await db.from("inbound_email_attachments").select("raw_storage_path").in("email_id", emailIds)
      : { data: [], error: null };
    if (emailAttachmentError) continue;
    const projectPaths = [
      ...(emailAttachments ?? []).map(attachment => attachment.raw_storage_path),
      ...(recordings ?? []).map((recording) => recording.audio_storage_key),
      ...(attachments ?? []).map((attachment) => attachment.storage_path),
      ...(envelopes ?? []).flatMap((envelope) => [
        envelope.original_pdf_path,
        envelope.executed_pdf_path,
        envelope.certificate_path,
      ]),
      ...(signers ?? []).map((signer) => signer.signature_image_path),
    ]
      .filter((path): path is string => typeof path === "string" && Boolean(path))
      .filter((path, index, all) => all.indexOf(path) === index)
      .sort();
    let projectObjectsPurged = 0;
    let objectFailure = false;
    for (const path of projectPaths) {
      try {
        await deleteFile(path);
        projectObjectsPurged += 1;
      } catch (storageError) {
        console.warn("[purge] project object deletion failed", {
          projectId: project.id,
          error:
            storageError instanceof Error
              ? storageError.message
              : String(storageError),
        });
        objectFailure = true;
        break;
      }
    }
    if (objectFailure) continue;

    const contentTables = [
      "recordings",
      "signature_envelopes",
      "email_messages",
      "calendar_writes",
      "calendar_event_meta",
      "authoring_jobs",
      "document_generation_jobs",
      "agent_operations",
      "tabular_reviews",
      "chats",
    ];
    let databaseRowsPurged = 1;
    let databaseFailure = false;
    for (const table of contentTables) {
      const { count: rowCount } = await db
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("project_id", project.id);
      const { error: contentDeleteError } = await db
        .from(table)
        .delete()
        .eq("project_id", project.id);
      if (contentDeleteError) {
        databaseFailure = true;
        break;
      }
      databaseRowsPurged += rowCount ?? 0;
    }
    if (databaseFailure) continue;
    const { error: deleteError } = await db.from("projects").delete().eq("id", project.id);
    if (deleteError) continue;
    if (project.matter_id) {
      const { error: matterDeleteError } = await db
        .from("matters")
        .delete()
        .eq("id", project.matter_id);
      if (!matterDeleteError) databaseRowsPurged += 1;
    }
    await db.from("purge_receipts").insert({
      org_id: project.org_id,
      target_type: "project",
      target_id_hash: sha256(String(project.id)),
      database_rows_purged: databaseRowsPurged,
      objects_purged: projectObjectsPurged,
      manifest_sha256: sha256(projectPaths.join("\n")),
    });
    projectCount += 1;
  }
  return { documents: documentCount, projects: projectCount };
}

export function startLifecyclePurgeWorker(): void {
  if (timer || (process.env.LIFECYCLE_PURGE_ENABLED ?? "true") === "false") return;
  const run = () => void purgeExpiredContentOnce().catch((error) =>
    console.error("[purge] sweep failed", { error: error instanceof Error ? error.message : String(error) }),
  );
  run();
  timer = setInterval(run, 24 * 60 * 60_000);
  timer.unref();
}
