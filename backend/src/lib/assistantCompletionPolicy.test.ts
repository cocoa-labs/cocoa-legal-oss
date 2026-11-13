import assert from "node:assert/strict";
import {
    hasCompleteFinalProse,
    mayExecuteToolsOnAttempt,
} from "./assistantCompletionPolicy";

assert.equal(hasCompleteFinalProse("completed", "Final answer"), true);
assert.equal(hasCompleteFinalProse("completed", "   "), false);
assert.equal(hasCompleteFinalProse("max_output", "Partial answer"), false);

assert.equal(mayExecuteToolsOnAttempt(false, ""), true);
assert.equal(mayExecuteToolsOnAttempt(true, ""), false);
assert.equal(mayExecuteToolsOnAttempt(false, "Partial answer"), false);

console.log("assistantCompletionPolicy tests passed");
