// backend/src/lib/legalCapabilities/run.test.ts
//
// The pure half of the in-chat capability run: the run prompt handed to the
// model, and the validator that turns one `record_capability_result` tool call
// into the persisted `capability_result` event.
//
// The validator is the trust boundary. Everything it accepts is model output
// (which is itself downstream of UNTRUSTED document text), so these tests are
// mostly about what it REFUSES — a wrong capability, a missing required
// section, a mis-shaped table, an out-of-range score — and about the one thing
// it drops rather than refuses: a citation naming a doc handle the turn never
// had.

import assert from "node:assert/strict";
import { renderSectionsToDocxBuffer } from "../docxAssembly";
import type { DocIndex } from "../chatTools";
import type { PlaybookEntry } from "../playbooks";
import { clearRegistryForTests, registerCapability } from "./index";
import {
    buildCapabilityRunPrompt,
    capabilityResultToDocxSections,
    failedCapabilityResult,
    recordCapabilityResult,
    resolveEscalationTemplate,
    type CapabilityResultEvent,
    type CapabilityRunContext,
} from "./run";
import type { LegalCapability } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureCapability(
    overrides: Partial<LegalCapability> = {},
): LegalCapability {
    return {
        id: "fixture-review",
        title: "Fixture Review",
        practice: "Legal Operations",
        description: "A fixture capability used only by run.test.ts.",
        workflow: {
            type: "assistant",
            prompt_md:
                "Review the agreement against {{playbook:fixture.positions}} on behalf of {{representedParty}}.",
        },
        systemPromptFragment: { persona_framing: "", methodology: "" },
        playbookKeys: ["fixture.positions", "fixture.escalation_template"],
        intentSignals: {
            keywords: [],
            document_hints: [],
            confirm_prompt: "Run the fixture review?",
            run_label: "Run fixture review",
        },
        resultCard: "CapabilityResultCard",
        outputs: { docx: false, in_app_document: false },
        connectorRequirements: [],
        escalation: {
            severities_requiring_escalation: ["RED"],
            notification_template: "fixture.escalation_template",
        },
        outputSpec: {
            overall_scheme: "traffic-light",
            sections: [
                {
                    id: "summary",
                    label: "Summary",
                    kind: "text",
                    required: true,
                },
                {
                    id: "terms",
                    label: "Key terms",
                    kind: "table",
                    columns: ["Term", "Position"],
                    required: true,
                },
                {
                    id: "issues",
                    label: "Issues",
                    kind: "findings",
                    required: true,
                },
                { id: "next_steps", label: "Next steps", kind: "list" },
            ],
        },
        ...overrides,
    };
}

/** Same fixture on the risk-score scheme, escalating on ORANGE and RED. */
function scoreCapability(): LegalCapability {
    return fixtureCapability({
        id: "fixture-score",
        escalation: {
            severities_requiring_escalation: ["ORANGE", "RED"],
            notification_template: "fixture.escalation_template",
        },
        outputSpec: {
            overall_scheme: "risk-score",
            sections: [
                {
                    id: "summary",
                    label: "Summary",
                    kind: "text",
                    required: true,
                },
            ],
        },
    });
}

function entry(key: string, value: unknown): PlaybookEntry {
    return {
        id: `entry-${key}`,
        playbook_id: "pb-1",
        key,
        value_json: value,
        notes_md: "",
        is_default: true,
        updated_by: "test",
        updated_at: "2026-01-01T00:00:00.000Z",
    };
}

const PLAYBOOK: Record<string, PlaybookEntry> = {
    "fixture.positions": entry(
        "fixture.positions",
        "Mutual indemnity only; no unlimited liability.",
    ),
    "fixture.escalation_template": entry("fixture.escalation_template", {
        subject: "Escalation: {{title}} ({{severity}})",
        body: "Severity {{severity}}.\n\n{{summary}}",
    }),
};

const DOC_INDEX: DocIndex = {
    "doc-1": { document_id: "uuid-a", filename: "nda.pdf" },
    "doc-2": { document_id: "uuid-b", filename: "msa.docx" },
};

function runContext(
    cap: LegalCapability,
    overrides: Partial<CapabilityRunContext> = {},
): CapabilityRunContext {
    return {
        cap,
        capabilityRun: {
            capabilityId: cap.id,
            proposalId: "9f1c1c74-2f6e-4a0b-8f0d-9d4a1a6b1c22",
            documentIds: ["uuid-a"],
            inputs: { representedParty: "the tenant" },
        },
        escalationTemplate: resolveEscalationTemplate(cap, PLAYBOOK),
        ...overrides,
    };
}

const NOW = () => new Date("2026-09-02T10:11:12.000Z");
const UUID = () => "11111111-2222-3333-4444-555555555555";

function validPayload(): Record<string, unknown> {
    return {
        capability_id: "fixture-review",
        title: "Mutual NDA — fixture review",
        summary_md: "Two issues worth raising before signature.",
        overall: { scheme: "traffic-light", value: "RED" },
        sections: [
            { id: "summary", label: "Summary", kind: "text", text_md: "Fine." },
            {
                id: "terms",
                label: "Key terms",
                kind: "table",
                columns: ["ignored", "by", "the", "validator"],
                rows: [["Term", "Off-market"]],
            },
            {
                id: "issues",
                label: "Issues",
                kind: "findings",
                findings: [
                    {
                        label: "Unlimited liability",
                        value_md: "Clause 8 has no cap.",
                        flag: "RED",
                        citation: {
                            doc_id: "doc-1",
                            page: 4,
                            quote: "without limitation",
                        },
                    },
                ],
            },
            {
                id: "next_steps",
                label: "Next steps",
                kind: "list",
                items: ["Send the redline."],
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// buildCapabilityRunPrompt
// ---------------------------------------------------------------------------

function testPrompt() {
    const cap = fixtureCapability();
    const prompt = buildCapabilityRunPrompt({
        cap,
        resolvedPlaybook: PLAYBOOK,
        docIndex: DOC_INDEX,
        documentIds: ["uuid-a", "uuid-missing"],
        representedParty: "the tenant",
    });

    assert.ok(
        prompt.includes("Mutual indemnity only; no unlimited liability."),
        "playbook placeholder substituted",
    );
    assert.ok(
        prompt.includes("on behalf of the tenant."),
        "representedParty substituted",
    );
    assert.ok(
        !prompt.includes("{{playbook:") && !prompt.includes("{{representedParty}}"),
        "no template syntax leaks to the model",
    );

    for (const line of [
        '- id="summary" label="Summary" kind=text required',
        '- id="terms" label="Key terms" kind=table columns=["Term","Position"] required',
        '- id="issues" label="Issues" kind=findings required',
        '- id="next_steps" label="Next steps" kind=list',
    ]) {
        assert.ok(prompt.includes(line), `section line missing: ${line}`);
    }
    assert.ok(
        !prompt.includes('- id="next_steps" label="Next steps" kind=list required'),
        "optional section is not marked required",
    );

    assert.ok(
        prompt.includes("GREEN | YELLOW | ORANGE | RED | grey"),
        "flag vocabulary present",
    );
    assert.ok(
        prompt.includes("Overall scheme: traffic-light"),
        "overall scheme named",
    );
    assert.ok(
        prompt.includes("GREEN | YELLOW | RED"),
        "traffic-light allowed values listed",
    );
    assert.ok(
        prompt.includes(
            'Every YELLOW/ORANGE/RED/high finding must carry a citation `{ doc_id: "doc-N", page?, quote? }` when a document was read; cite the doc-N handles exactly as listed under AVAILABLE DOCUMENTS',
        ),
        "citation rule verbatim",
    );

    assert.ok(
        prompt.includes('- Focus document: doc-1 ("nda.pdf")'),
        "focus line for a document in the index",
    );
    assert.ok(
        !prompt.includes("uuid-missing"),
        "a document id with no handle produces no focus line",
    );
    assert.ok(
        !prompt.includes("doc-2"),
        "documents that were not pinned are not focus documents",
    );

    const mandate =
        'Read every focus document with `read_document` before analysing. Your final act this turn MUST be exactly one `record_capability_result` call with `capability_id: "fixture-review"`; prose alone does not record a result. After the tool succeeds, reply in 2–4 sentences and do not restate the card.';
    assert.ok(prompt.includes(mandate), "mandate present");
    assert.ok(prompt.trimEnd().endsWith(mandate), "prompt ends with the mandate");
    assert.ok(
        prompt.indexOf("Mutual indemnity only") <
            prompt.indexOf('- id="summary"'),
        "run prompt precedes the output contract",
    );

    // Every registered run-capable scheme names its allowed values.
    const scorePrompt = buildCapabilityRunPrompt({
        cap: scoreCapability(),
        resolvedPlaybook: PLAYBOOK,
        docIndex: DOC_INDEX,
        documentIds: [],
        representedParty: null,
    });
    assert.ok(
        scorePrompt.includes("Overall scheme: risk-score"),
        "risk-score scheme named",
    );
    assert.ok(
        scorePrompt.includes("integer 1–25"),
        "risk-score range stated",
    );
    assert.ok(
        !scorePrompt.includes("Focus document:"),
        "no focus block when nothing was pinned",
    );
    assert.ok(
        scorePrompt.includes("the party you represent"),
        "absent representedParty falls back to the neutral default",
    );
}

// ---------------------------------------------------------------------------
// recordCapabilityResult — the happy path
// ---------------------------------------------------------------------------

function testRecordValid() {
    const ctx = runContext(fixtureCapability());
    const outcome = recordCapabilityResult({
        ctx,
        toolArgs: validPayload(),
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(outcome.ok, `expected ok, got ${JSON.stringify(outcome)}`);
    if (!outcome.ok) return;

    const ev = outcome.event;
    assert.equal(ev.type, "capability_result");
    assert.equal(ev.result_id, UUID());
    assert.equal(ev.capability_id, "fixture-review");
    assert.equal(ev.proposal_id, "9f1c1c74-2f6e-4a0b-8f0d-9d4a1a6b1c22");
    assert.equal(ev.title, "Mutual NDA — fixture review");
    assert.equal(ev.status, "complete");
    assert.equal(ev.error_code, null);
    assert.equal(ev.retry, null, "a complete result carries no retry payload");
    assert.equal(ev.recorded_at, "2026-09-02T10:11:12.000Z");
    assert.deepEqual(ev.overall, {
        scheme: "traffic-light",
        native_label: "RED",
        band: "high",
    });

    assert.deepEqual(
        ev.sections.map((s) => s.id),
        ["summary", "terms", "issues", "next_steps"],
    );

    // The card and the DOCX export read in the CONTRACT's order, not whatever
    // order the model happened to emit.
    const shuffled = recordCapabilityResult({
        ctx,
        toolArgs: {
            ...validPayload(),
            sections: [...(validPayload().sections as unknown[])].reverse(),
        },
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(shuffled.ok);
    if (shuffled.ok) {
        assert.deepEqual(
            shuffled.event.sections.map((s) => s.id),
            ["summary", "terms", "issues", "next_steps"],
            "sections are re-ordered to the spec's order",
        );
    }
    const terms = ev.sections.find((s) => s.id === "terms");
    assert.deepEqual(
        terms?.columns,
        ["Term", "Position"],
        "spec columns win over model-supplied ones",
    );
    assert.deepEqual(terms?.rows, [["Term", "Off-market"]]);
    const issues = ev.sections.find((s) => s.id === "issues");
    assert.deepEqual(issues?.findings?.[0].citation, {
        document_id: "uuid-a",
        filename: "nda.pdf",
        page: 4,
        quote: "without limitation",
    });

    assert.deepEqual(
        ev.escalation,
        {
            subject: "Escalation: Mutual NDA — fixture review (RED)",
            body: "Severity RED.\n\nTwo issues worth raising before signature.",
        },
        "RED fills the escalation draft from the playbook template",
    );

    assert.equal(outcome.toolResult.ok, true);
    assert.equal(outcome.toolResult.result_id, UUID());
    assert.equal(
        outcome.toolResult.next_required_action,
        "Wrap up in 2–4 sentences; do not restate the card.",
    );
}

function testEscalationBands() {
    // Not in severities_requiring_escalation → no draft.
    const green = recordCapabilityResult({
        ctx: runContext(fixtureCapability()),
        toolArgs: {
            ...validPayload(),
            overall: { scheme: "traffic-light", value: "GREEN" },
        },
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(green.ok);
    if (green.ok) {
        assert.equal(green.event.escalation, null, "GREEN does not escalate");
        assert.equal(green.event.overall?.band, "low");
    }

    // No template resolved → no draft even at RED.
    const noTemplate = recordCapabilityResult({
        ctx: runContext(fixtureCapability(), { escalationTemplate: null }),
        toolArgs: validPayload(),
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(noTemplate.ok);
    if (noTemplate.ok) {
        assert.equal(noTemplate.event.escalation, null);
    }

    // risk-score must be mapped to a GREEN/YELLOW/ORANGE/RED label before it
    // is compared against severities_requiring_escalation — comparing the raw
    // score would never match and the escalation would silently never fire.
    const scoreCap = scoreCapability();
    const scored = (score: number) =>
        recordCapabilityResult({
            ctx: runContext(scoreCap),
            toolArgs: {
                capability_id: "fixture-score",
                title: "Scored risk",
                summary_md: "Summary text.",
                overall: { scheme: "risk-score", score },
                sections: [
                    {
                        id: "summary",
                        label: "Summary",
                        kind: "text",
                        text_md: "x",
                    },
                ],
            },
            docIndex: DOC_INDEX,
            now: NOW,
            uuid: UUID,
        });

    const orange = scored(12);
    assert.ok(orange.ok);
    if (orange.ok) {
        assert.equal(orange.event.overall?.native_label, "12");
        assert.equal(orange.event.overall?.band, "high");
        assert.equal(
            orange.event.escalation?.subject,
            "Escalation: Scored risk (ORANGE)",
            "score 12 maps to ORANGE and escalates",
        );
    }

    const yellow = scored(6);
    assert.ok(yellow.ok);
    if (yellow.ok) {
        assert.equal(
            yellow.event.escalation,
            null,
            "score 6 (YELLOW) is not an escalating severity here",
        );
    }

    const red = scored(20);
    assert.ok(red.ok);
    if (red.ok) {
        assert.equal(red.event.escalation?.subject, "Escalation: Scored risk (RED)");
        assert.equal(red.event.overall?.band, "critical");
    }
}

// ---------------------------------------------------------------------------
// recordCapabilityResult — refusals
// ---------------------------------------------------------------------------

function reject(toolArgs: unknown, label: string, cap = fixtureCapability()) {
    const outcome = recordCapabilityResult({
        ctx: runContext(cap),
        toolArgs,
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(!outcome.ok, `${label}: expected a refusal`);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.toolResult.ok, false);
    assert.ok(
        outcome.toolResult.error.length > 0,
        `${label}: refusal carries no error string`,
    );
    return outcome.toolResult;
}

function testRefusals() {
    const specIds = ["summary", "terms", "issues", "next_steps"];

    const wrongCap = reject(
        { ...validPayload(), capability_id: "some-other-capability" },
        "wrong capability_id",
    );
    assert.ok(
        wrongCap.error.includes("fixture-review"),
        "refusal names the expected capability",
    );
    assert.deepEqual(wrongCap.expected_sections, specIds);

    reject(null, "null tool args");
    reject("nope", "string tool args");
    reject({ ...validPayload(), title: "" }, "empty title");
    reject({ ...validPayload(), title: "t".repeat(201) }, "over-long title");
    reject({ ...validPayload(), summary_md: 42 }, "non-string summary");
    reject(
        { ...validPayload(), summary_md: "s".repeat(4001) },
        "over-long summary",
    );
    reject(
        { ...validPayload(), overall: { scheme: "risk-area", value: "high" } },
        "wrong overall scheme",
    );
    reject(
        { ...validPayload(), overall: { scheme: "traffic-light", value: "PUCE" } },
        "value outside the scheme's vocabulary",
    );
    reject({ ...validPayload(), overall: null }, "missing overall");
    reject({ ...validPayload(), sections: "all of them" }, "non-array sections");

    const missing = reject(
        {
            ...validPayload(),
            sections: (
                validPayload().sections as Record<string, unknown>[]
            ).slice(0, 2),
        },
        "missing required section",
    );
    assert.ok(
        missing.error.includes("issues"),
        "refusal names the missing section",
    );
    assert.deepEqual(
        missing.expected_sections,
        specIds,
        "refusal lists every spec id so the model can retry",
    );

    reject(
        {
            ...validPayload(),
            sections: [
                ...(validPayload().sections as unknown[]),
                {
                    id: "not_in_spec",
                    label: "Invented",
                    kind: "text",
                    text_md: "x",
                },
            ],
        },
        "section id outside the spec",
    );

    const dup = validPayload().sections as Record<string, unknown>[];
    reject({ ...validPayload(), sections: [...dup, dup[0]] }, "duplicate id");

    const wrongKind = dup.map((s) =>
        s.id === "summary" ? { ...s, kind: "list", items: ["x"] } : s,
    );
    reject({ ...validPayload(), sections: wrongKind }, "wrong kind for the id");

    const badWidth = dup.map((s) =>
        s.id === "terms" ? { ...s, rows: [["only-one-cell"]] } : s,
    );
    reject(
        { ...validPayload(), sections: badWidth },
        "table row width mismatch",
    );

    const tooManyRows = dup.map((s) =>
        s.id === "terms"
            ? { ...s, rows: Array.from({ length: 101 }, () => ["a", "b"]) }
            : s,
    );
    reject({ ...validPayload(), sections: tooManyRows }, "over 100 table rows");

    const fatCell = dup.map((s) =>
        s.id === "terms" ? { ...s, rows: [["a", "b".repeat(1001)]] } : s,
    );
    reject({ ...validPayload(), sections: fatCell }, "over-long table cell");

    const nonStringCell = dup.map((s) =>
        s.id === "terms" ? { ...s, rows: [["a", 7]] } : s,
    );
    reject({ ...validPayload(), sections: nonStringCell }, "non-string cell");

    const tooManyItems = dup.map((s) =>
        s.id === "next_steps"
            ? { ...s, items: Array.from({ length: 51 }, () => "x") }
            : s,
    );
    reject({ ...validPayload(), sections: tooManyItems }, "over 50 list items");

    const fatText = dup.map((s) =>
        s.id === "summary" ? { ...s, text_md: "x".repeat(8001) } : s,
    );
    reject({ ...validPayload(), sections: fatText }, "over-long text_md");

    const badFlag = dup.map((s) =>
        s.id === "issues"
            ? {
                  ...s,
                  findings: [
                      { label: "l", value_md: "v", flag: "MAUVE" },
                  ],
              }
            : s,
    );
    reject({ ...validPayload(), sections: badFlag }, "flag outside vocabulary");

    const fatFinding = dup.map((s) =>
        s.id === "issues"
            ? { ...s, findings: [{ label: "l", value_md: "v".repeat(4001) }] }
            : s,
    );
    reject({ ...validPayload(), sections: fatFinding }, "over-long value_md");

    const tooManyFindings = dup.map((s) =>
        s.id === "issues"
            ? {
                  ...s,
                  findings: Array.from({ length: 51 }, () => ({
                      label: "l",
                      value_md: "v",
                  })),
              }
            : s,
    );
    reject({ ...validPayload(), sections: tooManyFindings }, "over 50 findings");

    // risk-score is scored 1..25. 26 is out of range and is REFUSED, not
    // clamped — a clamp would report a score the model never gave.
    const scoreCap = scoreCapability();
    const scorePayload = (score: unknown) => ({
        capability_id: "fixture-score",
        title: "Scored risk",
        summary_md: "Summary text.",
        overall: { scheme: "risk-score", score },
        sections: [
            { id: "summary", label: "Summary", kind: "text", text_md: "x" },
        ],
    });
    reject(scorePayload(26), "risk-score above 25", scoreCap);
    reject(scorePayload(0), "risk-score below 1", scoreCap);
    reject(scorePayload(3.5), "non-integer risk-score", scoreCap);
    reject(scorePayload("12"), "non-numeric risk-score", scoreCap);
}

function testCitationDropping() {
    const payload = validPayload();
    const sections = payload.sections as Record<string, unknown>[];
    const withBadCitations = sections.map((s) =>
        s.id === "issues"
            ? {
                  ...s,
                  findings: [
                      {
                          label: "Unknown handle",
                          value_md: "x",
                          flag: "RED",
                          citation: { doc_id: "doc-99", page: 2 },
                      },
                      {
                          label: "Junk page and quote",
                          value_md: "y",
                          flag: "YELLOW",
                          citation: {
                              doc_id: "doc-2",
                              page: 0,
                              quote: "q".repeat(900),
                          },
                      },
                  ],
              }
            : s,
    );
    const outcome = recordCapabilityResult({
        ctx: runContext(fixtureCapability()),
        toolArgs: { ...payload, sections: withBadCitations },
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(outcome.ok, "an unknown doc handle must not reject the result");
    if (!outcome.ok) return;
    const findings = outcome.event.sections.find((s) => s.id === "issues")
        ?.findings;
    assert.equal(
        findings?.[0].citation,
        null,
        "citation naming a handle the turn never had is dropped",
    );
    assert.equal(
        findings?.[1].citation?.document_id,
        "uuid-b",
        "a resolvable handle survives",
    );
    assert.equal(findings?.[1].citation?.page, null, "page 0 is not a page");
    assert.equal(
        findings?.[1].citation?.quote?.length,
        500,
        "quote truncated to 500 chars",
    );
}

// ---------------------------------------------------------------------------
// failedCapabilityResult + resolveEscalationTemplate
// ---------------------------------------------------------------------------

function testFailedResult() {
    const ctx = runContext(fixtureCapability());
    const ev = failedCapabilityResult({
        ctx,
        errorCode: "no_result_recorded",
        now: NOW,
        uuid: UUID,
    });
    assert.equal(ev.type, "capability_result");
    assert.equal(ev.status, "failed");
    assert.equal(ev.error_code, "no_result_recorded");
    assert.equal(ev.capability_id, "fixture-review");
    assert.equal(ev.title, "Fixture Review");
    assert.equal(ev.summary_md, "");
    assert.equal(ev.overall, null);
    assert.equal(ev.escalation, null);
    assert.deepEqual(ev.sections, []);
    assert.equal(ev.recorded_at, "2026-09-02T10:11:12.000Z");
    assert.deepEqual(
        ev.retry,
        {
            document_ids: ["uuid-a"],
            inputs: { represented_party: "the tenant" },
        },
        "a failed result carries the inputs needed to re-run it",
    );
}

function testResolveEscalationTemplate() {
    const cap = fixtureCapability();
    assert.deepEqual(resolveEscalationTemplate(cap, PLAYBOOK), {
        subject: "Escalation: {{title}} ({{severity}})",
        body: "Severity {{severity}}.\n\n{{summary}}",
    });
    assert.equal(resolveEscalationTemplate(cap, {}), null, "no entry");
    assert.equal(
        resolveEscalationTemplate(cap, {
            "fixture.escalation_template": entry(
                "fixture.escalation_template",
                "a bare string",
            ),
        }),
        null,
        "a non-object value is not a template",
    );
    assert.equal(
        resolveEscalationTemplate(cap, {
            "fixture.escalation_template": entry(
                "fixture.escalation_template",
                { subject: "s" },
            ),
        }),
        null,
        "a template without a body is not a template",
    );
    assert.equal(
        resolveEscalationTemplate(
            fixtureCapability({ escalation: undefined }),
            PLAYBOOK,
        ),
        null,
        "a capability with no escalation declaration",
    );
}

// ---------------------------------------------------------------------------
// capabilityResultToDocxSections
// ---------------------------------------------------------------------------

function resultEvent(
    overrides: Partial<CapabilityResultEvent> = {},
): CapabilityResultEvent {
    return {
        type: "capability_result",
        result_id: "res-1",
        capability_id: "fixture-review",
        proposal_id: null,
        title: "Mutual NDA — fixture review",
        summary_md: "Two issues worth raising before signature.",
        overall: { scheme: "traffic-light", native_label: "RED", band: "high" },
        sections: [
            {
                id: "summary",
                label: "Summary",
                kind: "text",
                text_md: "The **cap** is missing.",
            },
            {
                id: "terms",
                label: "Key terms",
                kind: "table",
                columns: ["Term", "Position"],
                rows: [["Liability", "Off-market"]],
            },
            {
                id: "issues",
                label: "Issues",
                kind: "findings",
                findings: [
                    {
                        label: "Unlimited liability",
                        value_md: "Clause 8 has no cap.",
                        flag: "RED",
                        band: "high",
                        citation: {
                            document_id: "uuid-a",
                            filename: "nda.pdf",
                            page: 4,
                            quote: "without limitation",
                        },
                    },
                    {
                        label: "Term length",
                        value_md: "Five years.",
                        flag: null,
                        band: null,
                        citation: {
                            document_id: "uuid-a",
                            filename: "nda.pdf",
                            page: 2,
                            quote: null,
                        },
                    },
                    {
                        label: "Governing law",
                        value_md: "Delaware.",
                        flag: "GREEN",
                        band: "low",
                        citation: {
                            document_id: "uuid-b",
                            filename: "msa.docx",
                            page: null,
                            quote: "the laws of Delaware",
                        },
                    },
                    {
                        label: "Assignment",
                        value_md: "Silent.",
                        flag: "grey",
                        band: null,
                        citation: null,
                    },
                ],
            },
            {
                id: "next_steps",
                label: "Next steps",
                kind: "list",
                items: ["Send the redline.", "Book the call."],
            },
        ],
        escalation: {
            subject: "Escalation: Mutual NDA (RED)",
            body: "Severity RED.\n\nTwo issues.",
        },
        status: "complete",
        error_code: null,
        recorded_at: "2026-09-02T10:11:12.000Z",
        retry: null,
        ...overrides,
    };
}

function testDocxSections() {
    const sections = capabilityResultToDocxSections(resultEvent());

    assert.equal(sections.length, 6, "summary + 4 sections + escalation");

    // (1) summary first, prefixed with the overall line.
    assert.deepEqual(sections[0], {
        content:
            "Overall: RED (high)\n\nTwo issues worth raising before signature.",
    });

    // (2) each kind, in event order.
    assert.deepEqual(sections[1], {
        heading: "Summary",
        level: 2,
        content: "The **cap** is missing.",
    });
    assert.deepEqual(sections[2], {
        heading: "Key terms",
        level: 2,
        table: { headers: ["Term", "Position"], rows: [["Liability", "Off-market"]] },
    });
    assert.deepEqual(sections[3], {
        heading: "Issues",
        level: 2,
        table: {
            headers: ["Item", "Flag", "Detail", "Citation"],
            rows: [
                [
                    "Unlimited liability",
                    "RED",
                    "Clause 8 has no cap.",
                    'nda.pdf, p. 4 — "without limitation"',
                ],
                ["Term length", "", "Five years.", "nda.pdf, p. 2"],
                [
                    "Governing law",
                    "GREEN",
                    "Delaware.",
                    'msa.docx — "the laws of Delaware"',
                ],
                ["Assignment", "grey", "Silent.", ""],
            ],
        },
    });
    assert.deepEqual(sections[4], {
        heading: "Next steps",
        level: 2,
        content: "- Send the redline.\n- Book the call.",
    });

    // (3) escalation last.
    assert.deepEqual(sections[5], {
        heading: "Escalation draft",
        level: 2,
        content:
            "Subject: Escalation: Mutual NDA (RED)\n\nSeverity RED.\n\nTwo issues.",
    });
}

function testDocxSectionsSkipsAndOmissions() {
    // No overall → no prefix line.
    const noOverall = capabilityResultToDocxSections(
        resultEvent({ overall: null, sections: [], escalation: null }),
    );
    assert.deepEqual(noOverall, [
        { content: "Two issues worth raising before signature." },
    ]);

    // Empty sections of every kind are skipped.
    const empties = capabilityResultToDocxSections(
        resultEvent({
            overall: null,
            escalation: null,
            sections: [
                { id: "a", label: "Blank text", kind: "text", text_md: "   " },
                { id: "b", label: "Blank list", kind: "list", items: [] },
                {
                    id: "c",
                    label: "Blank table",
                    kind: "table",
                    columns: ["X"],
                    rows: [],
                },
                {
                    id: "d",
                    label: "Blank findings",
                    kind: "findings",
                    findings: [],
                },
                { id: "e", label: "Kept", kind: "text", text_md: "Here." },
            ],
        }),
    );
    assert.equal(empties.length, 2, "only the summary and the kept section");
    assert.equal(empties[1].heading, "Kept");
}

function testDocxSectionsFailedEvent() {
    const sections = capabilityResultToDocxSections(
        resultEvent({
            status: "failed",
            error_code: "no_result_recorded",
            summary_md: "",
            overall: null,
            sections: [],
            escalation: null,
        }),
    );
    assert.equal(sections.length, 1, "a failed run exports one section");
    assert.ok(
        /no result/i.test(sections[0].content ?? ""),
        `explains the absence of a result, got ${JSON.stringify(sections[0])}`,
    );
}

async function testDocxSectionsRender() {
    const event = resultEvent();
    const rendered = await renderSectionsToDocxBuffer(
        event.title,
        capabilityResultToDocxSections(event),
    );
    assert.ok(!("error" in rendered), `render failed: ${JSON.stringify(rendered)}`);
    if ("error" in rendered) return;
    assert.ok(Buffer.isBuffer(rendered.buffer), "renders a Buffer");
    assert.ok(rendered.buffer.length > 0, "buffer is non-empty");
}


// ---------------------------------------------------------------------------
// Final-review fixes: F11 (prototype-chain doc handles), F12 (registry-owned
// section labels), F15 (missing playbook keys are declared to the model),
// F16 (server-resolved finding bands).
// ---------------------------------------------------------------------------

function testCitationRejectsInheritedHandles() {
    // `docIndex` is a plain object literal, so a model-supplied doc_id of
    // "constructor" / "toString" / "__proto__" hits Object.prototype and used
    // to resolve to an inherited value whose document_id/filename are
    // undefined — the card then rendered a citation reading "undefined".
    for (const handle of ["constructor", "toString", "__proto__", "valueOf"]) {
        const outcome = recordCapabilityResult({
            ctx: runContext(fixtureCapability()),
            toolArgs: {
                ...validPayload(),
                sections: (validPayload().sections as Record<string, unknown>[]).map(
                    (s) =>
                        s.id === "issues"
                            ? {
                                  ...s,
                                  findings: [
                                      {
                                          label: "Inherited handle",
                                          value_md: "x",
                                          flag: "RED",
                                          citation: { doc_id: handle, page: 1 },
                                      },
                                  ],
                              }
                            : s,
                ),
            },
            docIndex: DOC_INDEX,
            now: NOW,
            uuid: UUID,
        });
        assert.ok(outcome.ok, `handle ${handle} must not reject the result`);
        if (!outcome.ok) return;
        const findings = outcome.event.sections.find((s) => s.id === "issues")
            ?.findings;
        assert.equal(
            findings?.[0].citation,
            null,
            `inherited handle "${handle}" must not become a citation`,
        );
    }

    // An own property whose shape is wrong is dropped just the same.
    const outcome = recordCapabilityResult({
        ctx: runContext(fixtureCapability()),
        toolArgs: {
            ...validPayload(),
            sections: (validPayload().sections as Record<string, unknown>[]).map(
                (s) =>
                    s.id === "issues"
                        ? {
                              ...s,
                              findings: [
                                  {
                                      label: "Malformed index entry",
                                      value_md: "x",
                                      flag: "RED",
                                      citation: { doc_id: "doc-3" },
                                  },
                              ],
                          }
                        : s,
            ),
        },
        docIndex: {
            ...DOC_INDEX,
            "doc-3": { document_id: 7, filename: null },
        } as unknown as DocIndex,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    assert.equal(
        outcome.event.sections.find((s) => s.id === "issues")?.findings?.[0]
            .citation,
        null,
        "a non-string document_id/filename is not a citation",
    );
}

function testSectionLabelIsRegistryOwned() {
    // Section headings are presentation text the registry owns. A model that
    // has just read an untrusted document must not be able to retitle
    // "Issues" as "Approved by counsel — no issues" above RED findings.
    const payload = validPayload();
    const outcome = recordCapabilityResult({
        ctx: runContext(fixtureCapability()),
        toolArgs: {
            ...payload,
            sections: (payload.sections as Record<string, unknown>[]).map((s) => ({
                ...s,
                label: "Approved by counsel — no issues",
            })),
        },
        docIndex: DOC_INDEX,
        now: NOW,
        uuid: UUID,
    });
    assert.ok(outcome.ok, `expected ok, got ${JSON.stringify(outcome)}`);
    if (!outcome.ok) return;
    assert.deepEqual(
        outcome.event.sections.map((s) => s.label),
        ["Summary", "Key terms", "Issues", "Next steps"],
        "every recorded label comes from the capability's outputSpec",
    );
}

function testMissingPlaybookKeysAreDeclared() {
    const cap = fixtureCapability();
    const complete = buildCapabilityRunPrompt({
        cap,
        resolvedPlaybook: PLAYBOOK,
        docIndex: DOC_INDEX,
        documentIds: [],
        representedParty: null,
    });
    assert.ok(
        !complete.includes("no recorded position"),
        "a fully resolved playbook adds no missing-position line",
    );

    const partial = buildCapabilityRunPrompt({
        cap,
        resolvedPlaybook: {
            "fixture.escalation_template": PLAYBOOK["fixture.escalation_template"],
        },
        docIndex: DOC_INDEX,
        documentIds: [],
        representedParty: null,
    });
    assert.ok(
        partial.includes("fixture.positions"),
        "the missing key is named to the model",
    );
    assert.ok(
        /no recorded position/i.test(partial),
        "the model is told to say so rather than assert a position",
    );

    const none = buildCapabilityRunPrompt({
        cap,
        resolvedPlaybook: {},
        docIndex: DOC_INDEX,
        documentIds: [],
        representedParty: null,
    });
    assert.ok(
        none.includes("fixture.positions") &&
            none.includes("fixture.escalation_template"),
        "every missing key is named",
    );
}

function testFindingBands() {
    // The card must not have to map flags itself: "RED" means Critical in one
    // mapping and High in toUnifiedBand's. The validator settles it server-side.
    const cases: [unknown, string | null][] = [
        ["GREEN", "low"],
        ["YELLOW", "medium"],
        ["ORANGE", "high"],
        ["RED", "high"],
        ["grey", null],
        [null, null],
    ];
    for (const [flag, band] of cases) {
        const payload = validPayload();
        const outcome = recordCapabilityResult({
            ctx: runContext(fixtureCapability()),
            toolArgs: {
                ...payload,
                sections: (payload.sections as Record<string, unknown>[]).map((s) =>
                    s.id === "issues"
                        ? {
                              ...s,
                              findings: [
                                  {
                                      label: "Flagged",
                                      value_md: "x",
                                      ...(flag === null ? {} : { flag }),
                                  },
                              ],
                          }
                        : s,
                ),
            },
            docIndex: DOC_INDEX,
            now: NOW,
            uuid: UUID,
        });
        assert.ok(outcome.ok, `flag ${String(flag)}: ${JSON.stringify(outcome)}`);
        if (!outcome.ok) return;
        const finding = outcome.event.sections.find((s) => s.id === "issues")
            ?.findings?.[0];
        assert.equal(
            finding?.band,
            band,
            `flag ${String(flag)} must record band ${String(band)}`,
        );
    }
}

async function main() {
    clearRegistryForTests();
    registerCapability(fixtureCapability());
    registerCapability(scoreCapability());

    testPrompt();
    testRecordValid();
    testEscalationBands();
    testRefusals();
    testCitationDropping();
    testCitationRejectsInheritedHandles();
    testSectionLabelIsRegistryOwned();
    testMissingPlaybookKeysAreDeclared();
    testFindingBands();
    testFailedResult();
    testResolveEscalationTemplate();
    testDocxSections();
    testDocxSectionsSkipsAndOmissions();
    testDocxSectionsFailedEvent();
    await testDocxSectionsRender();

    clearRegistryForTests();
    console.log("legalCapabilities/run.test.ts passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
