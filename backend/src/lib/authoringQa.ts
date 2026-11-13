// backend/src/lib/authoringQa.ts
export interface QaFinding {
  guardrail: "defined_terms" | "playbook" | "jurisdiction" | "research";
  severity: "info" | "advisory" | "blocking";
  section_id?: string;
  message: string;
  evidence?: string;
  suggestion?: string;
  citations?: unknown[];
}

/**
 * Deterministic pass over the EXTRACTED (plain-text) draft. It is a heuristic
 * over numberless text, so it NEVER returns `blocking` — blocking severity is
 * reserved exclusively for the LLM playbook / deal-breaker guardrail. This
 * scanner emits only `advisory` findings:
 *
 *  - `Section N` / `Clause N` cross-references. Assembled .docx files use Word
 *    AUTO-numbering: the visible clause numbers live in `numbering.xml`, NOT in
 *    the run text we extract here, so the set of "existing" literal `N.` clause
 *    numbers is essentially always empty for assembled docs. We therefore can
 *    NOT reliably confirm a cross-reference resolves from extracted text — we
 *    surface it as an advisory heads-up to confirm manually rather than a false
 *    `blocking` that would stop every valid draft from being sent.
 *  - Capitalized multi-word terms used like defined terms but never defined.
 *    Required to appear capitalized at least TWICE to drop single-mention
 *    proper-noun noise.
 */
export function scanDefinedTermsAndCrossRefs(text: string): QaFinding[] {
  const findings: QaFinding[] = [];

  // Cross-references to Section/Clause N. We can't verify these against
  // auto-generated numbering from extracted text, so every reference is an
  // advisory "could not auto-verify" heads-up — never blocking.
  for (const m of text.matchAll(/\b(?:Section|Clause)\s+(\d+)/g)) {
    findings.push({
      guardrail: "defined_terms",
      severity: "advisory",
      message: `Cross-reference to Section ${m[1]} could not be auto-verified — confirm it resolves.`,
      evidence: m[0],
    });
  }

  // Defined terms: `"X" means` / `(the "X")` define; `the X` usage references.
  const defined = new Set<string>();
  for (const m of text.matchAll(/"([A-Z][A-Za-z ]+)"\s+(?:means|shall mean)/g)) defined.add(m[1]);
  for (const m of text.matchAll(/\(\s*the\s+"([A-Z][A-Za-z ]+)"\s*\)/g)) defined.add(m[1]);
  // Bare parenthetical definition: Acme LLC ("Landlord"). Common for parties.
  for (const m of text.matchAll(/\(\s*"([A-Z][A-Za-z ]+)"\s*\)/g)) defined.add(m[1]);

  // Capitalized multi-use terms that look defined but aren't. The usage capture
  // matches a MULTI-WORD capitalized phrase (e.g. "the Base Rent"), mirroring
  // the multi-word DEFINITION regex above — capturing only the first word
  // ("Base") would falsely flag a genuinely-defined multi-word term.
  //
  // The article is written as `[Tt]he` (NOT the `/i` flag) on purpose: the
  // article reads identically whether sentence-initial ("The Property is ...")
  // or mid-sentence ("rent for the Property"), so we accept both casings — but
  // we must NOT relax case on the captured TERM. Under `/i` the continuation
  // `[A-Z][a-z]+` would match ordinary lowercase words too ("Property is
  // described in Exhibit" captured as one phrase), so the genuine multi-word
  // term would never be isolated and would slip past the >=2 threshold. Keeping
  // the term capture case-SENSITIVE means every word in the phrase must truly
  // begin uppercase, which is exactly the "looks like a defined term" signal.
  const usedCounts = new Map<string, number>();
  for (const m of text.matchAll(/\b[Tt]he\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g)) {
    const term = m[1];
    usedCounts.set(term, (usedCounts.get(term) ?? 0) + 1);
  }
  for (const [term, count] of usedCounts) {
    // Require >= 2 occurrences: a term used like a defined term recurs, so a
    // single capitalized mention is most likely an ordinary proper noun, not a
    // missing definition. Drops single-mention noise.
    if (count >= 2 && !defined.has(term) && !["The"].includes(term)) {
      findings.push({
        guardrail: "defined_terms",
        severity: "advisory",
        message: `"${term}" is used like a defined term but is never defined.`,
        evidence: `the ${term}`,
      });
    }
  }
  return findings;
}

export async function runAuthoringQa(args: {
  text: string;
  docType: string;
  variables: Record<string, unknown>;
  playbookEntries: Record<string, unknown>;
  jurisdiction?: string | null;
  /** LLM check covering playbook-compliance + jurisdiction language. Injected. */
  runCheck: (a: { text: string; docType: string; playbookEntries: Record<string, unknown>; jurisdiction?: string | null }) => Promise<QaFinding[]>;
  /** legal_search grounding for novel clauses. Injected. */
  runResearch: (a: { text: string; jurisdiction?: string | null }) => Promise<QaFinding[]>;
}): Promise<{ findings: QaFinding[]; status: "passed" | "advisory" | "blocked" }> {
  const [deterministic, checks, research] = await Promise.all([
    Promise.resolve(scanDefinedTermsAndCrossRefs(args.text)),
    args.runCheck({ text: args.text, docType: args.docType, playbookEntries: args.playbookEntries, jurisdiction: args.jurisdiction }).catch(() => []),
    args.runResearch({ text: args.text, jurisdiction: args.jurisdiction }).catch(() => []),
  ]);
  const findings = [...deterministic, ...checks, ...research];
  const status = findings.some((f) => f.severity === "blocking")
    ? "blocked"
    : findings.some((f) => f.severity === "advisory")
      ? "advisory"
      : "passed";
  return { findings, status };
}
