import assert from "node:assert/strict";
import {
    appendContinuation,
    continueSectionInChunks,
    countWords,
    DocumentSectionChunkLimitError,
    readDraftCheckpoint,
    requestedDocumentWordTarget,
    serializeDraftCheckpoint,
    targetWordsForSection,
} from "./chunkedDrafting";

async function main() {
    const outline = {
        sections: [
            { heading: "Background" },
            { heading: "Analysis" },
            { heading: "Conclusion" },
        ],
    };
    const background = {
        heading: "Background",
        level: 1,
        content:
            "This completed background section contains enough saved text.",
        pageBreak: false,
    };
    assert.deepEqual(readDraftCheckpoint([background], outline).sections, [
        background,
    ]);

    const saved = serializeDraftCheckpoint([background], {
        index: 1,
        heading: "Analysis",
        level: 1,
        content: "The analysis is saved through this sentence.",
        pageBreak: true,
        chunk_count: 2,
    });
    assert.equal(readDraftCheckpoint(saved, outline).active_section?.index, 1);
    assert.equal(
        readDraftCheckpoint(saved, outline).active_section?.chunk_count,
        2,
    );
    assert.equal(
        readDraftCheckpoint(saved, {
            sections: [{ heading: "Different Structure" }],
        }).sections.length,
        0,
        "stale draft prefixes must not be assembled against a new outline",
    );

    assert.equal(
        requestedDocumentWordTarget(
            "Prepare an approximately 100,000 word brief.",
        ),
        100_000,
    );
    assert.equal(
        requestedDocumentWordTarget(
            "Please provide a 100,000-word legal proceeding brief.",
        ),
        100_000,
    );
    assert.equal(
        requestedDocumentWordTarget("Produce a 250-page legal memorandum."),
        112_500,
    );
    assert.equal(
        requestedDocumentWordTarget("Discuss the citation on page 250."),
        null,
    );
    assert.equal(targetWordsForSection(100_000, 20), 5_000);

    assert.equal(
        appendContinuation(
            "Alpha ends with a deliberately repeated boundary phrase.",
            "a deliberately repeated boundary phrase. Beta continues.",
        ),
        "Alpha ends with a deliberately repeated boundary phrase. Beta continues.",
    );

    const checkpoints: { content: string; chunks: number }[] = [];
    let calls = 0;
    const continued = await continueSectionInChunks({
        isCancelled: async () => false,
        runChunk: async ({ onDelta }) => {
            calls += 1;
            const text =
                calls === 1
                    ? "First bounded chunk with substantive legal analysis that remains incomplete."
                    : "Second bounded chunk completes the section with a clear recommendation.";
            onDelta(text);
            return {
                text,
                finishReason: calls === 1 ? "max_output" : "completed",
            };
        },
        onCheckpoint: async (content, chunks) => {
            checkpoints.push({ content, chunks });
        },
    });
    assert.equal(calls, 2);
    assert.equal(checkpoints.length, 2);
    assert.equal(continued.chunkCount, 2);
    assert.match(continued.content, /First bounded chunk/);
    assert.match(continued.content, /Second bounded chunk/);

    let targetCalls = 0;
    const targetDraft = await continueSectionInChunks({
        targetWords: 40,
        isCancelled: async () => false,
        runChunk: async () => {
            targetCalls += 1;
            const text = Array.from(
                { length: targetCalls === 1 ? 15 : 25 },
                (_, index) => `word${targetCalls}_${index}`,
            ).join(" ");
            return { text, finishReason: "completed" };
        },
        onCheckpoint: async () => {},
    });
    assert.equal(targetCalls, 2, "an explicit size target spans model turns");
    assert.ok(countWords(targetDraft.content) >= 36);

    let partialSaved = "";
    await assert.rejects(
        continueSectionInChunks({
            isCancelled: async () => false,
            runChunk: async ({ onDelta }) => {
                onDelta(
                    "A streamed partial paragraph survives a dropped connection.",
                );
                throw new Error("permanent connection failure");
            },
            onCheckpoint: async (content) => {
                partialSaved = content;
            },
        }),
        /permanent connection failure/,
    );
    assert.match(partialSaved, /survives a dropped connection/);

    let guardedCheckpoints = 0;
    await assert.rejects(
        continueSectionInChunks({
            maxChunks: 4,
            isCancelled: async () => false,
            runChunk: async () => ({
                text: "Another complete-sized but still truncated legal drafting chunk.",
                finishReason: "max_output",
            }),
            onCheckpoint: async () => {
                guardedCheckpoints += 1;
            },
        }),
        (error: unknown) =>
            error instanceof DocumentSectionChunkLimitError && error.retryable,
    );
    assert.equal(guardedCheckpoints, 4);

    console.log("documentGeneration/chunkedDrafting.test.ts: all passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
