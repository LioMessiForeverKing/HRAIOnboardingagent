// ────────────────────────────────────────────────────────────────
// Shippo integration — laptop shipment to nurse's home address.
//
// Real Shippo flow: verify address → buy shipping label → generate
// tracking number → monitor delivery. We compress into two actions.
//
// Actions:
//   verify_address   validate the home address is deliverable
//   create_shipment  buy the label + return tracking info
// ────────────────────────────────────────────────────────────────

import {
  type Integration,
  type IntegrationAction,
  IntegrationError,
  shouldUseMocks,
  z,
} from "./types";
import { simulateApiCall, generateId } from "./mock-utils";

// ────────────────────────────────────────────────────────────────
// Schemas
// ────────────────────────────────────────────────────────────────

// A reusable address shape — mirrors the one on the `hires` Convex table.
const addressSchema = z.object({
  street1: z.string(),
  street2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
});

const verifyAddressInput = z.object({
  address: addressSchema,
});

const verifyAddressOutput = z.object({
  valid: z.boolean(),
  // Shippo normalizes addresses (e.g. "st" → "Street"). Return the cleaned version.
  normalized: addressSchema.optional(),
  // If invalid, explain why so the exception queue can show it.
  issues: z.array(z.string()).optional(),
});

const createShipmentInput = z.object({
  hireId: z.string(),
  toAddress: addressSchema,
  // SKU of the laptop being shipped. For now a single nurse laptop config.
  itemSku: z.string().default("nurse-macbook-14"),
});

const createShipmentOutput = z.object({
  shipmentId: z.string(),
  trackingNumber: z.string(),
  carrier: z.enum(["ups", "fedex", "usps"]),
  estimatedDelivery: z.string().describe("ISO date"),
});

export function __resetShippoMock(): void {
  // No long-lived mock state for Shippo today, but keep the hook
  // symmetrical with the other integrations so test cleanup is uniform.
}

// ────────────────────────────────────────────────────────────────
// Actions
// ────────────────────────────────────────────────────────────────

const verifyAddress: IntegrationAction<typeof verifyAddressInput, typeof verifyAddressOutput> = {
  name: "shippo_verify_address",
  description:
    "Validate a shipping address is deliverable before buying a label. Always call this before create_shipment.",
  input: verifyAddressInput,
  output: verifyAddressOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "shippo",
      latencyMs: 100,
      jitterMs: 50,
      transientFailureRate: 0.01,
      hardFailureRate: 0,
      result: () => {
        // Simulate a ~5% "address unverifiable" rate — triggers escalation.
        const invalid = Math.random() < 0.05;
        if (invalid) {
          return {
            valid: false,
            issues: ["Primary number missing from street address"],
          };
        }
        return {
          valid: true,
          normalized: {
            ...input.address,
            // Pretend normalization upper-cased the state code + padded the zip.
            state: input.address.state.toUpperCase(),
            zip: input.address.zip.padStart(5, "0"),
          },
        };
      },
    });
  },
};

const createShipment: IntegrationAction<typeof createShipmentInput, typeof createShipmentOutput> = {
  name: "shippo_create_shipment",
  description:
    "Buy a shipping label for the nurse's laptop. Returns a carrier tracking number for the operator and dashboard.",
  input: createShipmentInput,
  output: createShipmentOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "shippo",
      latencyMs: 250,
      jitterMs: 100,
      // Shipping label purchases are mostly reliable, but warehouse rate-limits happen.
      transientFailureRate: 0.03,
      hardFailureRate: 0.01,
      result: () => {
        const carriers = ["ups", "fedex", "usps"] as const;
        const carrier = carriers[Math.floor(Math.random() * carriers.length)];
        return {
          shipmentId: generateId("shp"),
          trackingNumber: `${carrier.toUpperCase()}${generateId("tn").slice(3)}`,
          carrier,
          // Mock 3–5 days out.
          estimatedDelivery: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10),
        };
      },
    });
  },
};

export function createShippoIntegration(): Integration {
  const useMocks = shouldUseMocks(["SHIPPO_API_TOKEN"]);
  if (!useMocks) {
    throw new Error("Shippo real client not implemented yet — see README Phase 3");
  }

  return {
    name: "shippo",
    isMock: true,
    actions: { verify_address: verifyAddress, create_shipment: createShipment },
  };
}
