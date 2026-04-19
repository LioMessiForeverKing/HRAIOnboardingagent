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
import type { Integration, IntegrationAction, IntegrationOpts } from "./types";

// ────────────────────────────────────────────────────────────────
// buildIntegrations — constructs every integration and returns:
//   - the typed `Integration` list for introspection
//   - a flat `toolMap` of "<tool>.<action>" → IntegrationAction
//
// Called once per graph build. Constructors may throw if real creds are
// present but not yet supported (Phase 3+).
//
// `opts.scenario` is forwarded to every integration so the demo can pin
// behavior to a specific test path (consider/suspended/declined/etc.)
// instead of relying on RNG.
// ────────────────────────────────────────────────────────────────
export function buildIntegrations(opts?: IntegrationOpts): {
  integrations: Integration[];
  toolMap: Record<string, IntegrationAction & { tool: string }>;
} {
  // Instantiate each integration. Today they're all mocks.
  const integrations: Integration[] = [
    createDocusignIntegration(opts),
    createCheckrIntegration(opts),
    createGustoIntegration(opts),
    createShippoIntegration(opts),
    createKandjiIntegration(opts),
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
export type { Integration, IntegrationAction, IntegrationOpts, Scenario } from "./types";
export { IntegrationError, ALL_SCENARIOS } from "./types";
