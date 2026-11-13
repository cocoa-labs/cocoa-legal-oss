// backend/src/lib/pi/store.ts
//
// Typed store for the personal-injury case tables — pi_cases,
// pi_case_policies, pi_case_expenses (see
// migrations/023_pi_cases_automation.sql). Narrow functions over the
// service-role Supabase client, mirroring lib/email/store.ts: db accessor
// passed in, snake_case row types, no classes. The email-automation pipeline
// (phase 4) builds on these; nothing here talks to an LLM.
//
// normalizeClientName is the canonical matching key: pi_cases stores it in
// client_name_normalized at every write, and the matcher normalizes inbound
// names with the SAME function, so the two sides can never drift.

import type { createServerSupabase } from "../supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type PiCaseStatus = "open" | "settled" | "closed" | "provisional";
export type PiCaseOrigin = "csv_import" | "manual" | "auto_created";
export type PiExpenseStatus =
    | "pending_approval"
    | "approved"
    | "paid"
    | "rejected"
    | "void";

/** Canonical value lists (DB check constraints in migration 023) — the
 * routes and CSV import validate against these, never ad-hoc copies. */
export const PI_CASE_STATUSES: readonly PiCaseStatus[] = [
    "open",
    "settled",
    "closed",
    "provisional",
];
export const PI_EXPENSE_STATUSES: readonly PiExpenseStatus[] = [
    "pending_approval",
    "approved",
    "paid",
    "rejected",
    "void",
];

export interface PiCase {
    id: string;
    user_id: string;
    project_id: string | null;
    case_number: string | null;
    client_name: string;
    client_name_normalized: string | null;
    date_of_loss: string | null;
    status: PiCaseStatus;
    origin: PiCaseOrigin;
    needs_review: boolean;
    attributes: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface PiCasePolicy {
    id: string;
    case_id: string;
    carrier: string;
    claim_number: string | null;
    policy_number: string | null;
    coverage_type: string | null;
    policy_limits: Record<string, unknown>;
    adjuster: Record<string, unknown>;
    effective_dates: unknown;
    source_document_id: string | null;
    source_run_id: string | null;
    details: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

export interface PiCaseExpense {
    id: string;
    case_id: string | null;
    user_id: string;
    vendor: string;
    invoice_number: string | null;
    amount_cents: number | null;
    currency: string;
    status: PiExpenseStatus;
    payment_portal_url: string | null;
    document_id: string | null;
    agent_operation_id: string | null;
    automation_run_id: string | null;
    incurred_at: string | null;
    paid_at: string | null;
    paid_by: string | null;
    notes: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

/**
 * Canonical client-name key: fold diacritics to their base letters, lowercase,
 * strip punctuation (without introducing spaces), collapse whitespace. Unicode
 * letters/digits outside Latin are preserved — a CJK name must never
 * normalize to "" (an empty key would "match" everything).
 */
export function normalizeClientName(name: string): string {
    return name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function serializeCase(row: Record<string, unknown>): PiCase {
    const r = row as unknown as PiCase & {
        attributes: Record<string, unknown> | null;
    };
    return { ...r, attributes: r.attributes ?? {} };
}

function serializePolicy(row: Record<string, unknown>): PiCasePolicy {
    const r = row as unknown as PiCasePolicy & {
        policy_limits: Record<string, unknown> | null;
        adjuster: Record<string, unknown> | null;
        details: Record<string, unknown> | null;
    };
    return {
        ...r,
        policy_limits: r.policy_limits ?? {},
        adjuster: r.adjuster ?? {},
        details: r.details ?? {},
    };
}

function serializeExpense(row: Record<string, unknown>): PiCaseExpense {
    const r = row as unknown as PiCaseExpense & {
        metadata: Record<string, unknown> | null;
    };
    return { ...r, metadata: r.metadata ?? {} };
}

function isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    if ((error as { code?: string }).code === "23505") return true;
    return /duplicate key|unique constraint/i.test(
        (error as { message?: string }).message ?? "",
    );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface PiCaseInsert {
    userId: string;
    clientName: string;
    caseNumber?: string | null;
    projectId?: string | null;
    dateOfLoss?: string | null;
    status?: PiCaseStatus;
    origin?: PiCaseOrigin;
    needsReview?: boolean;
    attributes?: Record<string, unknown>;
}

export async function createCase(db: Db, input: PiCaseInsert): Promise<PiCase> {
    const payload: Record<string, unknown> = {
        user_id: input.userId,
        client_name: input.clientName,
        client_name_normalized: normalizeClientName(input.clientName),
        case_number: input.caseNumber ?? null,
        project_id: input.projectId ?? null,
        date_of_loss: input.dateOfLoss ?? null,
        attributes: input.attributes ?? {},
    };
    // Omitted status/origin/needs_review fall through to the column defaults.
    if (input.status !== undefined) payload.status = input.status;
    if (input.origin !== undefined) payload.origin = input.origin;
    if (input.needsReview !== undefined) payload.needs_review = input.needsReview;

    const { data, error } = await db
        .from("pi_cases")
        .insert(payload)
        .select("*")
        .single();
    if (error) throw error;
    return serializeCase(data as Record<string, unknown>);
}

export async function getCase(
    db: Db,
    userId: string,
    id: string,
): Promise<PiCase | null> {
    const { data, error } = await db
        .from("pi_cases")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw error;
    return data ? serializeCase(data as Record<string, unknown>) : null;
}

export async function listCases(
    db: Db,
    userId: string,
    filters?: {
        status?: PiCaseStatus;
        search?: string;
        needsReview?: boolean;
        limit?: number;
        offset?: number;
    },
): Promise<PiCase[]> {
    const limit = Math.min(filters?.limit ?? 50, 100);
    const offset = Math.max(0, filters?.offset ?? 0);
    let query = db
        .from("pi_cases")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);
    if (filters?.status) query = query.eq("status", filters.status);
    if (filters?.needsReview !== undefined)
        query = query.eq("needs_review", filters.needsReview);
    if (filters?.search) {
        // Strip PostgREST or() delimiters so a user-typed term can't break
        // the filter expression; match the normalized name (same key the
        // matcher uses) or the raw case number.
        const term = filters.search.replace(/[,()]/g, " ").trim();
        const normalized = normalizeClientName(term);
        if (term) {
            const conditions = [`case_number.ilike.%${term}%`];
            if (normalized)
                conditions.unshift(
                    `client_name_normalized.ilike.%${normalized}%`,
                );
            query = query.or(conditions.join(","));
        }
    }
    const { data, error } = await query;
    if (error) throw error;
    return ((data as Record<string, unknown>[] | null) ?? []).map(
        serializeCase,
    );
}

export interface PiCasePatch {
    clientName?: string;
    caseNumber?: string | null;
    projectId?: string | null;
    dateOfLoss?: string | null;
    status?: PiCaseStatus;
    origin?: PiCaseOrigin;
    needsReview?: boolean;
    attributes?: Record<string, unknown>;
}

function casePatchToUpdate(patch: PiCasePatch): Record<string, unknown> {
    const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (patch.clientName !== undefined) {
        update.client_name = patch.clientName;
        // The normalized key must never drift from the display name.
        update.client_name_normalized = normalizeClientName(patch.clientName);
    }
    if (patch.caseNumber !== undefined) update.case_number = patch.caseNumber;
    if (patch.projectId !== undefined) update.project_id = patch.projectId;
    if (patch.dateOfLoss !== undefined) update.date_of_loss = patch.dateOfLoss;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.origin !== undefined) update.origin = patch.origin;
    if (patch.needsReview !== undefined) update.needs_review = patch.needsReview;
    if (patch.attributes !== undefined) update.attributes = patch.attributes;
    return update;
}

export async function updateCase(
    db: Db,
    userId: string,
    id: string,
    patch: PiCasePatch,
): Promise<PiCase | null> {
    const { data, error } = await db
        .from("pi_cases")
        .update(casePatchToUpdate(patch))
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();
    if (error) throw error;
    return data ? serializeCase(data as Record<string, unknown>) : null;
}

/** One CSV-import row. `attributes` carries extra columns that have no
 * dedicated pi_cases column; they merge into the case's attributes. */
export interface PiCaseImportRow {
    caseNumber: string;
    clientName?: string;
    projectId?: string | null;
    dateOfLoss?: string | null;
    status?: PiCaseStatus;
    needsReview?: boolean;
    attributes?: Record<string, unknown>;
}

async function findCaseByCaseNumber(
    db: Db,
    userId: string,
    caseNumber: string,
): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
    const { data, error } = await db
        .from("pi_cases")
        .select("id, attributes")
        .eq("user_id", userId)
        .eq("case_number", caseNumber)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { id: string; attributes: Record<string, unknown> | null };
    return { id: row.id, attributes: row.attributes ?? {} };
}

async function applyImportUpdate(
    db: Db,
    userId: string,
    existing: { id: string; attributes: Record<string, unknown> },
    row: PiCaseImportRow,
): Promise<string> {
    // Only overwrite what the import row actually provides; a re-import must
    // never blank fields the user filled in by hand. origin is untouched on
    // purpose — updating a case does not rewrite where it came from.
    const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (row.clientName !== undefined) {
        update.client_name = row.clientName;
        update.client_name_normalized = normalizeClientName(row.clientName);
    }
    if (row.projectId !== undefined) update.project_id = row.projectId;
    if (row.dateOfLoss !== undefined) update.date_of_loss = row.dateOfLoss;
    if (row.status !== undefined) update.status = row.status;
    if (row.needsReview !== undefined) update.needs_review = row.needsReview;
    if (row.attributes !== undefined) {
        update.attributes = { ...existing.attributes, ...row.attributes };
    }
    const { error } = await db
        .from("pi_cases")
        .update(update)
        .eq("id", existing.id)
        .eq("user_id", userId);
    if (error) throw error;
    return existing.id;
}

/**
 * Idempotent CSV-import upsert keyed on (user_id, case_number): update the
 * existing case (only the provided fields; attributes merge) or create a new
 * one with origin 'csv_import'. An insert that loses a concurrent-import race
 * on the unique index converges on updating the winner's row.
 */
export async function upsertCaseFromImport(
    db: Db,
    userId: string,
    row: PiCaseImportRow,
): Promise<{ id: string; action: "created" | "updated" }> {
    const caseNumber = row.caseNumber.trim();
    if (!caseNumber) {
        throw new Error("upsertCaseFromImport: caseNumber is required");
    }

    const existing = await findCaseByCaseNumber(db, userId, caseNumber);
    if (existing) {
        const id = await applyImportUpdate(db, userId, existing, row);
        return { id, action: "updated" };
    }

    const clientName = row.clientName?.trim();
    if (!clientName) {
        // pi_cases.client_name is NOT NULL — refuse loudly rather than
        // creating a case named "".
        throw new Error(
            "upsertCaseFromImport: clientName is required to create a new case",
        );
    }
    const payload: Record<string, unknown> = {
        user_id: userId,
        case_number: caseNumber,
        client_name: clientName,
        client_name_normalized: normalizeClientName(clientName),
        origin: "csv_import",
        attributes: row.attributes ?? {},
    };
    if (row.projectId !== undefined) payload.project_id = row.projectId;
    if (row.dateOfLoss !== undefined) payload.date_of_loss = row.dateOfLoss;
    if (row.status !== undefined) payload.status = row.status;
    if (row.needsReview !== undefined) payload.needs_review = row.needsReview;

    const { data, error } = await db
        .from("pi_cases")
        .insert(payload)
        .select("id")
        .single();
    if (!error && data) {
        return { id: (data as { id: string }).id, action: "created" };
    }
    if (isUniqueViolation(error)) {
        // Lost a concurrent-import race — the row exists now; update it.
        const raced = await findCaseByCaseNumber(db, userId, caseNumber);
        if (raced) {
            const id = await applyImportUpdate(db, userId, raced, row);
            return { id, action: "updated" };
        }
    }
    throw error ?? new Error("upsertCaseFromImport: insert returned no row");
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface PiCasePolicyInput {
    carrier: string;
    claimNumber?: string | null;
    policyNumber?: string | null;
    coverageType?: string | null;
    policyLimits?: Record<string, unknown>;
    adjuster?: Record<string, unknown>;
    effectiveDates?: unknown;
    sourceDocumentId?: string | null;
    sourceRunId?: string | null;
    details?: Record<string, unknown>;
}

export async function listPoliciesForCase(
    db: Db,
    caseId: string,
): Promise<PiCasePolicy[]> {
    const { data, error } = await db
        .from("pi_case_policies")
        .select("*")
        .eq("case_id", caseId)
        .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as Record<string, unknown>[] | null) ?? []).map(
        serializePolicy,
    );
}

async function findPolicyIdByCaseAndClaim(
    db: Db,
    caseId: string,
    claimNumber: string,
): Promise<string | null> {
    const { data, error } = await db
        .from("pi_case_policies")
        .select("id")
        .eq("case_id", caseId)
        .eq("claim_number", claimNumber)
        .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
}

/** Overwrite ONLY the provided fields on an existing policy row. */
async function updatePolicyById(
    db: Db,
    id: string,
    input: PiCasePolicyInput,
): Promise<PiCasePolicy> {
    const update: Record<string, unknown> = {
        carrier: input.carrier,
        updated_at: new Date().toISOString(),
    };
    if (input.policyNumber !== undefined)
        update.policy_number = input.policyNumber;
    if (input.coverageType !== undefined)
        update.coverage_type = input.coverageType;
    if (input.policyLimits !== undefined)
        update.policy_limits = input.policyLimits;
    if (input.adjuster !== undefined) update.adjuster = input.adjuster;
    if (input.effectiveDates !== undefined)
        update.effective_dates = input.effectiveDates;
    if (input.sourceDocumentId !== undefined)
        update.source_document_id = input.sourceDocumentId;
    if (input.sourceRunId !== undefined)
        update.source_run_id = input.sourceRunId;
    if (input.details !== undefined) update.details = input.details;

    const { data, error } = await db
        .from("pi_case_policies")
        .update(update)
        .eq("id", id)
        .select("*")
        .single();
    if (error) throw error;
    return serializePolicy(data as Record<string, unknown>);
}

/**
 * Insert a policy, or update the existing row when the case already has one
 * with the same non-null claim_number (re-processing the same claim
 * correspondence must not stack duplicate policies). On update, only the
 * provided fields are overwritten. The lookup-then-insert is backstopped by
 * the pi_case_policies_case_claim_unique index: an insert that loses a
 * concurrent race converges on updating the winner's row, like
 * upsertCaseFromImport.
 */
export async function upsertPolicy(
    db: Db,
    caseId: string,
    input: PiCasePolicyInput,
): Promise<PiCasePolicy> {
    const claimNumber = input.claimNumber?.trim() || null;

    if (claimNumber) {
        const existingId = await findPolicyIdByCaseAndClaim(
            db,
            caseId,
            claimNumber,
        );
        if (existingId) return updatePolicyById(db, existingId, input);
    }

    const { data, error } = await db
        .from("pi_case_policies")
        .insert({
            case_id: caseId,
            carrier: input.carrier,
            claim_number: claimNumber,
            policy_number: input.policyNumber ?? null,
            coverage_type: input.coverageType ?? null,
            policy_limits: input.policyLimits ?? {},
            adjuster: input.adjuster ?? {},
            effective_dates: input.effectiveDates ?? null,
            source_document_id: input.sourceDocumentId ?? null,
            source_run_id: input.sourceRunId ?? null,
            details: input.details ?? {},
        })
        .select("*")
        .single();
    if (!error && data) return serializePolicy(data as Record<string, unknown>);
    if (claimNumber && isUniqueViolation(error)) {
        // Lost a concurrent race on (case_id, claim_number) — the winner's
        // row exists now; apply this input as an update to it.
        const racedId = await findPolicyIdByCaseAndClaim(
            db,
            caseId,
            claimNumber,
        );
        if (racedId) return updatePolicyById(db, racedId, input);
    }
    throw error ?? new Error("upsertPolicy: insert returned no row");
}

/**
 * Resolve which of the user's cases a claim number belongs to, via
 * pi_case_policies joined to pi_cases — the inner join is what scopes the
 * lookup to the calling user's tenancy. Newest policy wins if the same claim
 * number somehow appears on several rows.
 */
export async function findCaseIdByClaimNumber(
    db: Db,
    userId: string,
    claimNumber: string,
): Promise<string | null> {
    const trimmed = claimNumber.trim();
    if (!trimmed) return null;
    const { data, error } = await db
        .from("pi_case_policies")
        .select("case_id, pi_cases!inner(user_id)")
        .eq("claim_number", trimmed)
        .eq("pi_cases.user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);
    if (error) throw error;
    const row = (data as { case_id: string }[] | null)?.[0];
    return row?.case_id ?? null;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export interface PiCaseExpenseInsert {
    userId: string;
    vendor: string;
    caseId?: string | null;
    invoiceNumber?: string | null;
    amountCents?: number | null;
    currency?: string;
    status?: PiExpenseStatus;
    paymentPortalUrl?: string | null;
    documentId?: string | null;
    agentOperationId?: string | null;
    automationRunId?: string | null;
    incurredAt?: string | null;
    notes?: string | null;
    metadata?: Record<string, unknown>;
}

export async function insertExpense(
    db: Db,
    input: PiCaseExpenseInsert,
): Promise<PiCaseExpense> {
    const payload: Record<string, unknown> = {
        user_id: input.userId,
        vendor: input.vendor,
        case_id: input.caseId ?? null,
        invoice_number: input.invoiceNumber ?? null,
        amount_cents: input.amountCents ?? null,
        payment_portal_url: input.paymentPortalUrl ?? null,
        document_id: input.documentId ?? null,
        agent_operation_id: input.agentOperationId ?? null,
        automation_run_id: input.automationRunId ?? null,
        incurred_at: input.incurredAt ?? null,
        notes: input.notes ?? null,
        metadata: input.metadata ?? {},
    };
    // Omitted currency/status fall through to the column defaults.
    if (input.currency !== undefined) payload.currency = input.currency;
    if (input.status !== undefined) payload.status = input.status;

    const { data, error } = await db
        .from("pi_case_expenses")
        .insert(payload)
        .select("*")
        .single();
    if (error) throw error;
    return serializeExpense(data as Record<string, unknown>);
}

/**
 * The expense a given automation run already staged, if any — the
 * idempotency lookup that lets stageInvoiceRun re-enter after a crash
 * without tripping the (user_id, vendor, invoice_number) unique index and
 * mis-reporting its own earlier insert as a duplicate invoice.
 */
export async function findExpenseByRunId(
    db: Db,
    userId: string,
    automationRunId: string,
): Promise<PiCaseExpense | null> {
    const { data, error } = await db
        .from("pi_case_expenses")
        .select("*")
        .eq("user_id", userId)
        .eq("automation_run_id", automationRunId)
        .order("created_at", { ascending: true })
        .limit(1);
    if (error) throw error;
    const row = (data as Record<string, unknown>[] | null)?.[0];
    return row ? serializeExpense(row) : null;
}

/** One expense, scoped to the owning user (tenancy mirror of getCase). */
export async function getExpense(
    db: Db,
    userId: string,
    id: string,
): Promise<PiCaseExpense | null> {
    const { data, error } = await db
        .from("pi_case_expenses")
        .select("*")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
    if (error) throw error;
    return data ? serializeExpense(data as Record<string, unknown>) : null;
}

export async function listExpensesForCase(
    db: Db,
    caseId: string,
): Promise<PiCaseExpense[]> {
    const { data, error } = await db
        .from("pi_case_expenses")
        .select("*")
        .eq("case_id", caseId)
        .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as Record<string, unknown>[] | null) ?? []).map(
        serializeExpense,
    );
}

export interface PiCaseExpensePatch {
    caseId?: string | null;
    vendor?: string;
    invoiceNumber?: string | null;
    amountCents?: number | null;
    currency?: string;
    status?: PiExpenseStatus;
    paymentPortalUrl?: string | null;
    documentId?: string | null;
    agentOperationId?: string | null;
    automationRunId?: string | null;
    incurredAt?: string | null;
    paidAt?: string | null;
    paidBy?: string | null;
    notes?: string | null;
    metadata?: Record<string, unknown>;
}

/**
 * Patch an expense (scoped to the owning user); always bumps updated_at.
 * Transitioning status to 'paid' stamps paid_at (now, unless the patch
 * carries an explicit paidAt) and paid_by from the patch.
 */
export async function updateExpense(
    db: Db,
    userId: string,
    id: string,
    patch: PiCaseExpensePatch,
): Promise<PiCaseExpense | null> {
    const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
    };
    if (patch.caseId !== undefined) update.case_id = patch.caseId;
    if (patch.vendor !== undefined) update.vendor = patch.vendor;
    if (patch.invoiceNumber !== undefined)
        update.invoice_number = patch.invoiceNumber;
    if (patch.amountCents !== undefined) update.amount_cents = patch.amountCents;
    if (patch.currency !== undefined) update.currency = patch.currency;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.paymentPortalUrl !== undefined)
        update.payment_portal_url = patch.paymentPortalUrl;
    if (patch.documentId !== undefined) update.document_id = patch.documentId;
    if (patch.agentOperationId !== undefined)
        update.agent_operation_id = patch.agentOperationId;
    if (patch.automationRunId !== undefined)
        update.automation_run_id = patch.automationRunId;
    if (patch.incurredAt !== undefined) update.incurred_at = patch.incurredAt;
    if (patch.paidAt !== undefined) update.paid_at = patch.paidAt;
    if (patch.paidBy !== undefined) update.paid_by = patch.paidBy;
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.metadata !== undefined) update.metadata = patch.metadata;

    if (patch.status === "paid" && update.paid_at === undefined) {
        update.paid_at = new Date().toISOString();
    }

    const { data, error } = await db
        .from("pi_case_expenses")
        .update(update)
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .maybeSingle();
    if (error) throw error;
    return data ? serializeExpense(data as Record<string, unknown>) : null;
}
