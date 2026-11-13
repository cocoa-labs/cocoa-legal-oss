import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assistantResponseIntegrity } from "./assistantResponseIntegrity";

const visible = "First café\nSecond block";
const integrity = assistantResponseIntegrity([
    { type: "reasoning", text: "hidden" },
    { type: "content", text: "First café" },
    { type: "doc_read", filename: "source.docx" },
    { type: "content", text: "\nSecond block" },
]);

assert.equal(
    integrity.visibleTextUtf8Bytes,
    Buffer.byteLength(visible, "utf8"),
);
assert.equal(
    integrity.visibleTextSha256,
    crypto.createHash("sha256").update(visible, "utf8").digest("hex"),
);

console.log("assistantResponseIntegrity tests passed");
