// Consent wording for every e-signature surface. It never asserts legal
// validity: the engine has not been legally reviewed, so whether a signature
// binds anyone is for the deploying firm and its counsel to decide.

export type SignatureConsentCopy = { checkbox: string; footnote: string };

export function signatureConsentCopy(nonbinding: boolean): SignatureConsentCopy {
    if (nonbinding) {
        return {
            checkbox:
                "I consent to record this electronic signature as a nonbinding test signature.",
            footnote:
                "By selecting “Sign document”, you agree to a nonbinding test signature. Your name, signature and a timestamp will be recorded.",
        };
    }
    return {
        checkbox: "I agree to sign this document electronically.",
        footnote:
            "By selecting “Sign document”, you agree to sign electronically. Your name, signature and a timestamp will be recorded.",
    };
}

/**
 * Banner and footer for the public signer page, from the same flag as the
 * consent copy. `null` means the signing session has not loaded yet, so the
 * page says nothing either way.
 */
export type SignerPageNotice = { banner: string | null; footer: string[] };

export function signerPageNotice(nonbinding: boolean | null): SignerPageNotice {
    if (nonbinding) {
        return {
            banner: "Beta test — not for legal execution. Use synthetic or redacted documents only.",
            footer: ["Controlled beta e-signature by Coco Legal", "Not for legal execution"],
        };
    }
    return { banner: null, footer: ["Electronic signature by Coco Legal"] };
}
