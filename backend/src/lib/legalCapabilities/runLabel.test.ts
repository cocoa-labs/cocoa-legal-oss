// backend/src/lib/legalCapabilities/runLabel.test.ts
//
// Registry hygiene: every capability the backend registers for production
// must carry an imperative `run_label` for the suggestion chip's primary
// button. This lives in its own file rather than index.test.ts because
// that file calls clearRegistryForTests() in every case, which would empty
// the registry this check is meant to inspect.
import assert from "node:assert/strict";
import "./register";
import { allCapabilities } from "./index";

async function testEveryCapabilityHasRunLabel() {
    const caps = allCapabilities();
    assert.ok(caps.length > 0, "register.ts should populate the registry");
    for (const cap of caps) {
        assert.equal(
            typeof cap.intentSignals.run_label,
            "string",
            `${cap.id}: run_label must be a string`,
        );
        assert.ok(
            cap.intentSignals.run_label.trim().length > 0,
            `${cap.id}: run_label must be non-empty`,
        );
    }
}

async function main() {
    await testEveryCapabilityHasRunLabel();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
