import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
    composerDraftStorageKey,
    decideAppVersionAction,
    persistComposerDraft,
    readComposerDraft,
} from "./appVersionState";

const base = {
    currentBuildId: "old-build",
    remoteBuildId: "new-build",
    lastReloadTarget: null,
    blockers: { drafts: 0, busy: 0 },
};

assert.equal(
    decideAppVersionAction(base),
    "reload",
    "an idle stale tab reloads",
);
assert.equal(
    decideAppVersionAction({
        ...base,
        blockers: { drafts: 1, busy: 0 },
    }),
    "defer",
    "an unsent composer draft defers automatic reload",
);

const values = new Map<string, string>();
const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
};
const draftKey = composerDraftStorageKey("/assistant/chat/chat-1");
persistComposerDraft(storage, draftKey, "Create the actual documents.");
assert.equal(
    readComposerDraft(storage, draftKey),
    "Create the actual documents.",
);
persistComposerDraft(storage, draftKey, "");
assert.equal(readComposerDraft(storage, draftKey), "");

const guardSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/AppVersionGuard.tsx"),
    "utf8",
);
assert.match(guardSource, /setInterval\([\s\S]*?, 60_000\)/);
assert.match(guardSource, /addEventListener\("focus"/);
assert.match(guardSource, /addEventListener\("visibilitychange"/);
assert.match(guardSource, /cache: "no-store"/);
assert.match(guardSource, /blockers\.busy === 0/);

const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/api/app-version/route.ts"),
    "utf8",
);
assert.match(routeSource, /force-dynamic/);
assert.match(routeSource, /no-store, no-cache/);
assert.equal(
    decideAppVersionAction({
        ...base,
        blockers: { drafts: 0, busy: 1 },
    }),
    "defer",
    "active streams and uploads defer reload",
);
assert.equal(
    decideAppVersionAction({ ...base, remoteBuildId: null }),
    "current",
    "an offline or failed version check never reloads",
);
assert.equal(
    decideAppVersionAction({ ...base, remoteBuildId: "old-build" }),
    "current",
);
assert.equal(
    decideAppVersionAction({ ...base, lastReloadTarget: "new-build" }),
    "intervention",
    "the same target cannot trigger an automatic reload loop",
);

console.log("appVersionState.test.ts: all passed");
