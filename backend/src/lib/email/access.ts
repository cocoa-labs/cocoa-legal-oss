// backend/src/lib/email/access.ts
//
// Read authorization for email_messages rows. Replaces the permissive
// canReadEmail rule (which let any authenticated user read every inbound email
// firm-wide — audit High, hardening batch 2) with a resource-scoped policy:
//
//   - A row the subject OWNS (email.user_id) is always readable.
//   - A row LINKED to a resource — signature envelope, chat, or project — is
//     readable only by users with access to that resource: the envelope owner,
//     the chat owner (or a member of the chat's project), or anyone with
//     authoritative matter membership via lib/access.ts.
//   - An UNLINKED inbound row (cold mail to the shared agent mailbox) stays
//     readable by any authenticated user — see the single-firm constant below.
//   - Anything else (another user's unlinked outbound draft) is private.
//
// These checks gate USER-facing reads only: GET /email, GET /email/:id, and
// the read_inbox / read_email chat tools. The ingest / auto-reply pipeline
// (lib/email/ingest.ts, autoReply.ts) runs as SERVICE context against the
// store directly and must never be routed through this policy.

import type { createServerSupabase } from "../supabase";
import { listAccessibleOrganizationIds, listAccessibleProjectIds } from "../access";
import type { EmailMessage } from "./store";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Single-firm assumption (project owner ratified, 2026-06): this deployment
 * serves ONE firm, so an inbound email that is not linked to any resource —
 * cold mail addressed to the shared agent mailbox — is treated as the firm's
 * communal inbox and is readable by every authenticated user. Multi-firm
 * hardening flips this to false (or replaces it with an org_id membership
 * check) in exactly this one place; every user-facing email read funnels
 * through canUserReadEmail / filterReadableEmails below.
 */
export const UNLINKED_INBOUND_IS_FIRM_READABLE = false;

/**
 * Batch read filter: returns the subset of `rows` the subject may read, in
 * input order. Linked resources (envelopes, chats) are prefetched with one
 * .in() query per table and project access resolves through the existing
 * lib/access.ts helper — never one query per row. A linked resource that no
 * longer exists denies (conservative: a link is a confidentiality claim we
 * cannot verify, so we do not fall back to the firm-inbox rule).
 */
export async function filterReadableEmails(
    db: Db,
    userId: string,
    rows: EmailMessage[],
    userEmail?: string | null,
): Promise<EmailMessage[]> {
    if (rows.length === 0) return [];

    // Resolve links for every row, including rows the caller originally
    // created. Removal from a matter must revoke linked email access
    // immediately; creator identity is not a fallback grant.
    const unresolved = rows;

    const envelopeIds = [
        ...new Set(
            unresolved
                .map((r) => r.signature_envelope_id)
                .filter((id): id is string => !!id),
        ),
    ];
    const chatIds = [
        ...new Set(
            unresolved
                .map((r) => r.chat_id)
                .filter((id): id is string => !!id),
        ),
    ];

    const [envelopeOwners, chatById] = await Promise.all([
        (async () => {
            const map = new Map<string, { user_id: string; project_id: string | null; org_id: string | null }>();
            if (envelopeIds.length === 0) return map;
            const { data } = await db
                .from("signature_envelopes")
                .select("id, user_id, project_id, org_id")
                .in("id", envelopeIds);
            for (const row of (data ?? []) as {
                id: string;
                user_id: string;
                project_id: string | null;
                org_id: string | null;
            }[]) {
                map.set(row.id, { user_id: row.user_id, project_id: row.project_id ?? null, org_id: row.org_id ?? null });
            }
            return map;
        })(),
        (async () => {
            const map = new Map<
                string,
                { user_id: string; project_id: string | null }
            >();
            if (chatIds.length === 0) return map;
            const { data } = await db
                .from("chats")
                .select("id, user_id, project_id")
                .in("id", chatIds);
            for (const row of (data ?? []) as {
                id: string;
                user_id: string;
                project_id: string | null;
            }[]) {
                map.set(row.id, {
                    user_id: row.user_id,
                    project_id: row.project_id ?? null,
                });
            }
            return map;
        })(),
    ]);

    // Projects come into play directly (email.project_id) or via the linked
    // chat's project (mirrors getAccessibleChat). Resolve the subject's full
    // accessible-project set once, through the shared helper.
    const needsProjects =
        unresolved.some((r) => r.project_id) ||
        [...chatById.values()].some((c) => c.project_id);
    const accessibleProjects = needsProjects
        ? new Set(await listAccessibleProjectIds(userId, userEmail, db))
        : new Set<string>();
    const needsOrganizations = unresolved.some((row) => row.org_id) || [...envelopeOwners.values()].some((envelope) => envelope.org_id);
    const accessibleOrganizations = needsOrganizations
        ? new Set(await listAccessibleOrganizationIds(userId, userEmail, db))
        : new Set<string>();

    const readable = (row: EmailMessage): boolean => {
        if (row.project_id)
            return accessibleProjects.has(row.project_id);
        if (row.signature_envelope_id) {
            const envelope = envelopeOwners.get(row.signature_envelope_id);
            if (!envelope) return false;
            if (envelope.project_id)
                return accessibleProjects.has(envelope.project_id);
            if (envelope.org_id)
                return accessibleOrganizations.has(envelope.org_id);
            return envelope.user_id === userId;
        }
        if (row.chat_id) {
            const chat = chatById.get(row.chat_id);
            if (!chat) return false;
            return chat.project_id
                ? accessibleProjects.has(chat.project_id)
                : chat.user_id === userId;
        }
        if (row.org_id)
            return accessibleOrganizations.has(row.org_id);
        return row.user_id === userId ||
            (UNLINKED_INBOUND_IS_FIRM_READABLE && row.direction === "inbound");
    };

    return rows.filter(readable);
}

/**
 * Single-row read check — same policy as filterReadableEmails (it delegates,
 * so the two can never drift). Gates GET /email/:id and the read_email tool.
 */
export async function canUserReadEmail(
    db: Db,
    userId: string,
    email: EmailMessage,
    userEmail?: string | null,
): Promise<boolean> {
    const readable = await filterReadableEmails(db, userId, [email], userEmail);
    return readable.length === 1;
}
