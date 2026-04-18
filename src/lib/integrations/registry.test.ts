// ────────────────────────────────────────────────────────────────
// Tests for the integration registry barrel — ensures the toolMap is
// wired correctly and every expected action key exists.
// ────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { buildIntegrations } from "./index";

describe("integration registry", () => {
  it("exposes every expected tool action in the flat map", () => {
    const { toolMap, integrations } = buildIntegrations();

    // Every integration should have reported as mock (we have no real keys).
    for (const i of integrations) {
      expect(i.isMock).toBe(true);
    }

    // The orchestrator relies on these exact keys. If anyone renames an action,
    // this test breaks loudly and forces a system-prompt update.
    const expectedKeys = [
      "docusign.send_offer",
      "docusign.check_status",
      "checkr.order_check",
      "checkr.get_result",
      "gusto.create_employee",
      "gusto.enroll_ichra",
      "shippo.verify_address",
      "shippo.create_shipment",
      "kandji.create_enrollment",
      "kandji.get_enrollment",
    ];

    for (const key of expectedKeys) {
      expect(toolMap, `missing tool ${key}`).toHaveProperty(key);
    }
  });
});
