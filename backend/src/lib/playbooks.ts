// backend/src/lib/playbooks.ts
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * The seed firm whose playbook holds the shipped Anthropic defaults.
 * Every firm inherits these entries unless it has set its own override
 * for the same key. Seeded by a migration in a later phase.
 */
export const DEFAULT_SHARED_FIRM_ID = "default-shared";

export interface PlaybookEntry {
    id: string;
    playbook_id: string;
    key: string;
    value_json: unknown;
    notes_md: string;
    is_default: boolean;
    updated_by: string;
    updated_at: string;
}

/**
 * Loud fallback firm slug used only when FIRM_ID is unset. Never a
 * per-user id — every user of a deployment shares ONE firm.
 */
const FALLBACK_FIRM_ID = "pilot-firm";

/**
 * Resolve which firm the calling user belongs to. Single-firm model:
 * every user of a deployment is a colleague of ONE firm, so this returns
 * the deployment's shared firm slug from `process.env.FIRM_ID` for
 * everyone — never the per-user id. `firm_playbooks.firm_id` (and the
 * templates `firm_id`) are TEXT, so a human-readable slug is a valid key
 * and nothing needs the org UUID. When FIRM_ID is unset we fall back
 * loudly to `pilot-firm` rather than silently scoping per-user (which
 * would fragment the shared playbook/memory) or writing onto the
 * `default-shared` seed baseline. The `userId` argument is retained for
 * signature stability and a future per-user→firm membership lookup.
 */
export async function resolveFirmId(userId: string): Promise<string> {
    void userId;
    const id = process.env.FIRM_ID?.trim();
    if (!id) {
        console.error(
            `[firm] FIRM_ID is unset — falling back to '${FALLBACK_FIRM_ID}'. ` +
                `Set FIRM_ID to the deployment's firm slug so shared playbook/memory is stable.`,
        );
    }
    return id || FALLBACK_FIRM_ID;
}

/**
 * Internal: get-or-create the firm_playbooks row for a firm. Idempotent.
 */
async function ensurePlaybook(db: Db, firmId: string): Promise<string> {
    const existing = await db
        .from("firm_playbooks")
        .select("id")
        .eq("firm_id", firmId)
        .maybeSingle();
    if (existing.error) {
        throw new Error(
            `Failed to read firm_playbooks row: ${existing.error.message}`,
        );
    }
    if (existing.data) return (existing.data as { id: string }).id;

    const inserted = await db
        .from("firm_playbooks")
        .insert({ firm_id: firmId, updated_by: firmId })
        .select("id")
        .single();
    if (inserted.error || !inserted.data) {
        throw new Error(
            `Failed to create firm_playbooks row: ${inserted.error?.message ?? "unknown"}`,
        );
    }
    return (inserted.data as { id: string }).id;
}

export async function getPlaybookEntry(
    db: Db,
    firmId: string,
    key: string,
): Promise<PlaybookEntry | null> {
    const playbookId = await ensurePlaybook(db, firmId);
    const { data, error } = await db
        .from("playbook_entries")
        .select("*")
        .eq("playbook_id", playbookId)
        .eq("key", key)
        .maybeSingle();
    if (error) {
        throw new Error(`Failed to read playbook entry: ${error.message}`);
    }
    return (data as PlaybookEntry | null) ?? null;
}

export async function getPlaybookEntries(
    db: Db,
    firmId: string,
    keys: string[],
): Promise<Record<string, PlaybookEntry>> {
    if (keys.length === 0) return {};
    const playbookId = await ensurePlaybook(db, firmId);
    const { data, error } = await db
        .from("playbook_entries")
        .select("*")
        .eq("playbook_id", playbookId)
        .in("key", keys);
    if (error) {
        throw new Error(`Failed to read playbook entries: ${error.message}`);
    }
    const out: Record<string, PlaybookEntry> = {};
    for (const row of (data as PlaybookEntry[] | null) ?? []) {
        out[row.key] = row;
    }
    return out;
}

/**
 * Resolve the effective playbook entries for a firm across `keys`, with
 * fallback to the `default-shared` seed firm. Firm-specific overrides win;
 * any key the firm hasn't set falls back to the seeded default; a key
 * absent from BOTH is omitted from the result (the caller decides how to
 * handle a genuine miss — e.g. substitute() warns and blanks it).
 *
 * Stays batched: one read for the firm, and at most one additional read
 * for the still-missing keys against the seed firm (no per-key queries).
 */
export async function getEffectivePlaybookEntries(
    db: Db,
    firmId: string,
    keys: string[],
): Promise<Record<string, PlaybookEntry>> {
    if (keys.length === 0) return {};

    const firmEntries = await getPlaybookEntries(db, firmId, keys);

    // The seed firm is its own baseline — no further fallback exists.
    if (firmId === DEFAULT_SHARED_FIRM_ID) return firmEntries;

    const missing = keys.filter((k) => !(k in firmEntries));
    if (missing.length === 0) return firmEntries;

    const defaults = await getPlaybookEntries(
        db,
        DEFAULT_SHARED_FIRM_ID,
        missing,
    );
    // Firm entries take precedence; defaults fill only the gaps.
    return { ...defaults, ...firmEntries };
}

export async function setPlaybookEntry(
    db: Db,
    firmId: string,
    key: string,
    args: { value: unknown; notes_md?: string },
): Promise<void> {
    const playbookId = await ensurePlaybook(db, firmId);
    // Atomic upsert on the (playbook_id, key) unique index
    // (playbook_entries_key_unique in 005_firm_playbooks.sql) so a
    // concurrent double-write collapses to a single row. updated_at is
    // left to the column default in 005.
    const { error } = await db.from("playbook_entries").upsert(
        {
            playbook_id: playbookId,
            key,
            value_json: args.value,
            notes_md: args.notes_md ?? "",
            is_default: false,
            updated_by: firmId,
        },
        { onConflict: "playbook_id,key" },
    );
    if (error) {
        throw new Error(`Failed to upsert playbook entry: ${error.message}`);
    }
}

export async function listPlaybookEntries(
    db: Db,
    firmId: string,
): Promise<PlaybookEntry[]> {
    const existing = await db
        .from("firm_playbooks")
        .select("id")
        .eq("firm_id", firmId)
        .maybeSingle();
    if (existing.error) {
        throw new Error(
            `Failed to read firm_playbooks row: ${existing.error.message}`,
        );
    }
    if (!existing.data) return [];
    const playbookId = (existing.data as { id: string }).id;
    const { data, error } = await db
        .from("playbook_entries")
        .select("*")
        .eq("playbook_id", playbookId);
    if (error) {
        throw new Error(`Failed to list playbook entries: ${error.message}`);
    }
    return (data as PlaybookEntry[] | null) ?? [];
}

export async function deletePlaybookEntry(
    db: Db,
    firmId: string,
    key: string,
): Promise<void> {
    const playbookId = await ensurePlaybook(db, firmId);
    const { error } = await db
        .from("playbook_entries")
        .delete()
        .eq("playbook_id", playbookId)
        .eq("key", key);
    if (error) {
        throw new Error(`Failed to delete playbook entry: ${error.message}`);
    }
}
