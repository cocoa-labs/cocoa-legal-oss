import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { createServerSupabase } from "./supabase";

export const EXPECTED_SCHEMA_VERSION = 44;

export function checkMigrationDirectory(): void {
    const migrationsDir = path.resolve(process.cwd(), "migrations");
    try {
        const files = fs
            .readdirSync(migrationsDir)
            .filter((file) => file.endsWith(".sql"))
            .sort();
        if (files.length === 0) {
            console.warn(
                "[startup] No migration files found. Production deployments should apply backend/migrations/*.sql.",
            );
            return;
        }
        console.log("[startup] Migration files available", {
            count: files.length,
            latest: files[files.length - 1],
        });
    } catch (err) {
        console.warn("[startup] Could not inspect backend migrations", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

export async function checkDatabaseSchema(
    db: ReturnType<typeof createServerSupabase>,
): Promise<void> {
    const { data, error } = await db
        .from("app_schema_migrations")
        .select("version, filename, checksum")
        .order("version", { ascending: true });
    if (error)
        throw new Error(`migration ledger unavailable: ${error.message}`);
    const rows = data ?? [];
    const latest = rows.at(-1);
    if (!latest || Number(latest.version) < EXPECTED_SCHEMA_VERSION) {
        throw new Error(
            `database schema is behind: expected ${EXPECTED_SCHEMA_VERSION}, found ${latest?.version ?? "none"}`,
        );
    }
    const ledger = new Map(rows.map((row) => [Number(row.version), row]));
    const migrationsDir = path.resolve(process.cwd(), "migrations");
    const files = fs
        .readdirSync(migrationsDir)
        .filter((file) => /^\d{3}_.+\.sql$/.test(file))
        .sort();
    for (const filename of files) {
        const version = Number.parseInt(filename.slice(0, 3), 10);
        if (version > EXPECTED_SCHEMA_VERSION) continue;
        const row = ledger.get(version);
        if (!row) throw new Error(`migration ledger is missing ${filename}`);
        const checksum = crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(migrationsDir, filename), "utf8"))
            .digest("hex");
        if (row.filename !== filename || row.checksum !== checksum)
            throw new Error(`migration checksum differs for ${filename}`);
    }
}
