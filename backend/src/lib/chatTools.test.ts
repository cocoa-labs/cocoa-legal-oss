import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessages,
  collectConversationImageAttachmentIds,
  buildToolset,
  extractJsonObject,
  formatCents,
  parseRecordCaseExpenseArgs,
  parseUpdateCaseInsuranceArgs,
  slugify,
  resolveCopyTargetProjectId,
  PROJECT_EXTRA_TOOLS,
  TABULAR_TOOLS,
  RECORDING_TOOLS,
  RECORDING_TOOL_NAMES,
  RECORDING_TRANSCRIPT_EXCERPT_CAP,
  RECORDING_TRANSCRIPT_UNTRUSTED_PREFIX,
  shapeRecordingListItem,
  buildRecordingDetailPayload,
  parseGenerateRecordingExtraArgs,
  runRecordingToolCall,
  resolveSignatureSourceVersion,
  runToolCalls,
  CAPABILITY_TOOLS,
} from "./chatTools";
import type { DocStore } from "./chatTools";
import type { CapabilityRunContext } from "./legalCapabilities/run";
import type { LegalCapability } from "./legalCapabilities/types";
import type { Recording } from "./recordings/types";
import type { EmailMessage } from "./email/store";
import { RecordingArtifactError } from "./recordings/artifacts";

// extractJsonObject — pull the first balanced JSON object out of a possibly
// fenced / prose-wrapped LLM string. The caller still owns JSON.parse, so we
// assert the returned candidate parses to the expected object.

test("extractJsonObject: bare JSON object passes through", () => {
  const raw = '{"skeleton":[],"variableSchema":[],"clauseSlots":[]}';
  const out = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(out), {
    skeleton: [],
    variableSchema: [],
    clauseSlots: [],
  });
});

// buildMessages memory seam: personal memory must append under its heading
// when present, and be a complete no-op when absent (protecting the
// byte-stable base system message alongside the buildSystemPrompt invariant).

test("buildMessages: absent personal memory leaves the system message unchanged", () => {
  const base = buildMessages([], [], undefined, undefined, undefined, {});
  const withUndefined = buildMessages([], [], undefined, undefined, undefined, {
    personalMemory: undefined,
  });
  const sys = base[0] as { role: string; content: string };
  assert.equal(sys.role, "system");
  assert.ok(!sys.content.includes("## What you remember"));
  assert.equal((withUndefined[0] as { content: string }).content, sys.content);
});

test("buildMessages: personal memory appends under its heading behind a reference-only guard", () => {
  const out = buildMessages([], [], undefined, undefined, undefined, {
    personalMemory: "- Represents landlords",
  });
  const sys = (out[0] as { content: string }).content;
  assert.match(sys, /## What you remember/);
  assert.match(sys, /- Represents landlords/);
  assert.match(sys, /reference only/i);
});

test("buildMessages exposes conversation-bound chat image ids without sending GIF bytes to vision", () => {
  const messages = [
    {
      role: "user",
      content: "Email this image.",
      files: [
        {
          kind: "image" as const,
          filename: "animation.gif",
          attachment_id: "image-attachment-1",
          mime_type: "image/gif",
        },
      ],
    },
  ];
  const out = buildMessages(messages, [], undefined, {}, new Map(), {});
  const user = out[1] as { content: string };
  assert.match(user.content, /attachment_id image-attachment-1/);
  assert.match(user.content, /attachable GIF; not supplied as vision input/);
  assert.deepEqual(
    [...collectConversationImageAttachmentIds(messages)],
    ["image-attachment-1"],
  );
});

test("extractJsonObject: ```json fenced block is unwrapped", () => {
  const raw = '```json\n{"a": 1, "b": [2, 3]}\n```';
  const out = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(out), { a: 1, b: [2, 3] });
});

test("extractJsonObject: bare ``` fenced block is unwrapped", () => {
  const raw = "```\n{\"x\": true}\n```";
  const out = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(out), { x: true });
});

test("extractJsonObject: prose before and after is stripped", () => {
  const raw =
    'Sure! Here is the template you asked for:\n{"title": "Office Lease", "n": 4}\nLet me know if you want changes.';
  const out = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(out), { title: "Office Lease", n: 4 });
});

test("extractJsonObject: nested braces keep the outermost object intact", () => {
  const raw = 'noise {"a": {"b": {"c": 1}}, "d": [ {"e": 2} ]} trailing';
  const out = extractJsonObject(raw);
  assert.deepEqual(JSON.parse(out), { a: { b: { c: 1 } }, d: [{ e: 2 }] });
});

// slugify — firm-scoped template slug derivation.

test("slugify: lowercases, hyphenates, and trims punctuation", () => {
  assert.equal(slugify("Office Lease (NNN)"), "office-lease-nnn");
});

test("slugify: falls back to 'template' when no slug-able chars remain", () => {
  assert.equal(slugify("!!!"), "template");
  assert.equal(slugify(""), "template");
});

// parseUpdateCaseInsuranceArgs — the pure gate in front of the MUTATING
// update_case_insurance tool. What it returns becomes the pending
// operation's arguments verbatim, so the canonical staged shape (nested
// policy_limits / adjuster records, exactly what caseWrites.ts executes on
// approval) is pinned here.

test("parseUpdateCaseInsuranceArgs: happy path builds the canonical staged upsert shape", () => {
  const parsed = parseUpdateCaseInsuranceArgs({
    case_id: "case-1",
    policy_upserts: [
      {
        carrier: "Example Mutual",
        claim_number: "24-12345",
        policy_number: "P-9",
        coverage_type: "bodily injury",
        policy_limits_text: "$50k/$100k",
        adjuster_name: "Jane Adjuster",
        adjuster_email: "jane@examplemutual.test",
        adjuster_phone: "555-0100",
      },
    ],
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.value.caseId, "case-1");
  assert.deepEqual(parsed.value.policyUpserts, [
    {
      carrier: "Example Mutual",
      claim_number: "24-12345",
      policy_number: "P-9",
      coverage_type: "bodily injury",
      policy_limits: { raw_text: "$50k/$100k" },
      adjuster: {
        name: "Jane Adjuster",
        email: "jane@examplemutual.test",
        phone: "555-0100",
      },
    },
  ]);
});

test("parseUpdateCaseInsuranceArgs: optional fields absent → nulls and empty records", () => {
  const parsed = parseUpdateCaseInsuranceArgs({
    case_id: "case-1",
    policy_upserts: [{ carrier: "Demo Auto" }],
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.policyUpserts, [
    {
      carrier: "Demo Auto",
      claim_number: null,
      policy_number: null,
      coverage_type: null,
      policy_limits: {},
      adjuster: {},
    },
  ]);
});

test("parseUpdateCaseInsuranceArgs: rejects missing case_id, empty/missing upserts, and carrier-less entries", () => {
  assert.equal(parseUpdateCaseInsuranceArgs({ policy_upserts: [{ carrier: "X" }] }).ok, false);
  assert.equal(parseUpdateCaseInsuranceArgs({ case_id: "c", policy_upserts: [] }).ok, false);
  assert.equal(parseUpdateCaseInsuranceArgs({ case_id: "c" }).ok, false);
  const noCarrier = parseUpdateCaseInsuranceArgs({
    case_id: "c",
    policy_upserts: [{ claim_number: "24-1" }],
  });
  assert.equal(noCarrier.ok, false);
  if (!noCarrier.ok) assert.match(noCarrier.error, /carrier/);
  const notObject = parseUpdateCaseInsuranceArgs({
    case_id: "c",
    policy_upserts: ["nope"],
  });
  assert.equal(notObject.ok, false);
});

// parseRecordCaseExpenseArgs — the pure gate in front of the MUTATING
// record_case_expense tool (pending_approval expense + pending operation).

test("parseRecordCaseExpenseArgs: happy path normalizes currency and trims strings", () => {
  const parsed = parseRecordCaseExpenseArgs({
    case_id: " case-1 ",
    vendor: " Sample Medical Records Co ",
    invoice_number: "INV-77",
    amount_cents: 12550,
    currency: "usd",
    payment_portal_url: "https://pay.example.com/inv-77",
    document_id: "doc-0",
    notes: "records retrieval",
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    caseId: "case-1",
    vendor: "Sample Medical Records Co",
    invoiceNumber: "INV-77",
    amountCents: 12550,
    currency: "USD",
    paymentPortalUrl: "https://pay.example.com/inv-77",
    documentId: "doc-0",
    notes: "records retrieval",
  });
});

test("parseRecordCaseExpenseArgs: optionals default to null / USD", () => {
  const parsed = parseRecordCaseExpenseArgs({
    case_id: "case-1",
    vendor: "Vendor",
    amount_cents: 100,
  });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    caseId: "case-1",
    vendor: "Vendor",
    invoiceNumber: null,
    amountCents: 100,
    currency: "USD",
    paymentPortalUrl: null,
    documentId: null,
    notes: null,
  });
});

test("parseRecordCaseExpenseArgs: rejects missing case_id/vendor, bad amounts, junk currency and non-http portal URLs", () => {
  assert.equal(parseRecordCaseExpenseArgs({ vendor: "V", amount_cents: 1 }).ok, false);
  assert.equal(parseRecordCaseExpenseArgs({ case_id: "c", amount_cents: 1 }).ok, false);
  for (const amount of [undefined, 0, -5, 1.5, "100", Number.NaN]) {
    const parsed = parseRecordCaseExpenseArgs({
      case_id: "c",
      vendor: "V",
      amount_cents: amount,
    });
    assert.equal(parsed.ok, false, `amount_cents ${String(amount)} must be rejected`);
    if (!parsed.ok) assert.match(parsed.error, /amount_cents/);
  }
  const badCurrency = parseRecordCaseExpenseArgs({
    case_id: "c",
    vendor: "V",
    amount_cents: 1,
    currency: "dollars",
  });
  assert.equal(badCurrency.ok, false);
  if (!badCurrency.ok) assert.match(badCurrency.error, /currency/);
  const badUrl = parseRecordCaseExpenseArgs({
    case_id: "c",
    vendor: "V",
    amount_cents: 1,
    payment_portal_url: "javascript:alert(1)",
  });
  assert.equal(badUrl.ok, false);
  if (!badUrl.ok) assert.match(badUrl.error, /payment_portal_url/);
});

// formatCents — compact money rendering for read_case tool output.

test("formatCents: formats known currencies and degrades for unknown codes/null", () => {
  assert.equal(formatCents(12550, "USD"), "$125.50");
  assert.equal(formatCents(100, "usd"), "$1.00");
  assert.equal(formatCents(null, "USD"), "unknown amount");
  assert.equal(formatCents(9900, "ZZZ"), "ZZZ 99.00");
});

// ---------------------------------------------------------------------------
// Recordings chat tools (list_recordings / get_recording /
// generate_recording_extra / draft_recording_email). The dispatch surface is
// runRecordingToolCall, exercised here with injected collaborators so no live
// db / LLM / OpenAI / email rails are touched — matching the pure-helper style
// of the gates above. `db` is never dereferenced (every store call is faked).
// ---------------------------------------------------------------------------

type RecToolDb = Parameters<typeof runRecordingToolCall>[0]["db"];
const fakeDb = {} as unknown as RecToolDb;

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    user_id: "u1",
    project_id: null,
    chat_id: null,
    chat_message_id: null,
    title: "Client intake call",
    source: "mic",
    status: "ready",
    audio_storage_key: "key",
    audio_mime: "audio/webm",
    audio_size_bytes: 1,
    duration_seconds: 620,
    consent_ack_at: "2026-01-01T00:00:00Z",
    assemblyai_transcript_id: null,
    utterances: [],
    transcript_text: null,
    summary_md: null,
    action_items: [],
    transcript_document_id: null,
    voice_briefing_document_id: null,
    timeline_image_document_id: null,
    email_id: null,
    error: null,
    retry_count: 0,
    next_attempt_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

// Schema surface — the four tools the LLM is offered.

test("RECORDING_TOOLS exposes the four recordings tool schemas", () => {
  const names = RECORDING_TOOLS.map((t) => t.function.name).sort();
  assert.deepEqual(names, [
    "draft_recording_email",
    "generate_recording_extra",
    "get_recording",
    "list_recordings",
  ]);
  // The dispatch guard set matches the schema surface exactly.
  assert.deepEqual([...RECORDING_TOOL_NAMES].sort(), names);

  const byName = new Map(RECORDING_TOOLS.map((t) => [t.function.name, t]));
  // Read tools require their id (get) / nothing (list); write tools require id.
  assert.deepEqual(byName.get("list_recordings")!.function.parameters.required, undefined);
  assert.deepEqual(byName.get("get_recording")!.function.parameters.required, ["recording_id"]);
  assert.deepEqual(byName.get("draft_recording_email")!.function.parameters.required, ["recording_id"]);
  const gen = byName.get("generate_recording_extra")!.function;
  assert.deepEqual(gen.parameters.required, ["recording_id", "kind"]);
  assert.deepEqual(
    (gen.parameters.properties as { kind: { enum: string[] } }).kind.enum,
    ["voice_briefing", "timeline_image"],
  );
});

// ---------------------------------------------------------------------------
// buildToolset — WHICH tools each chat surface is offered.
//
// The matter-lookup pair (list_matters / get_matter_documents) is main-chat
// ONLY, and that is a confidentiality boundary, not a preference. A matter
// chat is SHARED: routes/chat.ts getAccessibleChat hands a project's chats to
// every colleague in projects.shared_with[]. Offering cross-matter lookup
// there would let a colleague shared into matter A pull their OWN unrelated
// client file into A's transcript, which persists where A can read it. A
// matter chat needs nothing from those tools anyway — list_documents /
// fetch_documents already cover the matter it is sitting in.
// ---------------------------------------------------------------------------

const toolNames = (tools: unknown[]) =>
  tools.map(
    (t) => (t as { function?: { name?: string } }).function?.name ?? "",
  );

test("buildToolset: matter lookup is offered in main chat only", () => {
  const mainChat = toolNames(buildToolset());
  assert.equal(mainChat.includes("list_matters"), true);
  assert.equal(mainChat.includes("get_matter_documents"), true);

  // Both surfaces that pass extraTools — matter chat and the tabular grid.
  for (const [label, extra] of [
    ["matter chat", PROJECT_EXTRA_TOOLS],
    ["tabular", TABULAR_TOOLS],
  ] as const) {
    const names = toolNames(buildToolset(extra));
    assert.equal(
      names.includes("list_matters"),
      false,
      `${label} must not be offered list_matters`,
    );
    assert.equal(
      names.includes("get_matter_documents"),
      false,
      `${label} must not be offered get_matter_documents`,
    );
    // The narrowing is surgical: the surface keeps everything else, including
    // its own extraTools.
    for (const name of toolNames(extra)) {
      assert.equal(names.includes(name), true, `${label} lost ${name}`);
    }
    assert.equal(names.includes("read_document"), true);
    assert.equal(names.includes("search_cases"), true);
  }

  // A matter chat still reaches every document in the matter it is IN — the
  // scoped tools that make the matter tools unnecessary there.
  const matterChat = toolNames(buildToolset(PROJECT_EXTRA_TOOLS));
  assert.equal(matterChat.includes("list_documents"), true);
  assert.equal(matterChat.includes("fetch_documents"), true);

  // An empty extraTools array is the main chat, not a third surface.
  assert.deepEqual(toolNames(buildToolset([])), mainChat);
  // No duplicate schemas on any surface.
  assert.equal(new Set(mainChat).size, mainChat.length);
  assert.equal(new Set(matterChat).size, matterChat.length);
});

// shapeRecordingListItem — the compact list row.

test("shapeRecordingListItem summarizes a row without dumping content", () => {
  const row = shapeRecordingListItem(
    makeRecording({
      id: "rec-9",
      title: "Deposition",
      status: "ready",
      source: "upload",
      duration_seconds: 42,
      summary_md: "  a summary  ",
      action_items: [
        { id: "a1", text: "File motion", done: false, owner: "Pat", due: "2026-02-01" },
        { id: "a2", text: "Call client", done: true, owner: null, due: null },
      ],
    }),
  );
  assert.deepEqual(row, {
    recording_id: "rec-9",
    title: "Deposition",
    status: "ready",
    source: "upload",
    duration_seconds: 42,
    created_at: "2026-01-02T00:00:00Z",
    has_summary: true,
    action_item_count: 2,
  });
});

test("shapeRecordingListItem: blank/absent summary → has_summary false", () => {
  assert.equal(shapeRecordingListItem(makeRecording({ summary_md: null })).has_summary, false);
  assert.equal(shapeRecordingListItem(makeRecording({ summary_md: "   " })).has_summary, false);
});

// buildRecordingDetailPayload — get_recording body, incl. the excerpt gate.

test("buildRecordingDetailPayload omits the transcript excerpt unless requested", () => {
  const rec = makeRecording({
    summary_md: "Summary text",
    utterances: [
      { speaker: "A", text: "hi", start_ms: 0, end_ms: 1 },
      { speaker: "B", text: "hello", start_ms: 1, end_ms: 2 },
      { speaker: "A", text: "again", start_ms: 2, end_ms: 3 },
    ],
  });
  const payload = buildRecordingDetailPayload(rec, false);
  assert.equal(payload.summary_md, "Summary text");
  assert.equal(payload.speaker_count, 2); // distinct speakers A, B
  assert.equal("transcript_excerpt" in payload, false);
  assert.equal("transcript_truncated" in payload, false);
});

test("buildRecordingDetailPayload includes a diarized, untrusted-prefixed excerpt when requested", () => {
  const rec = makeRecording({
    utterances: [
      { speaker: "Counsel", text: "Please state your name.", start_ms: 0, end_ms: 1 },
      { speaker: "Witness", text: "Jane Roe.", start_ms: 1, end_ms: 2 },
    ],
  });
  const payload = buildRecordingDetailPayload(rec, true);
  const excerpt = payload.transcript_excerpt as string;
  assert.ok(excerpt.startsWith(RECORDING_TRANSCRIPT_UNTRUSTED_PREFIX));
  assert.match(excerpt, /Counsel: Please state your name\./);
  assert.match(excerpt, /Witness: Jane Roe\./);
  assert.equal(payload.transcript_truncated, false);
  assert.equal("transcript_note" in payload, false);
});

test("buildRecordingDetailPayload hard-caps the excerpt body at 50k and flags truncation", () => {
  const long = "x".repeat(80_000);
  const rec = makeRecording({
    utterances: [{ speaker: "S", text: long, start_ms: 0, end_ms: 1 }],
  });
  const payload = buildRecordingDetailPayload(rec, true);
  const excerpt = payload.transcript_excerpt as string;
  const body = excerpt.slice(RECORDING_TRANSCRIPT_UNTRUSTED_PREFIX.length + 2); // prefix + "\n\n"
  assert.equal(body.length, RECORDING_TRANSCRIPT_EXCERPT_CAP);
  assert.equal(payload.transcript_truncated, true);
  assert.match(payload.transcript_note as string, /truncated to the first 50000/i);
});

test("buildRecordingDetailPayload falls back to transcript_text when there are no utterances", () => {
  const rec = makeRecording({ utterances: [], transcript_text: "plain transcript" });
  const payload = buildRecordingDetailPayload(rec, true);
  assert.equal(payload.speaker_count, 0);
  assert.ok((payload.transcript_excerpt as string).endsWith("plain transcript"));
});

// parseGenerateRecordingExtraArgs — the pure kind/id gate.

test("parseGenerateRecordingExtraArgs accepts both kinds and the force flag", () => {
  const a = parseGenerateRecordingExtraArgs({ recording_id: " rec-1 ", kind: "voice_briefing" });
  assert.ok(a.ok);
  if (a.ok) assert.deepEqual(a.value, { recordingId: "rec-1", kind: "voice_briefing", force: false });

  const b = parseGenerateRecordingExtraArgs({ recording_id: "rec-1", kind: "timeline_image", force: true });
  assert.ok(b.ok);
  if (b.ok) assert.equal(b.value.force, true);
});

test("parseGenerateRecordingExtraArgs rejects a missing id or an unknown kind", () => {
  assert.equal(parseGenerateRecordingExtraArgs({ kind: "voice_briefing" }).ok, false);
  assert.equal(parseGenerateRecordingExtraArgs({ recording_id: "rec-1" }).ok, false);
  assert.equal(parseGenerateRecordingExtraArgs({ recording_id: "rec-1", kind: "summary" }).ok, false);
  const bad = parseGenerateRecordingExtraArgs({ recording_id: "rec-1", kind: "nope" });
  if (!bad.ok) assert.match(bad.error, /voice_briefing.*timeline_image/);
});

// runRecordingToolCall — dispatch with injected collaborators.

test("runRecordingToolCall list_recordings returns shaped rows scoped to the user", async () => {
  let sawUser = "";
  let sawOpts: unknown = null;
  const { toolResult } = await runRecordingToolCall({
    name: "list_recordings",
    args: { limit: 5, project_id: "proj-7" },
    db: fakeDb,
    userId: "u1",
    deps: {
      listRecordingsFn: async (_db, userId, opts) => {
        sawUser = userId;
        sawOpts = opts;
        return [makeRecording({ id: "rec-a", summary_md: "s" })];
      },
    },
  });
  assert.equal(sawUser, "u1");
  assert.deepEqual(sawOpts, { projectId: "proj-7", limit: 5 });
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.count, 1);
  assert.equal((toolResult.recordings as { recording_id: string }[])[0].recording_id, "rec-a");
});

test("runRecordingToolCall get_recording returns detail; missing id / not found → readable error", async () => {
  const withRec = await runRecordingToolCall({
    name: "get_recording",
    args: { recording_id: "rec-1" },
    db: fakeDb,
    userId: "u1",
    deps: { getRecordingFn: async () => makeRecording({ summary_md: "S" }) },
  });
  assert.equal(withRec.toolResult.ok, true);
  assert.equal((withRec.toolResult.recording as { summary_md: string }).summary_md, "S");
  assert.equal("transcript_excerpt" in (withRec.toolResult.recording as object), false);

  const noId = await runRecordingToolCall({
    name: "get_recording",
    args: {},
    db: fakeDb,
    userId: "u1",
  });
  assert.equal(noId.toolResult.ok, false);
  assert.match(noId.toolResult.error as string, /recording_id/);

  const missing = await runRecordingToolCall({
    name: "get_recording",
    args: { recording_id: "rec-x" },
    db: fakeDb,
    userId: "u1",
    deps: { getRecordingFn: async () => null },
  });
  assert.equal(missing.toolResult.ok, false);
  assert.match(missing.toolResult.error as string, /not found or is not accessible/);
});

test("runRecordingToolCall generate_recording_extra routes each kind to the right generator", async () => {
  let voiceArg: string | null = null;
  let timelineArg: string | null = null;
  const deps = {
    generateVoiceBriefingFn: async (p: { recordingId: string }) => {
      voiceArg = p.recordingId;
      return { documentId: "doc-voice", created: true };
    },
    generateTimelineImageFn: async (p: { recordingId: string }) => {
      timelineArg = p.recordingId;
      return { documentId: "doc-timeline", created: false };
    },
  };

  const v = await runRecordingToolCall({
    name: "generate_recording_extra",
    args: { recording_id: "rec-1", kind: "voice_briefing" },
    db: fakeDb,
    userId: "u1",
    deps,
  });
  assert.equal(voiceArg, "rec-1");
  assert.equal(timelineArg, null);
  assert.equal(v.toolResult.ok, true);
  assert.equal(v.toolResult.kind, "voice_briefing");
  assert.equal(v.toolResult.document_id, "doc-voice");
  assert.equal(v.toolResult.created, true);

  voiceArg = null;
  const t = await runRecordingToolCall({
    name: "generate_recording_extra",
    args: { recording_id: "rec-2", kind: "timeline_image" },
    db: fakeDb,
    userId: "u1",
    deps,
  });
  assert.equal(timelineArg, "rec-2");
  assert.equal(voiceArg, null);
  assert.equal(t.toolResult.document_id, "doc-timeline");
  assert.equal(t.toolResult.created, false);
  assert.match(t.toolResult.message as string, /already existed/);
});

test("runRecordingToolCall maps a not_ready RecordingArtifactError to actionable text", async () => {
  const r = await runRecordingToolCall({
    name: "generate_recording_extra",
    args: { recording_id: "rec-1", kind: "voice_briefing" },
    db: fakeDb,
    userId: "u1",
    deps: {
      generateVoiceBriefingFn: async () => {
        throw new RecordingArtifactError("not_ready", "Recording is not ready yet.");
      },
    },
  });
  assert.equal(r.toolResult.ok, false);
  assert.match(r.toolResult.error as string, /still transcribing or summarizing/i);
});

test("runRecordingToolCall draft_recording_email emits an email_pending event and creates nothing itself", async () => {
  let draftArgs: { recordingId: string; userEmail: string; input: unknown } | null = null;
  let emailLookedUp = "";
  const { toolResult, pendingEmail } = await runRecordingToolCall({
    name: "draft_recording_email",
    args: { recording_id: "rec-1", to: ["client@example.com"] },
    db: fakeDb,
    userId: "u1",
    userEmail: "me@firm.com",
    deps: {
      // The ONLY collaborator that creates the operation + pending email. The
      // dispatch delegates to it; it never touches the email store directly.
      draftRecordingEmailFn: async (p) => {
        draftArgs = { recordingId: p.recordingId, userEmail: p.userEmail, input: p.input };
        return {
          emailId: "email-77",
          recording: makeRecording({ id: "rec-1", title: "Client intake call" }),
          created: true,
        };
      },
      getEmailFn: async (_db, id) => {
        emailLookedUp = id;
        return {
          id: "email-77",
          agent_operation_id: "op-77",
          to_addresses: ["client@example.com"],
          cc_addresses: [],
          subject: "Recording summary: Client intake call",
          body_text: "Summary body...",
          attachments: [{ document_id: "doc-transcript", filename: "transcript.pdf" }],
        } as unknown as EmailMessage;
      },
    },
  });

  // Delegated (created nothing itself) and read the row back for the card.
  assert.deepEqual(draftArgs, {
    recordingId: "rec-1",
    userEmail: "me@firm.com",
    input: { to: ["client@example.com"], subject: undefined, note: undefined },
  });
  assert.equal(emailLookedUp, "email-77");

  // The email_pending event mirrors send_email's shape.
  assert.ok(pendingEmail);
  assert.equal(pendingEmail!.type, "email_pending");
  assert.equal(pendingEmail!.email_id, "email-77");
  assert.equal(pendingEmail!.operation_id, "op-77");
  assert.deepEqual(pendingEmail!.to, ["client@example.com"]);
  assert.equal(pendingEmail!.subject, "Recording summary: Client intake call");
  assert.deepEqual(pendingEmail!.attachments, [
    { document_id: "doc-transcript", filename: "transcript.pdf" },
  ]);

  // The tool-result text follows send_email's "drafted, not sent" discipline.
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.status, "pending_approval");
  assert.equal(toolResult.attachment_count, 1);
  assert.match(toolResult.message as string, /Do NOT claim you have already sent it/);
});

test("runRecordingToolCall draft_recording_email requires an id and a default recipient", async () => {
  const noId = await runRecordingToolCall({
    name: "draft_recording_email",
    args: {},
    db: fakeDb,
    userId: "u1",
    userEmail: "me@firm.com",
  });
  assert.equal(noId.toolResult.ok, false);
  assert.equal(noId.pendingEmail, undefined);
  assert.match(noId.toolResult.error as string, /recording_id/);

  const noEmail = await runRecordingToolCall({
    name: "draft_recording_email",
    args: { recording_id: "rec-1" },
    db: fakeDb,
    userId: "u1",
    userEmail: null,
  });
  assert.equal(noEmail.toolResult.ok, false);
  assert.match(noEmail.toolResult.error as string, /signed-in user's email/);
});

// ---------------------------------------------------------------------------
// resolveCopyTargetProjectId — where a COPY of an existing document is filed.
//
// create_clean_document and replicate_document both write a new `documents`
// row, and both used to take that row's project_id from the TURN's matter.
// That holds only while every handle in a turn came from the current matter —
// get_matter_documents hands out handles to documents in a DIFFERENT matter,
// and copying one under matter A would drop one client's document into
// another client's file. buildToolset has since kept that tool out of matter
// chats entirely, so this is now defence in depth rather than the live path,
// and these tests pin the invariant so the next handle-producing tool cannot
// quietly reopen the hole. The value this returns is what both copy paths
// write as documents.project_id.
// ---------------------------------------------------------------------------

/** Minimal `documents`-row stub: .from().select().eq().maybeSingle(). */
function makeDocumentsDb(rows: Record<string, { project_id: string | null }>) {
  const reads: { table: string; id: string }[] = [];
  const db = {
    from(table: string) {
      let id = "";
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_column: string, value: string) => {
          id = value;
          return chain;
        },
        maybeSingle: async () => {
          reads.push({ table, id });
          return { data: rows[id] ?? null, error: null };
        },
      };
      return chain;
    },
  } as never;
  return { db, reads };
}

test("resolveCopyTargetProjectId: a cross-matter source files the copy under the SOURCE's matter, not the turn's", async () => {
  const { db, reads } = makeDocumentsDb({
    "uuid-in-matter-b": { project_id: "matter-B" },
  });

  // The turn is matter A's chat; the handle came from a get_matter_documents
  // lookup against matter B.
  const target = await resolveCopyTargetProjectId({
    db,
    sourceDocumentId: "uuid-in-matter-b",
    turnProjectId: "matter-A",
  });

  assert.equal(target, "matter-B");
  assert.notEqual(target, "matter-A");
  // Derived from the source row, not assumed from the turn.
  assert.deepEqual(reads, [{ table: "documents", id: "uuid-in-matter-b" }]);
});

test("resolveCopyTargetProjectId: a same-matter source is unchanged (every pre-existing case)", async () => {
  // Matter chat builds its docIndex/docStore only from
  // buildProjectDocContext(projectId), which filters .eq("project_id",
  // projectId) — so before cross-matter lookup the source ALWAYS sat in the
  // turn's matter and this returns exactly the old value.
  const { db } = makeDocumentsDb({
    "uuid-in-matter-a": { project_id: "matter-A" },
  });
  assert.equal(
    await resolveCopyTargetProjectId({
      db,
      sourceDocumentId: "uuid-in-matter-a",
      turnProjectId: "matter-A",
    }),
    "matter-A",
  );
});

test("resolveCopyTargetProjectId: a matterless, missing or unreadable source falls back to the turn's matter", async () => {
  const { db } = makeDocumentsDb({ standalone: { project_id: null } });
  // A standalone chat attachment has no matter of its own.
  assert.equal(
    await resolveCopyTargetProjectId({
      db,
      sourceDocumentId: "standalone",
      turnProjectId: "matter-A",
    }),
    "matter-A",
  );
  assert.equal(
    await resolveCopyTargetProjectId({
      db,
      sourceDocumentId: "no-such-document",
      turnProjectId: "matter-A",
    }),
    "matter-A",
  );
  // A failed lookup must not take the copy down with it.
  const exploding = {
    from() {
      throw new Error("connection reset");
    },
  } as never;
  assert.equal(
    await resolveCopyTargetProjectId({
      db: exploding,
      sourceDocumentId: "uuid-in-matter-b",
      turnProjectId: "matter-A",
    }),
    "matter-A",
  );
});

// ---------------------------------------------------------------------------
// resolveSignatureSourceVersion — which document version a STAGED signature
// request was prepared against. send_for_signature only proposes; the user
// approves later, possibly after editing. With no pin, approval falls through
// to documents.current_version_id and the signer cryptographically signs the
// document as of APPROVAL — bytes nobody reviewed when the request was made.
// Exercised with an injected `loadActive`, so `db` is only passed through and
// never dereferenced.
// ---------------------------------------------------------------------------

type SigVersionDb = Parameters<typeof resolveSignatureSourceVersion>[0]["db"];
const sigDb = {} as unknown as SigVersionDb;

function makeActiveVersion(id: string, versionNumber: number | null) {
  return {
    id,
    storage_path: `signatures/${id}.docx`,
    pdf_storage_path: null,
    version_number: versionNumber,
    display_name: null,
    source: null,
  };
}

test("resolveSignatureSourceVersion: an indexed version wins, and the db is never consulted", async () => {
  // Not merely a cache hit. The per-turn anchor override in
  // buildProjectDocContext points the docIndex entry at the version the user
  // is VIEWING — that, not the live current_version_id, is what "prepared
  // against" means, so the index has to win outright.
  let loadActiveCalls = 0;
  const out = await resolveSignatureSourceVersion({
    db: sigDb,
    documentId: "doc-uuid",
    docId: "doc-3",
    docIndex: {
      "doc-3": {
        document_id: "doc-uuid",
        filename: "Lease.docx",
        version_id: "v-2",
        version_number: 2,
      },
    },
    loadActive: async () => {
      loadActiveCalls++;
      return makeActiveVersion("v-9", 9);
    },
  });
  assert.deepEqual(out, { versionId: "v-2", versionNumber: 2 });
  assert.equal(
    loadActiveCalls,
    0,
    "an indexed version must short-circuit the lookup entirely",
  );
});

test("resolveSignatureSourceVersion: a version-less index entry falls back to the active version", async () => {
  // This is the shape generate_docx / replicate_document used to register:
  // document_id + filename and nothing else.
  const calls: unknown[][] = [];
  const out = await resolveSignatureSourceVersion({
    db: sigDb,
    documentId: "doc-uuid",
    docId: "doc-3",
    docIndex: {
      "doc-3": { document_id: "doc-uuid", filename: "Draft.docx" },
    },
    loadActive: async (...args) => {
      calls.push(args);
      return makeActiveVersion("v-9", 9);
    },
  });
  assert.deepEqual(out, { versionId: "v-9", versionNumber: 9 });
  assert.equal(calls.length, 1, "the fallback must fire exactly once");
  assert.equal(
    calls[0][0],
    "doc-uuid",
    "looked up by document UUID, not the chat-local doc-N label",
  );
  assert.equal(calls[0][1], sigDb, "uses the caller's db handle");
  assert.equal(
    calls[0][2],
    undefined,
    "no versionId argument — the fallback wants the document's ACTIVE version",
  );
});

test("resolveSignatureSourceVersion: no resolvable version degrades to a null pin", async () => {
  // A null pin means legacy send-current behavior, which is strictly better
  // than refusing to stage a request the user explicitly asked for.
  const out = await resolveSignatureSourceVersion({
    db: sigDb,
    documentId: "doc-uuid",
    docId: "doc-3",
    // No docIndex at all — the standalone-chat shape.
    loadActive: async () => null,
  });
  assert.deepEqual(out, { versionId: null, versionNumber: null });
});

test("resolveSignatureSourceVersion: a throwing lookup degrades instead of rejecting", async () => {
  const out = await resolveSignatureSourceVersion({
    db: sigDb,
    documentId: "doc-uuid",
    docId: "doc-3",
    docIndex: { "doc-3": { document_id: "doc-uuid", filename: "Draft.docx" } },
    loadActive: async () => {
      throw new Error("connection reset");
    },
  });
  assert.deepEqual(
    out,
    { versionId: null, versionNumber: null },
    "a db blip must not take the whole signature proposal down with it",
  );
});

// ---------------------------------------------------------------------------
// record_capability_result — the opt-in capability-run tool.
//
// It must NOT be part of the standing toolset on any surface. A model that can
// see it on an ordinary turn will eventually call it, and the result would be a
// persisted result card for a run the user never confirmed.
// ---------------------------------------------------------------------------

test("record_capability_result is absent from every standing toolset", () => {
  for (const [label, tools] of [
    ["main chat", buildToolset()],
    ["matter chat", buildToolset(PROJECT_EXTRA_TOOLS)],
    ["tabular grid", buildToolset(TABULAR_TOOLS)],
  ] as const) {
    assert.ok(
      !toolNames(tools).includes("record_capability_result"),
      `${label}: record_capability_result must not be offered by default`,
    );
  }
});

test("CAPABILITY_TOOLS holds exactly the one run tool", () => {
  assert.deepEqual(toolNames(CAPABILITY_TOOLS), ["record_capability_result"]);
  const fn = (
    CAPABILITY_TOOLS[0] as {
      function: { parameters: { required?: string[] } };
    }
  ).function;
  assert.deepEqual(fn.parameters.required, [
    "capability_id",
    "title",
    "summary_md",
    "overall",
    "sections",
  ]);
});

// F5 — one run records exactly one result. Two accepted calls would stream and
// persist two cards for one confirmed run, so a lawyer could be shown two
// contradictory overall ratings. The guard lives on the run context, which is
// created once per runLLMStream and threaded into every runToolCalls
// iteration, so it holds ACROSS tool-call rounds and not just within one.

function singleResultRunContext(): CapabilityRunContext {
  const cap: LegalCapability = {
    id: "fixture-run",
    title: "Fixture run",
    practice: "Legal Operations",
    description: "chatTools.test.ts fixture",
    workflow: { type: "assistant", prompt_md: "x" },
    systemPromptFragment: { persona_framing: "", methodology: "" },
    playbookKeys: [],
    intentSignals: {
      keywords: [],
      document_hints: [],
      confirm_prompt: "Run it?",
      run_label: "Run it",
    },
    resultCard: "CapabilityResultCard",
    outputs: { docx: false, in_app_document: false },
    connectorRequirements: [],
    outputSpec: {
      overall_scheme: "traffic-light",
      sections: [
        { id: "summary", label: "Summary", kind: "text", required: true },
      ],
    },
  };
  return {
    cap,
    capabilityRun: {
      capabilityId: cap.id,
      proposalId: null,
      documentIds: [],
      inputs: { representedParty: null },
    },
    escalationTemplate: null,
  };
}

function recordCall(id: string) {
  return {
    id,
    function: {
      name: "record_capability_result",
      arguments: JSON.stringify({
        capability_id: "fixture-run",
        title: "Fixture result",
        summary_md: "One line.",
        overall: { scheme: "traffic-light", value: "GREEN" },
        sections: [
          { id: "summary", label: "Summary", kind: "text", text_md: "Fine." },
        ],
      }),
    },
  };
}

const ALREADY_RECORDED =
  "a result was already recorded for this run; do not call record_capability_result again";

test("record_capability_result records once per run, refusing a second call in the same round", async () => {
  const written: string[] = [];
  const out = await runToolCalls({
    toolCalls: [recordCall("call-1"), recordCall("call-2")],
    docStore: new Map() as DocStore,
    userId: "u1",
    db: {} as Parameters<typeof runToolCalls>[0]["db"],
    write: (s) => written.push(s),
    capabilityRun: singleResultRunContext(),
  });
  assert.equal(out.capabilityResults.length, 1, "exactly one recorded result");
  assert.equal(written.length, 1, "exactly one SSE frame");
  assert.equal(out.toolResults.length, 2);
  const second = JSON.parse(
    (out.toolResults[1] as { content: string }).content,
  );
  assert.deepEqual(second, { ok: false, error: ALREADY_RECORDED });
});

test("record_capability_result's single-result guard survives across tool-call rounds", async () => {
  // The per-invocation accumulator cannot see an earlier iteration's call;
  // the shared run context can.
  const ctx = singleResultRunContext();
  const written: string[] = [];
  const first = await runToolCalls({
    toolCalls: [recordCall("call-1")],
    docStore: new Map() as DocStore,
    userId: "u1",
    db: {} as Parameters<typeof runToolCalls>[0]["db"],
    write: (s) => written.push(s),
    capabilityRun: ctx,
  });
  assert.equal(first.capabilityResults.length, 1);

  const second = await runToolCalls({
    toolCalls: [recordCall("call-2")],
    docStore: new Map() as DocStore,
    userId: "u1",
    db: {} as Parameters<typeof runToolCalls>[0]["db"],
    write: (s) => written.push(s),
    capabilityRun: ctx,
  });
  assert.deepEqual(second.capabilityResults, [], "no second card");
  assert.equal(written.length, 1, "still exactly one SSE frame");
  assert.deepEqual(
    JSON.parse((second.toolResults[0] as { content: string }).content),
    { ok: false, error: ALREADY_RECORDED },
  );
});

test("record_capability_result refuses to run outside a capability-run turn", async () => {
  // Reached only if the model hallucinates the tool name (or a future surface
  // leaks it). No capabilityRun in opts means there is nothing to record
  // against, so the branch must refuse before touching anything.
  const written: string[] = [];
  const out = await runToolCalls({
    toolCalls: [
      {
        id: "call-1",
        function: {
          name: "record_capability_result",
          arguments: JSON.stringify({ capability_id: "triage-nda" }),
        },
      },
    ],
    docStore: new Map() as DocStore,
    userId: "u1",
    db: {} as Parameters<typeof runToolCalls>[0]["db"],
    write: (s) => written.push(s),
  });
  assert.deepEqual(out.capabilityResults, []);
  assert.equal(written.length, 0, "no SSE frame for a refused call");
  assert.equal(out.toolResults.length, 1);
  const content = JSON.parse(
    (out.toolResults[0] as { content: string }).content,
  );
  assert.deepEqual(content, {
    ok: false,
    error:
      "record_capability_result is only available on a capability-run turn",
  });
});
