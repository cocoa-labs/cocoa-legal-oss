// backend/src/lib/legalCapabilities/generalCapabilities.test.ts
//
// Guard test for the four GENERAL (non-practice-specific) capabilities:
// compliance-check, legal-risk-assessment, triage-nda and review-contract.
//
// It pins four things CI must not let drift:
//   1. Registration — the exact ids/titles/practices/run_labels, and the
//      order register.ts imports them in (the six practice capabilities
//      first, then these four).
//   2. Capability↔seed lockstep in BOTH directions against migration
//      042_general_capabilities.sql, read from disk — a canonical key with
//      no seed (a placeholder that would silently render blank) or a seed
//      for a key the code does not know about is caught here.
//   3. Placeholder hygiene — every {{playbook:...}} a module inlines is
//      declared in its playbookKeys (the substitution machinery only
//      resolves declared keys), and every declared key is actually used
//      (or is the escalation template / the shared risk-threshold key).
//   4. Signal + output-spec hygiene — lowercased signals, no bare
//      document-type hints that would fire a chip on any agreement, and a
//      well-formed outputSpec (the in-chat run path generates its output
//      contract from it).
//
// Unlike personalInjury.test.ts this file imports ./register rather than
// the modules directly, because assertion (1) is about the registration
// ORDER the production entry point produces.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./register";
import { allCapabilities, getCapability } from "./index";
import type { CapabilityOutputSection, LegalCapability } from "./types";
import {
    GENERAL_PLAYBOOK_KEYS,
    SHARED_RISK_KEY,
    COMPLIANCE_PROMPT_KEYS,
    RISK_PROMPT_KEYS,
    NDA_PROMPT_KEYS,
    CONTRACT_PROMPT_KEYS,
} from "./generalProfiles";

const MIGRATION_PATH = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "migrations",
    "042_general_capabilities.sql",
);

/** The six practice capabilities register.ts already imported, in order. */
const EXISTING_CAPABILITY_IDS = [
    "cre-review",
    "cre-authoring",
    "pi-claims-triage",
    "pi-invoice-processing",
    "meeting-intelligence",
    "calendar-scheduling",
] as const;

const GENERAL_CAPABILITY_IDS = [
    "compliance-check",
    "legal-risk-assessment",
    "triage-nda",
    "review-contract",
] as const;

type GeneralId = (typeof GENERAL_CAPABILITY_IDS)[number];

const EXPECTED: Record<
    GeneralId,
    {
        title: string;
        practice: string;
        run_label: string;
        promptKeys: readonly string[];
        overall_scheme: string;
        requiredSections: string[];
    }
> = {
    "compliance-check": {
        title: "Compliance Check",
        practice: "Legal Operations",
        run_label: "Run compliance check",
        promptKeys: COMPLIANCE_PROMPT_KEYS,
        overall_scheme: "risk-area",
        requiredSections: [
            "summary",
            "regulations",
            "requirements",
            "risk_areas",
            "recommended_actions",
        ],
    },
    "legal-risk-assessment": {
        title: "Legal Risk Assessment",
        practice: "Legal Operations",
        run_label: "Assess legal risk",
        promptKeys: RISK_PROMPT_KEYS,
        overall_scheme: "risk-score",
        requiredSections: [
            "risk_description",
            "analysis",
            "recommended_approach",
            "next_steps",
        ],
    },
    "triage-nda": {
        title: "NDA Triage",
        practice: "General Transactions",
        run_label: "Triage NDA",
        promptKeys: NDA_PROMPT_KEYS,
        overall_scheme: "traffic-light",
        requiredSections: [
            "metadata",
            "screening",
            "issues",
            "recommendation",
        ],
    },
    "review-contract": {
        title: "Contract Review",
        practice: "General Transactions",
        run_label: "Review contract",
        promptKeys: CONTRACT_PROMPT_KEYS,
        overall_scheme: "traffic-light",
        requiredSections: [
            "metadata",
            "key_findings",
            "clauses",
            "negotiation_strategy",
        ],
    },
};

/** Every text surface a module can inline a {{playbook:...}} placeholder in. */
function promptSurfaces(cap: LegalCapability): string[] {
    const surfaces = [
        cap.systemPromptFragment.persona_framing,
        cap.systemPromptFragment.methodology,
    ];
    if (cap.workflow.type === "assistant") {
        surfaces.push(cap.workflow.prompt_md);
    } else {
        for (const col of cap.workflow.columns_config) {
            surfaces.push(col.prompt);
        }
    }
    return surfaces;
}

// (1) All four register, with the exact registry metadata, appended after
// the six practice capabilities in the declared order.
async function testRegistration() {
    const ids = allCapabilities().map((c) => c.id);
    assert.deepEqual(
        ids,
        [...EXISTING_CAPABILITY_IDS, ...GENERAL_CAPABILITY_IDS],
        "register.ts must import the four general capabilities after the existing six, in order",
    );

    for (const id of GENERAL_CAPABILITY_IDS) {
        const cap = getCapability(id);
        assert.ok(cap, `capability ${id} should be registered`);
        assert.equal(cap.title, EXPECTED[id].title, `${id}.title`);
        assert.equal(cap.practice, EXPECTED[id].practice, `${id}.practice`);
        assert.equal(
            cap.intentSignals.run_label,
            EXPECTED[id].run_label,
            `${id}.intentSignals.run_label`,
        );
        assert.equal(cap.workflow.type, "assistant", `${id}.workflow.type`);
        assert.equal(cap.resultCard, "CapabilityResultCard", `${id}.resultCard`);
        assert.equal(cap.outputs.docx, true, `${id}.outputs.docx`);
        assert.equal(
            cap.outputs.in_app_document,
            false,
            `${id}.outputs.in_app_document`,
        );
        assert.deepEqual(
            cap.connectorRequirements,
            [],
            `${id}.connectorRequirements`,
        );
        assert.ok(
            cap.classifierGuidance?.choose_when?.trim(),
            `${id} must declare classifierGuidance.choose_when`,
        );
        assert.ok(
            cap.classifierGuidance?.do_not_choose_when?.trim(),
            `${id} must declare classifierGuidance.do_not_choose_when`,
        );
        assert.deepEqual(
            [...cap.playbookKeys].sort(),
            [...EXPECTED[id].promptKeys].sort(),
            `${id}.playbookKeys must equal its generalProfiles.ts key set exactly`,
        );
    }
}

// (2) Capability↔seed lockstep in both directions against migration 042.
async function testSeedLockstep() {
    assert.ok(
        fs.existsSync(MIGRATION_PATH),
        `seed migration missing at ${MIGRATION_PATH}`,
    );
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

    for (const key of GENERAL_PLAYBOOK_KEYS) {
        assert.ok(
            sql.includes(`'${key}'`),
            `GENERAL_PLAYBOOK_KEYS key "${key}" is not seeded by 042_general_capabilities.sql`,
        );
    }

    // Reverse: the migration may not seed a key the code does not know
    // about. The shared risk.escalation_thresholds key (seeded by 009) is
    // allowed to appear, since 042 may re-assert it with DO NOTHING.
    const canonical = new Set<string>([
        ...GENERAL_PLAYBOOK_KEYS,
        SHARED_RISK_KEY,
    ]);
    for (const m of sql.matchAll(
        /'((?:compliance|risk|contract|nda)\.[a-z0-9_.]+)'/g,
    )) {
        assert.ok(
            canonical.has(m[1]),
            `042_general_capabilities.sql seeds "${m[1]}" which is not in GENERAL_PLAYBOOK_KEYS`,
        );
    }

    // Every canonical key must also be reachable from exactly one module.
    const declared = new Set<string>([
        ...COMPLIANCE_PROMPT_KEYS,
        ...RISK_PROMPT_KEYS,
        ...NDA_PROMPT_KEYS,
        ...CONTRACT_PROMPT_KEYS,
    ]);
    for (const key of GENERAL_PLAYBOOK_KEYS) {
        assert.ok(
            declared.has(key),
            `canonical key "${key}" is seeded but no capability declares it`,
        );
    }
}

// (3) Placeholder hygiene, both directions.
async function testPlaceholderHygiene() {
    for (const id of GENERAL_CAPABILITY_IDS) {
        const cap = getCapability(id);
        assert.ok(cap, `capability ${id} should be registered`);

        const declared = new Set(cap.playbookKeys);
        const referenced = new Set<string>();
        for (const text of promptSurfaces(cap)) {
            for (const m of text.matchAll(/\{\{playbook:([^}\s]+)\}\}/g)) {
                referenced.add(m[1]);
                assert.ok(
                    declared.has(m[1]),
                    `${id} inlines {{playbook:${m[1]}}} but does not declare it in playbookKeys — the substitution machinery only resolves declared keys`,
                );
            }
        }

        const escalationKey = cap.escalation?.notification_template;
        for (const key of cap.playbookKeys) {
            assert.ok(
                referenced.has(key) ||
                    key === escalationKey ||
                    key === SHARED_RISK_KEY,
                `${id} declares playbook key "${key}" but never references it — drop it or inline it`,
            );
        }

        assert.ok(
            escalationKey,
            `${id} must declare an escalation notification_template`,
        );
        assert.ok(
            declared.has(escalationKey!),
            `${id}.escalation.notification_template "${escalationKey}" must be in playbookKeys`,
        );
        assert.ok(
            (cap.escalation?.severities_requiring_escalation.length ?? 0) > 0,
            `${id} must declare at least one escalating severity`,
        );
    }
}

// (4) Signal + output-spec hygiene.
const BARE_DOCUMENT_WORDS = new Set([
    "agreement",
    "contract",
    "license",
    "licence",
    "lease",
    "policy",
]);

async function testSignalAndOutputHygiene() {
    for (const id of GENERAL_CAPABILITY_IDS) {
        const cap = getCapability(id);
        assert.ok(cap, `capability ${id} should be registered`);

        assert.ok(
            cap.intentSignals.run_label.trim().length > 0,
            `${id}.run_label must be non-empty`,
        );
        assert.ok(
            cap.intentSignals.confirm_prompt.trim().length > 0,
            `${id}.confirm_prompt must be non-empty`,
        );

        for (const kw of cap.intentSignals.keywords) {
            assert.equal(
                kw,
                kw.toLowerCase(),
                `${id} keyword "${kw}" must be lowercase`,
            );
            assert.ok(kw.trim().length > 0, `${id} has an empty keyword`);
        }
        for (const hint of cap.intentSignals.document_hints) {
            assert.equal(
                hint,
                hint.toLowerCase(),
                `${id} document hint "${hint}" must be lowercase`,
            );
            assert.ok(
                !BARE_DOCUMENT_WORDS.has(hint),
                `${id} document hint "${hint}" is a bare document word — a structural hint can fire a chip on its own, so it must be a specific document type`,
            );
        }

        const spec = cap.outputSpec;
        assert.ok(spec, `${id} must declare an outputSpec to run in chat`);
        assert.equal(
            spec.overall_scheme,
            EXPECTED[id].overall_scheme,
            `${id}.outputSpec.overall_scheme`,
        );
        assert.ok(
            spec.sections.length > 0,
            `${id}.outputSpec.sections must be non-empty`,
        );

        const seen = new Set<string>();
        for (const section of spec.sections) {
            assert.ok(
                section.id.trim().length > 0 && !seen.has(section.id),
                `${id}.outputSpec has a duplicate or empty section id "${section.id}"`,
            );
            seen.add(section.id);
            assert.ok(
                section.label.trim().length > 0,
                `${id}.outputSpec section "${section.id}" needs a label`,
            );
            if (section.kind === "table") {
                assert.ok(
                    (section.columns?.length ?? 0) >= 2,
                    `${id}.outputSpec table section "${section.id}" needs at least 2 columns`,
                );
            }
        }

        for (const requiredId of EXPECTED[id].requiredSections) {
            const found: CapabilityOutputSection | undefined =
                spec.sections.find((s) => s.id === requiredId);
            assert.ok(
                found,
                `${id}.outputSpec is missing section "${requiredId}"`,
            );
            assert.equal(
                found.required,
                true,
                `${id}.outputSpec section "${requiredId}" must be required`,
            );
        }
    }
}

// (5) review-contract collects the represented side before it can run, and
// its prompt actually uses it.
async function testRepresentedPartyIntake() {
    const cap = getCapability("review-contract");
    assert.ok(cap);
    assert.ok(
        cap.intake?.includes("represented_party"),
        "review-contract must collect represented_party via intake",
    );
    assert.equal(cap.workflow.type, "assistant");
    if (cap.workflow.type === "assistant") {
        assert.ok(
            cap.workflow.prompt_md.includes("{{representedParty}}"),
            "review-contract.prompt_md must use {{representedParty}}",
        );
    }
}

// (6) Migration section B adds the two chat columns idempotently.
async function testMigrationSectionB() {
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
    assert.ok(
        /alter table public\.chats\s+add column if not exists suggestion_settings jsonb/i.test(
            sql,
        ),
        "042 must add chats.suggestion_settings with `add column if not exists`",
    );
    assert.ok(
        /alter table public\.chat_messages\s+add column if not exists capability_run jsonb/i.test(
            sql,
        ),
        "042 must add chat_messages.capability_run with `add column if not exists`",
    );
}

async function main() {
    await testRegistration();
    await testSeedLockstep();
    await testPlaceholderHygiene();
    await testSignalAndOutputHygiene();
    await testRepresentedPartyIntake();
    await testMigrationSectionB();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
