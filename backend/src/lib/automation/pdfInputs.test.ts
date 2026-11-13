// backend/src/lib/automation/pdfInputs.test.ts
//
// Rehearsal regression: pdfjs (via extractDocumentText) TRANSFERS the raw
// buffer to its worker, detaching the underlying ArrayBuffer. The base64
// encoding for the model's native-PDF input must therefore happen BEFORE
// text extraction — encoding after threw "Cannot perform Construct on a
// detached ArrayBuffer" and stranded every PDF-carrying run at `queued`.
// The fake extractor here detaches its input exactly like pdfjs does, and
// the test pins that the document payload still carries the original bytes.
import assert from "node:assert/strict";
import { loadRunDocuments } from "./extract/pdfInputs";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`  ok — ${name}`);
        })
        .catch((err) => {
            console.error(`  FAIL — ${name}`);
            throw err;
        });
}

function bytesOf(content: string): ArrayBuffer {
    const raw = new TextEncoder().encode(content);
    const ab = new ArrayBuffer(raw.byteLength);
    new Uint8Array(ab).set(raw);
    return ab;
}

async function main(): Promise<void> {
    await test(
        "base64 payload survives a pdfjs-style buffer detach during text extraction",
        async () => {
            const content = "%PDF-1.4 synthetic fixture bytes";
            const bytes = bytesOf(content);
            const expectedBase64 = Buffer.from(content).toString("base64");

            const out = await loadRunDocuments(
                undefined as unknown as Parameters<typeof loadRunDocuments>[0],
                {
                    attachments: [
                        {
                            document_id: "doc-1",
                            version_id: "ver-1",
                            filename: "dec-page.pdf",
                            content_type: "application/pdf",
                            size: bytes.byteLength,
                        },
                    ],
                },
                {
                    loadActiveVersionFn: async () =>
                        ({ storage_path: "path/dec-page.pdf" }) as never,
                    downloadFileFn: async () => bytes,
                    extractTextFn: async ({ rawBuf }) => {
                        // Detach exactly like pdfjs's worker transfer does.
                        const ab = rawBuf as ArrayBuffer;
                        structuredClone(ab, { transfer: [ab] });
                        assert.equal(
                            ab.byteLength,
                            0,
                            "precondition: the extractor detached its input",
                        );
                        return "[Page 1]\nDECLARATIONS PAGE";
                    },
                },
            );

            assert.equal(out.unprocessed.length, 0);
            assert.equal(out.documents.length, 1);
            assert.equal(out.documents[0].data, expectedBase64);
            assert.equal(out.documents[0].filename, "dec-page.pdf");
            assert.deepEqual(out.pageTexts.get("doc-1"), [
                "DECLARATIONS PAGE",
            ]);
        },
    );

    console.log("automation/pdfInputs.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
