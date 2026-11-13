import { createHash } from "node:crypto";
import type { createServerSupabase } from "./supabase";
import {
  listMatterTasks,
  reconcileProjectTasks,
  type MatterTask,
} from "./matterTasks";

type Db = ReturnType<typeof createServerSupabase>;

export type ReplyEvidence = {
  email_id: string;
  from_address: string | null;
  received_at: string;
};

export type DocumentActionState = {
  document_id: string;
  filename: string;
  current_version: {
    id: string | null;
    number: number | null;
    source: string | null;
    modified_at: string | null;
  };
  delivery: {
    current_version_sent: boolean;
    sent_versions: {
      email_id: string;
      version_id: string;
      version_number: number | null;
      sent_at: string | null;
      from_address: string | null;
      to_addresses: string[];
      cc_addresses: string[];
      bcc_addresses: string[];
      replies: ReplyEvidence[];
    }[];
    pending_versions: {
      version_id: string;
      status: string;
      email_id: string;
      from_address: string | null;
      to_addresses: string[];
      cc_addresses: string[];
      bcc_addresses: string[];
      sent_at: string | null;
    }[];
    newer_version_available: boolean;
  };
  signature: {
    current_version_status: string | null;
    latest_envelope_id: string | null;
    versions: {
      version_id: string;
      status: string;
      envelope_id: string;
      updated_at: string;
      completed_at: string | null;
      signers: {
        id: string;
        name: string;
        email: string;
        status: string;
        viewed_at: string | null;
        signed_at: string | null;
        declined_at: string | null;
      }[];
    }[];
    newer_version_available: boolean;
  };
  pending_operations: {
    id: string;
    tool_name: string;
    status: string;
    created_at: string;
  }[];
};

type DocumentRow = {
  id: string;
  filename: string;
  current_version_id: string | null;
  updated_at: string | null;
};

type VersionRow = {
  id: string;
  document_id: string;
  version_number: number | null;
  source: string | null;
  created_at: string;
};

type EmailRow = {
  id: string;
  direction?: "inbound" | "outbound";
  status: string;
  attachments: unknown;
  from_address?: string | null;
  to_addresses?: unknown;
  cc_addresses?: unknown;
  bcc_addresses?: unknown;
  provider_thread_id?: string | null;
  sent_at: string | null;
  received_at?: string | null;
  updated_at: string;
  completed_at?: string | null;
};

type EnvelopeRow = {
  id: string;
  document_id: string | null;
  source_version_id: string | null;
  status: string;
  completed_at?: string | null;
  updated_at: string;
};

type SignerRow = {
  id: string;
  envelope_id: string;
  name: string;
  email: string;
  status: string;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
};

type OperationRow = {
  id: string;
  source_document_id: string | null;
  result_document_id: string | null;
  tool_name: string;
  status: string;
  created_at: string;
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function attachmentRefs(
  value: unknown,
): { document_id: string; version_id: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.document_id !== "string") return [];
    return [
      {
        document_id: row.document_id,
        version_id: typeof row.version_id === "string" ? row.version_id : null,
      },
    ];
  });
}

function repliesForEmail(email: EmailRow, emails: EmailRow[]): ReplyEvidence[] {
  if (!email.provider_thread_id) return [];
  return emails
    .filter(
      (candidate) =>
        candidate.direction === "inbound" &&
        candidate.provider_thread_id === email.provider_thread_id &&
        Boolean(candidate.received_at),
    )
    .map((candidate) => ({
      email_id: candidate.id,
      from_address: candidate.from_address ?? null,
      received_at: candidate.received_at!,
    }))
    .sort((a, b) => a.received_at.localeCompare(b.received_at));
}

export function deriveDocumentActionState(input: {
  documents: DocumentRow[];
  versions: VersionRow[];
  emails: EmailRow[];
  envelopes: EnvelopeRow[];
  signers?: SignerRow[];
  operations: OperationRow[];
}): DocumentActionState[] {
  const versionById = new Map(input.versions.map((version) => [version.id, version]));
  const outboundEmails = input.emails.filter(
    (email) => !email.direction || email.direction === "outbound",
  );
  const signersByEnvelope = new Map<string, SignerRow[]>();
  for (const signer of input.signers ?? []) {
    const list = signersByEnvelope.get(signer.envelope_id) ?? [];
    list.push(signer);
    signersByEnvelope.set(signer.envelope_id, list);
  }

  return input.documents.map((document) => {
    const current = document.current_version_id
      ? versionById.get(document.current_version_id) ?? null
      : null;
    const sentVersions: DocumentActionState["delivery"]["sent_versions"] = [];
    const pendingVersions: DocumentActionState["delivery"]["pending_versions"] = [];
    for (const email of outboundEmails) {
      for (const attachment of attachmentRefs(email.attachments)) {
        if (attachment.document_id !== document.id || !attachment.version_id) continue;
        const version = versionById.get(attachment.version_id);
        if (email.status === "sent") {
          sentVersions.push({
            email_id: email.id,
            version_id: attachment.version_id,
            version_number: version?.version_number ?? null,
            sent_at: email.sent_at,
            from_address: email.from_address ?? null,
            to_addresses: strings(email.to_addresses),
            cc_addresses: strings(email.cc_addresses),
            bcc_addresses: strings(email.bcc_addresses),
            replies: repliesForEmail(email, input.emails),
          });
        } else if (["pending_approval", "approved", "sending", "failed", "cancelled"].includes(email.status)) {
          pendingVersions.push({
            version_id: attachment.version_id,
            status: email.status,
            email_id: email.id,
            from_address: email.from_address ?? null,
            to_addresses: strings(email.to_addresses),
            cc_addresses: strings(email.cc_addresses),
            bcc_addresses: strings(email.bcc_addresses),
            sent_at: email.sent_at,
          });
        }
      }
    }
    const signatureVersions = input.envelopes
      .filter(
        (envelope) =>
          envelope.document_id === document.id && envelope.source_version_id,
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((envelope) => ({
        version_id: envelope.source_version_id!,
        status: envelope.status,
        envelope_id: envelope.id,
        updated_at: envelope.updated_at,
        completed_at: envelope.completed_at ?? null,
        signers: (signersByEnvelope.get(envelope.id) ?? []).map(
          ({ id, name, email, status, viewed_at, signed_at, declined_at }) => ({
            id,
            name,
            email,
            status,
            viewed_at,
            signed_at,
            declined_at,
          }),
        ),
      }));
    const currentVersionSent = sentVersions.some(
      (sent) => sent.version_id === document.current_version_id,
    );
    const currentSignature = signatureVersions.find(
      (entry) => entry.version_id === document.current_version_id,
    );
    const historicSent = sentVersions.some(
      (sent) => sent.version_id !== document.current_version_id,
    );
    const historicSignature = signatureVersions.some(
      (entry) =>
        entry.version_id !== document.current_version_id &&
        ["sent", "partially_signed", "completed"].includes(entry.status),
    );
    return {
      document_id: document.id,
      filename: document.filename,
      current_version: {
        id: document.current_version_id,
        number: current?.version_number ?? null,
        source: current?.source ?? null,
        modified_at: current?.created_at ?? document.updated_at,
      },
      delivery: {
        current_version_sent: currentVersionSent,
        sent_versions: sentVersions,
        pending_versions: pendingVersions,
        newer_version_available: historicSent && !currentVersionSent,
      },
      signature: {
        current_version_status: currentSignature?.status ?? null,
        latest_envelope_id: signatureVersions[0]?.envelope_id ?? null,
        versions: signatureVersions,
        newer_version_available: historicSignature && !currentSignature,
      },
      pending_operations: input.operations
        .filter(
          (operation) =>
            operation.source_document_id === document.id ||
            operation.result_document_id === document.id,
        )
        .map(({ id, tool_name, status, created_at }) => ({
          id,
          tool_name,
          status,
          created_at,
        })),
    };
  });
}

export type ProjectActionState = {
  documents: DocumentActionState[];
  communications: {
    id: string;
    status: string;
    from_address: string | null;
    to_addresses: string[];
    cc_addresses: string[];
    bcc_addresses: string[];
    sent_at: string | null;
    replies: ReplyEvidence[];
  }[];
  signatures: {
    id: string;
    document_id: string | null;
    source_version_id: string | null;
    status: string;
    completed_at: string | null;
    updated_at: string;
    signers: DocumentActionState["signature"]["versions"][number]["signers"];
  }[];
  operations: {
    id: string;
    source_document_id: string | null;
    result_document_id: string | null;
    tool_name: string;
    status: string;
    created_at: string;
  }[];
  tasks: MatterTask[];
  cursor: string;
};

export async function getProjectActionState(
  db: Db,
  projectId: string,
): Promise<ProjectActionState> {
  await reconcileProjectTasks(db, projectId);
  const [documentsResult, emailsResult, envelopesResult, operationsResult, tasks] =
    await Promise.all([
      db
        .from("documents")
        .select("id, filename, current_version_id, updated_at")
        .eq("project_id", projectId)
        .eq("status", "ready")
        .eq("lifecycle_status", "active"),
      db
        .from("email_messages")
        .select(
          "id, direction, status, attachments, from_address, to_addresses, cc_addresses, bcc_addresses, provider_thread_id, sent_at, received_at, updated_at",
        )
        .eq("project_id", projectId),
      db
        .from("signature_envelopes")
        .select("id, document_id, source_version_id, status, completed_at, updated_at")
        .eq("project_id", projectId),
      db
        .from("agent_operations")
        .select(
          "id, source_document_id, result_document_id, tool_name, status, created_at",
        )
        .eq("project_id", projectId)
        .in("status", ["pending_approval", "approved", "running"]),
      listMatterTasks(db, projectId),
    ]);
  if (documentsResult.error) throw documentsResult.error;
  if (emailsResult.error) throw emailsResult.error;
  if (envelopesResult.error) throw envelopesResult.error;
  if (operationsResult.error) throw operationsResult.error;

  const documents = (documentsResult.data ?? []) as DocumentRow[];
  const emails = (emailsResult.data ?? []) as EmailRow[];
  const envelopes = (envelopesResult.data ?? []) as EnvelopeRow[];
  const documentIds = documents.map((document) => document.id);
  const envelopeIds = envelopes.map((envelope) => envelope.id);
  const [versionsResult, signersResult] = await Promise.all([
    documentIds.length
      ? db
          .from("document_versions")
          .select("id, document_id, version_number, source, created_at")
          .in("document_id", documentIds)
      : Promise.resolve({ data: [], error: null }),
    envelopeIds.length
      ? db
          .from("signature_signers")
          .select(
            "id, envelope_id, name, email, status, viewed_at, signed_at, declined_at",
          )
          .in("envelope_id", envelopeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (versionsResult.error) throw versionsResult.error;
  if (signersResult.error) throw signersResult.error;

  const documentState = deriveDocumentActionState({
    documents,
    versions: (versionsResult.data ?? []) as VersionRow[],
    emails,
    envelopes,
    signers: (signersResult.data ?? []) as SignerRow[],
    operations: (operationsResult.data ?? []) as OperationRow[],
  });
  const communications = emails
    .filter((email) => !email.direction || email.direction === "outbound")
    .map((email) => ({
      id: email.id,
      status: email.status,
      from_address: email.from_address ?? null,
      to_addresses: strings(email.to_addresses),
      cc_addresses: strings(email.cc_addresses),
      bcc_addresses: strings(email.bcc_addresses),
      sent_at: email.sent_at,
      replies: repliesForEmail(email, emails),
    }));
  const signerRows = (signersResult.data ?? []) as SignerRow[];
  const signatures = envelopes.map((envelope) => ({
    id: envelope.id,
    document_id: envelope.document_id,
    source_version_id: envelope.source_version_id,
    status: envelope.status,
    completed_at: envelope.completed_at ?? null,
    updated_at: envelope.updated_at,
    signers: signerRows
      .filter((signer) => signer.envelope_id === envelope.id)
      .map(({ id, name, email, status, viewed_at, signed_at, declined_at }) => ({
        id,
        name,
        email,
        status,
        viewed_at,
        signed_at,
        declined_at,
      })),
  }));
  const operations = ((operationsResult.data ?? []) as OperationRow[]).map(
    ({ id, source_document_id, result_document_id, tool_name, status, created_at }) => ({
      id,
      source_document_id,
      result_document_id,
      tool_name,
      status,
      created_at,
    }),
  );
  const cursorSource = JSON.stringify({
    documents: documentState.map((state) => [state.document_id, state.current_version.id]),
    communications: communications.map((email) => [email.id, email.status, email.sent_at, email.replies.length]),
    signatures: signatures.map((envelope) => [
      envelope.id,
      envelope.status,
      envelope.updated_at,
      envelope.signers.map((signer) => [signer.id, signer.status, signer.viewed_at, signer.signed_at, signer.declined_at]),
    ]),
    operations: operations.map((operation) => [operation.id, operation.status]),
    tasks: tasks.map((task) => [task.id, task.revision, task.status]),
  });
  return {
    documents: documentState,
    communications,
    signatures,
    operations,
    tasks,
    cursor: createHash("sha256").update(cursorSource).digest("hex").slice(0, 24),
  };
}

export async function getProjectDocumentActionState(
  db: Db,
  projectId: string,
): Promise<DocumentActionState[]> {
  return (await getProjectActionState(db, projectId)).documents;
}

export function formatDocumentActionStateForPrompt(
  states: DocumentActionState[],
): string[] {
  const lines: string[] = [];
  for (const state of states) {
    const currentLabel = state.current_version.number
      ? `V${state.current_version.number}`
      : state.current_version.id?.slice(0, 8) ?? "current version";
    const sent = state.delivery.sent_versions
      .map((version) =>
        version.version_number
          ? `V${version.version_number}`
          : version.version_id.slice(0, 8),
      )
      .join(", ");
    if (sent) {
      const replyCount = state.delivery.sent_versions.reduce(
        (total, version) => total + version.replies.length,
        0,
      );
      lines.push(
        `- "${state.filename}": ${sent} sent${replyCount ? `; ${replyCount} authoritative inbound reply event(s)` : ""}; ${currentLabel} ${state.delivery.current_version_sent ? "sent" : "not sent"}${state.delivery.newer_version_available ? " — newer version available" : ""}.`,
      );
    }
    const latestSignature = state.signature.versions[0];
    if (latestSignature) {
      const signedVersion = versionByNumber(state, latestSignature.version_id);
      const signerSummary = latestSignature.signers
        .map((signer) => `${signer.email}: ${signer.status}`)
        .join(", ");
      lines.push(
        `- "${state.filename}": signature ${latestSignature.status} for ${signedVersion}${signerSummary ? ` (${signerSummary})` : ""}; ${currentLabel}${state.signature.newer_version_available ? " is newer and has not been sent for signature" : " is the signature target"}.`,
      );
    }
  }
  return lines;
}

function versionByNumber(state: DocumentActionState, versionId: string): string {
  const sent = state.delivery.sent_versions.find(
    (version) => version.version_id === versionId,
  );
  return sent?.version_number ? `V${sent.version_number}` : versionId.slice(0, 8);
}
