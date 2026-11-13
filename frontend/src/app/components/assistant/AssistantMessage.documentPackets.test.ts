import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantEvent } from "../shared/types";
import { documentPacketJobsByMessage } from "../authoring/documentPacketState";

const require = createRequire(`${process.cwd()}/package.json`);
require.extensions[".css"] = () => {};
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "isolated-packet-test";
process.env.NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:9";

test("saved packet cards survive collapsed activity, streaming completion, reload, and deduplication in both chat surfaces", async () => {
    const { AssistantMessage } = await import("./AssistantMessage");
    const events: AssistantEvent[] = [
        {
            type: "document_job_started",
            job_id: "real-job",
            total_documents: 8,
        },
        { type: "document_job_status", job_id: "real-job", total_documents: 8 },
        { type: "reasoning", text: "Checking the saved packet." },
        { type: "content", text: "The packet is still running." },
    ];
    for (const surface of ["chat", "matter"] as const)
        for (const isStreaming of [true, false]) {
            const render = (saved: AssistantEvent[]) =>
                renderToStaticMarkup(
                    createElement(AssistantMessage, {
                        content: "The packet is still running.",
                        events: saved,
                        isStreaming,
                        surface,
                    }),
                );
            const html = render(events);
            assert.equal((html.match(/Document packet/g) ?? []).length, 1);
            assert.match(html, /0 of 8 ready/);
            if (!isStreaming) assert.match(html, /Completed in/);
            assert.equal(
                render(JSON.parse(JSON.stringify(events))),
                html,
                "reload retains cards from saved server events",
            );
        }
    const messages = [
        { events },
        {
            events: [
                {
                    type: "document_job_status",
                    job_id: "real-job",
                    total_documents: 8,
                } as AssistantEvent,
            ],
        },
    ];
    const owners = documentPacketJobsByMessage(messages);
    const cards = messages
        .map((message, index) =>
            renderToStaticMarkup(
                createElement(AssistantMessage, {
                    content: "Saved status",
                    events: message.events,
                    documentPacketJobIds: owners[index],
                }),
            ),
        )
        .join("");
    assert.equal((cards.match(/Document packet/g) ?? []).length, 1);
});

test("historical fabricated marker produces a warning and no artifact card", async () => {
    const { AssistantMessage } = await import("./AssistantMessage");
    const content =
        'Queued two memos. [document_job_started action] {"job_id":"fictional-job","total_documents":2}';
    for (const events of [
        undefined,
        [{ type: "content", text: content } as AssistantEvent],
    ]) {
        const html = renderToStaticMarkup(
            createElement(AssistantMessage, { content, events }),
        );
        assert.doesNotMatch(
            html,
            /fictional-job|\[document_job_started action\]|Document packet/,
        );
        assert.match(html, /unverified scheduling claim/);
    }
});
