// backend/src/lib/automation/env.test.ts
//
// The automation env readers gate the whole pipeline: automationEnabled() is
// the master kill-switch for the scheduler AND the ingest enqueue hook, and
// the drafts-only / retry / model knobs are the safety rails 4b builds on.
// Pure functions over an injected env object, so the defaults/overrides
// matrix is pinned here without mutating process.env.
import assert from "node:assert/strict";
import {
    automationEnabled,
    automationPollIntervalMs,
    automationDraftsOnly,
    automationMaxRetries,
    automationLlmClassifyEnabled,
    automationModel,
    automationReconcileEveryNTicks,
} from "./env";
import { DEFAULT_MAIN_MODEL } from "../llm/models";

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

console.log("automation/env.test.ts");

test("defaults on an empty env: automation OFF, drafts-only ON", () => {
    assert.equal(automationEnabled({}), false, "master switch defaults OFF");
    assert.equal(automationPollIntervalMs({}), 120_000);
    assert.equal(automationDraftsOnly({}), true, "drafts-only defaults ON");
    assert.equal(automationMaxRetries({}), 3);
    assert.equal(automationLlmClassifyEnabled({}), true);
    assert.equal(automationModel({}), DEFAULT_MAIN_MODEL);
});

test("automationEnabled follows the repo boolean convention (strict 'true')", () => {
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "true" }), true);
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "TRUE" }), true);
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "True" }), true);
    // Anything else stays off — same contract as EMAIL_AUTOREPLY_ENABLED.
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "1" }), false);
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "yes" }), false);
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "false" }), false);
    assert.equal(automationEnabled({ AUTOMATION_ENABLED: "" }), false);
});

test("automationPollIntervalMs: override wins, junk falls back", () => {
    assert.equal(
        automationPollIntervalMs({ AUTOMATION_POLL_INTERVAL_MS: "30000" }),
        30_000,
    );
    assert.equal(
        automationPollIntervalMs({ AUTOMATION_POLL_INTERVAL_MS: "abc" }),
        120_000,
    );
    assert.equal(
        automationPollIntervalMs({ AUTOMATION_POLL_INTERVAL_MS: "-5" }),
        120_000,
        "a non-positive interval would spin the scheduler — fall back",
    );
    assert.equal(
        automationPollIntervalMs({ AUTOMATION_POLL_INTERVAL_MS: "0" }),
        120_000,
    );
});

test("automationDraftsOnly: only an explicit 'false' disarms the safety", () => {
    assert.equal(automationDraftsOnly({ AUTOMATION_DRAFTS_ONLY: "false" }), false);
    assert.equal(automationDraftsOnly({ AUTOMATION_DRAFTS_ONLY: "FALSE" }), false);
    assert.equal(automationDraftsOnly({ AUTOMATION_DRAFTS_ONLY: "true" }), true);
    assert.equal(
        automationDraftsOnly({ AUTOMATION_DRAFTS_ONLY: "0" }),
        true,
        "junk must NOT disarm drafts-only",
    );
});

test("automationMaxRetries: zero is a valid policy, junk falls back", () => {
    assert.equal(automationMaxRetries({ AUTOMATION_MAX_RETRIES: "5" }), 5);
    assert.equal(
        automationMaxRetries({ AUTOMATION_MAX_RETRIES: "0" }),
        0,
        "0 = never retry is meaningful",
    );
    assert.equal(automationMaxRetries({ AUTOMATION_MAX_RETRIES: "-1" }), 3);
    assert.equal(automationMaxRetries({ AUTOMATION_MAX_RETRIES: "many" }), 3);
});

test("automationLlmClassifyEnabled: only an explicit 'false' turns it off", () => {
    assert.equal(
        automationLlmClassifyEnabled({ AUTOMATION_LLM_CLASSIFY_ENABLED: "false" }),
        false,
    );
    assert.equal(
        automationLlmClassifyEnabled({ AUTOMATION_LLM_CLASSIFY_ENABLED: "true" }),
        true,
    );
    assert.equal(
        automationLlmClassifyEnabled({ AUTOMATION_LLM_CLASSIFY_ENABLED: "off" }),
        true,
    );
});

test("automationReconcileEveryNTicks: default 30, override wins, junk falls back", () => {
    assert.equal(automationReconcileEveryNTicks({}), 30);
    assert.equal(
        automationReconcileEveryNTicks({
            AUTOMATION_RECONCILE_EVERY_N_TICKS: "10",
        }),
        10,
    );
    assert.equal(
        automationReconcileEveryNTicks({
            AUTOMATION_RECONCILE_EVERY_N_TICKS: "abc",
        }),
        30,
    );
    assert.equal(
        automationReconcileEveryNTicks({
            AUTOMATION_RECONCILE_EVERY_N_TICKS: "0",
        }),
        30,
        "a non-positive cadence would never (or always) reconcile — fall back",
    );
    assert.equal(
        automationReconcileEveryNTicks({
            AUTOMATION_RECONCILE_EVERY_N_TICKS: "-3",
        }),
        30,
    );
});

test("automationModel: AUTOMATION_MODEL wins, blank falls back to DEFAULT_MAIN_MODEL", () => {
    assert.equal(
        automationModel({ AUTOMATION_MODEL: "claude-opus-4-8" }),
        "claude-opus-4-8",
    );
    assert.equal(automationModel({ AUTOMATION_MODEL: "" }), DEFAULT_MAIN_MODEL);
    assert.equal(
        automationModel({ AUTOMATION_MODEL: "   " }),
        DEFAULT_MAIN_MODEL,
        "whitespace-only is not a model id",
    );
});

console.log("automation/env.test.ts: all passed");
