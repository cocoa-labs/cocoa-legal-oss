import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSections } from "./templateAssembly";

test("assembleSections substitutes deterministically and only LLM-expands marked sections", async () => {
  const calls: string[] = [];
  const draftSection = async (s: any) => { calls.push(s.id); return `EXPANDED:${s.id}`; };
  const out = await assembleSections({
    skeleton: [
      { id: "parties", heading: "Parties", body_md: "{{var.landlord}} and {{var.tenant}}." },
      { id: "use", heading: "Permitted Use", body_md: "", variables_used: [] },
    ],
    variables: { landlord: "Acme LLC", tenant: "Beta Inc" },
    playbookEntries: {},
    draftSection,
  });
  assert.equal(out.sections[0].content, "Acme LLC and Beta Inc.");
  assert.equal(out.sections[1].content, "EXPANDED:use");
  assert.deepEqual(calls, ["use"]);
  assert.equal(out.provenance[0].source, "substitution");
  assert.equal(out.provenance[1].source, "llm");
});
