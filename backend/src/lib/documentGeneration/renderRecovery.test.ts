import assert from "node:assert/strict";
import { test } from "node:test";

import {
    DOCUMENT_LAYOUT_QA_FAILED,
    DOCUMENT_QA_UNAVAILABLE,
    DocumentLayoutQaError,
    type DocumentLayoutQaReport,
} from "../documentLayoutQa";
import { checkLibreOfficeReachable } from "../libreoffice";
import type { DocxSection } from "../docxAssembly";
import {
    renderDocumentWithRecovery,
    type DocumentRenderAttempt,
} from "./renderRecovery";

function report(
    status: "passed" | "failed",
    reason?: string,
): DocumentLayoutQaReport {
    return {
        schema_version: 1,
        artifact_type: "docx",
        sha256: status.repeat(32),
        checked_at: new Date().toISOString(),
        status,
        failure_code:
            status === "failed" ? DOCUMENT_LAYOUT_QA_FAILED : undefined,
        views: [
            {
                view: "stored",
                sha256: status.repeat(32),
                pdf: {
                    analyzer_version: 2,
                    sha256: status.repeat(32),
                    page_count: 2,
                    text_item_count: 100,
                    rendered_token_count: status === "passed" ? 100 : 95,
                    expected_token_count: 100,
                    expected_token_coverage: status === "passed" ? 1 : 0.95,
                    missing_token_count: status === "passed" ? 0 : 5,
                    ordered_token_coverage: status === "passed" ? 1 : 0.95,
                    collision_count: status === "passed" ? 0 : 1,
                    out_of_bounds_count: 0,
                    affected_pages: status === "passed" ? [] : [2],
                    failure_reasons: reason ? [reason] : [],
                    status,
                },
            },
        ],
    };
}

const sections: DocxSection[] = [
    {
        heading: "Scope",
        level: 1,
        content: "Ordinary prose remains unnumbered and readable.",
    },
];

test("standard rendition publishes after a passing layout report", async () => {
    const modes: string[] = [];
    const result = await renderDocumentWithRecovery({
        title: "Standard Pass",
        sections,
        render: async (_title, _sections, options) => {
            modes.push(options?.mode ?? "standard");
            return { buffer: Buffer.from("standard") };
        },
        verify: async () => report("passed"),
    });
    assert.equal(result.rendererMode, "standard");
    assert.deepEqual(modes, ["standard"]);
});

test("layout failure rerenders once with compatibility settings and retains diagnostics", async () => {
    const modes: string[] = [];
    const attempts: DocumentRenderAttempt[] = [];
    const result = await renderDocumentWithRecovery({
        title: "Compatibility Fallback",
        sections,
        render: async (_title, _sections, options) => {
            const mode = options?.mode ?? "standard";
            modes.push(mode);
            return { buffer: Buffer.from(mode) };
        },
        verify: async ({ bytes }) => {
            if (bytes.toString() === "standard") {
                const failed = report("failed", "paragraph collision");
                throw new DocumentLayoutQaError(
                    DOCUMENT_LAYOUT_QA_FAILED,
                    "standard failed",
                    failed,
                );
            }
            return report("passed");
        },
        onAttempt: (attempt) => {
            attempts.push(attempt);
        },
    });
    assert.equal(result.rendererMode, "compatibility");
    assert.deepEqual(modes, ["standard", "compatibility"]);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].summary.failure_code, DOCUMENT_LAYOUT_QA_FAILED);
    assert.deepEqual(attempts[0].summary.affected_pages, [2]);
    assert.equal(attempts[0].summary.text_coverage, 0.95);
    assert.equal(attempts[0].summary.analyzer_version, 2);
    assert.equal(attempts[0].summary.missing_token_count, 5);
    assert.equal(attempts[1].summary.status, "passed");
});

test("transient QA unavailability retries three attempts without redrafting", async () => {
    let renders = 0;
    let verifications = 0;
    const attempts: DocumentRenderAttempt[] = [];
    const result = await renderDocumentWithRecovery({
        title: "Transient Retry",
        sections,
        render: async () => {
            renders += 1;
            return { buffer: Buffer.from("same-draft") };
        },
        verify: async () => {
            verifications += 1;
            if (verifications < 3) {
                throw new DocumentLayoutQaError(
                    DOCUMENT_QA_UNAVAILABLE,
                    "converter temporarily unavailable",
                );
            }
            return report("passed");
        },
        sleep: async () => undefined,
        onAttempt: (attempt) => {
            attempts.push(attempt);
        },
    });
    assert.equal(result.rendererMode, "standard");
    assert.equal(renders, 1);
    assert.equal(verifications, 3);
    assert.deepEqual(
        attempts.map((attempt) => attempt.summary.status),
        ["unavailable", "unavailable", "passed"],
    );
});

test("terminal QA unavailability retains all three failed attempts", async () => {
    const attempts: DocumentRenderAttempt[] = [];
    await assert.rejects(
        renderDocumentWithRecovery({
            title: "Terminal Retry",
            sections,
            render: async () => ({ buffer: Buffer.from("draft") }),
            verify: async () => {
                throw new DocumentLayoutQaError(
                    DOCUMENT_QA_UNAVAILABLE,
                    "converter unavailable",
                );
            },
            sleep: async () => undefined,
            onAttempt: (attempt) => {
                attempts.push(attempt);
            },
        }),
        (error: unknown) =>
            error instanceof DocumentLayoutQaError &&
            error.code === DOCUMENT_QA_UNAVAILABLE,
    );
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((attempt) => attempt.retryable));
});

test("attempt persistence failures are not mislabeled or retried as QA outages", async () => {
    const persistenceError = new Error("database unavailable");
    let verifications = 0;
    await assert.rejects(
        renderDocumentWithRecovery({
            title: "Attempt Persistence Failure",
            sections,
            render: async () => ({ buffer: Buffer.from("draft") }),
            verify: async () => {
                verifications += 1;
                return report("passed");
            },
            sleep: async () => undefined,
            onAttempt: () => {
                throw persistenceError;
            },
        }),
        (error: unknown) => error === persistenceError,
    );
    assert.equal(verifications, 1);
});

const LONG_URL =
    "https://www.example.com/registration-membership/who-has-to-register/overview.html?identifier=XYZ-EXAMPLE-MARKETS-LLC-2026-REGULATORY-READINESS";

function memorandumFixture(): DocxSection[] {
    return Array.from({ length: 12 }, (_, index) => ({
        heading:
            index === 0
                ? "Executive Summary"
                : `${index + 1}. ${
                      [
                          "Single-Member LLC Ownership Structure",
                          "Building A and Building B Lease Status and Specifications",
                          "Entity Formation and Governance",
                          "Single-Member Versus Multi-Member LLC Analysis",
                          "Lender Consent Mechanics",
                          "Like-Kind Exchange Analysis Under Treas. Reg. 1.1031(k)-1",
                          "Property Management Economics",
                          "Broker Selection Criteria",
                          "Compliance Program Build",
                          "Eight-Week Workstream and Ownership Matrix",
                          "Closing Conditions, Dependencies, and Principal Risks",
                      ][index - 1]
                  }`,
        level: 1,
        pageBreak: index > 0 && index % 3 === 0,
        content: [
            `Section ${index + 1} provides production-shaped analysis for Example Markets LLC and preserves Treas. Reg. 1.1031(k)-1(g)(4), 26 U.S.C. § 1031(a)(3), and long identifiers.`,
            `• Review the controlling source at ${LONG_URL}`,
            "(a) Assign the workstream to a named owner and target week.",
            "    (i) Record evidence, dependencies, approval gates, and residual risk.",
        ].join("\n"),
    }));
}

function checklistFixture(): DocxSection[] {
    return Array.from({ length: 10 }, (_, index) => ({
        heading: `${index + 1}. Checklist Workstream ${index + 1}`,
        level: 1,
        pageBreak: index === 5,
        content: [
            `☐ Collect and validate workstream ${index + 1} evidence for record ID XYZ-EM-${String(index + 1).padStart(2, "0")}.`,
            "[ ] Confirm responsible owner, reviewer, due date, and escalation path.",
            `• Source: ${LONG_URL}&workstream=${index + 1}`,
            "Ordinary explanatory prose follows the checklist without acquiring an automatic list number.",
        ].join("\n"),
    }));
}

test("real LibreOffice passes production-shaped 12-section memo and 10-section checklist", async (t) => {
    try {
        await checkLibreOfficeReachable();
    } catch {
        t.skip("LibreOffice is not installed in this local environment.");
        return;
    }

    for (const [title, fixture] of [
        [
            "Portfolio Roadmap Memorandum - Example Markets LLC",
            memorandumFixture(),
        ],
        [
            "Closing Package Checklist - Example Markets LLC",
            checklistFixture(),
        ],
    ] as const) {
        const attempts: DocumentRenderAttempt[] = [];
        let result: Awaited<ReturnType<typeof renderDocumentWithRecovery>>;
        try {
            result = await renderDocumentWithRecovery({
                title,
                sections: fixture,
                onAttempt: (attempt) => {
                    attempts.push(attempt);
                },
            });
        } catch (error) {
            console.error(
                "production-shaped DOCX fixture diagnostics",
                JSON.stringify(
                    {
                        title,
                        attempts: attempts.map((attempt) => attempt.summary),
                    },
                    null,
                    2,
                ),
            );
            throw error;
        }
        assert.equal(result.report.status, "passed");
        assert.ok(result.buffer.byteLength > 2_000);
    }
});
