// backend/src/lib/systemPrompt/substitute.test.ts
import assert from "node:assert/strict";
import {
    substitute,
    substituteVariables,
    validateVariables,
    extractPlaybookKeys,
    __resetSubstituteWarnings,
    DEFAULT_REPRESENTED_PARTY,
} from "./substitute";
import type { PlaybookEntry } from "../playbooks";
import type { TemplateVariable } from "../templates";

function entry(value: unknown): PlaybookEntry {
    return {
        id: "e1",
        playbook_id: "p1",
        key: "k",
        value_json: value,
        notes_md: "",
        is_default: false,
        updated_by: "u1",
        updated_at: "2026-01-01T00:00:00Z",
    };
}

async function testPresentStringValue() {
    // A bare string value is inlined verbatim (no JSON quoting).
    const out = substitute("Greeting: {{playbook:greeting}}.", {
        greeting: "Hello world",
    });
    assert.equal(out, "Greeting: Hello world.");
}

async function testPresentObjectValueIsJsonStringified() {
    const out = substitute("Positions: {{playbook:nda.positions}}", {
        "nda.positions": { mutual: true, term_years: 2 },
    });
    assert.equal(out, 'Positions: {"mutual":true,"term_years":2}');
}

async function testPlaybookEntryUsesValueJson() {
    // When the entry is a full PlaybookEntry, its value_json is used.
    const out = substitute("X={{playbook:k}}", { k: entry("from-value-json") });
    assert.equal(out, "X=from-value-json");

    const out2 = substitute("X={{playbook:k}}", { k: entry({ a: 1 }) });
    assert.equal(out2, 'X={"a":1}');
}

async function testAbsentKeyDropsToEmptyAndWarnsOnce() {
    __resetSubstituteWarnings();
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args);
    };
    try {
        // Two occurrences of the same missing key across two calls — must
        // collapse the placeholder to "" and warn exactly once.
        const a = substitute("[{{playbook:missing}}]", {});
        const b = substitute("again [{{playbook:missing}}]", {});
        assert.equal(a, "[]");
        assert.equal(b, "again []");
        assert.equal(
            warnings.length,
            1,
            `expected one warn, got ${warnings.length}`,
        );
    } finally {
        console.warn = original;
    }
}

async function testNoPlaceholderPassthrough() {
    const text = "Plain methodology text with no placeholders at all.";
    assert.equal(substitute(text, { unused: "x" }), text);
    assert.equal(substitute(text, {}), text);
}

async function testMultipleAndRepeatedPlaceholders() {
    const out = substitute(
        "{{playbook:a}} and {{playbook:b}} and {{playbook:a}}",
        { a: "A", b: "B" },
    );
    assert.equal(out, "A and B and A");
}

async function testNullValueDropsToEmpty() {
    // An explicitly-present null/undefined value yields "" rather than the
    // literal string "null" (which would pollute the prompt).
    __resetSubstituteWarnings();
    assert.equal(substitute("[{{playbook:k}}]", { k: null }), "[]");
    assert.equal(substitute("[{{playbook:k}}]", { k: entry(null) }), "[]");
}

async function testExtractPlaybookKeys() {
    // Single string, multiple/duplicate keys → deduped, order-stable.
    assert.deepEqual(
        extractPlaybookKeys("{{playbook:a}} x {{playbook:b}} y {{playbook:a}}"),
        ["a", "b"],
    );
    // Array of templates, union across them.
    assert.deepEqual(
        extractPlaybookKeys([
            "no placeholders here",
            "uses {{playbook:c}}",
            "uses {{playbook:b}} and {{playbook:c}}",
        ]),
        ["c", "b"],
    );
    // No placeholders → empty.
    assert.deepEqual(extractPlaybookKeys("plain text"), []);
    assert.deepEqual(extractPlaybookKeys([]), []);
}

async function testRepresentedPartyProvidedValueReplaces() {
    // A provided side replaces every {{representedParty}} occurrence verbatim,
    // and NO literal placeholder survives.
    const out = substitute(
        "Frame from {{representedParty}}'s side; {{representedParty}} wants X.",
        {},
        "Tenant",
    );
    assert.equal(out, "Frame from Tenant's side; Tenant wants X.");
    assert.equal(out.includes("{{representedParty}}"), false);
}

async function testRepresentedPartyAbsentUsesNeutralDefault() {
    // No value (undefined) and explicit null/blank both collapse to the
    // neutral default — never the literal token.
    for (const value of [undefined, null, "", "   "] as (
        | string
        | null
        | undefined
    )[]) {
        const out = substitute("Represent {{representedParty}}.", {}, value);
        assert.equal(
            out,
            `Represent ${DEFAULT_REPRESENTED_PARTY}.`,
            `value=${JSON.stringify(value)} should use the neutral default`,
        );
        assert.equal(out.includes("{{representedParty}}"), false);
    }
}

async function testRepresentedPartyAndPlaybookCoexist() {
    // Both placeholder kinds in one template are resolved together; no literal
    // {{playbook: or {{representedParty}} survives.
    const out = substitute(
        "Grade against {{playbook:cre.lease.standard_positions}} from {{representedParty}}'s side.",
        { "cre.lease.standard_positions": "NNN market position" },
        "Landlord",
    );
    assert.equal(
        out,
        "Grade against NNN market position from Landlord's side.",
    );
    assert.equal(out.includes("{{"), false);
}

async function testRepresentedPartyTrimsProvidedValue() {
    // A padded value is trimmed before substitution.
    const out = substitute("{{representedParty}} represents.", {}, "  Buyer  ");
    assert.equal(out, "Buyer represents.");
}

async function testNoRepresentedPartyPlaceholderPassthrough() {
    // A template with neither placeholder is returned unchanged even when a
    // represented side is supplied (no spurious mutation).
    const text = "Plain text, no placeholders.";
    assert.equal(substitute(text, {}, "Tenant"), text);
}

// ---- {{var.*}} substitution + variable validation (Task 6) ----

async function testSubstituteVariablesReplacesValues() {
    const out = substituteVariables(
        "Landlord: {{var.landlord}}; Rent: {{var.rent}}",
        { landlord: "Acme LLC", rent: "$10,000" },
    );
    assert.equal(out, "Landlord: Acme LLC; Rent: $10,000");
}

async function testSubstituteVariablesColonFormAndCoercion() {
    // The {{var:name}} colon form is supported alongside {{var.name}}, and a
    // non-string value is coerced via String() rather than JSON-stringified.
    const out = substituteVariables("Term: {{var:term}}; N={{var.count}}", {
        term: "12 months",
        count: 3,
    });
    assert.equal(out, "Term: 12 months; N=3");
}

async function testSubstituteVariablesBlanksMissing() {
    // A missing var collapses to "" — the literal {{var.*}} token must never
    // leak into the assembled section body.
    const out = substituteVariables("X: {{var.ghost}}", {});
    assert.equal(out, "X: ");
    assert.equal(out.includes("{{var"), false);
}

async function testSubstituteVariablesNoTokenPassthrough() {
    const text = "Plain clause body, no variables.";
    assert.equal(substituteVariables(text, { unused: "x" }), text);
}

async function testValidateVariablesFlagsMissingRequired() {
    const res = validateVariables(
        [{ name: "landlord", label: "Landlord", type: "party", required: true }],
        {},
    );
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("landlord")));
}

async function testValidateVariablesRejectsBadEnum() {
    const res = validateVariables(
        [
            {
                name: "kind",
                label: "Kind",
                type: "enum",
                required: true,
                enum_options: ["gross", "net"],
            },
        ],
        { kind: "triple" },
    );
    assert.equal(res.ok, false);
}

async function testValidateVariablesRejectsNonNumericMoney() {
    // money/number must parse after stripping $ and , — "abc" fails.
    const res = validateVariables(
        [{ name: "rent", label: "Rent", type: "money", required: true }],
        { rent: "abc" },
    );
    assert.equal(res.ok, false);
    // A well-formed currency string passes (commas/$ stripped).
    const ok = validateVariables(
        [{ name: "rent", label: "Rent", type: "money", required: true }],
        { rent: "$10,000" },
    );
    assert.equal(ok.ok, true);
}

async function testValidateVariablesPassesWellFormedSet() {
    const res = validateVariables(
        [
            { name: "landlord", label: "Landlord", type: "party", required: true },
            { name: "term", label: "Term", type: "duration", required: false },
        ],
        { landlord: "Acme LLC" },
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
}

async function testValidateVariablesSkipsDependsOnHiddenRequired() {
    // A REQUIRED variable gated by an unmet dependsOn is invisible in the
    // wizard, so it must not be enforced here either — otherwise the wizard's
    // gate (which skips hidden fields) passes but /assemble 400s. Schema: a
    // required `entity_state` that only shows when `entity_type === "LLC"`.
    const schema: TemplateVariable[] = [
        { name: "entity_type", label: "Entity Type", type: "text", required: true },
        {
            name: "entity_state",
            label: "State of Formation",
            type: "text",
            required: true,
            dependsOn: { name: "entity_type", equals: "LLC" },
        },
    ];

    // Controller present but NOT equal to `equals` → dependent hidden → its
    // absence must NOT be an error. (entity_type itself is supplied.)
    const hidden = validateVariables(schema, { entity_type: "Corporation" });
    assert.equal(hidden.ok, true, "hidden required dependsOn field must not fail");
    assert.deepEqual(hidden.errors, []);

    // Controller missing entirely → undefined !== "LLC" → still hidden, still
    // not enforced (matches the frontend, where a missing controller value
    // also hides the dependent field).
    const hiddenNoController = validateVariables(schema, {});
    assert.ok(
        !hiddenNoController.errors.some((e) => e.includes("entity_state")),
        "absent controller hides the dependent field — no entity_state error",
    );

    // Controller EQUALS `equals` → dependent visible. Empty → required fails.
    const visibleEmpty = validateVariables(schema, { entity_type: "LLC" });
    assert.equal(visibleEmpty.ok, false, "visible empty required field must fail");
    assert.ok(
        visibleEmpty.errors.some((e) => e.includes("entity_state")),
        "the now-visible required field is flagged missing",
    );

    // Controller EQUALS and dependent filled → all good.
    const visibleFilled = validateVariables(schema, {
        entity_type: "LLC",
        entity_state: "Delaware",
    });
    assert.equal(visibleFilled.ok, true);
    assert.deepEqual(visibleFilled.errors, []);
}

async function main() {
    await testPresentStringValue();
    await testPresentObjectValueIsJsonStringified();
    await testPlaybookEntryUsesValueJson();
    await testAbsentKeyDropsToEmptyAndWarnsOnce();
    await testNoPlaceholderPassthrough();
    await testMultipleAndRepeatedPlaceholders();
    await testNullValueDropsToEmpty();
    await testExtractPlaybookKeys();
    await testRepresentedPartyProvidedValueReplaces();
    await testRepresentedPartyAbsentUsesNeutralDefault();
    await testRepresentedPartyAndPlaybookCoexist();
    await testRepresentedPartyTrimsProvidedValue();
    await testNoRepresentedPartyPlaceholderPassthrough();
    await testSubstituteVariablesReplacesValues();
    await testSubstituteVariablesColonFormAndCoercion();
    await testSubstituteVariablesBlanksMissing();
    await testSubstituteVariablesNoTokenPassthrough();
    await testValidateVariablesFlagsMissingRequired();
    await testValidateVariablesRejectsBadEnum();
    await testValidateVariablesRejectsNonNumericMoney();
    await testValidateVariablesPassesWellFormedSet();
    await testValidateVariablesSkipsDependsOnHiddenRequired();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
