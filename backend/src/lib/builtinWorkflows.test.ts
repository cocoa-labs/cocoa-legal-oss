// backend/src/lib/builtinWorkflows.test.ts
//
// Dual-source parity guard for the built-in assistant workflows that exist
// in BOTH stores: backend/src/lib/builtinWorkflows.ts (what makes them
// chat-readable via read_workflow/buildWorkflowStore) and
// frontend/src/app/components/workflows/builtinWorkflows.ts (the UI shape).
// The comment at the top of each file demands the shared entries stay
// byte-aligned; this test makes that discipline executable for the CRE
// assistant summaries and the two PI workflows.
//
// (builtin-cp-checklist is deliberately NOT in the parity set: the backend
// copy carries extra table-formatting instructions by design.)
//
// The frontend module is loaded at runtime via a computed path so the
// backend tsc run (rootDir: ./src) never typechecks across the package
// boundary; tsx compiles the .ts on the fly. The frontend file's only
// import is type-only, so it is erased at load time.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_WORKFLOWS } from "./builtinWorkflows";
import { PI_PLAYBOOK_KEYS } from "./legalCapabilities/piProfiles";

const FRONTEND_BUILTINS_PATH = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "frontend",
    "src",
    "app",
    "components",
    "workflows",
    "builtinWorkflows.ts",
);

/** Ids whose prompt_md must be byte-identical across the two files. */
const PARITY_IDS = [
    "builtin-cre-title-summary",
    "builtin-cre-loi-summary",
    "builtin-cre-loan-summary",
    "builtin-cre-ccr-summary",
    "builtin-pi-claim-triage",
    "builtin-pi-invoice-intake",
] as const;

const PI_BUILTIN_IDS = [
    "builtin-pi-claim-triage",
    "builtin-pi-invoice-intake",
] as const;

interface FrontendWorkflow {
    id: string;
    title: string;
    prompt_md: string | null;
    practice?: string | null;
}

async function loadFrontendBuiltins(): Promise<FrontendWorkflow[]> {
    const mod = (await import(pathToFileURL(FRONTEND_BUILTINS_PATH).href)) as {
        BUILT_IN_WORKFLOWS: FrontendWorkflow[];
    };
    assert.ok(
        Array.isArray(mod.BUILT_IN_WORKFLOWS),
        "frontend builtinWorkflows.ts should export BUILT_IN_WORKFLOWS",
    );
    return mod.BUILT_IN_WORKFLOWS;
}

async function testPromptParity() {
    const frontend = await loadFrontendBuiltins();
    const feById = new Map(frontend.map((wf) => [wf.id, wf]));
    const beById = new Map(BUILTIN_WORKFLOWS.map((wf) => [wf.id, wf]));

    for (const id of PARITY_IDS) {
        const be = beById.get(id);
        const fe = feById.get(id);
        assert.ok(be, `backend builtinWorkflows.ts is missing ${id}`);
        assert.ok(fe, `frontend builtinWorkflows.ts is missing ${id}`);
        assert.ok(
            typeof be.prompt_md === "string" && be.prompt_md.length > 0,
            `${id} backend prompt_md must be a non-empty string`,
        );
        assert.equal(
            fe.prompt_md,
            be.prompt_md,
            `${id} prompt_md has drifted between backend and frontend — the two files must stay byte-identical for shared ids`,
        );
        assert.equal(
            fe.title,
            be.title,
            `${id} title has drifted between backend and frontend`,
        );
    }
}

// Every {{playbook:pi.*}} placeholder in the PI builtin prompts must be a
// canonical seeded key (repo hard rule: never reference a playbook key the
// seed migration does not cover).
async function testPiBuiltinPlaybookKeysAreSeeded() {
    const canonical = new Set<string>(PI_PLAYBOOK_KEYS);
    const placeholderRe = /\{\{playbook:(pi\.[^}\s]+)\}\}/g;
    const beById = new Map(BUILTIN_WORKFLOWS.map((wf) => [wf.id, wf]));

    for (const id of PI_BUILTIN_IDS) {
        const wf = beById.get(id);
        assert.ok(wf, `backend builtinWorkflows.ts is missing ${id}`);
        const placeholders = [...wf.prompt_md.matchAll(placeholderRe)].map(
            (m) => m[1],
        );
        assert.ok(
            placeholders.length > 0,
            `${id} prompt_md should steer off the pi.* playbook`,
        );
        for (const key of placeholders) {
            assert.ok(
                canonical.has(key),
                `${id} references {{playbook:${key}}} which is not in PI_PLAYBOOK_KEYS / not seeded by 024_pi_playbook_seed.sql`,
            );
        }
    }
}

// The frontend PI entries must be filterable under the Personal Injury
// practice chip.
async function testPiFrontendPractice() {
    const frontend = await loadFrontendBuiltins();
    for (const id of PI_BUILTIN_IDS) {
        const fe = frontend.find((wf) => wf.id === id);
        assert.ok(fe, `frontend builtinWorkflows.ts is missing ${id}`);
        assert.equal(
            fe.practice,
            "Personal Injury",
            `${id} frontend practice must be "Personal Injury"`,
        );
    }
}

async function main() {
    await testPromptParity();
    await testPiBuiltinPlaybookKeysAreSeeded();
    await testPiFrontendPractice();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
