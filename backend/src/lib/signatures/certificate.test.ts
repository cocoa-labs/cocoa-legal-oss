// backend/src/lib/signatures/certificate.test.ts
//
// Pins the Certificate of Completion's "Signer identity" disclosure — the one
// legally meaningful surface that says WHICH certificate produced the
// cryptographic signature. Three modes, three wordings, and the concrete
// identity fields (CN / issuer / serial / expiry / fingerprint) must all be
// printed. Prevents the regression where loading a persistent-but-self-signed
// org cert via env silently stopped disclosing that it is self-signed.
import assert from "node:assert/strict";
import { buildCertificateOfCompletion } from "./certificate";
import { extractPdfTextForQa } from "../documentLayoutQa";
import type { SigningIdentityDescription } from "./cert";

function identity(
    mode: SigningIdentityDescription["mode"],
): SigningIdentityDescription {
    return {
        mode,
        subjectCN:
            mode === "ca-issued" ? "Cocoa Legal Signing" : "Cocoa Legal Document Signing",
        issuerCN:
            mode === "ca-issued" ? "Example Trust CA" : "Cocoa Legal Document Signing",
        serialHex: "01deadbeefcafe42",
        notBefore: new Date("2026-01-01T00:00:00.000Z"),
        notAfter: new Date("2031-01-01T00:00:00.000Z"),
        sha256Fingerprint:
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        certificateCount: mode === "ca-issued" ? 3 : 1,
    };
}

async function buildText(
    mode: SigningIdentityDescription["mode"],
): Promise<string> {
    const pdf = await buildCertificateOfCompletion({
        envelopeId: "env-123",
        subject: "Test Agreement",
        documentName: "agreement.pdf",
        originalSha256: "11".repeat(32),
        executedSha256: "22".repeat(32),
        signers: [
            {
                name: "Alice Attorney",
                email: "alice@example.com",
                signedAt: "2026-07-01T12:00:00.000Z",
                ip: "203.0.113.5",
                consentAt: "2026-07-01T11:59:00.000Z",
            },
        ],
        events: [{ type: "completed", created_at: "2026-07-01T12:01:00.000Z" }],
        signingIdentity: identity(mode),
    });
    assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF"));
    return extractPdfTextForQa(pdf);
}

async function testDevEphemeralWording() {
    const text = await buildText("dev-ephemeral");
    assert.match(text, /ephemeral development certificate/i);
    assert.match(text, /not suitable for legally binding/i);
    assert.match(text, /01deadbeefcafe42/i);
}

async function testOrgSelfSignedWording() {
    const text = await buildText("org-self-signed");
    // The honest self-signed disclosure must survive the env-cert swap.
    assert.match(text, /self-signed certificate/i);
    assert.match(text, /rather than a publicly trusted certificate/i);
    assert.doesNotMatch(text, /ephemeral development/i);
    assert.match(text, /Cocoa Legal Document Signing/);
    assert.match(text, /01deadbeefcafe42/i);
    // Fingerprint prefix (chunked rendering may wrap the tail).
    assert.match(text, /aabbccddeeff0011/i);
    // Expiry year visible.
    assert.match(text, /2031/);
}

async function testCaIssuedWording() {
    const text = await buildText("ca-issued");
    assert.match(text, /issued by/i);
    assert.match(text, /Example Trust CA/);
    assert.doesNotMatch(text, /self-signed certificate/i);
    assert.doesNotMatch(text, /ephemeral development/i);
}

async function testSignerTableUnchanged() {
    const text = await buildText("org-self-signed");
    assert.match(text, /Alice Attorney/);
    assert.match(text, /alice@example\.com/);
    assert.match(text, /203\.0\.113\.5/);
    assert.match(text, /Certificate of Completion/i);
}

async function main() {
    await testDevEphemeralWording();
    await testOrgSelfSignedWording();
    await testCaIssuedWording();
    await testSignerTableUnchanged();
    console.log("certificate.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
