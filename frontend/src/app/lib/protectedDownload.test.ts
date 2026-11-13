import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    downloadProtectedFile,
    ProtectedDownloadError,
} from "./protectedDownload";

const docxType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function run() {
    {
        const requests: Array<{
            url: string;
            authorization: string | null;
        }> = [];
        let saved: { size: number; filename: string } | null = null;

        await downloadProtectedFile({
            apiBase: "https://api.example.test",
            downloadUrl: "/download/signed-token",
            filename: "memorandum.docx",
            getAccessToken: async () => "access-token",
            fetchImpl: async (input, init) => {
                const headers = new Headers(init?.headers);
                requests.push({
                    url: String(input),
                    authorization: headers.get("Authorization"),
                });
                return new Response(new Uint8Array([80, 75, 3, 4]), {
                    status: 200,
                    headers: { "content-type": docxType },
                });
            },
            saveBlob: async (blob, filename) => {
                saved = { size: blob.size, filename };
            },
        });

        assert.deepEqual(requests, [
            {
                url: "https://api.example.test/download/signed-token",
                authorization: "Bearer access-token",
            },
        ]);
        assert.deepEqual(saved, { size: 4, filename: "memorandum.docx" });
    }

    {
        const authorizations: Array<string | null> = [];
        await downloadProtectedFile({
            apiBase: "https://api.example.test",
            downloadUrl: "/download/signed-token",
            filename: "checklist.docx",
            getAccessToken: async () => "expired-token",
            refreshAccessToken: async () => "refreshed-token",
            fetchImpl: async (_input, init) => {
                const authorization = new Headers(init?.headers).get(
                    "Authorization",
                );
                authorizations.push(authorization);
                if (authorizations.length === 1) {
                    return new Response("unauthorized", { status: 401 });
                }
                return new Response(new Uint8Array([80, 75]), {
                    status: 200,
                    headers: { "content-type": docxType },
                });
            },
            saveBlob: () => undefined,
        });
        assert.deepEqual(authorizations, [
            "Bearer expired-token",
            "Bearer refreshed-token",
        ]);
    }

    await assert.rejects(
        () =>
            downloadProtectedFile({
                apiBase: "https://api.example.test",
                downloadUrl: "https://evil.example/download/token",
                filename: "document.docx",
                getAccessToken: async () => "secret-token",
                saveBlob: () => undefined,
            }),
        (error: unknown) =>
            error instanceof ProtectedDownloadError &&
            error.message === "The download link is invalid.",
    );

    await assert.rejects(
        () =>
            downloadProtectedFile({
                apiBase: "https://api.example.test",
                downloadUrl: "/download/token",
                filename: "document.docx",
                getAccessToken: async () => null,
                saveBlob: () => undefined,
            }),
        (error: unknown) =>
            error instanceof ProtectedDownloadError && error.status === 401,
    );

    const packetCardSource = readFileSync(
        "src/app/components/authoring/DocumentPacketCard.tsx",
        "utf8",
    );
    assert.match(packetCardSource, /downloadProtectedFile/);
    assert.doesNotMatch(packetCardSource, /<a\s[^>]*href=/);

    console.log("protectedDownload.test.ts: all passed");
}

void run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
