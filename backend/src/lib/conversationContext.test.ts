import assert from "node:assert/strict";
import {
    assistantProseFromEvents,
    assistantMessageForModel,
    conversationLineageMatches,
    episodeSourceForSummary,
    groupConversationEpisodes,
    parseConversationSummary,
    selectEpisodesForContext,
    type StoredConversationMessage,
    type HistoricalEmail,
} from "./conversationContext";

function row(
    id: string,
    role: "user" | "assistant",
    content: unknown,
    generationStatus?: string | null,
): StoredConversationMessage {
    return {
        id,
        chat_id: "chat-1",
        role,
        content,
        created_at: id,
        generation_status: generationStatus,
    };
}

function seededEpisodes(count: number, addCurrent = false) {
    const rows: StoredConversationMessage[] = [];
    for (let index = 0; index < count; index++) {
        rows.push(row(`u-${index}`, "user", `question ${index}`));
        rows.push(
            row(
                `a-${index}`,
                "assistant",
                [{ type: "content", text: `answer ${index}` }],
                "completed",
            ),
        );
    }
    if (addCurrent) rows.push(row("u-current", "user", "current question"));
    return groupConversationEpisodes(rows);
}

assert.equal(
    assistantProseFromEvents([
        { type: "reasoning", text: "hidden" },
        { type: "content", text: "visible one" },
        { type: "thinking" },
        { type: "content", text: " and two" },
    ]),
    "visible one and two",
);

assert.equal(
    conversationLineageMatches(
        { project_id: "matter-a", user_id: "member-a" },
        { project_id: "matter-a", user_id: "member-b" },
    ),
    true,
);
assert.equal(
    conversationLineageMatches(
        { project_id: "matter-a", user_id: "member-a" },
        { project_id: "matter-b", user_id: "member-a" },
    ),
    false,
);
assert.equal(
    conversationLineageMatches(
        { project_id: null, user_id: "user-a" },
        { project_id: null, user_id: "user-b" },
    ),
    false,
);

{
    const episodes = seededEpisodes(60, true);
    const selected = selectEpisodesForContext({ episodes, summary: null });
    assert.equal(selected.exactCompleted.length, 50);
    assert.equal(selected.unsummarizedOverflow.length, 10);
    assert.equal(selected.selected.length, 61);
    assert.equal(selected.selected.at(-1)?.completed, false);
}

{
    const episodes = seededEpisodes(50, true);
    const selected = selectEpisodesForContext({ episodes, summary: null });
    assert.equal(selected.exactCompleted.length, 50);
    assert.equal(selected.unsummarizedOverflow.length, 0);
    assert.equal(selected.selected.length, 51);
}

{
    const episodes = seededEpisodes(100, true);
    const selected = selectEpisodesForContext({ episodes, summary: null });
    assert.equal(selected.exactCompleted.length, 50);
    assert.equal(selected.unsummarizedOverflow.length, 50);
    assert.equal(selected.selected.length, 101);
}

{
    const episodes = seededEpisodes(100, true);
    const summary = parseConversationSummary({
        version: 1,
        narrative: "first fifty episodes",
        entries: [],
        source_message_ids: [],
        source_episode_count: 50,
        through_message_id: "a-49",
    });
    const selected = selectEpisodesForContext({ episodes, summary });
    assert.equal(selected.exactCompleted.length, 50);
    assert.equal(selected.unsummarizedOverflow.length, 0);
    assert.equal(selected.selected.length, 51);
    assert.equal(selected.selected[0].user?.content, "question 50");
}

{
    const assistant = row(
        "a-sent-email",
        "assistant",
        [
            { type: "content", text: "The draft is ready." },
            { type: "email_pending", email_id: "email-sent" },
        ],
        "completed",
    );
    const email: HistoricalEmail = {
        id: "email-sent",
        chat_id: "chat-1",
        status: "sent",
        direction: "outbound",
        from_address: "legal@example.com",
        to_addresses: ["morgan@example.com"],
        cc_addresses: ["riley@example.com"],
        bcc_addresses: [],
        subject: "Light review — Mutual NDA",
        body_text:
            "Exact sent body with both prior-knowledge and independent-development carve-outs.",
        attachments: [],
        sent_at: "2026-08-25T14:00:00.000Z",
    };
    const restored = assistantMessageForModel(
        assistant,
        new Map([[email.id, email]]),
    );
    assert.match(restored?.content ?? "", /current status sent/);
    assert.match(restored?.content ?? "", /Light review — Mutual NDA/);
    assert.match(
        restored?.content ?? "",
        /Exact sent body with both prior-knowledge and independent-development carve-outs/,
    );
}

{
    const episodes = seededEpisodes(60, true);
    const summary = parseConversationSummary({
        version: 1,
        narrative: "episodes zero through nine",
        entries: [
            {
                text: "older details",
                source_message_ids: ["u-0", "a-0"],
            },
        ],
        source_message_ids: ["u-0", "a-0"],
        source_episode_count: 10,
        through_message_id: "a-9",
    });
    assert.ok(summary);
    const selected = selectEpisodesForContext({ episodes, summary });
    assert.equal(selected.unsummarizedOverflow.length, 0);
    assert.equal(selected.selected.length, 51);
    assert.equal(selected.selected[0].user?.content, "question 10");
}

{
    const episodes = seededEpisodes(60, true);
    const summary = parseConversationSummary({
        version: 1,
        narrative: "episodes zero through four",
        entries: [],
        source_message_ids: [],
        source_episode_count: 5,
        through_message_id: "a-4",
    });
    const selected = selectEpisodesForContext({ episodes, summary });
    assert.equal(selected.unsummarizedOverflow.length, 5);
    assert.equal(selected.selected.length, 56);
}

{
    const episodes = groupConversationEpisodes([
        row("u-partial", "user", "do the thing"),
        row(
            "a-partial",
            "assistant",
            [{ type: "content", text: "started" }],
            "streaming",
        ),
    ]);
    assert.equal(episodes[0].completed, false);
    const restored = assistantMessageForModel(
        episodes[0].assistants[0],
        new Map(),
    );
    assert.match(restored?.content ?? "", /status: streaming/);
}

{
    const episode = groupConversationEpisodes([
        row("u-email", "user", "send it"),
        row(
            "a-email",
            "assistant",
            [
                { type: "reasoning", text: "private reasoning" },
                { type: "content", text: "I prepared it." },
                {
                    type: "email_pending",
                    email_id: "email-123",
                    to: ["recipient@example.com"],
                    subject: "NDA review",
                    body_preview: "not used as canonical body",
                },
            ],
            "completed",
        ),
    ])[0];
    const source = episodeSourceForSummary(episode);
    assert.match(source.text, /email-123/);
    assert.match(source.text, /I prepared it/);
    assert.doesNotMatch(source.text, /private reasoning/);
    assert.deepEqual(source.source_message_ids, ["u-email", "a-email"]);
}

// A `capability_result` event carries the WHOLE analysis — every section, row
// and finding. Replaying that into the next turn's context would cost more
// tokens than the answer it came from and would tempt the model to re-run a
// capability the user already has a card for. Both context paths compact it to
// the four fields that identify it.
{
    const capabilityEvent = {
        type: "capability_result",
        result_id: "res-1",
        capability_id: "triage-nda",
        proposal_id: null,
        title: "Acme mutual NDA",
        summary_md: "Two off-market terms.",
        overall: { scheme: "traffic-light", native_label: "RED", band: "high" },
        sections: [
            {
                id: "issues",
                label: "Issues",
                kind: "findings",
                findings: [
                    {
                        label: "Perpetual confidentiality",
                        value_md: "SECTION_BODY_MARKER clause 4 never expires.",
                        flag: "RED",
                        citation: null,
                    },
                ],
            },
        ],
        escalation: null,
        status: "complete",
        error_code: null,
        recorded_at: "2026-09-02T10:11:12.000Z",
        retry: null,
    };

    const stored = row("a-cap", "assistant", [
        { type: "content", text: "Flagged two terms." },
        capabilityEvent,
    ]);
    const restored = assistantMessageForModel(stored, new Map());
    const text = restored?.content ?? "";
    assert.match(text, /triage-nda/);
    assert.match(text, /Acme mutual NDA/);
    assert.match(text, /high/);
    assert.match(text, /complete/);
    assert.doesNotMatch(
        text,
        /SECTION_BODY_MARKER/,
        "section bodies must not be replayed into the model's context",
    );
    assert.doesNotMatch(text, /Perpetual confidentiality/);
    assert.doesNotMatch(text, /summary_md|Two off-market terms/);

    const episode = groupConversationEpisodes([
        row("u-cap", "user", "triage this NDA"),
        stored,
    ])[0];
    const capSource = episodeSourceForSummary(episode);
    assert.match(capSource.text, /triage-nda/);
    assert.match(capSource.text, /Acme mutual NDA/);
    assert.match(capSource.text, /high/);
    assert.doesNotMatch(
        capSource.text,
        /SECTION_BODY_MARKER/,
        "the rolling summary must not carry section bodies either",
    );

    // A failed run has no overall; it must still compact cleanly.
    const failed = row("a-cap-failed", "assistant", [
        { ...capabilityEvent, overall: null, status: "failed", sections: [] },
    ]);
    const failedText =
        assistantMessageForModel(failed, new Map())?.content ?? "";
    assert.match(failedText, /failed/);
    assert.match(failedText, /"band":null/);
}

console.log("conversationContext.test.ts: all passed");
