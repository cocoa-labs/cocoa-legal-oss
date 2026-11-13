// backend/src/lib/chatSuggestions.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    alreadyRunCapabilityIds,
    chatAuditScope,
    mergeSuggestionSettings,
    parseSuggestionAction,
    readSuggestionSettings,
} from "./chatSuggestions";

describe("readSuggestionSettings", () => {
    it("defaults when the column is missing, null or not an object", () => {
        const empty = { suppressed: false, dismissedCapabilityIds: [] };
        assert.deepEqual(readSuggestionSettings(null, "u1"), empty);
        assert.deepEqual(readSuggestionSettings(undefined, "u1"), empty);
        assert.deepEqual(readSuggestionSettings({}, "u1"), empty);
        assert.deepEqual(
            readSuggestionSettings({ suggestion_settings: null }, "u1"),
            empty,
        );
        assert.deepEqual(
            readSuggestionSettings({ suggestion_settings: "garbage" }, "u1"),
            empty,
        );
        assert.deepEqual(
            readSuggestionSettings({ suggestion_settings: [1, 2] }, "u1"),
            empty,
        );
    });

    it("reads only this user's entry", () => {
        const row = {
            suggestion_settings: {
                by_user: {
                    u1: {
                        suppressed: true,
                        dismissed_capability_ids: ["cre-review", "triage-nda"],
                    },
                    u2: { suppressed: false, dismissed_capability_ids: ["x-y"] },
                },
            },
        };
        assert.deepEqual(readSuggestionSettings(row, "u1"), {
            suppressed: true,
            dismissedCapabilityIds: ["cre-review", "triage-nda"],
        });
        assert.deepEqual(readSuggestionSettings(row, "u2"), {
            suppressed: false,
            dismissedCapabilityIds: ["x-y"],
        });
        assert.deepEqual(readSuggestionSettings(row, "u3"), {
            suppressed: false,
            dismissedCapabilityIds: [],
        });
    });

    it("tolerates a garbage entry for this user", () => {
        assert.deepEqual(
            readSuggestionSettings(
                {
                    suggestion_settings: {
                        by_user: {
                            u1: {
                                suppressed: "yes",
                                dismissed_capability_ids: [
                                    "cre-review",
                                    7,
                                    null,
                                    "cre-review",
                                ],
                            },
                        },
                    },
                },
                "u1",
            ),
            { suppressed: false, dismissedCapabilityIds: ["cre-review"] },
            "non-boolean suppressed is false; non-string ids dropped and deduped",
        );
        assert.deepEqual(
            readSuggestionSettings(
                { suggestion_settings: { by_user: "nope" } },
                "u1",
            ),
            { suppressed: false, dismissedCapabilityIds: [] },
        );
    });
});

describe("parseSuggestionAction", () => {
    it("rejects a non-object body and an unknown action", () => {
        for (const body of [null, undefined, "dismiss", [], 7]) {
            const parsed = parseSuggestionAction(body);
            assert.equal(parsed.ok, false);
        }
        const bad = parseSuggestionAction({ action: "delete" });
        assert.equal(bad.ok, false);
        assert.match(bad.ok === false ? bad.detail : "", /action/);
    });

    it("requires a kebab capability_id for dismiss", () => {
        const missing = parseSuggestionAction({ action: "dismiss" });
        assert.equal(missing.ok, false);
        assert.match(missing.ok === false ? missing.detail : "", /capability_id/);

        for (const id of ["CRE-Review", "ab", "-cre", "cre_review", "cre review", 7]) {
            const parsed = parseSuggestionAction({
                action: "dismiss",
                capability_id: id,
            });
            assert.equal(parsed.ok, false, `expected ${String(id)} to be rejected`);
        }

        const ok = parseSuggestionAction({
            action: "dismiss",
            capability_id: "cre-review",
        });
        assert.deepEqual(ok, {
            ok: true,
            action: "dismiss",
            capabilityId: "cre-review",
            proposalId: null,
        });
    });

    it("accepts suppress/unsuppress with no capability id", () => {
        assert.deepEqual(parseSuggestionAction({ action: "suppress" }), {
            ok: true,
            action: "suppress",
            capabilityId: null,
            proposalId: null,
        });
        assert.deepEqual(
            parseSuggestionAction({
                action: "unsuppress",
                capability_id: "cre-review",
            }),
            {
                ok: true,
                action: "unsuppress",
                capabilityId: null,
                proposalId: null,
            },
            "capability_id is meaningless outside dismiss and is dropped",
        );
    });

    it("accepts an optional uuid proposal_id and rejects a malformed one", () => {
        const uuid = "7f9f4a2e-1c3d-4b6a-9e0f-2a1b3c4d5e6f";
        const ok = parseSuggestionAction({ action: "suppress", proposal_id: uuid });
        assert.deepEqual(ok, {
            ok: true,
            action: "suppress",
            capabilityId: null,
            proposalId: uuid,
        });
        const bad = parseSuggestionAction({
            action: "suppress",
            proposal_id: "not-a-uuid",
        });
        assert.equal(bad.ok, false);
        assert.match(bad.ok === false ? bad.detail : "", /proposal_id/);
    });
});

describe("mergeSuggestionSettings", () => {
    it("builds the column value from nothing", () => {
        assert.deepEqual(
            mergeSuggestionSettings(null, "u1", "dismiss", "cre-review"),
            { by_user: { u1: { dismissed_capability_ids: ["cre-review"] } } },
        );
        assert.deepEqual(mergeSuggestionSettings(undefined, "u1", "suppress", null), {
            by_user: { u1: { suppressed: true } },
        });
    });

    it("preserves other users' entries", () => {
        const existing = {
            by_user: {
                u2: { suppressed: true, dismissed_capability_ids: ["triage-nda"] },
            },
        };
        const next = mergeSuggestionSettings(existing, "u1", "suppress", null);
        assert.deepEqual(next, {
            by_user: {
                u2: {
                    suppressed: true,
                    dismissed_capability_ids: ["triage-nda"],
                },
                u1: { suppressed: true },
            },
        });
        assert.deepEqual(
            existing.by_user.u2.dismissed_capability_ids,
            ["triage-nda"],
            "the input value is not mutated",
        );
    });

    it("dedupes a repeated dismiss and keeps the suppressed flag", () => {
        const first = mergeSuggestionSettings(
            { by_user: { u1: { suppressed: true } } },
            "u1",
            "dismiss",
            "cre-review",
        );
        assert.deepEqual(first, {
            by_user: {
                u1: { suppressed: true, dismissed_capability_ids: ["cre-review"] },
            },
        });
        const second = mergeSuggestionSettings(first, "u1", "dismiss", "cre-review");
        assert.deepEqual(second, first, "dismissing twice is idempotent");
        const third = mergeSuggestionSettings(second, "u1", "dismiss", "triage-nda");
        assert.deepEqual(
            readSuggestionSettings({ suggestion_settings: third }, "u1")
                .dismissedCapabilityIds,
            ["cre-review", "triage-nda"],
        );
    });

    it("unsuppress clears only the suppressed flag", () => {
        const suppressed = mergeSuggestionSettings(
            { by_user: { u1: { dismissed_capability_ids: ["cre-review"] } } },
            "u1",
            "suppress",
            null,
        );
        assert.equal(
            readSuggestionSettings({ suggestion_settings: suppressed }, "u1")
                .suppressed,
            true,
        );
        const cleared = mergeSuggestionSettings(suppressed, "u1", "unsuppress", null);
        assert.deepEqual(
            readSuggestionSettings({ suggestion_settings: cleared }, "u1"),
            { suppressed: false, dismissedCapabilityIds: ["cre-review"] },
        );
    });

    it("replaces a garbage column rather than throwing", () => {
        assert.deepEqual(mergeSuggestionSettings("garbage", "u1", "suppress", null), {
            by_user: { u1: { suppressed: true } },
        });
        assert.deepEqual(
            mergeSuggestionSettings({ by_user: 7 }, "u1", "suppress", null),
            { by_user: { u1: { suppressed: true } } },
        );
    });
});

describe("chatAuditScope", () => {
    it("picks string ids only", () => {
        assert.deepEqual(
            chatAuditScope({
                org_id: "org-1",
                matter_id: "m-1",
                project_id: "p-1",
            }),
            { orgId: "org-1", matterId: "m-1", projectId: "p-1" },
        );
        assert.deepEqual(
            chatAuditScope({ org_id: null, matter_id: 7, project_id: "p-1" }),
            { projectId: "p-1" },
        );
        assert.deepEqual(chatAuditScope(null), {});
        assert.deepEqual(chatAuditScope(undefined), {});
        assert.deepEqual(chatAuditScope({}), {});
    });
});

describe("alreadyRunCapabilityIds", () => {
    it("collects ids of complete capability results only", () => {
        const ids = alreadyRunCapabilityIds([
            {
                assistants: [
                    {
                        content: [
                            { type: "text", text: "hi" },
                            {
                                type: "capability_result",
                                status: "complete",
                                capability_id: "cre-review",
                            },
                        ],
                    },
                ],
            },
            {
                assistants: [
                    {
                        content: [
                            {
                                type: "capability_result",
                                status: "running",
                                capability_id: "triage-nda",
                            },
                            {
                                type: "capability_result",
                                status: "failed",
                                capability_id: "compliance-check",
                            },
                            {
                                type: "other_event",
                                status: "complete",
                                capability_id: "review-contract",
                            },
                        ],
                    },
                    { content: null },
                    { content: "a string" },
                    {},
                ],
            },
            {
                assistants: [
                    {
                        content: [
                            {
                                type: "capability_result",
                                status: "complete",
                                capability_id: "cre-review",
                            },
                            {
                                type: "capability_result",
                                status: "complete",
                                capability_id: 7,
                            },
                            null,
                            "junk",
                        ],
                    },
                ],
            },
        ]);
        assert.deepEqual([...ids], ["cre-review"]);
    });

    it("returns an empty set for no episodes", () => {
        assert.equal(alreadyRunCapabilityIds([]).size, 0);
    });
});

console.log("chatSuggestions tests passed");
