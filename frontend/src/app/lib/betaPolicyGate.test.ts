import assert from "node:assert/strict";

import { projectBetaGate } from "./betaPolicyGate";

// No policy loaded, or beta mode off: no controlled-beta panel and no upload gate.
assert.deepEqual(projectBetaGate(null), { showPanel: false, uploadsBlocked: false });
assert.deepEqual(projectBetaGate({ enabled: false, accepted: false }), {
    showPanel: false,
    uploadsBlocked: false,
});

// Beta mode on: the panel shows and uploads wait for the data policy.
assert.deepEqual(projectBetaGate({ enabled: true, accepted: false }), {
    showPanel: true,
    uploadsBlocked: true,
});
assert.deepEqual(projectBetaGate({ enabled: true, accepted: true }), {
    showPanel: true,
    uploadsBlocked: false,
});

console.log("betaPolicyGate.test.ts: all passed");
