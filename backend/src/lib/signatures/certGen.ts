// backend/src/lib/signatures/certGen.ts
//
// Parameterized X.509 signing-certificate minting — the single minting path
// shared by the dev-ephemeral fallback (cert.ts), the operator script
// (scripts/generateSigningCert.ts), and the test fixtures.
//
// Key generation uses node:crypto (native, instant even at 4096 bits) and the
// PEM is handed to node-forge for certificate assembly; forge's pure-JS keygen
// takes minutes at 4096 bits and must not be used.
//
// The PKCS#12 bundle always shrouds the private key (pkcs8ShroudedKeyBag):
// @signpdf's P12Signer reads ONLY shrouded key bags, so an unencrypted export
// would produce a bundle the signer cannot open.

import { createHash, generateKeyPairSync } from "node:crypto";
import forge from "node-forge";

/** id-kp-documentSigning (RFC 9336) — Adobe's preferred EKU for signing certs.
 * node-forge has no name for it; a dotted-OID key round-trips as-is. */
const DOCUMENT_SIGNING_EKU_OID = "1.3.6.1.5.5.7.3.36";

export interface SigningCertParams {
    commonName: string;
    organization: string;
    organizationalUnit?: string;
    country?: string;
    /** RSA modulus bits. Default 4096. P12Signer supports RSA only. */
    keyBits?: number;
    /** Certificate validity from notBefore. Default 5 years. */
    validityYears?: number;
    /** Test hook (expired-cert fixtures). Default: now - 24h clock-skew grace. */
    notBefore?: Date;
    passphrase: string;
    /** PKCS#12 key-shrouding cipher. Default aes256. */
    p12Algorithm?: "aes256" | "3des";
    /** When present, the cert is signed by this issuer instead of itself. */
    issuer?: {
        cert: forge.pki.Certificate;
        privateKey: forge.pki.rsa.PrivateKey;
    };
    /** Mint a CA certificate (fixtures): basicConstraints cA + keyCertSign. */
    isCa?: boolean;
}

export interface MintedIdentity {
    /** DER-encoded PKCS#12 holding the private key + this certificate. */
    p12: Buffer;
    passphrase: string;
    /** Parsed forms, exposed so callers can build chained fixtures. */
    cert: forge.pki.Certificate;
    privateKey: forge.pki.rsa.PrivateKey;
    subjectCN: string;
    serialHex: string;
    notBefore: Date;
    notAfter: Date;
    /** Lowercase hex SHA-256 over the certificate DER. */
    sha256Fingerprint: string;
}

/** Lowercase-hex SHA-256 of a certificate's DER encoding. */
export function certSha256Fingerprint(cert: forge.pki.Certificate): string {
    const der = forge.asn1
        .toDer(forge.pki.certificateToAsn1(cert))
        .getBytes();
    return createHash("sha256")
        .update(Buffer.from(der, "binary"))
        .digest("hex");
}

/**
 * Package a private key + certificate chain (leaf first) as an encrypted
 * PKCS#12. Used for the minted identity itself and for chained test fixtures;
 * P12Signer embeds every certificate in the bundle into the CMS signature.
 */
export function bundleP12(
    privateKey: forge.pki.rsa.PrivateKey,
    chain: forge.pki.Certificate[],
    passphrase: string,
    algorithm: "aes256" | "3des" = "aes256",
): Buffer {
    const asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, chain, passphrase, {
        algorithm,
        friendlyName: chain[0]?.subject.getField("CN")?.value,
    });
    return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

export function mintSigningIdentity(params: SigningCertParams): MintedIdentity {
    const keyBits = params.keyBits ?? 4096;
    const validityYears = params.validityYears ?? 5;
    const algorithm = params.p12Algorithm ?? "aes256";

    // Native keygen, then hand the PEM to forge for cert assembly.
    const { privateKey: privatePem } = generateKeyPairSync("rsa", {
        modulusLength: keyBits,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const privateKey = forge.pki.privateKeyFromPem(
        privatePem,
    ) as forge.pki.rsa.PrivateKey;
    const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);

    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKey;
    // Leading "01" keeps the serial a positive DER integer.
    cert.serialNumber =
        "01" + forge.util.bytesToHex(forge.random.getBytesSync(8));

    const notBefore =
        params.notBefore ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const notAfter = new Date(notBefore.getTime());
    notAfter.setFullYear(notAfter.getFullYear() + validityYears);
    cert.validity.notBefore = notBefore;
    cert.validity.notAfter = notAfter;

    const attrs: forge.pki.CertificateField[] = [
        { name: "commonName", value: params.commonName },
        { name: "organizationName", value: params.organization },
    ];
    if (params.organizationalUnit) {
        attrs.push({ shortName: "OU", value: params.organizationalUnit });
    }
    if (params.country) {
        attrs.push({ shortName: "C", value: params.country });
    }
    cert.setSubject(attrs);
    cert.setIssuer(
        params.issuer ? params.issuer.cert.subject.attributes : attrs,
    );

    const extensions: Record<string, unknown>[] = [
        { name: "basicConstraints", cA: params.isCa === true },
        {
            name: "keyUsage",
            digitalSignature: true,
            nonRepudiation: true,
            ...(params.isCa ? { keyCertSign: true, cRLSign: true } : {}),
        },
    ];
    if (!params.isCa) {
        // Named EKUs resolve through forge's OID map; the documentSigning EKU
        // has no forge name, so its dotted OID is emitted (and re-parsed)
        // verbatim.
        extensions.push({
            name: "extKeyUsage",
            emailProtection: true,
            clientAuth: true,
            [DOCUMENT_SIGNING_EKU_OID]: true,
        });
    }
    cert.setExtensions(extensions as forge.pki.CertificateField[]);

    cert.sign(
        params.issuer ? params.issuer.privateKey : privateKey,
        forge.md.sha256.create(),
    );

    return {
        p12: bundleP12(privateKey, [cert], params.passphrase, algorithm),
        passphrase: params.passphrase,
        cert,
        privateKey,
        subjectCN: params.commonName,
        serialHex: cert.serialNumber.toLowerCase(),
        notBefore,
        notAfter,
        sha256Fingerprint: certSha256Fingerprint(cert),
    };
}
