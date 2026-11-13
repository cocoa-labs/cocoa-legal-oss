// backend/src/lib/userLookup.test.ts
//
// resolveAuthUsers replaces the two inline listUsers({ perPage: 1000 })
// call sites (/projects/:id/people, /tabular-review/:id/people) that
// silently dropped any user past the first 1000 rows — a shared project
// member beyond that cliff simply vanished from the People modal. These
// tests pin the paging contract with a stub admin client: resolve across
// pages, stop early once everything requested is found, stop at the last
// short page, and respect the hard page cap.
import assert from "node:assert/strict";
import { resolveAuthUsers } from "./userLookup";

type StubUser = { id: string; email?: string | null };

/** Build a stub Supabase client whose auth.admin.listUsers serves `pages`. */
function stubClient(pages: StubUser[][]) {
    const calls: { page: number; perPage: number }[] = [];
    const client = {
        auth: {
            admin: {
                listUsers: async (opts?: { page?: number; perPage?: number }) => {
                    const page = opts?.page ?? 1;
                    const perPage = opts?.perPage ?? 50;
                    calls.push({ page, perPage });
                    return {
                        data: { users: pages[page - 1] ?? [] },
                        error: null,
                    };
                },
            },
        },
    };
    return { client, calls };
}

async function main() {
    // Single short page: everything resolves, no second request.
    {
        const { client, calls } = stubClient([
            [
                { id: "u1", email: "Alice@Firm.com" },
                { id: "u2", email: "bob@firm.com" },
            ],
        ]);
        const result = await resolveAuthUsers(client, {
            emails: ["alice@firm.com"],
            userIds: ["u2"],
            perPage: 10,
        });
        assert.equal(calls.length, 1);
        // Email lookups are case-insensitive but preserve the stored casing.
        assert.deepEqual(result.userByEmail.get("alice@firm.com"), {
            id: "u1",
            email: "Alice@Firm.com",
        });
        assert.deepEqual(result.userById.get("u2"), {
            id: "u2",
            email: "bob@firm.com",
        });
        assert.equal(result.pageCapHit, false);
    }

    // The >perPage cliff the old code fell off: the target lives on page 3.
    {
        const page = (start: number): StubUser[] =>
            Array.from({ length: 2 }, (_, i) => ({
                id: `u${start + i}`,
                email: `user${start + i}@firm.com`,
            }));
        const { client, calls } = stubClient([
            page(0),
            page(2),
            [{ id: "u4", email: "target@firm.com" }],
        ]);
        const result = await resolveAuthUsers(client, {
            emails: ["target@firm.com"],
            perPage: 2,
        });
        assert.equal(calls.length, 3);
        assert.deepEqual(
            calls.map((c) => c.page),
            [1, 2, 3],
        );
        assert.equal(result.userByEmail.get("target@firm.com")?.id, "u4");
        assert.equal(result.pageCapHit, false);
    }

    // Early stop: once every requested email AND id is resolved, stop paging
    // even though more full pages exist.
    {
        const { client, calls } = stubClient([
            [
                { id: "u1", email: "a@firm.com" },
                { id: "u2", email: "b@firm.com" },
            ],
            [
                { id: "u3", email: "c@firm.com" },
                { id: "u4", email: "d@firm.com" },
            ],
        ]);
        const result = await resolveAuthUsers(client, {
            emails: ["b@firm.com"],
            userIds: ["u1"],
            perPage: 2,
        });
        assert.equal(calls.length, 1);
        assert.equal(result.userByEmail.size, 2); // both page-1 users mapped
        assert.equal(result.userById.size, 2);
    }

    // Unresolvable email: a short (last) page ends the walk without looping.
    {
        const { client, calls } = stubClient([
            [
                { id: "u1", email: "a@firm.com" },
                { id: "u2", email: "b@firm.com" },
            ],
            [{ id: "u3", email: "c@firm.com" }],
        ]);
        const result = await resolveAuthUsers(client, {
            emails: ["ghost@nowhere.com"],
            perPage: 2,
        });
        assert.equal(calls.length, 2);
        assert.equal(result.userByEmail.has("ghost@nowhere.com"), false);
        assert.equal(result.pageCapHit, false);
    }

    // Hard cap: full pages forever + an unresolvable target stops at
    // maxPages and reports the cap so the caller can log it.
    {
        const fullPage: StubUser[] = [
            { id: "x1", email: "x1@firm.com" },
            { id: "x2", email: "x2@firm.com" },
        ];
        const { client, calls } = stubClient(
            Array.from({ length: 50 }, () => fullPage),
        );
        const result = await resolveAuthUsers(client, {
            emails: ["never@firm.com"],
            perPage: 2,
            maxPages: 3,
        });
        assert.equal(calls.length, 3);
        assert.equal(result.pageCapHit, true);
    }

    // Users without an email are skipped for the email map but still
    // resolvable by id (matches the old inline `if (!u.email) continue`
    // guard, which also dropped them from userById — keeping them findable
    // by id is strictly better for the owner row).
    {
        const { client } = stubClient([
            [
                { id: "no-mail", email: null },
                { id: "u1", email: "a@firm.com" },
            ],
        ]);
        const result = await resolveAuthUsers(client, {
            emails: ["a@firm.com"],
            userIds: ["no-mail"],
            perPage: 10,
        });
        assert.equal(result.userByEmail.size, 1);
        assert.deepEqual(result.userById.get("no-mail"), {
            id: "no-mail",
            email: null,
        });
    }

    // Nothing requested: resolves without a single network call.
    {
        const { client, calls } = stubClient([[]]);
        const result = await resolveAuthUsers(client, {});
        assert.equal(calls.length, 0);
        assert.equal(result.userByEmail.size, 0);
        assert.equal(result.userById.size, 0);
    }

    console.log("userLookup.test.ts: all assertions passed");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
