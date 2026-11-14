// The built-in template marker the code writes and reads ("cocoa_seed") must be
// what the latest migration's check constraint on document_templates.source_kind
// allows, so a fresh install and an upgraded one agree with the code. Runs from
// backend/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const migrations = readdirSync("migrations")
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .sort();

let latest: { file: string; values: string[] } | null = null;
for (const file of migrations) {
    const sql = readFileSync(`migrations/${file}`, "utf8");
    for (const match of sql.matchAll(/source_kind\s*=\s*any\s*\(\s*array\s*\[([^\]]*)\]/gi)) {
        latest = { file, values: [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) };
    }
}

assert.ok(latest, "a migration constrains document_templates.source_kind");
assert.ok(
    latest.values.includes("cocoa_seed"),
    `${latest.file} must allow 'cocoa_seed', the marker the code uses (allows: ${latest.values.join(", ")})`,
);
assert.ok(
    !latest.values.includes("coco_seed"),
    `${latest.file} still allows the pre-rename 'coco_seed' marker`,
);

console.log(`templateSourceKindContract.test.ts: all passed (${latest.file})`);
