// backend/scripts/seedFirm.ts
//
// Idempotent seeding for the single-firm model: the firm, its shared playbook
// container, the sign-up allowlist, and memberships for accounts that already
// exist. Safe to re-run: every write is an upsert or an explicit existence
// check.
//
// Does the DATA half of migration 027 plus the 028 allowlist:
//   1. the firm's organizations row
//   2. the firm's firm_playbooks container
//   3. allowed_emails rows (028's trigger rejects any sign-up not listed)
//   4. organization_memberships, but only for accounts that ALREADY exist.
//      Since migration 034, sign-up claims only explicit invitations, so on a
//      fresh install this step grants nothing: new accounts get a personal
//      workspace when they create their first matter. Re-run after people sign
//      up to make --admin accounts firm owners (and --allow accounts firm
//      lawyers, a role that cannot create matters in the firm organization).
//
// Dry run by default; nothing is written without --apply:
//   npm run seed:firm -- --name "Example Law LLP" --admin you@example.com --allow colleague@example.com
//   npm run seed:firm -- --name "Example Law LLP" --admin you@example.com --allow colleague@example.com --apply
//
// --slug defaults to "pilot-firm" (the slug migration 027 seeds and the
// FIRM_ID fallback). If you pass a different slug, set FIRM_ID to match.
import "../src/lib/loadEnv";
import { parseFirmSeedArgs } from "../src/lib/firmSeedArgs";
import { createServerSupabase } from "../src/lib/supabase";

const config = parseFirmSeedArgs(process.argv.slice(2));
const FIRM_NAME = config.name;
const FIRM_SLUG = config.slug;
/** Firm admins get role 'owner' (weight 5) so they can approve firm memory. */
const ADMIN_EMAILS = config.admins;
/** allowed_emails rows: admins first, then everyone passed with --allow. */
const ROSTER: { email: string; note: string | null }[] = config.allowed.map(
    (email) => ({
        email,
        note: ADMIN_EMAILS.includes(email) ? "firm admin" : null,
    }),
);

const norm = (e: string) => e.trim().toLowerCase();
/** Lowercased view used for membership matching against auth.users. */
const ALLOWED = config.allowed;

function printDryRun() {
    console.log(`=== Dry run: seeding firm "${FIRM_NAME}" (slug: ${FIRM_SLUG}) ===\n`);
    console.log(`1. organizations       would upsert "${FIRM_NAME}" (slug ${FIRM_SLUG})`);
    console.log(`2. firm_playbooks      would ensure firm_id=${FIRM_SLUG}`);
    if (ROSTER.length === 0) {
        console.log("3. allowed_emails      none given (--admin / --allow); sign-up stays closed");
    } else {
        console.log(`3. allowed_emails      would upsert ${ROSTER.length}:`);
        for (const row of ROSTER) {
            console.log(`                           ${row.email}${row.note ? ` (${row.note})` : ""}`);
        }
    }
    console.log(
        "4. memberships         would add or correct memberships for existing accounts" +
            " whose email is allowlisted (owners: --admin emails)",
    );
    console.log("\nNothing was written. Re-run with --apply to make these changes.");
}

async function main() {
    if (!config.apply) {
        printDryRun();
        return;
    }
    const db = createServerSupabase();
    console.log(`=== Seeding firm "${FIRM_NAME}" (slug: ${FIRM_SLUG}) ===\n`);

    // 1. The firm's organizations row.
    const { error: orgErr } = await db
        .from("organizations")
        .upsert(
            {
                name: FIRM_NAME,
                slug: FIRM_SLUG,
                created_by_user_id: "migration",
            },
            { onConflict: "slug" },
        );
    if (orgErr) throw new Error(`organizations upsert failed: ${orgErr.message}`);

    const { data: org, error: orgReadErr } = await db
        .from("organizations")
        .select("id, name, slug")
        .eq("slug", FIRM_SLUG)
        .maybeSingle();
    if (orgReadErr || !org) {
        throw new Error(
            `could not read back the firm org: ${orgReadErr?.message ?? "not found"}`,
        );
    }
    const orgId = (org as { id: string }).id;
    console.log(`1. organizations       ok  "${FIRM_NAME}" (${orgId})`);

    // 2. The firm's playbook container, so the first shared read/write never
    //    races in ensurePlaybook().
    const { error: pbErr } = await db
        .from("firm_playbooks")
        .upsert(
            { firm_id: FIRM_SLUG, updated_by: "migration" },
            { onConflict: "firm_id" },
        );
    if (pbErr) throw new Error(`firm_playbooks upsert failed: ${pbErr.message}`);
    console.log(`2. firm_playbooks      ok  firm_id=${FIRM_SLUG}`);

    // 3. The invite allowlist. NOTE: the 028 BEFORE INSERT trigger rejects any
    //    signup not listed here, so an empty table blocks everyone.
    if (ROSTER.length === 0) {
        console.log("3. allowed_emails      SKIPPED — no emails configured!");
    } else {
        const { error: allowErr } = await db
            .from("allowed_emails")
            .upsert(ROSTER, { onConflict: "email" });
        if (allowErr) {
            const missing =
                /could not find the table|does not exist|schema cache/i.test(
                    allowErr.message,
                );
            if (!missing) {
                throw new Error(
                    `allowed_emails upsert failed: ${allowErr.message}`,
                );
            }
            console.log(
                "3. allowed_emails      SKIPPED — table not created yet." +
                    "\n                       Run `npm run migrate` first, then re-run this script.",
            );
        } else {
            console.log(`3. allowed_emails      ok  ${ALLOWED.length} seeded`);
            for (const e of ALLOWED) console.log(`                           ${e}`);
        }
    }

    // 4. Membership backfill for accounts that already exist. Sign-up (034's
    //    handle_new_user) claims only explicit invitations, so without this
    //    authorizeFirm() denies and /firm-memory returns 403.
    const { data: page, error: userErr } = await db.auth.admin.listUsers({
        page: 1,
        perPage: 200,
    });
    if (userErr) throw new Error(`listUsers failed: ${userErr.message}`);
    const users = page?.users ?? [];

    const admins = ADMIN_EMAILS.map(norm);
    let granted = 0;
    const skipped: string[] = [];
    for (const u of users) {
        const email = norm(u.email ?? "");
        if (!email || !ALLOWED.includes(email)) {
            skipped.push(u.email ?? u.id);
            continue;
        }
        const role = admins.includes(email) ? "owner" : "lawyer";
        // Select-then-write rather than upsert: organization_memberships gained
        // invitation columns and no longer carries a unique constraint matching
        // (organization_id, user_id), so an ON CONFLICT target here fails with
        // "no unique or exclusion constraint matching the ON CONFLICT
        // specification". Explicit existence check keeps this idempotent
        // regardless of which constraints the table currently has.
        const { data: existingMem, error: readErr } = await db
            .from("organization_memberships")
            .select("id, role, status")
            .eq("organization_id", orgId)
            .eq("user_id", u.id)
            .maybeSingle();
        if (readErr) {
            throw new Error(`membership read failed for ${email}: ${readErr.message}`);
        }

        if (existingMem) {
            // Only correct drift (e.g. an admin who should be owner, or a
            // membership left disabled); otherwise leave the row untouched.
            if (existingMem.role !== role || existingMem.status !== "active") {
                const { error: updErr } = await db
                    .from("organization_memberships")
                    .update({ role, status: "active", email })
                    .eq("id", existingMem.id);
                if (updErr) {
                    throw new Error(`membership update failed for ${email}: ${updErr.message}`);
                }
                console.log(`4. membership          ok  ${email} -> ${role} (updated)`);
            } else {
                console.log(`4. membership          ok  ${email} -> ${role} (unchanged)`);
            }
        } else {
            const { error: insErr } = await db
                .from("organization_memberships")
                .insert({
                    organization_id: orgId,
                    user_id: u.id,
                    email,
                    role,
                    status: "active",
                });
            if (insErr) {
                throw new Error(`membership insert failed for ${email}: ${insErr.message}`);
            }
            console.log(`4. membership          ok  ${email} -> ${role} (created)`);
        }
        granted += 1;
    }
    if (granted === 0) console.log("4. membership          none granted");
    if (skipped.length) {
        console.log(
            `\n   NOT granted membership (not on the allowlist): ${skipped.join(", ")}`,
        );
        console.log(
            "   ^ these accounts still EXIST and can still log in. The allowlist is a",
        );
        console.log(
            "     BEFORE INSERT trigger — it cannot retroactively gate them. Disable",
        );
        console.log("     or delete them explicitly before going live.");
    }

    console.log(
        `\nDone. Ensure FIRM_ID=${FIRM_SLUG} is set in the backend env (local .env and your host).`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
