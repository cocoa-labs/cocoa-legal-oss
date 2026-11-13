import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    isGenerationRefusal,
    isGenerationMaxOutputError,
    isGenerationContextLimitError,
    isTransientGenerationError,
    calculatedDraftOutputTokens,
    savedBriefContext,
    validateGeneratedSections,
    validateSavedOutline,
} from "./worker";

assert.equal(isTransientGenerationError(new Error("429 rate limit")), true);
assert.equal(isTransientGenerationError(new Error("503 overloaded")), true);
assert.equal(isTransientGenerationError(new Error("validation failed")), false);
assert.equal(isGenerationRefusal(new Error("content safety refusal")), true);
assert.equal(isGenerationRefusal(new Error("network timeout")), false);
assert.equal(
    isGenerationMaxOutputError(
        new Error("[max_output] Claude truncated the structured completion"),
    ),
    true,
);
assert.equal(isGenerationMaxOutputError(new Error("validation failed")), false);
assert.equal(
    isGenerationContextLimitError(
        new Error("[context_limit] Claude exceeded its context window"),
    ),
    true,
);
assert.equal(
    isGenerationContextLimitError(new Error("network timeout")),
    false,
);
assert.equal(calculatedDraftOutputTokens(1_000, 128_000), 4_500);
assert.equal(calculatedDraftOutputTokens(20_000, 128_000), 32_000);
assert.equal(calculatedDraftOutputTokens(20_000, 16_384), 16_384);
assert.equal(calculatedDraftOutputTokens(null, 128_000), 32_000);
assert.match(
    savedBriefContext({ summary: "Use the single-member LLC ownership structure." }),
    /SAVED JOB BRIEF:\nUse the single-member LLC ownership structure/,
);
assert.equal(savedBriefContext({}), "");

assert.deepEqual(
    validateGeneratedSections({
        sections: [
            {
                heading: "Definitions",
                level: 1,
                content:
                    "This section contains enough substantive text to be valid.",
                pageBreak: false,
            },
        ],
    }),
    [
        {
            heading: "Definitions",
            level: 1,
            content:
                "This section contains enough substantive text to be valid.",
            pageBreak: false,
        },
    ],
);
assert.equal(validateGeneratedSections({ sections: [] }), null);
assert.equal(
    validateGeneratedSections({ sections: [{ heading: "Broken" }] }),
    null,
);
assert.deepEqual(
    validateGeneratedSections({
        sections: [
            {
                heading: "Single versus multi-member LLC",
                level: 1,
                content: "The launch recommendation follows the comparison.",
                pageBreak: false,
                table: {
                    headers: ["Criterion", "Single-member", "Multi-member"],
                    rows: [
                        ["Capital", "No minimum", "$45,000"],
                        ["Lender relationships", "One", "Multiple"],
                    ],
                },
            },
        ],
    }),
    [
        {
            heading: "Single versus multi-member LLC",
            level: 1,
            content: "The launch recommendation follows the comparison.",
            pageBreak: false,
            table: {
                headers: ["Criterion", "Single-member", "Multi-member"],
                rows: [
                    ["Capital", "No minimum", "$45,000"],
                    ["Lender relationships", "One", "Multiple"],
                ],
            },
        },
    ],
);
assert.deepEqual(
    validateSavedOutline({
        sections: [
            {
                heading: "Executive Summary",
                level: 1,
                instructions: "Summarize the recommended structure.",
            },
        ],
    }),
    {
        sections: [
            {
                heading: "Executive Summary",
                level: 1,
                instructions: "Summarize the recommended structure.",
            },
        ],
    },
);
assert.equal(validateSavedOutline({ sections: [] }), null);

const migration = fs.readFileSync(
    path.resolve(process.cwd(), "migrations/031_document_generation_jobs.sql"),
    "utf8",
);
assert.match(migration, /for update skip locked/i);
assert.match(migration, /heartbeat_at/i);
assert.match(migration, /cancel_requested_at/i);
assert.match(migration, /unique\(job_id, position\)/i);

const recoveryMigration = fs.readFileSync(
    path.resolve(
        process.cwd(),
        "migrations/043_document_generation_recovery.sql",
    ),
    "utf8",
);
for (const column of [
    "draft_sections_json",
    "layout_attempts_json",
    "failure_stage",
    "failure_code",
    "retryable",
    "run_attempts",
]) {
    assert.match(
        recoveryMigration,
        new RegExp(`add column if not exists ${column}`, "i"),
    );
}
assert.match(recoveryMigration, /retry_document_generation_job/i);
assert.match(
    recoveryMigration,
    /where job_id = p_job_id and status = 'failed'/i,
);
assert.match(recoveryMigration, /status = 'queued'/i);
assert.match(recoveryMigration, /status = 'ready'/i);
assert.match(recoveryMigration, /grant execute[\s\S]*service_role/i);
assert.doesNotMatch(
    recoveryMigration,
    /layout_attempts_json\s*=/i,
    "manual retry must preserve prior render diagnostics",
);

const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/routes/documentGeneration.ts"),
    "utf8",
);
assert.match(routeSource, /documentGenerationRouter\.use\(requireAuth\)/);
assert.match(routeSource, /retryDocumentGeneration\(\s*db,\s*req.params.jobId/);
const statusSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/documentGeneration/status.ts"),
    "utf8",
);
assert.match(
    statusSource,
    /documents!document_versions_document_id_fkey\(filename\)/,
    "ready packet items must hydrate downloads through the unambiguous document-version relationship",
);
assert.match(
    statusSource,
    /if \(versionsError\)[\s\S]*Failed to load generated document downloads/,
    "download hydration failures must be surfaced instead of silently hiding ready files",
);
console.log("documentGeneration/worker.test.ts: all passed");
