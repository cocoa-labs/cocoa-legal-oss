// backend/src/lib/legalCapabilities/types.ts

/**
 * A Capability Module declares everything one legal capability needs to be
 * usable from a workflow, the chat agent, the playbook layer, and the UI.
 * Each of the 9 Anthropic legal capabilities exports one of these as a
 * default const that the registry imports.
 */

import type { ColumnConfig } from "./workflowShared";
import type { RiskInput } from "./riskMap";

/** Practice areas surfaced in the WorkflowList filter chip. */
export type LegalPractice =
    | "Legal Operations"
    | "Corporate"
    | "Finance"
    | "Employment"
    | "Real Estate"
    | "Litigation"
    | "Personal Injury"
    | "Private Equity"
    | "General Transactions";

/**
 * The workflow shape the gallery uses. Mirrors the existing
 * CocoaLegalWorkflow shape (assistant or tabular) so a capability becomes a
 * built-in workflow with no extra plumbing. A capability may also declare
 * `sub_workflows` — IDs of legacy workflows that run as a deeper second
 * step (e.g. Triage NDA → NDA Review).
 */
export type CapabilityWorkflow =
    | {
          type: "assistant";
          /**
           * The prompt template. May contain `{{playbook:key}}` placeholders
           * that the runtime substitutes with the firm's current playbook
           * entry value at execution time.
           */
          prompt_md: string;
          sub_workflows?: string[];
      }
    | {
          type: "tabular";
          /** Same placeholder substitution applies inside column prompts. */
          columns_config: ColumnConfig[];
          /** Optional assistant-prompt preamble run before column extraction. */
          prompt_md?: string;
          sub_workflows?: string[];
      };

/**
 * System-prompt fragment a capability contributes to the chat agent's
 * combined system prompt. `persona_framing` is a 1-2 sentence "you are
 * doing X when …" hint; `methodology` is the procedural knowledge. Both
 * support `{{playbook:key}}` placeholders.
 */
export interface CapabilitySystemPromptFragment {
    persona_framing: string;
    methodology: string;
}

/**
 * Signals the intent router inspects to propose this capability for a
 * free-form chat message. Detection is purely lexical/structural in v1 —
 * no LLM classifier. See systematic-debugging notes on why we keep this
 * deterministic.
 */
export interface IntentSignals {
    /** Lowercased substrings to look for in the user's message. */
    keywords: string[];
    /**
     * Lowercased substrings to look for in attachment filenames OR in
     * the first 2KB of attachment text (PDF/DOCX-extracted).
     */
    document_hints: string[];
    /** Shown to the user as the confirm prompt. */
    confirm_prompt: string;
    /** Imperative label for the suggestion chip's primary button, e.g. "Run compliance check". Fixed per capability; never model-authored. */
    run_label: string;
}

export type CapabilitySectionKind = "text" | "list" | "table" | "findings";

export interface CapabilityOutputSection {
    /** Stable snake_case id the model must echo back, e.g. "regulations". */
    id: string;
    /** Human heading shown on the result card and in the DOCX export. */
    label: string;
    kind: CapabilitySectionKind;
    /** Column headers; required when kind === "table". */
    columns?: string[];
    /** When true the run is rejected if the section is missing. Default false. */
    required?: boolean;
}

export interface CapabilityOutputSpec {
    /** Which RiskInput scheme the model reports `overall` in (see riskMap.ts). */
    overall_scheme: RiskInput["scheme"];
    sections: CapabilityOutputSection[];
}

/** What this capability produces and through which Cocoa output paths. */
export interface OutputBindings {
    /** Set true if the capability can generate a DOCX export. */
    docx: boolean;
    /**
     * Set true if the capability produces a result that should land in
     * the existing versioned-document review UI (with highlights /
     * tracked-changes). Used by review-contract.
     */
    in_app_document: boolean;
    /**
     * If present, the capability can draft an email packet (recipient/
     * subject/body) the user reviews and sends through the Email
     * connector. `template` is a playbook key whose value is the email
     * body template.
     */
    draft_email?: { template: string };
}

/** Connector kinds a capability may require. Pure declaration, not wiring. */
export type ConnectorKind = "email" | "calendar" | "docStorage" | "esign";

/**
 * Escalation declaration. The capability's runtime emits a severity; if
 * it appears in `severities_requiring_escalation`, the result-card
 * surfaces an EscalationDraft component pre-filled from the playbook
 * template at `notification_template`.
 */
export interface EscalationDeclaration {
    severities_requiring_escalation: string[];
    notification_template: string;
}

/** The full capability declaration. */
export interface LegalCapability {
    /** Stable kebab-case identifier — used in URLs and registry lookups. */
    id: string;
    /** User-facing title (workflow gallery row, result-card header). */
    title: string;
    /** Practice area for filtering. */
    practice: LegalPractice;
    /** Short description shown in the gallery. */
    description: string;
    workflow: CapabilityWorkflow;
    systemPromptFragment: CapabilitySystemPromptFragment;
    /** Playbook keys this capability reads. Used by the system-prompt
     * builder to inline only the playbook entries relevant to the
     * current context. */
    playbookKeys: string[];
    intentSignals: IntentSignals;
    /** Frontend component name to render the result card. The component
     * lives at frontend/src/app/components/legal/cards/<resultCard>.tsx. */
    resultCard: string;
    outputs: OutputBindings;
    connectorRequirements: ConnectorKind[];
    escalation?: EscalationDeclaration;
    /** Registry-owned disambiguation text handed to the LLM intent
     * classifier so it can tell near-neighbour capabilities apart. */
    classifierGuidance?: { choose_when: string; do_not_choose_when: string };
    /** Inputs the suggestion chip must collect from the user before a run
     * can start. */
    intake?: ("represented_party")[];
    /** Presence means the capability can run in-chat and produce a
     * structured result card; absence means it cannot. */
    outputSpec?: CapabilityOutputSpec;
}
