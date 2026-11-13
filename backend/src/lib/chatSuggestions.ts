// backend/src/lib/chatSuggestions.ts
//
// Per-chat, per-user state for capability suggestion chips, plus the request
// parsing for the endpoint that changes it. Everything here is PURE: the
// route owns the queries, this module owns the shape of the
// `chats.suggestion_settings` JSONB column (migration 042) and the rules for
// reading and merging it.
//
// The column is shared by everyone who can open the chat, so a write must
// never clobber another user's entry — hence the `by_user` map and the
// merge-not-replace helper below. Every read tolerates a missing or garbage
// value: the column defaults to `{}`, older rows predate it entirely, and a
// suggestion chip is never worth a 500.

/** One user's suggestion state for one chat. */
export interface UserSuggestionSettings {
    /** True when the user muted suggestions for this whole chat. */
    suppressed: boolean;
    /** Capabilities this user dismissed in this chat; never re-proposed. */
    dismissedCapabilityIds: string[];
}

const EMPTY_SETTINGS: UserSuggestionSettings = {
    suppressed: false,
    dismissedCapabilityIds: [],
};

/** Registry ids are kebab-case; the same shape the capability modules use. */
const CAPABILITY_ID = /^[a-z][a-z0-9-]{2,63}$/;
const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * Read one user's entry out of a chat row's `suggestion_settings`.
 * A missing column, a non-object value, a missing `by_user` map or a garbage
 * entry all read as "firm defaults apply".
 */
export function readSuggestionSettings(
    row: Record<string, unknown> | null | undefined,
    userId: string,
): UserSuggestionSettings {
    const settings = asRecord(row?.suggestion_settings);
    const byUser = asRecord(settings?.by_user);
    const entry = asRecord(byUser?.[userId]);
    if (!entry) return { ...EMPTY_SETTINGS, dismissedCapabilityIds: [] };

    const rawIds = Array.isArray(entry.dismissed_capability_ids)
        ? entry.dismissed_capability_ids
        : [];
    return {
        suppressed: entry.suppressed === true,
        dismissedCapabilityIds: [
            ...new Set(
                rawIds.filter(
                    (id): id is string => typeof id === "string" && id.length > 0,
                ),
            ),
        ],
    };
}

export type SuggestionAction = "dismiss" | "suppress" | "unsuppress";

const ACTIONS: readonly SuggestionAction[] = ["dismiss", "suppress", "unsuppress"];

/**
 * Validate a `POST /chat/:chatId/suggestions` body. `capability_id` is
 * required for a dismiss and ignored otherwise (it means nothing for a
 * whole-chat mute); `proposal_id` is optional but must be a UUID when given,
 * so a malformed client can't write junk into the audit trail.
 */
export function parseSuggestionAction(
    body: unknown,
):
    | {
          ok: true;
          action: SuggestionAction;
          capabilityId: string | null;
          proposalId: string | null;
      }
    | { ok: false; detail: string } {
    const record = asRecord(body);
    if (!record) return { ok: false, detail: "body must be a JSON object" };

    const action = record.action;
    if (
        typeof action !== "string" ||
        !ACTIONS.includes(action as SuggestionAction)
    ) {
        return {
            ok: false,
            detail: `action must be one of ${ACTIONS.join(", ")}`,
        };
    }

    let capabilityId: string | null = null;
    if (action === "dismiss") {
        const raw = record.capability_id;
        if (typeof raw !== "string" || !CAPABILITY_ID.test(raw)) {
            return {
                ok: false,
                detail: "capability_id must be a kebab-case capability id",
            };
        }
        capabilityId = raw;
    }

    let proposalId: string | null = null;
    if (record.proposal_id !== undefined && record.proposal_id !== null) {
        const raw = record.proposal_id;
        if (typeof raw !== "string" || !UUID.test(raw)) {
            return { ok: false, detail: "proposal_id must be a uuid" };
        }
        proposalId = raw;
    }

    return { ok: true, action: action as SuggestionAction, capabilityId, proposalId };
}

/**
 * Build the new `suggestion_settings` value for one user's action, preserving
 * every other user's entry (and any unrecognised top-level key). Never
 * mutates its input.
 */
export function mergeSuggestionSettings(
    existing: unknown,
    userId: string,
    action: SuggestionAction,
    capabilityId: string | null,
): Record<string, unknown> {
    const settings = asRecord(existing) ?? {};
    const byUser = asRecord(settings.by_user) ?? {};
    const entry = { ...(asRecord(byUser[userId]) ?? {}) };

    if (action === "dismiss" && capabilityId) {
        const current = Array.isArray(entry.dismissed_capability_ids)
            ? entry.dismissed_capability_ids.filter(
                  (id): id is string => typeof id === "string" && id.length > 0,
              )
            : [];
        entry.dismissed_capability_ids = [
            ...new Set([...current, capabilityId]),
        ];
    } else if (action === "suppress") {
        entry.suppressed = true;
    } else if (action === "unsuppress") {
        delete entry.suppressed;
    }

    return { ...settings, by_user: { ...byUser, [userId]: entry } };
}

/**
 * The tenancy scope an audit event for this chat belongs to. Only string ids
 * are carried through — a null or a mistyped column is simply absent.
 */
export function chatAuditScope(
    row: Record<string, unknown> | null | undefined,
): { orgId?: string; matterId?: string; projectId?: string } {
    const scope: { orgId?: string; matterId?: string; projectId?: string } = {};
    if (typeof row?.org_id === "string") scope.orgId = row.org_id;
    if (typeof row?.matter_id === "string") scope.matterId = row.matter_id;
    if (typeof row?.project_id === "string") scope.projectId = row.project_id;
    return scope;
}

/**
 * Capability ids that already produced a COMPLETE result in this
 * conversation. Re-proposing one is the most annoying kind of wrong
 * suggestion, so the orchestrator excludes them.
 *
 * The `capability_result` assistant event is introduced by a later task, so
 * the scan is deliberately generic: any element of an assistant message's
 * content array shaped `{ type: "capability_result", status: "complete",
 * capability_id: string }` counts, and anything else is ignored.
 */
export function alreadyRunCapabilityIds(
    episodes: ReadonlyArray<{ assistants: ReadonlyArray<{ content?: unknown }> }>,
): Set<string> {
    const ids = new Set<string>();
    for (const episode of episodes) {
        for (const assistant of episode.assistants ?? []) {
            const content = assistant?.content;
            if (!Array.isArray(content)) continue;
            for (const raw of content) {
                const event = asRecord(raw);
                if (!event) continue;
                if (event.type !== "capability_result") continue;
                if (event.status !== "complete") continue;
                if (typeof event.capability_id !== "string") continue;
                ids.add(event.capability_id);
            }
        }
    }
    return ids;
}
