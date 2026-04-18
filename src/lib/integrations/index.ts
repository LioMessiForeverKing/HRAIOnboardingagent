// ────────────────────────────────────────────────────────────────
// Integration registry — builds all tool instances once and exposes
// a flat map of { "<tool>.<action>": IntegrationAction }.
//
// The orchestrator uses this flat map as its tool list: the LLM sees every
// action at once and picks the right one.
// ────────────────────────────────────────────────────────────────

import { createDocusignIntegration } from "./docusign";
import { createCheckrIntegration } from "./checkr";
import { createGustoIntegration } from "./gusto";
import { createShippoIntegration } from "./shippo";
import { createKandjiIntegration } from "./kandji";
import type { Integration, IntegrationAction } from "./types";

// ────────────────────────────────────────────────────────────────
// buildIntegrations — constructs every integration and returns:
//   - the typed `Integration` list for introspection
//   - a flat `toolMap` of "<tool>.<action>" → IntegrationAction
//
// Called once on agent startup. Constructors may throw if real creds are
// present but not yet supported (Phase 3+).
// ────────────────────────────────────────────────────────────────
export function buildIntegrations(): {
  integrations: Integration[];
  toolMap: Record<string, IntegrationAction & { tool: string }>;
} {
  // Instantiate each integration. Today they're all mocks.
  const integrations: Integration[] = [
    createDocusignIntegration(),
    createCheckrIntegration(),
    createGustoIntegration(),
    createShippoIntegration(),
    createKandjiIntegration(),
  ];

  // Flatten to a single lookup map. Keys use dot notation so the agent's
  // tool names read naturally: "docusign.send_offer".
  const toolMap: Record<string, IntegrationAction & { tool: string }> = {};
  for (const integration of integrations) {
    for (const [actionName, action] of Object.entries(integration.actions)) {
      toolMap[`${integration.name}.${actionName}`] = {
        ...action,
        tool: integration.name,
      };
    }
  }

  return { integrations, toolMap };
}

// Re-export key types so callers only need to import from this barrel file.
export type { Integration, IntegrationAction } from "./types";
export { IntegrationError } from "./types";
