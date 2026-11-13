import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";
import { installStructuredConsole } from "../lib/logger";

installStructuredConsole();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const migrationsDir = path.resolve(process.cwd(), "migrations");
const files = fs
  .readdirSync(migrationsDir)
  .filter((file) => /^\d{3}_.+\.sql$/.test(file))
  .sort();
const baselineArg = process.argv.find((arg) => arg.startsWith("--baseline-through="));
const baselineThrough = baselineArg
  ? Number.parseInt(baselineArg.split("=")[1] ?? "", 10)
  : null;
const verifyOnly = process.argv.includes("--verify");

function fileInfo(filename: string) {
  const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
  return {
    filename,
    version: Number.parseInt(filename.slice(0, 3), 10),
    sql,
    checksum: crypto.createHash("sha256").update(sql).digest("hex"),
  };
}

const BASELINE_TABLES = [
  "organizations", "organization_memberships", "matters", "matter_memberships",
  "agent_operations", "document_versions", "document_edits", "document_highlight_sets",
  "document_highlights", "chat_attachments", "firm_playbooks", "playbook_entries",
  "playbook_versions", "email_messages", "signature_envelopes", "signature_signers",
  "signature_events", "signature_fields", "document_templates", "template_versions",
  "clause_library", "authoring_jobs", "pi_cases", "pi_case_policies", "pi_case_expenses",
  "automation_runs", "automation_state", "recordings", "recordings_state", "calendar_writes",
  "calendar_event_meta", "calendar_sync_state", "allowed_emails", "personal_memory_entries",
  "firm_memory_entries", "firm_memory_versions", "firm_memory_candidates",
  "document_generation_jobs", "document_generation_items",
] as const;

const BASELINE_COLUMNS = [
  ["projects", "org_id"], ["projects", "matter_id"], ["projects", "lifecycle_status"],
  ["documents", "org_id"], ["documents", "matter_id"], ["documents", "lifecycle_status"],
  ["chats", "org_id"], ["chats", "matter_id"], ["chats", "parent_chat_id"],
  ["chat_messages", "version_context"], ["chat_messages", "workflow"],
  ["document_versions", "parent_version_id"], ["document_versions", "source"],
  ["agent_operations", "chat_message_id"], ["tabular_reviews", "represented_party"],
] as const;

async function verifyBaseline(client: Client): Promise<void> {
  const missingTables: string[] = [];
  for (const table of BASELINE_TABLES) {
    const { rows } = await client.query<{ relation: string | null }>(
      "select to_regclass($1)::text as relation",
      [`public.${table}`],
    );
    if (!rows[0]?.relation) missingTables.push(table);
  }
  const { rows: columnRows } = await client.query<{ table_name: string; column_name: string }>(`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
  `);
  const existingColumns = new Set(
    columnRows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const missingColumns = BASELINE_COLUMNS
    .map(([table, column]) => `${table}.${column}`)
    .filter((column) => !existingColumns.has(column));
  const { rows: functionRows } = await client.query<{ exists: boolean }>(`
    select exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'commit_document_edit'
    ) as exists
  `);
  if (missingTables.length || missingColumns.length || !functionRows[0]?.exists) {
    throw new Error(
      `Cannot baseline migrations through 033; schema verification failed (${missingTables.length} missing tables, ${missingColumns.length} missing columns, edit RPC ${functionRows[0]?.exists ? "present" : "missing"}).`,
    );
  }
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(434236)");
    await client.query(`
      create table if not exists public.app_schema_migrations (
        version integer primary key,
        filename text not null unique,
        checksum text,
        applied_at timestamptz not null default now()
      )
    `);
    const { rows: appliedRows } = await client.query<{
      version: number;
      filename: string;
      checksum: string | null;
    }>("select version, filename, checksum from public.app_schema_migrations order by version");
    const applied = new Map(appliedRows.map((row) => [row.version, row]));

    if (baselineThrough !== null) {
      if (baselineThrough !== 33)
        throw new Error("Only --baseline-through=33 is supported for verified legacy databases");
      await verifyBaseline(client);
      for (const info of files.map(fileInfo)) {
        if (info.version > baselineThrough || applied.has(info.version)) continue;
        await client.query(
          "insert into public.app_schema_migrations(version, filename, checksum) values($1,$2,$3)",
          [info.version, info.filename, info.checksum],
        );
        applied.set(info.version, {
          version: info.version,
          filename: info.filename,
          checksum: info.checksum,
        });
        console.info(`Baselined ${info.filename}`);
      }
    }

    for (const info of files.map(fileInfo)) {
      const existing = applied.get(info.version);
      if (existing) {
        if (existing.filename !== info.filename || existing.checksum !== info.checksum) {
          throw new Error(`Migration drift detected for ${info.filename}`);
        }
        continue;
      }
      if (verifyOnly) throw new Error(`Pending migration: ${info.filename}`);
      await client.query("begin");
      try {
        await client.query(info.sql);
        await client.query(
          "insert into public.app_schema_migrations(version, filename, checksum) values($1,$2,$3)",
          [info.version, info.filename, info.checksum],
        );
        await client.query("commit");
        console.info(`Applied ${info.filename}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    console.info(`Schema verified through ${files.at(-1) ?? "none"}`);
  } finally {
    await client.query("select pg_advisory_unlock(434236)").catch(() => undefined);
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
