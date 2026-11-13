// backend/src/lib/legalCapabilities/register.ts
//
// Capability registration entry point. Each legal capability module
// self-registers by calling `registerCapability` at module load (see
// legalCapabilities/index.ts). Importing this module once during backend
// bootstrap pulls in every capability so the registry is populated before
// any router serves traffic.
//
// This module is intentionally side-effect-only: it has no exports. It is
// imported for its import-time effects, not for any value.
//
// Each capability module self-registers at import time. Add a capability to
// production by importing it here. buildSystemPrompt({}) output stays
// byte-identical to the legacy prompt regardless of what is registered,
// because the firm-aware preamble/fragments are gated on the ctx flag, not
// on registry contents (see systemPrompt/index.ts).
import "./commercialRealEstate";
import "./documentAuthoring";
import "./piClaimsTriage";
import "./piInvoiceProcessing";
import "./recordingsCapability";
import "./calendarCapability";
import "./complianceCheck";
import "./legalRiskAssessment";
import "./triageNda";
import "./reviewContract";

export {};
