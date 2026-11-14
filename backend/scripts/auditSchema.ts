// backend/scripts/auditSchema.ts
//
// Supplemental READ-ONLY data audit. The migration ledger command and
// readiness check are the schema source of truth; this probe additionally
// checks migration-specific seed rows that a schema checksum cannot validate.
//
// Writes nothing. Run:  npx tsx scripts/auditSchema.ts
import "../src/lib/loadEnv";
import { createServerSupabase } from "../src/lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

const EXPECTED: { migration: string; table: string }[] = [
    { migration: "001 production foundation", table: "organizations" },
    { migration: "001 production foundation", table: "organization_memberships" },
    { migration: "001 production foundation", table: "matters" },
    { migration: "001 production foundation", table: "matter_memberships" },
    { migration: "001 production foundation", table: "agent_operations" },
    { migration: "003 document highlights", table: "document_highlight_sets" },
    { migration: "003 document highlights", table: "document_highlights" },
    { migration: "004 chat attachments", table: "chat_attachments" },
    { migration: "005 firm playbooks", table: "firm_playbooks" },
    { migration: "005 firm playbooks", table: "playbook_entries" },
    { migration: "005 firm playbooks", table: "playbook_versions" },
    { migration: "011 email", table: "email_messages" },
    { migration: "012 e-signature", table: "signature_envelopes" },
    { migration: "012 e-signature", table: "signature_signers" },
    { migration: "012 e-signature", table: "signature_events" },
    { migration: "015 signature fields", table: "signature_fields" },
    { migration: "019 authoring", table: "document_templates" },
    { migration: "019 authoring", table: "template_versions" },
    { migration: "019 authoring", table: "clause_library" },
    { migration: "019 authoring", table: "authoring_jobs" },
    { migration: "023 PI + automation", table: "pi_cases" },
    { migration: "023 PI + automation", table: "pi_case_policies" },
    { migration: "023 PI + automation", table: "pi_case_expenses" },
    { migration: "023 PI + automation", table: "automation_runs" },
    { migration: "023 PI + automation", table: "automation_state" },
    { migration: "025 recordings", table: "recordings" },
    { migration: "025 recordings", table: "recordings_state" },
    { migration: "026 calendar", table: "calendar_writes" },
    { migration: "026 calendar", table: "calendar_event_meta" },
    { migration: "026 calendar", table: "calendar_sync_state" },
    { migration: "028 invite allowlist", table: "allowed_emails" },
    { migration: "029 personal memory", table: "personal_memory_entries" },
    { migration: "030 firm memory", table: "firm_memory_entries" },
    { migration: "030 firm memory", table: "firm_memory_versions" },
    { migration: "030 firm memory", table: "firm_memory_candidates" },
    { migration: "031 document generation", table: "document_generation_jobs" },
    { migration: "031 document generation", table: "document_generation_items" },
];

const MISSING_CODES = new Set(["42P01", "PGRST205", "PGRST204"]);

function looksMissing(error: { code?: string; message?: string } | null) {
    if (!error) return false;
    if (error.code && MISSING_CODES.has(error.code)) return true;
    return /relation .* does not exist|could not find the table|schema cache/i.test(
        error.message ?? "",
    );
}

async function tableExists(db: Db, table: string) {
    // NOTE: must be a real (non-head) select. With { head: true } PostgREST
    // returns an empty body and the client reports error: null even for a table
    // that does not exist — which silently makes every table look present.
    const { error } = await db.from(table).select("*").limit(1);
    if (!error) return { ok: true as const };
    if (looksMissing(error)) return { ok: false as const, missing: true };
    return { ok: false as const, missing: false, message: error.message };
}

async function main() {
    const db = createServerSupabase();
    console.log("=== Cocoa Legal — go-live schema audit (READ-ONLY) ===\n");

    // 1. Table presence, grouped by migration.
    const missingByMigration = new Map<string, string[]>();
    const oddities: string[] = [];
    for (const { migration, table } of EXPECTED) {
        const res = await tableExists(db, table);
        if (res.ok) continue;
        if (res.missing) {
            const list = missingByMigration.get(migration) ?? [];
            list.push(table);
            missingByMigration.set(migration, list);
        } else {
            oddities.push(`${table}: ${res.message}`);
        }
    }

    if (missingByMigration.size === 0) {
        console.log(
            `TABLES: all ${EXPECTED.length} expected tables present — schema is current.\n`,
        );
    } else {
        console.log("TABLES: MISSING (these migrations still need applying)");
        for (const [migration, tables] of [...missingByMigration].sort()) {
            console.log(`  ${migration}`);
            for (const t of tables) console.log(`      - ${t}`);
        }
        console.log("");
    }
    if (oddities.length) {
        console.log("UNEXPECTED ERRORS (not a missing table):");
        for (const o of oddities) console.log(`  ${o}`);
        console.log("");
    }

    // 2. Seed checks that a table list cannot see.
    console.log("SEEDS / CONFIG");
    const { data: seedFirm } = await db
        .from("firm_playbooks")
        .select("id")
        .eq("firm_id", "default-shared")
        .maybeSingle();
    console.log(`  default-shared seed firm: ${seedFirm ? "present" : "MISSING (006)"}`);

    if (seedFirm) {
        const { count: piCount } = await db
            .from("playbook_entries")
            .select("*", { head: true, count: "exact" })
            .eq("playbook_id", (seedFirm as { id: string }).id)
            .like("key", "pi.%");
        const n = piCount ?? 0;
        console.log(
            `  pi.* playbook keys: ${n} (need 10)${n === 10 ? "" : "  <-- migration 024 NOT applied; PI classifier silently skips ALL mail"}`,
        );
        const { count: creCount } = await db
            .from("playbook_entries")
            .select("*", { head: true, count: "exact" })
            .eq("playbook_id", (seedFirm as { id: string }).id)
            .like("key", "cre.%");
        console.log(`  cre.* playbook keys: ${creCount ?? 0} (expect 7)`);
    }

    const orgProbe = await tableExists(db, "organizations");
    if (orgProbe.ok) {
        const { data: orgs } = await db
            .from("organizations")
            .select("name, slug, created_by_user_id");
        const rows = (orgs as { name: string; slug: string; created_by_user_id: string }[] | null) ?? [];
        console.log(`  organizations rows: ${rows.length}`);
        for (const o of rows) console.log(`      "${o.name}"  slug=${o.slug}  by=${o.created_by_user_id}`);
        if (!rows.some((o) => o.created_by_user_id === "migration")) {
            console.log("      (no migration-seeded firm yet -> 027 not applied)");
        }
    }

    const allowProbe = await tableExists(db, "allowed_emails");
    if (allowProbe.ok) {
        const { data: allowed } = await db.from("allowed_emails").select("email");
        const list = (allowed as { email: string }[] | null) ?? [];
        console.log(`  allowed_emails seeded: ${list.length}`);
        for (const a of list) console.log(`      ${a.email}`);
    }
    console.log("");

    // 3. Account inventory — the access audit. The invite allowlist is a
    //    BEFORE INSERT trigger, so it cannot gate accounts that already exist.
    console.log("ACCOUNTS (auth.users)");
    const { data: userPage, error: userErr } = await db.auth.admin.listUsers({
        page: 1,
        perPage: 200,
    });
    if (userErr) {
        console.log(`  could not list users: ${userErr.message}`);
    } else {
        const users = userPage?.users ?? [];
        let memberships: { user_id: string; role: string; status: string }[] = [];
        const memProbe = await tableExists(db, "organization_memberships");
        if (memProbe.ok) {
            const { data } = await db
                .from("organization_memberships")
                .select("user_id, role, status");
            memberships = (data as typeof memberships | null) ?? [];
        }
        console.log(`  total: ${users.length}`);
        for (const u of users) {
            const m = memberships.find(
                (x) => x.user_id === u.id && x.status === "active",
            );
            const last = u.last_sign_in_at
                ? new Date(u.last_sign_in_at).toISOString().slice(0, 10)
                : "never";
            console.log(
                `      ${(u.email ?? "(no email)").padEnd(34)} created ${new Date(
                    u.created_at,
                )
                    .toISOString()
                    .slice(0, 10)}  last_login ${last.padEnd(10)}  firm_role ${m?.role ?? "-"}`,
            );
        }
    }

    console.log(
        "\nNOTE: two checks need the SQL editor (not exposed over the API):" +
            "\n  - document_versions_source_check contains 'authored'  (021)" +
            "\n  - handle_new_user() references organization_memberships (027)",
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
