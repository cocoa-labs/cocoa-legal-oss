// backend/src/lib/signatures/cert.test.ts
//
// Signing-identity resolution. Locks the three-mode contract
// (dev-ephemeral / org-self-signed / ca-issued), the fail-fast behavior for a
// set-but-broken SIGNING_CERT_P12_BASE64 (which previously exploded mid-
// envelope-completion inside P12Signer), and the boot check that surfaces the
// active identity + expiry warnings.
//
// Every block saves and restores the env so the suite stays hermetic and the
// dev-fallback assumptions of pdf.test.ts keep holding.
import assert from "node:assert/strict";
import {
    resolveSigningIdentity,
    describeSigningIdentity,
    checkSigningIdentityAtBoot,
    SigningIdentityError,
} from "./cert";
import { mintSigningIdentity, bundleP12 } from "./certGen";

function withEnv<T>(
    vars: Record<string, string | undefined>,
    fn: () => T,
): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
        saved[k] = process.env[k];
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
    }
    try {
        return fn();
    } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

const CLEARED = {
    SIGNING_CERT_P12_BASE64: undefined,
    SIGNING_CERT_PASSPHRASE: undefined,
};

async function testDevEphemeralStableAcrossCalls() {
    withEnv(CLEARED, () => {
        const a = resolveSigningIdentity();
        const b = resolveSigningIdentity();
        assert.equal(a.mode, "dev-ephemeral");
        assert.equal(a.serialHex, b.serialHex, "one identity per process");
        assert.match(a.subjectCN, /dev self-signed/);
        assert.ok(a.p12.length > 0);
        assert.equal(a.certificateCount, 1);
    });
}

async function testEnvOrgSelfSigned() {
    const minted = mintSigningIdentity({
        commonName: "Org Persistent Signing",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "org-pass",
    });
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: minted.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "org-pass",
        },
        () => {
            const id = resolveSigningIdentity();
            assert.equal(id.mode, "org-self-signed");
            assert.equal(id.subjectCN, "Org Persistent Signing");
            assert.equal(id.issuerCN, "Org Persistent Signing");
            assert.equal(id.serialHex, minted.serialHex);
            assert.equal(id.sha256Fingerprint, minted.sha256Fingerprint);
            assert.equal(id.certificateCount, 1);

            const desc = describeSigningIdentity();
            assert.equal(desc.mode, "org-self-signed");
            assert.equal(desc.serialHex, minted.serialHex);
            assert.ok(!("p12" in desc), "describe omits the P12");
            assert.ok(!("passphrase" in desc), "describe omits the passphrase");
        },
    );
}

async function testEnvChainedCaIssued() {
    const ca = mintSigningIdentity({
        commonName: "Fixture Root CA",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "ca",
        isCa: true,
    });
    const leaf = mintSigningIdentity({
        commonName: "Chained Leaf",
        organization: "Test Firm",
        keyBits: 2048,
        passphrase: "leaf",
        issuer: { cert: ca.cert, privateKey: ca.privateKey },
    });
    const chained = bundleP12(leaf.privateKey, [leaf.cert, ca.cert], "chain");
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: chained.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "chain",
        },
        () => {
            const id = resolveSigningIdentity();
            assert.equal(id.mode, "ca-issued");
            assert.equal(id.subjectCN, "Chained Leaf");
            assert.equal(id.issuerCN, "Fixture Root CA");
            assert.equal(id.certificateCount, 2);
        },
    );
}

async function testEnvReResolvesWhenChanged() {
    const a = mintSigningIdentity({
        commonName: "First",
        organization: "T",
        keyBits: 2048,
        passphrase: "p",
    });
    const b = mintSigningIdentity({
        commonName: "Second",
        organization: "T",
        keyBits: 2048,
        passphrase: "p",
    });
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: a.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            assert.equal(resolveSigningIdentity().serialHex, a.serialHex);
        },
    );
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: b.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            assert.equal(
                resolveSigningIdentity().serialHex,
                b.serialHex,
                "cache keys on the env value, not just presence",
            );
        },
    );
}

async function testBadBase64Throws() {
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: "not-valid-base64!!!",
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            assert.throws(
                () => resolveSigningIdentity(),
                (err: unknown) =>
                    err instanceof SigningIdentityError &&
                    /SIGNING_CERT_P12_BASE64/.test(err.message),
            );
        },
    );
}

async function testWrongPassphraseThrows() {
    const minted = mintSigningIdentity({
        commonName: "Pass Check",
        organization: "T",
        keyBits: 2048,
        passphrase: "right",
    });
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: minted.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "wrong",
        },
        () => {
            assert.throws(
                () => resolveSigningIdentity(),
                (err: unknown) =>
                    err instanceof SigningIdentityError &&
                    /passphrase/i.test(err.message),
            );
        },
    );
}

async function testExpiredCertThrows() {
    const minted = mintSigningIdentity({
        commonName: "Expired",
        organization: "T",
        keyBits: 2048,
        passphrase: "p",
        notBefore: new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000),
        validityYears: 1,
    });
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: minted.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            assert.throws(
                () => resolveSigningIdentity(),
                (err: unknown) =>
                    err instanceof SigningIdentityError &&
                    /expired/i.test(err.message),
            );
        },
    );
}

async function testBootCheckMatrix() {
    // Unset env → ok, dev-ephemeral, and no eager minting requirement on the
    // log line (identity is minted on first signature).
    withEnv(CLEARED, () => {
        const res = checkSigningIdentityAtBoot();
        assert.ok(res.ok);
        if (res.ok) {
            assert.match(res.logLine, /dev-ephemeral/);
            assert.deepEqual(res.warnings, []);
        }
    });

    // Valid env cert far from expiry → ok, identity details, no warnings.
    const healthy = mintSigningIdentity({
        commonName: "Healthy Org Cert",
        organization: "T",
        keyBits: 2048,
        validityYears: 5,
        passphrase: "p",
    });
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: healthy.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            const res = checkSigningIdentityAtBoot();
            assert.ok(res.ok);
            if (res.ok) {
                assert.match(res.logLine, /org-self-signed/);
                assert.match(res.logLine, /Healthy Org Cert/);
                assert.ok(res.logLine.includes(healthy.serialHex));
                assert.deepEqual(res.warnings, []);
            }
        },
    );

    // Valid but expiring inside 90 days → ok with an expiry warning.
    const expiring = mintSigningIdentity({
        commonName: "Expiring Org Cert",
        organization: "T",
        keyBits: 2048,
        validityYears: 1,
        // notBefore ~340 days ago → ~25 days of validity left.
        notBefore: new Date(Date.now() - 340 * 24 * 3600 * 1000),
        passphrase: "p",
    });
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: expiring.p12.toString("base64"),
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            const res = checkSigningIdentityAtBoot();
            assert.ok(res.ok);
            if (res.ok) {
                assert.equal(res.warnings.length, 1);
                assert.match(res.warnings[0], /expires/i);
            }
        },
    );

    // Set-but-broken → ok:false with a named error (never silent fallback).
    withEnv(
        {
            SIGNING_CERT_P12_BASE64: "garbage!!!",
            SIGNING_CERT_PASSPHRASE: "p",
        },
        () => {
            const res = checkSigningIdentityAtBoot();
            assert.equal(res.ok, false);
            if (!res.ok) {
                assert.match(res.error, /SIGNING_CERT_P12_BASE64/);
            }
        },
    );
}

async function main() {
    await testDevEphemeralStableAcrossCalls();
    await testEnvOrgSelfSigned();
    await testEnvChainedCaIssued();
    await testEnvReResolvesWhenChanged();
    await testBadBase64Throws();
    await testWrongPassphraseThrows();
    await testExpiredCertThrows();
    await testBootCheckMatrix();
    console.log("cert.test.ts: all passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
