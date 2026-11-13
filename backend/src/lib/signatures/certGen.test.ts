// backend/src/lib/signatures/certGen.test.ts
//
// Parameterized signing-certificate minting. These tests round-trip every
// minted artifact back through forge's own PKCS#12/X.509 parsers, so they lock
// the exact properties the rest of the pipeline depends on: subject fields,
// the documentSigning EKU surviving a re-parse as a dotted OID, aes256 P12
// encryption, passphrase enforcement, and issuer-signed (chained) leaves.
import assert from "node:assert/strict";
import forge from "node-forge";
import { mintSigningIdentity, bundleP12 } from "./certGen";

function parseP12(p12: Buffer, passphrase: string) {
    const asn1 = forge.asn1.fromDer(
        forge.util.createBuffer(p12.toString("binary")),
    );
    return forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
}

function leafCertFrom(p12: Buffer, passphrase: string): forge.pki.Certificate {
    const parsed = parseP12(p12, passphrase);
    const certBags = parsed.getBags({ bagType: forge.pki.oids.certBag })[
        forge.pki.oids.certBag
    ];
    assert.ok(certBags && certBags.length > 0, "P12 contains a cert bag");
    const cert = certBags[0].cert;
    assert.ok(cert, "cert bag holds a certificate");
    return cert;
}

function subjectField(cert: forge.pki.Certificate, shortNameOrName: string) {
    const f =
        cert.subject.getField({ shortName: shortNameOrName }) ??
        cert.subject.getField({ name: shortNameOrName }) ??
        cert.subject.getField(shortNameOrName);
    return f?.value;
}

async function testSubjectAndIssuerRoundTrip() {
    const minted = mintSigningIdentity({
        commonName: "Test Firm Document Signing",
        organization: "Test Firm",
        organizationalUnit: "E-Signature Service",
        country: "US",
        keyBits: 2048,
        validityYears: 3,
        passphrase: "round-trip-pass",
    });
    const cert = leafCertFrom(minted.p12, "round-trip-pass");
    assert.equal(subjectField(cert, "CN"), "Test Firm Document Signing");
    assert.equal(subjectField(cert, "O"), "Test Firm");
    assert.equal(subjectField(cert, "OU"), "E-Signature Service");
    assert.equal(subjectField(cert, "C"), "US");
    // Self-signed: issuer === subject.
    assert.ok(cert.isIssuer(cert), "self-signed cert is its own issuer");
    // Returned metadata matches the parsed cert.
    assert.equal(minted.subjectCN, "Test Firm Document Signing");
    assert.equal(
        cert.serialNumber.toLowerCase(),
        minted.serialHex.toLowerCase(),
    );
    assert.match(minted.sha256Fingerprint, /^[0-9a-f]{64}$/);
}

async function testKeyBitsAndValidityHonored() {
    const minted = mintSigningIdentity({
        commonName: "Bits Check",
        organization: "Test Firm",
        keyBits: 2048,
        validityYears: 5,
        passphrase: "bits-pass",
    });
    const cert = leafCertFrom(minted.p12, "bits-pass");
    const pub = cert.publicKey as forge.pki.rsa.PublicKey;
    assert.equal(pub.n.bitLength(), 2048, "modulus length honors keyBits");
    const years =
        (cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()) /
        (365.25 * 24 * 3600 * 1000);
    assert.ok(years > 4.9 && years < 5.2, `validity ~5y (got ${years})`);
}

async function testDocumentSigningEkuSurvivesReparse() {
    const minted = mintSigningIdentity({
        commonName: "EKU Check",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "eku-pass",
    });
    const cert = leafCertFrom(minted.p12, "eku-pass");
    const eku = cert.getExtension("extKeyUsage") as
        | (Record<string, unknown> & { name: string })
        | null;
    assert.ok(eku, "extKeyUsage extension present");
    assert.equal(eku.emailProtection, true, "emailProtection EKU");
    assert.equal(eku.clientAuth, true, "clientAuth EKU");
    assert.equal(
        eku["1.3.6.1.5.5.7.3.36"],
        true,
        "id-kp-documentSigning OID survives round-trip",
    );
    const ku = cert.getExtension("keyUsage") as
        | (Record<string, unknown> & { name: string })
        | null;
    assert.ok(ku, "keyUsage extension present");
    assert.equal(ku.digitalSignature, true);
    assert.equal(ku.nonRepudiation, true);
}

async function testAes256EncryptionAndWrongPassphrase() {
    const minted = mintSigningIdentity({
        commonName: "AES Check",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "right-pass",
    });
    // aes256-CBC OID 2.16.840.1.101.3.4.1.42 appears in the DER when the key
    // bag is shrouded with AES-256 (default p12Algorithm).
    const aes256Oid = Buffer.from("060960864801650304012a", "hex");
    assert.ok(
        minted.p12.includes(aes256Oid),
        "P12 DER carries the aes256-CBC OID",
    );
    // Correct passphrase opens it and yields a private key bag.
    const parsed = parseP12(minted.p12, "right-pass");
    const keyBags = parsed.getBags({
        bagType: forge.pki.oids.pkcs8ShroudedKeyBag,
    })[forge.pki.oids.pkcs8ShroudedKeyBag];
    assert.ok(keyBags && keyBags.length === 1 && keyBags[0].key, "key bag opens");
    // Wrong passphrase must throw, not decode garbage.
    assert.throws(() => parseP12(minted.p12, "wrong-pass"));
}

async function testSerialsDifferAcrossMints() {
    const a = mintSigningIdentity({
        commonName: "Serial A",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "p",
    });
    const b = mintSigningIdentity({
        commonName: "Serial B",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "p",
    });
    assert.notEqual(a.serialHex, b.serialHex, "serials are random per mint");
    assert.notEqual(
        a.sha256Fingerprint,
        b.sha256Fingerprint,
        "fingerprints differ",
    );
}

async function testIssuerSignedLeafAndChainBundle() {
    const ca = mintSigningIdentity({
        commonName: "Test Firm Root CA",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "ca-pass",
        isCa: true,
    });
    const leaf = mintSigningIdentity({
        commonName: "Test Firm Leaf",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "leaf-pass",
        issuer: { cert: ca.cert, privateKey: ca.privateKey },
    });
    // The leaf is NOT self-signed and verifies against the CA.
    assert.ok(!leaf.cert.isIssuer(leaf.cert), "leaf is not its own issuer");
    assert.ok(ca.cert.verify(leaf.cert), "CA signature verifies the leaf");
    assert.equal(
        leaf.cert.issuer.getField("CN")?.value,
        "Test Firm Root CA",
        "leaf issuer CN is the CA",
    );

    // bundleP12 packages leaf key + [leaf, ca] chain; both certs round-trip.
    const chained = bundleP12(
        leaf.privateKey,
        [leaf.cert, ca.cert],
        "chain-pass",
    );
    const parsed = parseP12(chained, "chain-pass");
    const certBags = parsed.getBags({ bagType: forge.pki.oids.certBag })[
        forge.pki.oids.certBag
    ];
    assert.equal(certBags?.length, 2, "chained P12 carries both certificates");
}

async function main() {
    await testSubjectAndIssuerRoundTrip();
    await testKeyBitsAndValidityHonored();
    await testDocumentSigningEkuSurvivesReparse();
    await testAes256EncryptionAndWrongPassphrase();
    await testSerialsDifferAcrossMints();
    await testIssuerSignedLeafAndChainBundle();
    console.log("certGen.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
