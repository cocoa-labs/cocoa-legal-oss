import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createDocumentActionFilter,
    hasUnverifiedDocumentClaim,
    isDocumentProgressRequest,
    normalizeDocumentActionProse,
} from "./responseGuard";
import { assistantMessageForModel } from "../conversationContext";

const fakeId = "36837eb5-04b6-4c4a-b2f0-cf72f5a6dbd0";
const marker = `[document_job_started action] ${JSON.stringify({ job_id: fakeId, total_documents: 2, nested: { title: 'A brace } and an escaped " quote' } })}`;

test("the screenshot's fabricated marker is suppressed at every streaming boundary", () => {
    const input = `The documents are queued. ${marker} More prose.`;
    for (let split = 0; split <= input.length; split++) {
        const ids: (string | null)[] = [];
        const filter = createDocumentActionFilter((id) => ids.push(id));
        const output =
            filter.push(input.slice(0, split)) +
            filter.push(input.slice(split)) +
            filter.finish();
        assert.equal(output, "The documents are queued.  More prose.");
        assert.deepEqual(ids, [fakeId]);
        assert.equal(hasUnverifiedDocumentClaim(output, ids, new Set()), true);
    }
    const filter = createDocumentActionFilter(() => {});
    assert.equal(
        [...marker].map((char) => filter.push(char)).join("") + filter.finish(),
        "",
    );
    assert.equal(
        normalizeDocumentActionProse("[a normal reference] is retained."),
        "[a normal reference] is retained.",
    );
});

test("only confirmed scheduling backs acknowledgements, including claims with no marker", () => {
    assert.equal(
        hasUnverifiedDocumentClaim(
            "What I’ve queued now\nTwo memos.",
            [],
            new Set(),
        ),
        true,
    );
    assert.equal(
        hasUnverifiedDocumentClaim(
            "I've scheduled two documents.",
            [],
            new Set(),
        ),
        true,
    );
    assert.equal(
        hasUnverifiedDocumentClaim(
            "I have not queued any documents.",
            [],
            new Set(),
        ),
        false,
    );
    assert.equal(
        hasUnverifiedDocumentClaim("No documents were queued.", [], new Set()),
        false,
    );
    assert.equal(
        hasUnverifiedDocumentClaim("", [fakeId], new Set([fakeId])),
        false,
    );
    assert.equal(
        hasUnverifiedDocumentClaim("", [fakeId], new Set(["different-job"])),
        true,
    );
    assert.equal(
        normalizeDocumentActionProse(
            'Visible. [document_job_started action] {"job_id":',
        ),
        "Visible. ",
    );
});

test("historical packet events become reference metadata, never executable action prose", () => {
    const message = assistantMessageForModel(
        {
            id: "old-message",
            chat_id: "chat-1",
            role: "assistant",
            created_at: "2026-09-12",
            content: [
                {
                    type: "content",
                    text: `I've queued two documents. ${marker}`,
                },
                {
                    type: "document_job_started",
                    job_id: "real-job",
                    total_documents: 8,
                },
            ],
        },
        new Map(),
    )!.content as string;
    assert.doesNotMatch(message, /\[document_job_started action\]/);
    assert.doesNotMatch(message, new RegExp(fakeId));
    assert.match(message, /Historical document packet reference/);
    assert.match(message, /not authorization/);
});

test("only direct current status/continuation requests restrict new packets", () => {
    assert.equal(
        isDocumentProgressRequest(
            "What are you still building, and are you done? Please continue if not.",
        ),
        true,
    );
    assert.equal(isDocumentProgressRequest("Continue"), true);
    assert.equal(isDocumentProgressRequest("Continue the draft."), true);
    assert.equal(isDocumentProgressRequest("Please finish this."), true);
    assert.equal(isDocumentProgressRequest("What is the packet status?"), true);
    assert.equal(
        isDocumentProgressRequest("Continue, and add a new compensation memo."),
        false,
    );
    assert.equal(
        isDocumentProgressRequest("Draft bylaws for my nonprofit."),
        false,
    );
});
