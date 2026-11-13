// Shared helpers for the Personal Injury surfaces (Cases + Automation queue).
// Pure functions only — no React, no fetching — mirroring creShared.ts: the
// panels, cards and tables all pull formatting/grouping from here so labels,
// badge tones and money formatting can never drift between surfaces.

import type {
    AutomationRun,
    AutomationRunStatus,
    AutomationWorkflowKind,
    PiCaseStatus,
    PiExpenseStatus,
} from "@/app/lib/cocoLegalApi";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * THE cents → localized currency helper (every PI amount renders through
 * this). Null/undefined cents (an invoice whose amount never extracted)
 * render as an em dash rather than $0.00.
 */
export function formatCents(
    cents: number | null | undefined,
    currency?: string | null,
): string {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) {
        return "—";
    }
    const amount = cents / 100;
    try {
        return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: (currency || "USD").toUpperCase(),
        }).format(amount);
    } catch {
        // Unknown currency code from an extraction — degrade, don't throw.
        return `${(currency || "USD").toUpperCase()} ${amount.toFixed(2)}`;
    }
}

/** Short date+time, matching the inbox/signatures list convention. */
export function formatWhen(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

/** Date-only (date of loss, incurred dates). Renders the calendar date the
 * ISO string names — no timezone shifting for date-only values. */
export function formatDateOnly(iso: string | null | undefined): string {
    if (!iso) return "—";
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!match) return iso;
    const d = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
    );
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

/** Compact age for run cards ("2m ago", "3h ago", "5d ago"). */
export function timeAgo(iso: string | null | undefined): string {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return formatWhen(iso);
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export interface BadgeTone {
    label: string;
    cls: string;
}

/** Human label + tone for a case status (statusBadge convention from
 * SignaturesPanel). */
export function caseStatusBadge(status: PiCaseStatus): BadgeTone {
    switch (status) {
        case "open":
            return { label: "Open", cls: "bg-green-100 text-green-800" };
        case "provisional":
            return { label: "Provisional", cls: "bg-amber-100 text-amber-800" };
        case "settled":
            return { label: "Settled", cls: "bg-blue-100 text-blue-800" };
        case "closed":
            return { label: "Closed", cls: "bg-gray-100 text-gray-600" };
    }
}

export function expenseStatusBadge(status: PiExpenseStatus): BadgeTone {
    switch (status) {
        case "pending_approval":
            return {
                label: "Pending approval",
                cls: "bg-amber-100 text-amber-800",
            };
        case "approved":
            return { label: "Approved", cls: "bg-blue-100 text-blue-800" };
        case "paid":
            return { label: "Paid", cls: "bg-green-100 text-green-800" };
        case "rejected":
            return { label: "Rejected", cls: "bg-red-100 text-red-700" };
        case "void":
            return { label: "Void", cls: "bg-gray-100 text-gray-600" };
    }
}

export function runStatusBadge(status: AutomationRunStatus): BadgeTone {
    switch (status) {
        case "staged":
            return {
                label: "Ready for review",
                cls: "bg-amber-100 text-amber-800",
            };
        case "triage":
            return { label: "Needs attention", cls: "bg-red-100 text-red-700" };
        case "queued":
            return { label: "Queued", cls: "bg-blue-100 text-blue-800" };
        case "classifying":
            return { label: "Classifying", cls: "bg-blue-100 text-blue-800" };
        case "extracting":
            return { label: "Extracting", cls: "bg-blue-100 text-blue-800" };
        case "matching":
            return { label: "Matching", cls: "bg-blue-100 text-blue-800" };
        case "staging":
            return { label: "Staging", cls: "bg-blue-100 text-blue-800" };
        case "approved":
            return { label: "Approved", cls: "bg-green-100 text-green-800" };
        case "rejected":
            return { label: "Rejected", cls: "bg-gray-100 text-gray-600" };
        case "failed":
            return { label: "Failed", cls: "bg-red-100 text-red-700" };
        case "skipped":
            return { label: "Skipped", cls: "bg-gray-100 text-gray-600" };
    }
}

export function workflowKindLabel(
    kind: AutomationWorkflowKind | null,
): string {
    switch (kind) {
        case "claim_correspondence":
            return "Claim correspondence";
        case "vendor_invoice":
            return "Vendor invoice";
        default:
            return "Unclassified";
    }
}

export function caseOriginLabel(origin: string): string {
    switch (origin) {
        case "csv_import":
            return "CSV import";
        case "manual":
            return "Manual";
        case "auto_created":
            return "Auto-created";
        default:
            return origin;
    }
}

// ---------------------------------------------------------------------------
// Run grouping (queue order: triage → staged → working → terminal)
// ---------------------------------------------------------------------------

const WORKING_STATUSES = new Set<AutomationRunStatus>([
    "queued",
    "classifying",
    "extracting",
    "matching",
    "staging",
]);

const TERMINAL_STATUSES = new Set<AutomationRunStatus>([
    "approved",
    "rejected",
    "failed",
    "skipped",
]);

export interface GroupedRuns {
    triage: AutomationRun[];
    staged: AutomationRun[];
    working: AutomationRun[];
    terminal: AutomationRun[];
}

/** Bucket queue runs; each bucket keeps the API's newest-first order. */
export function groupRuns(runs: AutomationRun[]): GroupedRuns {
    const triage: AutomationRun[] = [];
    const staged: AutomationRun[] = [];
    const working: AutomationRun[] = [];
    const terminal: AutomationRun[] = [];
    for (const run of runs) {
        if (run.status === "triage") triage.push(run);
        else if (run.status === "staged") staged.push(run);
        else if (WORKING_STATUSES.has(run.status)) working.push(run);
        else if (TERMINAL_STATUSES.has(run.status)) terminal.push(run);
    }
    return { triage, staged, working, terminal };
}

// ---------------------------------------------------------------------------
// Extraction flattening (ExtractedFieldsTable rows)
// ---------------------------------------------------------------------------

/** One extracted datum with provenance (types.ts ExtractedField). */
export interface ExtractedFieldValue {
    value: string;
    quote: string;
    page: number | null;
    source: "pdf" | "email_body";
    confidence: number;
}

export interface FlattenedField {
    /** Verification path ("claims[0].carrier", "vendor"). */
    path: string;
    /** Human field name. */
    label: string;
    /** Claim index for multi-claim extractions, else null. */
    claimIndex: number | null;
    field: ExtractedFieldValue;
    /** Deterministic-grounding verdict from run.verification.checks;
     * null when the run has no verification record for the path. */
    verified: boolean | null;
}

/** Canonical per-claim field order (types.ts: required, then optional). */
const CLAIM_FIELD_ORDER = [
    "claim_number",
    "carrier",
    "policy_number",
    "coverage_type",
    "policy_limits_text",
    "adjuster_name",
    "adjuster_email",
    "adjuster_phone",
    "client_or_insured_name",
    "date_of_loss",
    "correspondence_type",
    "requested_action",
] as const;

const INVOICE_FIELD_ORDER = [
    "vendor",
    "invoice_number",
    "amount_raw",
    "invoice_date",
    "matter_reference",
] as const;

const FIELD_LABELS: Record<string, string> = {
    claim_number: "Claim number",
    carrier: "Carrier",
    policy_number: "Policy number",
    coverage_type: "Coverage type",
    policy_limits_text: "Policy limits",
    adjuster_name: "Adjuster name",
    adjuster_email: "Adjuster email",
    adjuster_phone: "Adjuster phone",
    client_or_insured_name: "Client / insured",
    date_of_loss: "Date of loss",
    correspondence_type: "Correspondence type",
    requested_action: "Requested action",
    vendor: "Vendor",
    invoice_number: "Invoice number",
    amount_raw: "Amount (as quoted)",
    invoice_date: "Invoice date",
    matter_reference: "Matter reference",
};

function asExtractedField(v: unknown): ExtractedFieldValue | null {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const f = v as Record<string, unknown>;
    if (typeof f.value !== "string" || typeof f.quote !== "string") return null;
    const source = f.source === "pdf" ? "pdf" : "email_body";
    return {
        value: f.value,
        quote: f.quote,
        page: typeof f.page === "number" ? f.page : null,
        source,
        confidence: typeof f.confidence === "number" ? f.confidence : 0,
    };
}

/**
 * Flatten a run's extraction JSON into display rows in the pipeline's
 * canonical field order (claims arrays get a claim index), joined with the
 * per-path verification verdicts. Defensive over untyped JSON: anything
 * that doesn't look like an ExtractedField is skipped, never thrown on.
 */
export function flattenExtractedFields(run: AutomationRun): FlattenedField[] {
    const extracted = run.extracted ?? {};
    const verification = run.verification ?? {};
    const verifiedByPath = new Map<string, boolean>();
    const checks = (verification as { checks?: unknown }).checks;
    if (Array.isArray(checks)) {
        for (const check of checks) {
            if (!check || typeof check !== "object") continue;
            const c = check as { path?: unknown; verified?: unknown };
            if (typeof c.path === "string" && typeof c.verified === "boolean") {
                verifiedByPath.set(c.path, c.verified);
            }
        }
    }

    const out: FlattenedField[] = [];
    const push = (path: string, key: string, claimIndex: number | null, raw: unknown) => {
        const field = asExtractedField(raw);
        if (!field) return;
        out.push({
            path,
            label: FIELD_LABELS[key] ?? key,
            claimIndex,
            field,
            verified: verifiedByPath.get(path) ?? null,
        });
    };

    if (run.workflow_kind === "vendor_invoice") {
        const inv = extracted as Record<string, unknown>;
        for (const key of INVOICE_FIELD_ORDER) push(key, key, null, inv[key]);
        return out;
    }

    const claims = (extracted as { claims?: unknown }).claims;
    if (!Array.isArray(claims)) return out;
    claims.forEach((claim, i) => {
        if (!claim || typeof claim !== "object") return;
        const c = claim as Record<string, unknown>;
        for (const key of CLAIM_FIELD_ORDER) {
            push(`claims[${i}].${key}`, key, claims.length > 1 ? i : null, c[key]);
        }
    });
    return out;
}

/**
 * The source document a run's PDF citations point at, from the staged
 * proposal (claim runs stage it on every policy upsert; invoice runs stage
 * document_id). Null for runs that never staged (e.g. triage before
 * staging) — those citations render without a document link.
 */
export function runSourceDocumentId(run: AutomationRun): string | null {
    const proposal = run.proposal ?? {};
    const documentId = (proposal as { document_id?: unknown }).document_id;
    if (typeof documentId === "string" && documentId) return documentId;
    const upserts = (proposal as { policy_upserts?: unknown }).policy_upserts;
    if (Array.isArray(upserts)) {
        for (const upsert of upserts) {
            if (!upsert || typeof upsert !== "object") continue;
            const id = (upsert as { source_document_id?: unknown })
                .source_document_id;
            if (typeof id === "string" && id) return id;
        }
    }
    return null;
}

/** proposal.needs_case_confirm === true (the approve 409 contract). */
export function runNeedsCaseConfirm(run: AutomationRun): boolean {
    return (
        (run.proposal as { needs_case_confirm?: unknown })
            ?.needs_case_confirm === true
    );
}

/** The staged proposal's one-line summary, when present. */
export function runSummary(run: AutomationRun): string | null {
    const summary = (run.proposal as { summary?: unknown })?.summary;
    return typeof summary === "string" && summary.trim() ? summary : null;
}
