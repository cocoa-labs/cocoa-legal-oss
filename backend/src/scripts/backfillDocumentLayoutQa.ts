import "../lib/loadEnv";

import { ensureVersionExportable } from "../lib/documentLayoutGate";
import { createServerSupabase } from "../lib/supabase";

const db = createServerSupabase();
const batchSize = Math.max(
    1,
    Math.min(
        100,
        Number.parseInt(
            process.argv.find((arg) => arg.startsWith("--batch-size="))?.split("=")[1] ??
                "20",
            10,
        ) || 20,
    ),
);
const maxVersions = Math.max(
    0,
    Number.parseInt(
        process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ??
            "0",
        10,
    ) || 0,
);
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
    let attempted = 0;
    let passed = 0;
    let failed = 0;

    while (maxVersions === 0 || attempted < maxVersions) {
        const limit =
            maxVersions === 0
                ? batchSize
                : Math.min(batchSize, maxVersions - attempted);
        const { data, error } = await db
            .from("document_versions")
            .select("id, document_id")
            .eq("layout_qa_status", "unverified")
            .order("created_at", { ascending: true })
            .limit(limit);
        if (error) throw error;
        const rows = (data ?? []) as { id: string; document_id: string }[];
        if (rows.length === 0) break;

        if (dryRun) {
            console.info(
                JSON.stringify({ pending_sample: rows.length, batch_size: batchSize }),
            );
            return;
        }

        for (const row of rows) {
            attempted += 1;
            try {
                await ensureVersionExportable({
                    db,
                    documentId: row.document_id,
                    versionId: row.id,
                });
                passed += 1;
            } catch (error) {
                failed += 1;
                const code =
                    error && typeof error === "object" && "code" in error
                        ? String(error.code)
                        : "DOCUMENT_QA_UNAVAILABLE";
                console.warn(
                    JSON.stringify({ version_id: row.id, status: "failed", code }),
                );
            }
        }
    }

    console.info(JSON.stringify({ attempted, passed, failed }));
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
