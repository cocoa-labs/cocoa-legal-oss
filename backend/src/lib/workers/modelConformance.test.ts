import assert from "node:assert/strict";
import { conformancePassed } from "./modelConformance";

assert.equal(
    conformancePassed({
        streaming: true,
        tools_then_final_prose: true,
        citations: true,
        structured_output: true,
        declared_modalities: true,
    }),
    true,
);
assert.equal(
    conformancePassed({
        streaming: true,
        tools_then_final_prose: false,
        citations: true,
        structured_output: true,
        declared_modalities: true,
    }),
    false,
);

console.log("workers/modelConformance.test.ts: all passed");
