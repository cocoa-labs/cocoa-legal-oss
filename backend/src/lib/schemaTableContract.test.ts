// Every table the backend reads or writes must be created by a migration, so a
// database built with `npm run migrate` has everything the code expects. A table
// that exists only on an older deployment passes there and fails on every fresh
// install. Covers literal `.from("name")` calls and table names passed as a
// `table:` option or typed as a string-literal union. Runs from backend/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const created = new Set<string>();
for (const file of readdirSync("migrations").filter((name) => /^\d{3}_.*\.sql$/.test(name))) {
    const sql = readFileSync(path.join("migrations", file), "utf8");
    for (const match of sql.matchAll(
        /create\s+(?:table|(?:or\s+replace\s+)?view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
        created.add(match[1].toLowerCase());
    }
}
assert.ok(created.size > 20, `expected the migrations to create many tables, found ${created.size}`);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
}

const used = new Map<string, string>();
const note = (table: string, where: string) => {
    if (!used.has(table)) used.set(table, where);
};
for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    // db.from("table") — skip Buffer.from / Array.from and friends.
    for (const match of text.matchAll(/(?<![A-Za-z0-9_])(?!Buffer|Array|Object|Readable|Uint8Array)[A-Za-z0-9_)\]]*\s*\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g)) {
        note(match[1], file);
    }
    // table: "name" options and `table: "a" | "b"` unions.
    for (const match of text.matchAll(/\btable\??:\s*((?:["'][a-z0-9_]+["']\s*\|?\s*)+)/g)) {
        for (const name of match[1].matchAll(/["']([a-z0-9_]+)["']/g)) note(name[1], file);
    }
}
assert.ok(used.size > 20, `expected the backend to use many tables, found ${used.size}`);

const missing = [...used].filter(([table]) => !created.has(table)).map(([table, where]) => `${table} (${where})`);
assert.deepEqual(
    missing,
    [],
    `tables used by the backend that no migration creates: ${missing.join(", ")}`,
);

console.log(`schemaTableContract.test.ts: all passed (${used.size} tables used, ${created.size} created by migrations)`);
