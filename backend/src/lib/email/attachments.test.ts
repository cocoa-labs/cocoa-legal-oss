import assert from "node:assert/strict";
import test from "node:test";

import {
    canonicalAttachmentFilename,
    canonicalizeStoredAttachmentRefs,
    EmailAttachmentError,
    resolveOutboundAttachmentCandidates,
    sniffRasterImageMime,
} from "./attachments";

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
    return {
        from(table: string) {
            const filters = new Map<string, unknown>();
            const query = {
                select() {
                    return query;
                },
                eq(column: string, value: unknown) {
                    filters.set(column, value);
                    return query;
                },
                maybeSingle: async () => ({
                    data:
                        (tables[table] ?? []).find((row) =>
                            [...filters].every(
                                ([column, value]) => row[column] === value,
                            ),
                        ) ?? null,
                    error: null,
                }),
                single: async () => ({
                    data:
                        (tables[table] ?? []).find((row) =>
                            [...filters].every(
                                ([column, value]) => row[column] === value,
                            ),
                        ) ?? null,
                    error: null,
                }),
            };
            return query;
        },
    };
}

const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

test("raster signatures and filenames are canonicalized", () => {
    assert.equal(sniffRasterImageMime(PNG), "image/png");
    assert.equal(
        sniffRasterImageMime(Buffer.from([0xff, 0xd8, 0xff])),
        "image/jpeg",
    );
    assert.equal(
        sniffRasterImageMime(Buffer.from("GIF89a", "ascii")),
        "image/gif",
    );
    assert.equal(
        sniffRasterImageMime(
            Buffer.concat([
                Buffer.from("RIFF", "ascii"),
                Buffer.alloc(4),
                Buffer.from("WEBP", "ascii"),
            ]),
        ),
        "image/webp",
    );
    assert.equal(
        canonicalAttachmentFilename("uuid-without-extension", "image/png"),
        "uuid-without-extension.png",
    );
    assert.equal(
        canonicalAttachmentFilename("wrong.jpg", "image/png"),
        "wrong.png",
    );
});

test("generated image UUID resolves to canonical document metadata and pinned version", async () => {
    const db = fakeDb({
        documents: [
            {
                id: "doc-image",
                user_id: "user-1",
                project_id: null,
                matter_id: null,
                lifecycle_status: "active",
                status: "ready",
                filename: "Example infographic.png",
                file_type: "png",
                size_bytes: 1_900_000,
                current_version_id: "version-1",
            },
        ],
        document_versions: [
            {
                id: "version-1",
                document_id: "doc-image",
                storage_path: "documents/doc-image.png",
                pdf_storage_path: null,
                version_number: 1,
                display_name: "Example infographic.png",
                source: "image_generation",
                layout_qa_status: "source",
                created_at: "2026-08-25T00:00:00Z",
            },
        ],
    });
    const [ref] = await resolveOutboundAttachmentCandidates({
        db: db as never,
        userId: "user-1",
        candidates: [{ sourceKind: "document", sourceId: "doc-image" }],
    });
    assert.equal(ref.filename, "Example infographic.png");
    assert.equal(ref.content_type, "image/png");
    assert.equal(ref.size, 1_900_000);
    assert.equal(ref.version_id, "version-1");
    assert.equal(ref.inline, false);
    assert.equal(ref.content_id, null);

    const [repaired] = await canonicalizeStoredAttachmentRefs({
        db: db as never,
        userId: "user-1",
        refs: [{ document_id: "doc-image", filename: "doc-image" }],
    });
    assert.equal(repaired.filename, "Example infographic.png");
    assert.equal(repaired.content_type, "image/png");
});

test("stored attachment canonicalization preserves positional duplicates", async () => {
    const db = fakeDb({
        documents: [
            {
                id: "doc-image",
                user_id: "user-1",
                project_id: null,
                matter_id: null,
                lifecycle_status: "active",
                status: "ready",
                filename: "preview.png",
                file_type: "png",
                current_version_id: "version-1",
            },
        ],
        document_versions: [
            {
                id: "version-1",
                document_id: "doc-image",
                storage_path: "documents/preview.png",
                pdf_storage_path: null,
                version_number: 1,
                display_name: "preview.png",
                source: "image_generation",
                layout_qa_status: "source",
            },
        ],
    });
    const refs = await canonicalizeStoredAttachmentRefs({
        db: db as never,
        userId: "user-1",
        refs: [
            { document_id: "doc-image", filename: "doc-image" },
            { document_id: "doc-image", filename: "doc-image" },
        ],
    });
    assert.equal(refs.length, 2);
    assert.deepEqual(
        refs.map((ref) => ref.filename),
        ["preview.png", "preview.png"],
    );
});

test("conversation-bound chat image resolves with trusted MIME and filename", async () => {
    const db = fakeDb({
        chat_attachments: [
            {
                id: "chat-image",
                user_id: "user-1",
                project_id: null,
                kind: "image",
                filename: "mobile-preview",
                mime_type: "image/gif",
                size_bytes: 2048,
                storage_path: "chat/chat-image.gif",
            },
        ],
    });
    const [ref] = await resolveOutboundAttachmentCandidates({
        db: db as never,
        userId: "user-1",
        candidates: [
            { sourceKind: "chat_attachment", sourceId: "chat-image" },
        ],
        allowedChatAttachmentIds: new Set(["chat-image"]),
    });
    assert.equal(ref.source_kind, "chat_attachment");
    assert.equal(ref.chat_attachment_id, "chat-image");
    assert.equal(ref.filename, "mobile-preview.gif");
    assert.equal(ref.content_type, "image/gif");
    assert.equal(ref.size, 2048);
});

test("forged chat image and missing document fail with explicit contracts", async () => {
    const db = fakeDb({ chat_attachments: [], documents: [] });
    await assert.rejects(
        resolveOutboundAttachmentCandidates({
            db: db as never,
            userId: "user-1",
            candidates: [
                { sourceKind: "chat_attachment", sourceId: "forged" },
            ],
            allowedChatAttachmentIds: new Set(),
        }),
        (error: unknown) =>
            error instanceof EmailAttachmentError &&
            error.code === "EMAIL_ATTACHMENT_FORBIDDEN",
    );
    await assert.rejects(
        resolveOutboundAttachmentCandidates({
            db: db as never,
            userId: "user-1",
            candidates: [{ sourceKind: "document", sourceId: "missing" }],
        }),
        (error: unknown) =>
            error instanceof EmailAttachmentError &&
            error.code === "EMAIL_ATTACHMENT_UNAVAILABLE",
    );
});
