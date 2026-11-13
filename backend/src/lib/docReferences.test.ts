// Every documentation file that backend code or scripts point people to must
// ship with the repository, so an error message or script output never sends a
// deployer to a missing file. Internal planning docs (docs/superpowers) never
// ship, so nothing may point there. Runs from backend/.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });
}

const DOC_REFERENCE =
    /(?<![\w/.-])(docs\/[\w./-]+\.md|(?:AGENTS|CLAUDE|CONTRIBUTING|DEPLOY|DEPLOYING|README|SECURITY)\.md)/g;

const references: { file: string; doc: string }[] = [];
for (const file of [...sources("src"), ...sources("scripts")]) {
    for (const match of readFileSync(file, "utf8").matchAll(DOC_REFERENCE)) {
        references.push({ file, doc: match[1] });
    }
}

assert.ok(references.length > 0, "found the documentation references in backend code");
for (const { file, doc } of references) {
    assert.ok(!doc.startsWith("docs/superpowers/"), `${file} points at internal ${doc}`);
    assert.ok(existsSync(join("..", doc)), `${file} points at ${doc}, which is not in the repository`);
}

console.log(`docReferences.test.ts: all passed (${references.length} references)`);
