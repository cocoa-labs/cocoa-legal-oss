// Shared TypeScript types for Coco Legal legal assistant

export interface CocoLegalFolder {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CocoLegalProject {
  id: string;
  user_id: string;
  is_owner?: boolean;
  name: string;
  cm_number: string | null;
  shared_with: string[];
  org_id?: string | null;
  matter_id?: string | null;
  current_user_role?:
    | "owner"
    | "admin"
    | "lawyer"
    | "editor"
    | "reviewer"
    | "viewer";
  created_at: string;
  updated_at: string;
  documents?: CocoLegalDocument[];
  folders?: CocoLegalFolder[];
  document_count?: number;
  chat_count?: number;
  review_count?: number;
}

export interface CocoLegalDocument {
  id: string;
  user_id?: string;
  project_id: string | null;
  folder_id?: string | null;
  filename: string;
  file_type: string | null; // pdf | docx | doc
  storage_path: string | null;
  pdf_storage_path: string | null;
  current_version_id?: string | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: StructureNode[] | null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at?: string | null;
  /** Max version_number across assistant_edit rows, null if doc is unedited. */
  latest_version_number?: number | null;
}

export interface StructureNode {
  id: string;
  title: string;
  level: number;
  page_number: number | null;
  children: StructureNode[];
}

export interface CocoLegalChat {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  created_at: string;
  /** Fork lineage / anchor (present once migration 017 is applied; null on the main thread). */
  parent_chat_id?: string | null;
  forked_from_message_id?: string | null;
  anchor_document_id?: string | null;
  anchor_version_id?: string | null;
  branch_tip_version_id?: string | null;
}

export interface CocoLegalEditAnnotation {
  type?: "edit_data";
  kind?: "edit";
  edit_id: string;
  document_id: string;
  version_id: string;
  /** Per-document monotonic Vn for the edit's target version. */
  version_number?: number | null;
  change_id: string;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before?: string;
  context_after?: string;
  reason?: string;
  status: "pending" | "accepted" | "rejected";
}

export interface CocoLegalHighlightAnnotation {
  id: string;
  document_id: string;
  version_id: string | null;
  quote: string;
  context: string;
  label: string;
  color: "yellow";
  occurrence_index: number;
  page: number | null;
  status: "kept" | "removed" | "applied";
}

export type LegalSearchProvider = "tavily" | "exa" | "firecrawl";

export type LegalSearchResult = {
  title: string;
  url: string;
  provider: LegalSearchProvider;
  providers?: LegalSearchProvider[];
  sourceType: "official" | "research" | "pdf" | "news" | "secondary" | "web";
  publishedDate?: string | null;
  snippet?: string | null;
  highlights?: string[];
  markdown?: string | null;
  confidence: number;
  retrievedAt: string;
};

export type LegalSearchRequest = {
  query: string;
  mode?: "default" | "fast" | "authority" | "deep";
  maxResults?: number;
  jurisdiction?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type OperationStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "undone"
  | "cancelled";

export type OperationApproval =
  | "not_required"
  | "required"
  | "approved"
  | "rejected";

export type OperationInverse =
  | "none"
  | "restore_source_version"
  | "remove_highlights"
  | "archive_generated_document"
  | "restore_archived_document"
  | "revert_tabular_cells"
  | string;

export type MatterRole =
  | "owner"
  | "admin"
  | "lawyer"
  | "editor"
  | "reviewer"
  | "viewer";

export type ToolPermissionScope =
  | "read"
  | "search"
  | "document:annotate"
  | "document:mutate"
  | "document:export"
  | "matter:admin";

export interface AgentOperation {
  id: string;
  org_id: string | null;
  matter_id: string | null;
  project_id: string | null;
  chat_id: string | null;
  actor_user_id: string;
  actor_role: string | null;
  tool_name: string;
  action_type: string;
  status: OperationStatus;
  approval_status: OperationApproval;
  mutating: boolean;
  requires_approval: boolean;
  source_document_id: string | null;
  source_version_id: string | null;
  result_document_id: string | null;
  result_version_id: string | null;
  input_hash: string | null;
  arguments: Record<string, unknown>;
  metadata: Record<string, unknown>;
  providers: unknown[];
  citations: unknown[];
  anchors: unknown[];
  affected_ranges: unknown[];
  errors: unknown[];
  inverse_operation: OperationInverse | null;
  parent_operation_id: string | null;
  idempotency_key: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Document authoring (templates → intake → assembly → QA)
// ---------------------------------------------------------------------------

export interface DocTemplateVariable {
  name: string;
  label: string;
  type:
    | "party"
    | "date"
    | "money"
    | "jurisdiction"
    | "enum"
    | "text"
    | "multiline"
    | "number"
    | "boolean"
    | "duration";
  required: boolean;
  group?: string;
  enum_options?: string[];
  default?: unknown;
  help?: string;
  dependsOn?: { name: string; equals: unknown };
}

export interface DocTemplateSection {
  id: string;
  heading?: string;
  level?: number;
  body_md?: string;
  clause_slot_key?: string;
  pageBreak?: boolean;
}

export interface DocTemplate {
  id: string;
  firm_id: string;
  slug: string;
  title: string;
  doc_type: string;
  practice: string;
  jurisdiction: string | null;
  description: string | null;
  source_kind: "ai_generated" | "coco_seed" | "firm_parameterized";
  status: string;
  current_version_id: string | null;
}

export interface DocTemplateVersion {
  id: string;
  version_number: number;
  skeleton: DocTemplateSection[];
  variableSchema: DocTemplateVariable[];
  clauseSlots: unknown[];
  generationNotes: string;
}

export interface DraftQAFinding {
  guardrail: "defined_terms" | "playbook" | "jurisdiction" | "research";
  severity: "info" | "advisory" | "blocking";
  message: string;
  section_id?: string;
  evidence?: string;
  suggestion?: string;
  citations?: unknown[];
}

/**
 * Poll shape for an async authoring (assembly) job — the body of
 * `GET /templates/jobs/:jobId`. Assembly runs as a detached background job; the
 * frontend kicks it off (wizard submit or chat approve) and polls this until a
 * terminal state. `result` is non-null only when `status === "ready"`; the
 * `download_url` it carries is backend-RELATIVE (prefix with the API base).
 * Polling stops on `status` ready|failed, or when `stalled` is true (the
 * worker likely died on a process restart).
 */
export interface AuthoringJobStatus {
  job_id: string;
  status: "assembling" | "qa" | "ready" | "failed";
  qa_status: "pending" | "passed" | "advisory" | "blocked";
  qa_findings: DraftQAFinding[];
  result: {
    document_id: string;
    version_id: string;
    filename: string;
    download_url: string;
  } | null;
  error: string | null;
  stalled: boolean;
}

export interface DocumentGenerationJobStatus {
  last_activity_at?: string | null;
  stalled?: boolean;
  id: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";
  model_id: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  cancellation_requested: boolean;
  error: string | null;
  items: {
    id: string;
    position: number;
    title: string;
    document_type: string;
    status:
      | "queued"
      | "planning"
      | "drafting"
      | "assembling"
      | "qa"
      | "ready"
      | "failed"
      | "cancelled";
    progress: number;
    qa_status: "pending" | "passed" | "advisory" | "blocked";
    qa_findings: DraftQAFinding[];
    error: string | null;
    failure_code: string | null;
    failure_stage: string | null;
    retryable: boolean;
    can_retry: boolean;
    word_count?: number | null;
    word_budget?: {
      target_words: number;
      max_words: number;
      source: "ordinary" | "explicit_length" | "explicit_outline";
    } | null;
    layout_summary: {
      renderer_mode: "standard" | "compatibility" | null;
      status: "passed" | "failed" | "unavailable" | null;
      reasons: string[];
      affected_pages: number[];
      page_count: number | null;
      text_coverage: number | null;
      analyzer_version?: number | null;
      missing_token_count?: number | null;
    } | null;
    result: {
      document_id: string;
      version_id: string;
      filename: string;
      download_url: string;
    } | null;
  }[];
}

export type AssistantEvent =
  | { type: "reasoning"; text: string; isStreaming?: boolean }
  | {
      type: "tool_call_start";
      name: string;
      isStreaming?: boolean;
    }
  | {
      type: "tool_input_progress";
      name: string;
      total_chars: number;
      elapsed_ms: number;
      isStreaming?: boolean;
    }
  | {
      type: "document_job_started";
      job_id: string;
      total_documents: number;
    }
  | { type: "document_job_status"; job_id: string; total_documents: number }
  | {
      type: "generation_finish";
      finish_reason:
        | "completed"
        | "max_output"
        | "context_limit"
        | "refused"
        | "cancelled"
        | "iteration_limit"
        | "error";
    }
  | {
      type: "model_fallback";
      requested_model_id: string;
      final_model_id: string;
      attempt_count: number;
      reason:
        | "empty_final_answer"
        | "provider_error"
        | "max_output"
        | "context_limit";
    }
  | { type: "thinking"; isStreaming?: boolean }
  | {
      type: "doc_read";
      filename: string;
      document_id?: string;
      isStreaming?: boolean;
    }
  | {
      type: "doc_find";
      filename: string;
      query: string;
      total_matches: number;
      isStreaming?: boolean;
    }
  | {
      type: "doc_created";
      operation_id?: string | null;
      filename: string;
      download_url: string;
      /** Set when the generated doc is persisted as a first-class document. */
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
      isStreaming?: boolean;
    }
  | {
      /**
       * An image the agent generated or edited via the generate_image /
       * edit_image tools. Rendered as an inline GeneratedImageCard (the image
       * is fetched by document_id, with Download / Edit / Regenerate / Attach-
       * to-email actions). Persisted in the assistant message so it survives
       * reload; also streamed live during the turn.
       */
      type: "image_generated";
      document_id: string;
      filename: string;
      /** The prompt/instruction used — powers the Regenerate action. */
      prompt?: string;
      kind: "generate" | "edit";
      download_url?: string;
      isStreaming?: boolean;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
      type: "doc_replicated";
      /** Source document filename. */
      filename: string;
      /** How many copies were produced in this single tool call. */
      count: number;
      /** One entry per new copy. Empty while streaming. */
      copies?: {
        new_filename: string;
        document_id: string;
        version_id: string;
      }[];
      error?: string;
      isStreaming?: boolean;
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "doc_highlighted";
      operation_id?: string | null;
      highlight_set_id: string;
      document_id: string;
      version_id: string | null;
      version_number?: number | null;
      filename: string;
      title: string;
      total: number;
      groups: { label: string; count: number }[];
      highlights: CocoLegalHighlightAnnotation[];
      failed_matches: { label: string; query: string; reason: string }[];
      truncated: boolean;
      isStreaming?: boolean;
    }
  | {
      type: "legal_search";
      operation_id?: string | null;
      query: string;
      providers: LegalSearchProvider[];
      result_count: number;
      warnings: string[];
      results: Pick<
        LegalSearchResult,
        | "title"
        | "url"
        | "provider"
        | "providers"
        | "sourceType"
        | "publishedDate"
        | "snippet"
        | "highlights"
        | "confidence"
        | "retrievedAt"
      >[];
    }
  | {
      /**
       * A matter lookup (`list_matters`). Rendered so the step is visible:
       * before this event existed a fruitless lookup showed up as a blank
       * "Completed in 1 step" card with no hint of what was attempted.
       * Mirrors the backend MatterSearchEvent 1:1.
       */
      type: "matter_search";
      /** The search term, or null when the model listed everything. */
      query: string | null;
      count: number;
      /** A sample of the matches (the backend caps how many it sends). */
      matters: { matter_id: string; name: string }[];
    }
  | {
      /**
       * `get_matter_documents` registered a matter's documents as live
       * doc-N handles for the turn. Mirrors the backend
       * MatterDocumentsLoadedEvent 1:1.
       */
      type: "matter_documents_loaded";
      matter_id: string;
      matter_name: string;
      /**
       * EVERY document filed in the matter — the same count the matter list
       * shows. Not all of them are necessarily readable.
       */
      document_count: number;
      /**
       * How many came back as live doc-N handles. Absent on events persisted
       * before the field existed; the card then falls back to document_count.
       */
      readable_count?: number;
      /** True when the readable documents exceeded the listing cap. */
      truncated: boolean;
    }
  | {
      /**
       * A personal-injury case-registry search (`search_cases`). Same
       * rationale as matter_search: the lookup used to run invisibly.
       * Set on the failure paths (rejected `status`, thrown query), where
       * `count` is 0 and the card reports the failure instead of "no matches".
       */
      type: "case_search";
      query: string | null;
      count: number;
      error?: string;
    }
  | {
      type: "operation_created";
      operation: AgentOperation;
      filename?: string;
      document_id?: string;
      summary?: string;
    }
  | {
      /**
       * Approval-gated outbound email drafted by the agent. Rendered as an
       * inline approval card; every send is human-gated.
       */
      type: "email_pending";
      email_id: string;
      operation_id?: string | null;
      /** Current lifecycle status, hydrated on chat load (sent/cancelled/…). */
      status?: string | null;
      /** The inbound email this is a reply to, when it is one. */
      in_reply_to_email_id?: string | null;
      to: string[];
      cc: string[];
      subject: string;
      body_preview: string;
      attachments: {
        document_id: string;
        source_kind?: "document" | "chat_attachment";
        source_id?: string;
        chat_attachment_id?: string | null;
        version_id?: string | null;
        filename: string;
        content_type?: string | null;
        size?: number | null;
        previewable?: boolean;
      }[];
    }
  | {
      type: "email_attachments_loaded";
      email_id: string;
      attachments: { attachment_id: string; document_id: string; version_id: string }[];
    }
  | {
      /**
       * An inbound email that arrived on a thread Quill started. Rendered as a
       * compact "email received" card in the conversation; it pairs with the
       * email_pending card carrying the parked auto-draft reply.
       */
      type: "email_received";
      email_id: string;
      from_address: string | null;
      subject: string | null;
      body_preview: string | null;
      received_at: string | null;
      attachments: { document_id: string; filename: string }[];
    }
  | {
      /**
       * Approval-gated e-signature envelope prepared by the agent. Rendered
       * as an inline approval card; sending the signing links is human-gated.
       */
      type: "signature_pending";
      envelope_id: string;
      operation_id?: string | null;
      /** Current envelope status, hydrated on chat load (sent/completed/…). */
      status?: string | null;
      document_id: string;
      document_name: string;
      /**
       * Version the request was prepared against (the envelope's pinned
       * source version). Null on legacy events and when the pin could not
       * be resolved.
       */
      version_number?: number | null;
      /**
       * True when the document's current version differs from the pinned
       * one. Hydration-only — populated on chat reload, never at proposal
       * time, so `undefined` means "not known here", NOT "unchanged". A
       * request CAN be born changed and still be exactly what was asked
       * for (reading an older version in Doc Review and sending that one),
       * so this reads as "these differ", never as "something went wrong".
       */
      document_changed?: boolean | null;
      subject: string;
      signers: { name: string; email: string; role: string }[];
    }
  | {
      /**
       * Approval-gated calendar change prepared by the agent (an event WITH
       * attendees). Rendered as an inline approval card; invitations /
       * cancellations to attendees are sent only on approval. Mirrors the
       * backend CalendarPendingEvent 1:1.
       */
      type: "calendar_pending";
      write_id: string;
      operation_id?: string | null;
      /** Current write status, hydrated on chat load (applied/cancelled/…). */
      status?: string | null;
      op_kind: "create" | "update" | "delete";
      calendar: "primary" | "firm";
      title: string;
      start: string;
      end: string;
      location?: string | null;
      attendees: string[];
      add_meet: boolean;
    }
  | {
      type: "doc_edited";
      operation_id?: string | null;
      filename: string;
      document_id: string;
      version_id: string;
      /** Per-document monotonic Vn written at emit time. */
      version_number?: number | null;
      download_url: string;
      annotations: CocoLegalEditAnnotation[];
      layout_reflowed?: boolean;
      layout_qa_status?: "passed" | "failed" | "unverified";
      error?: string;
      error_code?:
        | "DISPLAYED_DOCUMENT_UNAVAILABLE"
        | "DISPLAYED_VERSION_NOT_CURRENT"
        | "DOCUMENT_VERSION_CONFLICT"
        | "AMBIGUOUS_DOCUMENT_NAME"
        | "EDIT_NO_MATCH"
        | "EDIT_PERSIST_FAILED"
        | "DOCUMENT_REFLOW_UNSUPPORTED"
        | "DOCUMENT_LAYOUT_QA_FAILED"
        | "DOCUMENT_QA_UNAVAILABLE";
      retryable?: boolean;
      resolution?: Record<string, unknown>;
      candidates?: Record<string, unknown>[];
      target?: {
        document_id: string;
        version_id: string | null;
        version_number: number | null;
      };
      isStreaming?: boolean;
    }
  | {
      /**
       * Coarse "assembly started" marker. Emitted by the doc-generation /
       * authoring-assembly SSE routes immediately before the heavy work; the
       * client renders a streaming `doc_created` placeholder until the
       * terminal `doc_created` arrives. `label` is the assemble route's
       * progress copy; `filename` is present on the generate_docx flow.
       */
      type: "doc_created_start";
      filename?: string;
      label?: string;
      isStreaming?: boolean;
    }
  | {
      /**
       * A firm template was generated + persisted (the chat `generate_template`
       * tool). Rendered as a "template ready" affordance that deep-links into
       * the intake wizard for `template_id`.
       */
      type: "template_created";
      template_id: string;
      title: string;
      doc_type: string;
      version_number: number;
    }
  | {
      /**
       * The four-guardrail QA result for an assembled draft (assemble SSE
       * route). `status` drives the banner: passed (green) / advisory (amber,
       * non-blocking notes) / blocked (a material deviation was flagged).
       */
      type: "draft_qa";
      findings: DraftQAFinding[];
      status: "passed" | "advisory" | "blocked";
    }
  | {
      /**
       * Capture-time durable card the recordings pipeline posts into the chat
       * when a recording is created with a chat_id (backend
       * recordings/postToChat.ts → insertRecordingCardMessage). The live
       * RecordingCard polls status from `recording_id` until terminal. Shape
       * mirrors that insert EXACTLY: { type, recording_id, title, source }.
       */
      type: "recording_card";
      recording_id: string;
      title: string;
      source: RecordingSource;
    }
  | {
      /**
       * Ready-time durable summary the pipeline posts when processing settles
       * (postToChat.ts → insertRecordingSummaryMessage). Rendered statically by
       * the summary RecordingCard. The same message ALSO carries a plain
       * { type:"content", text: summary_md } lead-in block (pre-T12 fallback);
       * AssistantMessage suppresses that duplicate when this block is present.
       * Shape mirrors the insert EXACTLY.
       */
      type: "recording_summary";
      recording_id: string;
      title: string;
      summary_md: string;
      action_items: RecordingActionItem[];
      transcript_document_id: string | null;
    }
  | CapabilityResultEvent
  | { type: "content"; text: string; isStreaming?: boolean };

/**
 * One provenance link inside a capability result. Mirrors
 * `CapabilityResultCitation` in backend/src/lib/legalCapabilities/run.ts. The
 * backend DROPS any citation naming a document the run never had, so a
 * citation that reaches the client always points at a real handle.
 */
export interface CapabilityResultCitation {
  document_id: string;
  filename: string;
  page: number | null;
  quote: string | null;
}

/** Flag vocabulary a finding may use — mirrors run.ts `FLAG_VALUES`. */
export type CapabilityResultFlag =
  | "GREEN"
  | "YELLOW"
  | "ORANGE"
  | "RED"
  | "grey";

/**
 * One labelled finding row. Mirrors `CapabilityResultFinding` in run.ts.
 *
 * `band` is the finding's severity on the same unified scale the card's
 * overall badge uses, resolved server-side from `flag` so one flag cannot mean
 * two severities in one card; `null` means "not assessed" and gets no badge.
 * It is absent on results recorded before the backend emitted it, which is why
 * the card still keeps a `flag` fallback.
 */
export interface CapabilityResultFinding {
  label: string;
  value_md: string;
  flag: CapabilityResultFlag | null;
  band?: "low" | "medium" | "high" | "critical" | null;
  citation: CapabilityResultCitation | null;
}

/** Section kinds a capability may declare — mirrors `CapabilitySectionKind`. */
export type CapabilityResultSectionKind =
  | "text"
  | "list"
  | "table"
  | "findings";

/**
 * One rendered section of a capability result. Which of the optional payload
 * fields is populated is decided by `kind`; the backend validator refuses a
 * section whose payload does not match its kind, so the card can switch on
 * `kind` alone. Mirrors `CapabilityResultSection` in run.ts.
 */
export interface CapabilityResultSection {
  id: string;
  label: string;
  kind: CapabilityResultSectionKind;
  text_md?: string;
  items?: string[];
  columns?: string[];
  rows?: string[][];
  findings?: CapabilityResultFinding[];
}

/**
 * The persisted result of one in-chat capability run, emitted live over SSE
 * and stored verbatim in the assistant message's content array — so the live
 * render and the reloaded render are the same card. Mirrors
 * `CapabilityResultEvent` in backend/src/lib/legalCapabilities/run.ts.
 */
export interface CapabilityResultEvent {
  type: "capability_result";
  result_id: string;
  capability_id: string;
  proposal_id: string | null;
  title: string;
  summary_md: string;
  overall: {
    scheme: string;
    native_label: string;
    band: "low" | "medium" | "high" | "critical";
  } | null;
  sections: CapabilityResultSection[];
  escalation: { subject: string; body: string } | null;
  status: "complete" | "failed";
  error_code: string | null;
  recorded_at: string;
  /** Set on failed events so the UI can re-run with the same inputs. */
  retry: {
    document_ids: string[];
    inputs: { represented_party: string | null };
  } | null;
}

/**
 * The confirmed capability run a user turn carried, as persisted on
 * `chat_messages.capability_run`. Mirrors the row the backend writes in
 * routes/chat.ts; present only on turns started from a proposal chip.
 */
export interface CapabilityRunRecord {
  capability_id: string;
  proposal_id: string | null;
  document_ids: string[];
  inputs: { represented_party: string | null };
}

/**
 * Snapshot of which document version each open tab was showing when a message
 * was sent (persisted to chat_messages.version_context). `displayed` marks the
 * active tab. Used to restore the doc a conversation is about. Mirrors the
 * backend VersionContext shape.
 */
export interface VersionContextSnapshot {
  anchored_document_id: string | null;
  docs: {
    document_id: string;
    version_id: string | null;
    version_number: number | null;
    displayed: boolean;
  }[];
}

export interface CocoLegalMessage {
  /** DB id of the persisted chat_messages row (absent while optimistic/streaming). */
  id?: string;
  /**
   * When set, this message is inherited by reference from a parent chat (the
   * pre-fork history of a branch). Rendered as "from the main thread."
   */
  inherited_from_chat_id?: string | null;
  /** The versions open when this turn was sent — used to restore the viewed doc. */
  version_context?: VersionContextSnapshot | null;
  role: "user" | "assistant";
  content: string;
  files?: CocoLegalMessageAttachment[];
  workflow?: { id: string; title: string };
  model?: string;
  annotations?: CocoLegalCitationAnnotation[];
  events?: AssistantEvent[];
  /** Set on a user turn confirmed from a proposal chip (chat_messages.capability_run). */
  capability_run?: CapabilityRunRecord | null;
  /** Durable generation lifecycle from chat_messages. */
  generation_status?: string | null;
  finish_reason?: string | null;
  /** Set when streaming failed; rendered as a red error block. */
  error?: string;
}

export type CocoLegalDocumentAttachment = {
  kind?: "document";
  filename: string;
  document_id?: string;
  attachment_id?: never;
};

export type CocoLegalImageAttachment = {
  kind: "image";
  filename: string;
  attachment_id: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size_bytes: number;
  document_id?: never;
};

export type CocoLegalMessageAttachment =
  | CocoLegalDocumentAttachment
  | CocoLegalImageAttachment;

export interface CitationQuote {
  page: number;
  quote: string;
  id?: string;
  color?: "blue" | "yellow";
  label?: string;
  occurrenceIndex?: number;
}

/**
 * A citation emitted by the assistant. Single-page citations have a numeric
 * `page` and a plain `quote`. A citation that spans a page break (one
 * continuous sentence cut by a page boundary) has `page` as a range string
 * like "41-42" and a `quote` containing the `[[PAGE_BREAK]]` sentinel at the
 * break point (text before is on page 41, text after is on page 42).
 */
export interface CocoLegalCitationAnnotation {
  type: "citation_data";
  ref: number;
  doc_id: string;
  document_id: string;
  version_id?: string | null;
  version_number?: number | null;
  filename: string;
  page: number | string;
  quote: string;
}

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 */
export function expandCitationToEntries(
  a: CocoLegalCitationAnnotation,
): CitationQuote[] {
  const rangeMatch =
    typeof a.page === "string" ? a.page.match(/^(\d+)\s*-\s*(\d+)$/) : null;
  if (rangeMatch && a.quote.includes(PAGE_BREAK_SENTINEL)) {
    const startPage = parseInt(rangeMatch[1], 10);
    const endPage = parseInt(rangeMatch[2], 10);
    const [before, after] = a.quote.split(PAGE_BREAK_SENTINEL);
    return [
      { page: startPage, quote: before.trim() },
      { page: endPage, quote: after.trim() },
    ].filter((e) => e.quote.length > 0);
  }
  const pageNum =
    typeof a.page === "number" ? a.page : parseInt(String(a.page), 10);
  if (!Number.isFinite(pageNum)) return [];
  return [{ page: pageNum, quote: a.quote }];
}

/** Format the page(s) of a citation for display, e.g. "Page 3" or "Page 41-42". */
export function formatCitationPage(a: CocoLegalCitationAnnotation): string {
  if (typeof a.page === "string") return `Page ${a.page}`;
  return `Page ${a.page}`;
}

/** Produce a reader-friendly version of the quote (replaces [[PAGE_BREAK]] with "..."). */
export function displayCitationQuote(a: CocoLegalCitationAnnotation): string {
  return a.quote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}

// Tabular Review

export type ColumnFormat =
  | "text"
  | "bulleted_list"
  | "number"
  | "currency"
  | "yes_no"
  | "date"
  | "tag"
  | "percentage"
  | "monetary_amount";

export interface ColumnConfig {
  index: number;
  name: string;
  prompt: string;
  format?: ColumnFormat;
  tags?: string[];
}

export interface TabularReview {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: ColumnConfig[] | null;
  document_ids?: string[] | null;
  workflow_id: string | null;
  practice?: string | null;
  /**
   * Which side the user represents for a CRE review (e.g. "Tenant",
   * "Landlord", "Buyer", "Seller"). Chosen at configure time and persisted on
   * the row; steers the {{representedParty}} substitution in the tabular
   * extraction path. Null for legacy/non-CRE reviews. Surfaced so the CRE
   * result card can show "Reviewing as: …".
   */
  represented_party?: string | null;
  /** Per-review email list. Used so standalone (project_id null) reviews can be shared directly. */
  shared_with?: string[];
  /** Server-set: true when the requesting user is the review's creator. */
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  document_count?: number;
}

export interface TabularCell {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
}

// Workflows

export interface CocoLegalWorkflow {
  id: string;
  user_id: string | null;
  title: string;
  type: "assistant" | "tabular";
  prompt_md: string | null;
  columns_config: ColumnConfig[] | null;
  is_system: boolean;
  created_at: string;
  practice?: string | null;
  /** Structured jurisdiction tag (e.g. "US", "UK"). Optional; set on built-in packs. */
  jurisdiction?: string;
  shared_by_name?: string | null;
  allow_edit?: boolean;
  is_owner?: boolean;
}

// Recordings & Transcription
//
// Snake_case mirror of the backend `recordings` row (lib/recordings/types.ts),
// minus the worker-internal columns the API returns but the client never needs
// (assemblyai_transcript_id, retry_count, next_attempt_at, audio_storage_key).
// The API returns the full row, so those extra fields are simply present-but-
// untyped here.

export type RecordingStatus =
  | "queued"
  | "transcribing"
  | "summarizing"
  | "ready"
  | "failed";

export type RecordingSource = "mic" | "upload";

export interface RecordingUtterance {
  speaker: string;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface RecordingActionItem {
  id: string;
  text: string;
  done: boolean;
  owner: string | null;
  due: string | null;
}

export interface Recording {
  id: string;
  user_id: string;
  project_id: string | null;
  chat_id: string | null;
  chat_message_id: string | null;
  title: string;
  source: RecordingSource;
  status: RecordingStatus;
  audio_mime: string;
  audio_size_bytes: number;
  duration_seconds: number | null;
  consent_ack_at: string;
  utterances: RecordingUtterance[];
  transcript_text: string | null;
  summary_md: string | null;
  action_items: RecordingActionItem[];
  transcript_document_id: string | null;
  voice_briefing_document_id: string | null;
  timeline_image_document_id: string | null;
  email_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// API helpers

export interface CocoLegalChatDetailOut {
  chat: CocoLegalChat;
  messages: CocoLegalMessage[];
}

export interface TabularReviewDetailOut {
  review: TabularReview;
  cells: TabularCell[];
  documents: CocoLegalDocument[];
}
