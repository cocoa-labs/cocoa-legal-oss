// backend/scripts/generateSigningCert.ts
//
// Mint the firm's PERSISTENT e-signature certificate and install it into
// backend/.env. One run establishes the signing identity every executed PDF
// will carry until the certificate is deliberately rotated or replaced by a
// purchased CA (AATL) certificate.
//
//   npx tsx scripts/generateSigningCert.ts
//   npx tsx scripts/generateSigningCert.ts --force            # rotate (new identity!)
//   npx tsx scripts/generateSigningCert.ts --key-bits=4096 --validity-years=5 \
//       --cn="Coco Legal Document Signing" --org="Coco Legal" --country=US
//
// Safety properties:
//   - Refuses to overwrite an existing SIGNING_CERT_* in .env unless --force:
//     rotation CHANGES the signing identity on every future envelope, so it
//     must be deliberate, never a side effect of re-running a setup script.
//   - Secrets are written only to backend/.env (gitignored); stdout gets the
//     NON-secret identity summary (CN / serial / validity / fingerprint).
//   - The key is always packaged in an encrypted (aes256) PKCS#12 —
//     @signpdf's P12Signer cannot open unencrypted key bags.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mintSigningIdentity } from "../src/lib/signatures/certGen";

const BACKEND_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(BACKEND_DIR, ".env");

function arg(name: string): string | undefined {
    return process.argv
        .find((a) => a.startsWith(`--${name}=`))
        ?.split("=")
        .slice(1)
        .join("=");
}

function main() {
    const force = process.argv.includes("--force");
    const keyBits = Number(arg("key-bits") ?? 4096);
    const validityYears = Number(arg("validity-years") ?? 5);
    const commonName = arg("cn") ?? "Coco Legal Document Signing";
    const organization = arg("org") ?? "Coco Legal";
    const country = arg("country") ?? "US";

    if (!existsSync(ENV_PATH)) {
        console.error(`No ${ENV_PATH} found — run from a configured checkout.`);
        process.exit(1);
    }
    const envText = readFileSync(ENV_PATH, "utf8");
    const present = ["SIGNING_CERT_P12_BASE64", "SIGNING_CERT_PASSPHRASE"].filter(
        (k) => new RegExp(`^${k}=`, "m").test(envText),
    );
    if (present.length > 0 && !force) {
        console.error(
            `${present.join(" and ")} already set in backend/.env.\n\n` +
                "Re-running would MINT A NEW IDENTITY: every future envelope would be\n" +
                "signed by a different certificate than past ones (completion\n" +
                "certificates and signing_cert_* attribution make the switch visible).\n" +
                "If rotation is deliberate, re-run with --force.",
        );
        process.exit(1);
    }

    console.log(
        `Minting RSA-${keyBits} certificate "${commonName}" (${validityYears}y validity)...`,
    );
    const passphrase = randomBytes(32).toString("base64url");
    const minted = mintSigningIdentity({
        commonName,
        organization,
        organizationalUnit: "E-Signature Service",
        country,
        keyBits,
        validityYears,
        passphrase,
        p12Algorithm: "aes256",
    });

    const stamp = new Date().toISOString();
    const block =
        `\n# E-signature signing identity — generated ${stamp} by scripts/generateSigningCert.ts\n` +
        `# Serial ${minted.serialHex} · expires ${minted.notAfter.toISOString()} · DO NOT rotate casually (see DEPLOY.md)\n` +
        `SIGNING_CERT_P12_BASE64="${minted.p12.toString("base64")}"\n` +
        `SIGNING_CERT_PASSPHRASE="${passphrase}"\n`;

    let nextText = envText;
    if (force && present.length > 0) {
        nextText = nextText
            .split("\n")
            .filter(
                (line) =>
                    !/^SIGNING_CERT_P12_BASE64=/.test(line) &&
                    !/^SIGNING_CERT_PASSPHRASE=/.test(line),
            )
            .join("\n");
    }
    writeFileSync(ENV_PATH, nextText.replace(/\n*$/, "\n") + block, {
        mode: 0o600,
    });

    console.log(`
Installed into backend/.env (values not printed).

  Subject      CN=${commonName}, O=${organization}, C=${country}
  Serial       ${minted.serialHex}
  Valid        ${minted.notBefore.toISOString()} -> ${minted.notAfter.toISOString()}
  Key          RSA-${keyBits}, PKCS#12 aes256
  SHA-256 fp   ${minted.sha256Fingerprint}

Next steps:
  1. BACK UP both values from backend/.env to the firm password manager NOW —
     Railway must never be the only holder of the signing identity.
  2. Restart the local backend; the boot log must show
     [signing] identity: mode=org-self-signed serial=${minted.serialHex}
  3. npx tsx scripts/buildProdEnv.ts --frontend-url=<vercel origin>
  4. Paste backend/.env.production.local into Railway (raw editor) + redeploy.
  5. Restart the Railway service once more and confirm the serial is UNCHANGED.
`);
}

main();
