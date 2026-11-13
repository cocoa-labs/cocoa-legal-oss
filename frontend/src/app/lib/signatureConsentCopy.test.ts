import assert from "node:assert/strict";

import { signatureConsentCopy, signerPageNotice } from "./signatureConsentCopy";

const COMPLIANCE_CLAIM = /\bESIGN\b|\bUETA\b|legally binding|compliant/i;

for (const nonbinding of [true, false]) {
    const copy = signatureConsentCopy(nonbinding);
    for (const text of [copy.checkbox, copy.footnote]) {
        assert.ok(text.trim().length > 0);
        assert.doesNotMatch(text, COMPLIANCE_CLAIM, "consent copy never asserts legal validity");
    }
}

const nonbinding = signatureConsentCopy(true);
assert.match(nonbinding.checkbox, /nonbinding/);
assert.match(nonbinding.footnote, /nonbinding/);

const neutral = signatureConsentCopy(false);
assert.doesNotMatch(`${neutral.checkbox} ${neutral.footnote}`, /nonbinding/);

// The public signer page's banner and footer follow the same flag as the
// consent copy. Before the session loads (null) the page claims nothing.
const betaNotice = signerPageNotice(true);
assert.match(betaNotice.banner ?? "", /not for legal execution/i);
assert.match(betaNotice.footer.join(" "), /controlled beta/i);
for (const flag of [false, null] as const) {
    const notice = signerPageNotice(flag);
    assert.equal(notice.banner, null, "no beta banner outside beta mode");
    assert.ok(notice.footer.join(" ").trim().length > 0);
    assert.doesNotMatch(notice.footer.join(" "), /beta|nonbinding|not for legal execution/i);
}
for (const flag of [true, false, null] as const) {
    const notice = signerPageNotice(flag);
    assert.doesNotMatch(`${notice.banner ?? ""} ${notice.footer.join(" ")}`, COMPLIANCE_CLAIM);
}

console.log("signatureConsentCopy.test.ts: all passed");
