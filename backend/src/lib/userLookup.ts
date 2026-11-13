// backend/src/lib/userLookup.ts
//
// Email/id → auth user resolution for the People endpoints
// (/projects/:id/people, /tabular-review/:id/people).
//
// Why this exists: both routes used to call
// `db.auth.admin.listUsers({ perPage: 1000 })` once and build lookup maps
// from that single page. user_profiles carries NO email column (checked
// schema.sql + migrations 001–022), so email→user_id resolution has to go
// through the auth admin API — but the single-page version silently dropped
// any user past row 1000: a shared member beyond the cliff just vanished
// from the People modal with no error. This helper pages until everything
// requested is resolved, with a hard page cap as a runaway guard.

type AuthUserLite = {
  id: string;
  email: string | null;
};

/**
 * The minimal slice of a Supabase service-role client this helper needs.
 * Typed structurally so tests can drive the paging logic with a stub.
 */
export type AuthAdminClient = {
  auth: {
    admin: {
      listUsers: (options?: { page?: number; perPage?: number }) => Promise<{
        data: { users: { id: string; email?: string | null }[] } | null;
        error?: unknown;
      }>;
    };
  };
};

export type ResolveAuthUsersResult = {
  /** Keyed by lowercased email; values keep the stored email casing. */
  userByEmail: Map<string, AuthUserLite>;
  /** Keyed by auth user id. Includes users without an email. */
  userById: Map<string, AuthUserLite>;
  /** True when the page cap stopped the walk before everything resolved. */
  pageCapHit: boolean;
};

/**
 * Resolve the given emails (case-insensitive) and user ids to auth users,
 * paging through auth.admin.listUsers until every requested entry is found,
 * the listing is exhausted (short page), or `maxPages` is hit. The maps
 * contain every user seen along the way, not just the requested ones, so
 * callers can keep their existing map-lookup code unchanged.
 */
export async function resolveAuthUsers(
  db: AuthAdminClient,
  request: {
    emails?: string[];
    userIds?: string[];
    perPage?: number;
    maxPages?: number;
  },
): Promise<ResolveAuthUsersResult> {
  const perPage = request.perPage ?? 1000;
  const maxPages = request.maxPages ?? 10;

  const wantedEmails = new Set(
    (request.emails ?? [])
      .map((e) => (e ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const wantedIds = new Set((request.userIds ?? []).filter(Boolean));

  const userByEmail = new Map<string, AuthUserLite>();
  const userById = new Map<string, AuthUserLite>();

  let pageCapHit = false;

  if (wantedEmails.size > 0 || wantedIds.size > 0) {
    for (let page = 1; page <= maxPages; page += 1) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const users = data?.users ?? [];

      for (const u of users) {
        const entry: AuthUserLite = { id: u.id, email: u.email ?? null };
        userById.set(u.id, entry);
        wantedIds.delete(u.id);
        if (u.email) {
          const lower = u.email.toLowerCase();
          userByEmail.set(lower, entry);
          wantedEmails.delete(lower);
        }
      }

      const allResolved = wantedEmails.size === 0 && wantedIds.size === 0;
      const lastPage = users.length < perPage;
      if (allResolved || lastPage) break;
      if (page === maxPages) {
        pageCapHit = true;
        console.warn(
          `[userLookup] hit the ${maxPages}-page cap (${maxPages * perPage} users) ` +
            `with ${wantedEmails.size} email(s) and ${wantedIds.size} id(s) unresolved — ` +
            `the user base has outgrown paged listUsers; move resolution to a DB-side lookup.`,
        );
      }
    }
  }

  return { userByEmail, userById, pageCapHit };
}
