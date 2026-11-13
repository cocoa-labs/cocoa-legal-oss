// The local Docker Compose stack must stay on the machine that runs it: every
// published port is bound to 127.0.0.1, and the object-store secret has no
// default that anyone could read in this repository. Runs from backend/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync("../docker-compose.yml", "utf8");
const composeEnv = readFileSync("../compose.env.example", "utf8");

/** The list items under every `ports:` key, unquoted, comments dropped. */
function publishedPorts(yaml: string): string[] {
    const lines = yaml.split("\n");
    const ports: string[] = [];
    lines.forEach((line, index) => {
        const header = /^(\s*)ports:/.exec(line);
        if (!header) return;
        for (const next of lines.slice(index + 1)) {
            if (!next.trim() || next.trim().startsWith("#")) continue;
            const item = /^(\s*)-\s*(.+)$/.exec(next);
            if (!item || item[1].length <= header[1].length) break;
            ports.push(
                item[2]
                    .replace(/\s+#.*$/, "")
                    .trim()
                    .replace(/^["']|["']$/g, ""),
            );
        }
    });
    return ports;
}

const ports = publishedPorts(compose);
assert.ok(ports.length >= 5, `expected every service's ports, found: ${ports.join(", ")}`);
for (const port of ports) {
    assert.match(port, /^127\.0\.0\.1:/, `port "${port}" must be bound to 127.0.0.1`);
}

assert.doesNotMatch(
    compose,
    /\$\{S3_SECRET_KEY:?-/,
    "the object-store secret must not fall back to a default",
);
assert.match(
    compose,
    /\$\{S3_SECRET_KEY:\?/,
    "Compose refuses to start without S3_SECRET_KEY",
);
assert.match(
    composeEnv,
    /^S3_SECRET_KEY=$/m,
    "compose.env.example leaves the secret blank for the deployer to generate",
);

console.log("composeExposure.test.ts: all passed");
