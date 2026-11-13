import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { installStructuredConsole } from "../lib/logger";

installStructuredConsole();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function main() {
 if (process.env.RESTORE_DRILL_CONFIRM !== "disposable")
   throw new Error("RESTORE_DRILL_CONFIRM=disposable is required");
 const target = required("RESTORE_DATABASE_URL");
 if (target === process.env.DATABASE_URL) throw new Error("Restore target must not equal DATABASE_URL");
 const work = await mkdtemp(path.join(os.tmpdir(), "coco-restore-"));
 try {
  const decrypted = path.join(work, "database.dump");
  await run("age", ["--decrypt", "--identity", required("BACKUP_AGE_IDENTITY_FILE"), "--output", decrypted, required("RESTORE_BACKUP_FILE")]);
  await run("pg_restore", ["--dbname", target, "--clean", "--if-exists", "--no-owner", decrypted]);
  const db = new Client({ connectionString: target });
  await db.connect();
  const { rows } = await db.query("select max(version) as version from public.app_schema_migrations");
  await db.end();
  console.info("Disposable restore drill completed", { count: rows[0]?.version ?? null });
 } finally {
   await rm(work, { recursive: true, force: true });
 }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
