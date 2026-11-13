import { performance } from "node:perf_hooks";

import {
    DOCUMENT_QA_UNAVAILABLE,
    DocumentLayoutQaError,
} from "../documentLayoutQa";
import {
    DocumentRenderError,
    renderDocumentWithRecovery,
} from "./renderRecovery";

export type DocumentGenerationCanaryState = {
    status: "pending" | "running" | "passed" | "failed";
    checked_at: string | null;
    renderer_mode: "standard" | "compatibility" | null;
    failure_code: string | null;
    error: string | null;
    duration_ms: number | null;
};

let state: DocumentGenerationCanaryState = {
    status: "pending",
    checked_at: null,
    renderer_mode: null,
    failure_code: null,
    error: null,
    duration_ms: null,
};
let inFlight: Promise<DocumentGenerationCanaryState> | null = null;

export function getDocumentGenerationCanaryState(): DocumentGenerationCanaryState {
    return { ...state };
}

export function documentGenerationCanaryPassed(): boolean {
    return state.status === "passed";
}

/**
 * Boot canary for the exact Quill path: structured sections -> generated DOCX
 * -> LibreOffice PDF -> visual/text layout QA. The result is cached for the
 * lifetime of the process so readiness probes never spawn LibreOffice.
 */
export function runDocumentGenerationCanary(): Promise<DocumentGenerationCanaryState> {
    if (inFlight) return inFlight;
    state = { ...state, status: "running", error: null, failure_code: null };
    const startedAt = performance.now();
    inFlight = (async () => {
        try {
            const result = await renderDocumentWithRecovery({
                title: "Quill Document Generation Readiness Memorandum",
                sections: [
                    {
                        heading: "Executive Summary and Scope of Review",
                        level: 1,
                        pageBreak: false,
                        content:
                            "This readiness memorandum confirms that Quill can produce a complete DOCX, convert it with LibreOffice Writer, and verify the visual result before publication. Ordinary prose must remain ordinary prose rather than becoming an unintended numbered paragraph.",
                    },
                    {
                        heading:
                            "2. Regulatory Identifiers, Citations, and Long References",
                        level: 1,
                        pageBreak: true,
                        content: [
                            "Treas. Reg. 1.1031(k)-1(g)(4), 26 U.S.C. § 1031(a)(3), and identifier XYZ-EXAMPLE-HOLDING-LLC-VERIFICATION-READINESS-2026 must remain legible.",
                            "• Confirm access to https://www.example.com/verification-references/how-to-read-samples/overview.html?source=quill-document-generation-readiness-canary",
                            "(a) Preserve supplied legal numbering and use a hanging indent.",
                            "    (i) Allow long tokens and URLs to wrap without leaving the printable page.",
                        ].join("\n"),
                    },
                    {
                        heading: "Operational Checklist",
                        level: 1,
                        pageBreak: false,
                        content: [
                            "☐ Entity formation documents collected",
                            "☑ Written supervisory procedures reviewed",
                            "[ ] Responsible owner and target date assigned",
                        ].join("\n"),
                    },
                    {
                        heading: "Signatures",
                        level: 1,
                        pageBreak: false,
                        content:
                            "By: ____________________\nName: Quill Readiness Agent\nTitle: Document Generation Canary\nDate: ____________________",
                    },
                ],
            });
            state = {
                status: "passed",
                checked_at: new Date().toISOString(),
                renderer_mode: result.rendererMode,
                failure_code: null,
                error: null,
                duration_ms: Math.round(performance.now() - startedAt),
            };
        } catch (error) {
            state = {
                status: "failed",
                checked_at: new Date().toISOString(),
                renderer_mode: null,
                failure_code:
                    error instanceof DocumentLayoutQaError
                        ? error.code
                        : error instanceof DocumentRenderError
                          ? error.code
                          : DOCUMENT_QA_UNAVAILABLE,
                error: error instanceof Error ? error.message : String(error),
                duration_ms: Math.round(performance.now() - startedAt),
            };
        }
        return getDocumentGenerationCanaryState();
    })();
    return inFlight;
}
