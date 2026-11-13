import path from "node:path";
import dotenv from "dotenv";

function backendDir() {
  const cwd = process.cwd();
  if (path.basename(cwd) === "backend") return cwd;
  return path.join(cwd, "backend");
}

const dir = backendDir();

// An empty-string env var (e.g. ANTHROPIC_API_KEY="" injected into the
// process by a parent launcher or another CLI) would otherwise shadow the
// real value in .env, because dotenv does not overwrite keys already
// present in process.env. An empty value is never a usable credential, so
// treat empties as absent and let .env supply the real one.
for (const key of Object.keys(process.env)) {
  if (process.env[key] === "") delete process.env[key];
}

dotenv.config({ path: path.join(dir, ".env"), quiet: true });
dotenv.config({ path: path.join(dir, ".env.local"), override: true, quiet: true });
dotenv.config({ path: path.join(dir, "local.env"), override: true, quiet: true });
