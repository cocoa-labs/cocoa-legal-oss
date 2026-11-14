import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTemplateShape, resolveTemplate, createTemplateVersion } from "./templates";

test("validateTemplateShape accepts a well-formed template", () => {
  const res = validateTemplateShape(
    [{ id: "s1", heading: "Parties", body_md: "{{var.landlord}} and {{var.tenant}}", variables_used: ["landlord", "tenant"] }],
    [
      { name: "landlord", label: "Landlord", type: "party", required: true },
      { name: "tenant", label: "Tenant", type: "party", required: true },
    ],
    [],
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test("validateTemplateShape rejects duplicate section ids", () => {
  const res = validateTemplateShape([{ id: "s1" }, { id: "s1" }], [], []);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("duplicate section id")));
});

test("validateTemplateShape rejects variables_used not in the schema", () => {
  const res = validateTemplateShape(
    [{ id: "s1", variables_used: ["ghost"] }],
    [{ name: "landlord", label: "Landlord", type: "party", required: true }],
    [],
  );
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("ghost")));
});

test("validateTemplateShape rejects a clause_slot_key with no matching slot", () => {
  const res = validateTemplateShape(
    [{ id: "s1", clause_slot_key: "snda" }],
    [],
    [{ key: "holdover", title: "Holdover" }],
  );
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("snda")));
});

test("validateTemplateShape rejects a body_md token not declared in the schema", () => {
  const res = validateTemplateShape(
    [{ id: "s1", heading: "Rent", body_md: "Rent is {{var.base_rent}} and {{var.ghost}}." }],
    [{ name: "base_rent", label: "Base Rent", type: "money", required: true }],
    [],
  );
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("ghost")));
});

test("validateTemplateShape accepts body_md tokens that are all declared (and ignores {{cocoa-sign:N}})", () => {
  const res = validateTemplateShape(
    [
      { id: "s1", heading: "Parties", body_md: "{{var.landlord}} and {{var.tenant}}." },
      { id: "sig", heading: "Signatures", body_md: "{{cocoa-sign:0}}\nBy: ____\n{{cocoa-sign:1}}\nBy: ____" },
    ],
    [
      { name: "landlord", label: "Landlord", type: "party", required: true },
      { name: "tenant", label: "Tenant", type: "party", required: true },
    ],
    [],
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test("validateTemplateShape rejects an unknown variable type", () => {
  const res = validateTemplateShape(
    [{ id: "s1" }],
    [{ name: "x", label: "X", type: "frobnicate" as never, required: false }],
    [],
  );
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("type")));
});

test("validateTemplateShape returns an error (does not throw) for a non-array skeleton", () => {
  const res = validateTemplateShape({} as never, [], []);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("skeleton must be a non-empty array")));
});

test("validateTemplateShape rejects an enum variable with no options", () => {
  const res = validateTemplateShape(
    [{ id: "s1" }],
    [{ name: "kind", label: "Kind", type: "enum", required: true }],
    [],
  );
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("enum_options")));
});

function fakeDb(rows: Record<string, unknown[]>) {
  return {
    from(table: string) {
      let res = rows[table] ?? [];
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => { res = res.filter((r: any) => r[col] === val); return builder; },
        in: (col: string, vals: unknown[]) => { res = res.filter((r: any) => vals.includes((r as any)[col])); return builder; },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: res[0] ?? null, error: null }),
        single: async () => ({ data: res[0] ?? null, error: null }),
        then: undefined,
      };
      return builder;
    },
  } as any;
}

test("resolveTemplate prefers the firm row over default-shared", async () => {
  const db = fakeDb({
    document_templates: [
      { id: "t-firm", firm_id: "user-1", slug: "commercial-lease", current_version_id: "v-firm", doc_type: "commercial_lease", title: "Firm Lease", practice: "Real Estate", jurisdiction: null, description: null, source_kind: "firm_parameterized", status: "active" },
      { id: "t-def", firm_id: "default-shared", slug: "commercial-lease", current_version_id: "v-def", doc_type: "commercial_lease", title: "Default Lease", practice: "Real Estate", jurisdiction: null, description: null, source_kind: "cocoa_seed", status: "active" },
    ],
    template_versions: [
      { id: "v-firm", version_number: 2, skeleton_json: [{ id: "s1" }], variable_schema_json: [], clause_slots_json: [], generation_notes_md: "" },
      { id: "v-def", version_number: 1, skeleton_json: [{ id: "d1" }], variable_schema_json: [], clause_slots_json: [], generation_notes_md: "" },
    ],
  });
  const r = await resolveTemplate(db, "user-1", "commercial-lease");
  assert.equal(r?.template.id, "t-firm");
  assert.equal(r?.version.skeleton[0].id, "s1");
});

test("resolveTemplate falls back to default-shared when the firm has none", async () => {
  const db = fakeDb({
    document_templates: [
      { id: "t-def", firm_id: "default-shared", slug: "loi", current_version_id: "v-def", doc_type: "loi", title: "LOI", practice: "Real Estate", jurisdiction: null, description: null, source_kind: "cocoa_seed", status: "active" },
    ],
    template_versions: [
      { id: "v-def", version_number: 1, skeleton_json: [{ id: "d1" }], variable_schema_json: [], clause_slots_json: [], generation_notes_md: "" },
    ],
  });
  const r = await resolveTemplate(db, "user-1", "loi");
  assert.equal(r?.template.id, "t-def");
});

test("resolveTemplate returns null (no throw) for an unknown slug", async () => {
  const db = fakeDb({ document_templates: [], template_versions: [] });
  const r = await resolveTemplate(db, "user-1", "no-such-template");
  assert.equal(r, null);
});

// FIX 1 (cross-firm IDOR): a uuid lookup must be firm-scoped. A template whose
// firm_id is neither the caller's firm nor default-shared must resolve to null,
// even though the uuid exists — otherwise any firm's doc is readable by UUID.
test("resolveTemplate returns null for a uuid owned by another firm", async () => {
  const foreignId = "11111111-1111-4111-8111-111111111111";
  const db = fakeDb({
    document_templates: [
      { id: foreignId, firm_id: "user-2", slug: "secret-lease", current_version_id: "v-2", doc_type: "commercial_lease", title: "Other Firm Lease", practice: "Real Estate", jurisdiction: null, description: null, source_kind: "firm_parameterized", status: "active" },
    ],
    template_versions: [
      { id: "v-2", version_number: 1, skeleton_json: [{ id: "x1" }], variable_schema_json: [], clause_slots_json: [], generation_notes_md: "" },
    ],
  });
  const r = await resolveTemplate(db, "user-1", foreignId);
  assert.equal(r, null);
});

// FIX 1: a default-shared template is still resolvable by uuid (it's in the
// allowed firm list for every caller), so the scoping doesn't break shared defaults.
test("resolveTemplate still resolves a default-shared template by uuid", async () => {
  const sharedId = "22222222-2222-4222-8222-222222222222";
  const db = fakeDb({
    document_templates: [
      { id: sharedId, firm_id: "default-shared", slug: "loi", current_version_id: "v-def", doc_type: "loi", title: "LOI", practice: "Real Estate", jurisdiction: null, description: null, source_kind: "cocoa_seed", status: "active" },
    ],
    template_versions: [
      { id: "v-def", version_number: 1, skeleton_json: [{ id: "d1" }], variable_schema_json: [], clause_slots_json: [], generation_notes_md: "" },
    ],
  });
  const r = await resolveTemplate(db, "user-1", sharedId);
  assert.equal(r?.template.id, sharedId);
});

// FIX 5 (version_number race): createTemplateVersion must retry when the
// template_versions insert hits the UNIQUE(template_id, version_number) index
// (e.g. a concurrent generate took the same number). The second insert here is
// rigged to fail once with a unique-violation; the function should re-read the
// max and succeed on retry without throwing.
test("createTemplateVersion retries past a version_number unique-violation", async () => {
  let insertedVersions: any[] = [];
  let failOnce = true;
  const db: any = {
    from(table: string) {
      const builder: any = {
        _table: table,
        _filters: [] as Array<(r: any) => boolean>,
        select() { return builder; },
        eq(col: string, val: unknown) {
          builder._filters.push((r: any) => r[col] === val);
          return builder;
        },
        order() { return builder; },
        limit() { return builder; },
        insert(row: any) {
          builder._insertRow = row;
          return builder;
        },
        update() { return builder; },
        async maybeSingle() {
          if (builder._table === "document_templates") {
            // get-or-create: pretend the template row already exists.
            return { data: { id: "tmpl-1" }, error: null };
          }
          if (builder._table === "template_versions") {
            // return the current max version_number row
            const rows = insertedVersions
              .slice()
              .sort((a, b) => b.version_number - a.version_number);
            return { data: rows[0] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          if (builder._insertRow && builder._table === "template_versions") {
            if (failOnce) {
              failOnce = false;
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"template_versions_tmpl_vnum_unique\"" } };
            }
            const id = `ver-${insertedVersions.length + 1}`;
            insertedVersions.push({ id, version_number: builder._insertRow.version_number });
            return { data: { id }, error: null };
          }
          if (builder._insertRow && builder._table === "document_templates") {
            return { data: { id: "tmpl-1" }, error: null };
          }
          // document_templates.select(...).single() in get-or-create
          return { data: { id: "tmpl-1" }, error: null };
        },
      };
      return builder;
    },
  };
  // Seed an existing version so the first computed number is 2; the first insert
  // for #2 fails with 23505, then retry re-reads (still max 1) → #2 succeeds.
  insertedVersions.push({ id: "ver-0", version_number: 1 });
  const res = await createTemplateVersion(db, {
    firmId: "user-1", slug: "commercial-lease", title: "Lease", docType: "commercial_lease",
    skeleton: [{ id: "s1" }] as any, variableSchema: [], clauseSlots: [],
    sourceKind: "firm_parameterized", userId: "user-1",
  });
  assert.equal(res.templateId, "tmpl-1");
  assert.equal(res.versionNumber, 2);
  assert.equal(failOnce, false); // the conflict path was actually exercised
});
