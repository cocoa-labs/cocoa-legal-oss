import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseClamAvResponse, validateUploadContainer } from "./upload";

async function main() {
 assert.deepEqual(parseClamAvResponse("stream: OK\0"), { status: "clean" });
 assert.deepEqual(parseClamAvResponse("stream: Eicar-Signature FOUND\0"), { status: "infected", signature: "Eicar-Signature" });
 assert.equal((await validateUploadContainer(Buffer.from("not a pdf"), "brief.pdf")).ok, false);
 assert.equal((await validateUploadContainer(Buffer.from("%PDF-1.7\n"), "brief.pdf")).ok, true);
 assert.equal((await validateUploadContainer(Buffer.from([0, 1, 2]), "cases.csv")).ok, false);
 assert.equal((await validateUploadContainer(Buffer.from("name,value\nA,1\n"), "cases.csv")).ok, true);

const bomb = new JSZip();
bomb.file("document.xml", "A".repeat(21 * 1024 * 1024));
const compressed = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
const bombResult = await validateUploadContainer(compressed, "fixture.docx");
assert.equal(bombResult.ok, false);
if (!bombResult.ok) assert.match(bombResult.reason, /expansion limits/i);

 console.log("uploadSecurity.test.ts: all passed");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
