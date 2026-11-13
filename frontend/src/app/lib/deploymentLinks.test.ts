import assert from "node:assert/strict";

import { privacyUrl, siteUrl, sourceCodeUrl, termsUrl } from "./deploymentLinks";

const KEYS = [
    "NEXT_PUBLIC_TERMS_URL",
    "NEXT_PUBLIC_PRIVACY_URL",
    "NEXT_PUBLIC_SOURCE_CODE_URL",
    "NEXT_PUBLIC_SITE_URL",
] as const;
type Key = (typeof KEYS)[number];

function withEnv(values: Partial<Record<Key, string>>, run: () => void) {
    const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
    try {
        for (const key of KEYS) {
            if (values[key] === undefined) delete process.env[key];
            else process.env[key] = values[key];
        }
        run();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

withEnv({}, () => {
    assert.equal(termsUrl(), null, "no terms link unless the deployer sets one");
    assert.equal(privacyUrl(), null, "no privacy link unless the deployer sets one");
    assert.equal(sourceCodeUrl(), "https://github.com/cocoa-labs/cocoa-legal-oss");
    assert.equal(siteUrl(), "http://localhost:3003");
});

withEnv({ NEXT_PUBLIC_TERMS_URL: "   ", NEXT_PUBLIC_PRIVACY_URL: "" }, () => {
    assert.equal(termsUrl(), null, "whitespace counts as unset");
    assert.equal(privacyUrl(), null, "empty counts as unset");
});

withEnv(
    {
        NEXT_PUBLIC_TERMS_URL: " https://legal.example.com/terms ",
        NEXT_PUBLIC_PRIVACY_URL: "https://legal.example.com/privacy",
        NEXT_PUBLIC_SOURCE_CODE_URL: "https://git.example.com/fork",
        NEXT_PUBLIC_SITE_URL: "https://app.example.com",
    },
    () => {
        assert.equal(termsUrl(), "https://legal.example.com/terms");
        assert.equal(privacyUrl(), "https://legal.example.com/privacy");
        assert.equal(sourceCodeUrl(), "https://git.example.com/fork");
        assert.equal(siteUrl(), "https://app.example.com");
    },
);

console.log("deploymentLinks.test.ts: all passed");
