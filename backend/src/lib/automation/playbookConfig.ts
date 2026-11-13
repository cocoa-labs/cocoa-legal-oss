// backend/src/lib/automation/playbookConfig.ts
//
// Typed resolution of the pi.* playbook entries the pipeline consumes.
// getEffectivePlaybookEntries returns raw {key → entry} rows (firm override
// falling back to the default-shared seed); resolvePlaybookConfig turns
// them into one validated config object — and any missing or unparseable
// REQUIRED key comes back as {ok:false, key} so the pipeline can park the
// run in triage ("playbook misconfigured: <key>") instead of crash-looping
// or classifying against garbage.

import type { createServerSupabase } from "../supabase";
import {
    getEffectivePlaybookEntries,
    resolveFirmId,
    type PlaybookEntry,
} from "../playbooks";
import { PI_PLAYBOOK_KEYS } from "../legalCapabilities/piProfiles";
import { parseRegistry, type RegistryEntry } from "./classify";
import type { MatchThresholds } from "./match";

type Db = ReturnType<typeof createServerSupabase>;

export interface ConfidenceThresholds {
    extractionMin: number;
    fieldMin: number;
    matchAuto: number;
    matchConfirm: number;
}

export interface PlaybookConfig {
    carriers: RegistryEntry[];
    vendors: RegistryEntry[];
    claimsGuidance: string;
    invoiceGuidance: string;
    ackTemplate: string;
    signatureBlock: string;
    /** May be "" — the seed ships it empty and expects a firm override. */
    replyTo: string;
    thresholds: ConfidenceThresholds;
    matchingMinScore: number;
    /** Dollar threshold above which an expense is flagged; null = never. */
    expenseFlagAboveUsd: number | null;
}

export type ResolvedPlaybook =
    | { ok: true; config: PlaybookConfig }
    | { ok: false; key: string; detail: string };

/** The MatchThresholds view of a resolved config (match.ts input). */
export function matchThresholds(config: PlaybookConfig): MatchThresholds {
    return {
        matchAuto: config.thresholds.matchAuto,
        matchConfirm: config.thresholds.matchConfirm,
        minScore: config.matchingMinScore,
    };
}

function bad(key: string, detail: string): ResolvedPlaybook {
    return { ok: false, key, detail };
}

function stringValue(entry: PlaybookEntry | undefined): string | null {
    return entry && typeof entry.value_json === "string"
        ? entry.value_json
        : null;
}

function numberIn01(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
        ? v
        : null;
}

/**
 * Validate the raw playbook entries into a PlaybookConfig. Required keys:
 * both registries, both extraction guidances, the ack template + signature
 * block, confidence_thresholds, and matching_rules. Optional with safe
 * defaults: reply_to ("" → no Reply-To header) and
 * expense_approval_threshold (null → nothing flagged).
 */
export function resolvePlaybookConfig(
    entries: Record<string, PlaybookEntry>,
): ResolvedPlaybook {
    let carriers: RegistryEntry[];
    let vendors: RegistryEntry[];
    try {
        const entry = entries["pi.claims.carrier_registry"];
        if (!entry) throw new Error("entry missing");
        carriers = parseRegistry(
            entry.value_json,
            "pi.claims.carrier_registry",
        );
    } catch (err) {
        return bad("pi.claims.carrier_registry", String((err as Error).message));
    }
    try {
        const entry = entries["pi.invoices.vendor_registry"];
        if (!entry) throw new Error("entry missing");
        vendors = parseRegistry(
            entry.value_json,
            "pi.invoices.vendor_registry",
        );
    } catch (err) {
        return bad("pi.invoices.vendor_registry", String((err as Error).message));
    }

    const claimsGuidance = stringValue(entries["pi.claims.extraction_guidance"]);
    if (claimsGuidance === null) {
        return bad("pi.claims.extraction_guidance", "missing or not a string");
    }
    const invoiceGuidance = stringValue(
        entries["pi.invoices.extraction_guidance"],
    );
    if (invoiceGuidance === null) {
        return bad("pi.invoices.extraction_guidance", "missing or not a string");
    }
    const ackTemplate = stringValue(entries["pi.claims.ack_template"]);
    if (ackTemplate === null) {
        return bad("pi.claims.ack_template", "missing or not a string");
    }
    const signatureBlock = stringValue(entries["pi.claims.signature_block"]);
    if (signatureBlock === null) {
        return bad("pi.claims.signature_block", "missing or not a string");
    }

    // reply_to: optional — absent counts as "", but a present non-string
    // value is a misconfiguration.
    let replyTo = "";
    const replyToEntry = entries["pi.claims.reply_to"];
    if (replyToEntry) {
        const value = stringValue(replyToEntry);
        if (value === null) return bad("pi.claims.reply_to", "not a string");
        replyTo = value.trim();
    }

    const thresholdsEntry = entries["pi.automation.confidence_thresholds"];
    const rawThresholds =
        thresholdsEntry &&
        thresholdsEntry.value_json &&
        typeof thresholdsEntry.value_json === "object" &&
        !Array.isArray(thresholdsEntry.value_json)
            ? (thresholdsEntry.value_json as Record<string, unknown>)
            : null;
    const extractionMin = numberIn01(rawThresholds?.extraction_min);
    const fieldMin = numberIn01(rawThresholds?.field_min);
    const matchAuto = numberIn01(rawThresholds?.match_auto);
    const matchConfirm = numberIn01(rawThresholds?.match_confirm);
    if (
        extractionMin === null ||
        fieldMin === null ||
        matchAuto === null ||
        matchConfirm === null
    ) {
        return bad(
            "pi.automation.confidence_thresholds",
            "missing or not an object of 0–1 numbers (extraction_min, field_min, match_auto, match_confirm)",
        );
    }

    const rulesEntry = entries["pi.cases.matching_rules"];
    const rawRules =
        rulesEntry &&
        rulesEntry.value_json &&
        typeof rulesEntry.value_json === "object" &&
        !Array.isArray(rulesEntry.value_json)
            ? (rulesEntry.value_json as Record<string, unknown>)
            : null;
    const minScore = numberIn01(rawRules?.min_score);
    if (minScore === null) {
        return bad(
            "pi.cases.matching_rules",
            "missing or not an object with a 0–1 min_score",
        );
    }

    // expense threshold: optional — absent means "never flag", but a
    // present malformed value is a misconfiguration.
    let expenseFlagAboveUsd: number | null = null;
    const expenseEntry = entries["pi.invoices.expense_approval_threshold"];
    if (expenseEntry) {
        const raw =
            expenseEntry.value_json &&
            typeof expenseEntry.value_json === "object" &&
            !Array.isArray(expenseEntry.value_json)
                ? (expenseEntry.value_json as Record<string, unknown>)
                : null;
        const flagAbove = raw?.flag_above_usd;
        if (
            typeof flagAbove !== "number" ||
            !Number.isFinite(flagAbove) ||
            flagAbove < 0
        ) {
            return bad(
                "pi.invoices.expense_approval_threshold",
                "flag_above_usd missing or not a non-negative number",
            );
        }
        expenseFlagAboveUsd = flagAbove;
    }

    return {
        ok: true,
        config: {
            carriers,
            vendors,
            claimsGuidance,
            invoiceGuidance,
            ackTemplate,
            signatureBlock,
            replyTo,
            thresholds: { extractionMin, fieldMin, matchAuto, matchConfirm },
            matchingMinScore: minScore,
            expenseFlagAboveUsd,
        },
    };
}

/**
 * Load + resolve the effective pi.* playbook for a user (firmId = userId in
 * v1 via resolveFirmId). One batched read per run — the pipeline resolves
 * this once and threads the config through every step.
 */
export async function loadPlaybookConfig(
    db: Db,
    userId: string,
): Promise<ResolvedPlaybook> {
    const firmId = await resolveFirmId(userId);
    const entries = await getEffectivePlaybookEntries(db, firmId, [
        ...PI_PLAYBOOK_KEYS,
    ]);
    return resolvePlaybookConfig(entries);
}
