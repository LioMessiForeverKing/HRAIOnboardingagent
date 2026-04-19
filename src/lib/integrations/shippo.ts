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
  type IntegrationOpts,
  IntegrationError,
  shouldUseMocks,
  z,
} from "./types";
import { simulateApiCall, generateId, shouldTransientFailOnce } from "./mock-utils";

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

function makeVerifyAddress(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof verifyAddressInput, typeof verifyAddressOutput> {
  return {
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
        transientFailureRate: scenario === "all_success" ? 0 : 0.01,
        hardFailureRate: 0,
        result: () => {
          // Scenario "address_invalid" forces verify to fail; "all_success"
          // forces it to pass; otherwise 5% random invalid rate.
          const invalid =
            scenario === "address_invalid"
              ? true
              : scenario === "all_success"
                ? false
                : Math.random() < 0.05;
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
}

function makeCreateShipment(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof createShipmentInput, typeof createShipmentOutput> {
  return {
    name: "shippo_create_shipment",
    description:
      "Buy a shipping label for the nurse's laptop. Returns a carrier tracking number for the operator and dashboard.",
    input: createShipmentInput,
    output: createShipmentOutput,
    handler: async (_input) => {
      // Scenario "shippo_label_failed" hard-fails the label purchase
      // (carrier rejected it). Non-retryable — escalates immediately.
      if (scenario === "shippo_label_failed") {
        throw new IntegrationError(
          "Shippo label purchase rejected by carrier (mock — shippo_label_failed scenario)",
          "label_failed",
          false,
          "shippo",
        );
      }
      return simulateApiCall({
        tool: "shippo",
        latencyMs: 250,
        jitterMs: 100,
        // Shipping label purchases are mostly reliable, but warehouse rate-limits happen.
        transientFailureRate: scenario === "all_success" ? 0 : 0.03,
        hardFailureRate: scenario === "all_success" ? 0 : 0.01,
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
}

// ════════════════════════════════════════════════════════════════
// REAL API IMPLEMENTATION (COMMENTED OUT — uncomment when creds land)
//
// Shippo REST API (docs.goshippo.com).
//
// AUTH: single API token, prefix picks env:
//   Authorization: ShippoToken shippo_live_xxx   (prod)
//   Authorization: ShippoToken shippo_test_xxx   (sandbox)
//
// BASE URL: https://api.goshippo.com   (no env subdomain)
//
// ENDPOINTS USED:
//   POST /addresses/           — create + optionally validate an address.
//     Body: { name, street1, city, state, zip, country, validate: true, ... }
//     → { object_id, is_complete, validation_results: { is_valid, messages }, ... }
//
//   Label purchase flow — prefer the combined "instalabel":
//   POST /transactions/        — create shipment + rate + purchase in one call.
//     Body: { shipment: { address_from, address_to, parcels: [...] },
//             carrier_account, servicelevel_token, label_file_type, async: false }
//     → { object_id, status ("SUCCESS"|"ERROR"),
//         tracking_number, tracking_url_provider, label_url, rate (obj), ... }
//
//   OR the multi-step version:
//     POST /shipments/          → { rates: [{ object_id, provider, amount, ... }] }
//     POST /transactions/       with { rate: "<rate_object_id>",
//                                      label_file_type: "PDF", async: false }
//
// RATE LIMITS (per minute):
//   Live:  POST/PUT 500, GET-single 4,000, GET-list 50, Tracking POST 750
//   Test:  POST/PUT 50,  GET-single 400,   GET-list 10, Tracking POST 50
//   429 on overrun; Shippo does NOT document headers — back off + retry.
// ════════════════════════════════════════════════════════════════

// const SHIPPO_BASE = "https://api.goshippo.com";
//
// function shippoHeaders(): HeadersInit {
//   return {
//     Authorization: `ShippoToken ${process.env.SHIPPO_API_TOKEN}`,
//     "Content-Type": "application/json",
//   };
// }
//
// const verifyAddressReal: IntegrationAction<typeof verifyAddressInput, typeof verifyAddressOutput> = {
//   name: "shippo_verify_address",
//   description: verifyAddress.description,
//   input: verifyAddressInput,
//   output: verifyAddressOutput,
//   handler: async (input) => {
//     // const res = await fetch(`${SHIPPO_BASE}/addresses/`, {
//     //   method: "POST",
//     //   headers: shippoHeaders(),
//     //   body: JSON.stringify({
//     //     name: "Onboarding Nurse",
//     //     street1: input.address.street1,
//     //     street2: input.address.street2,
//     //     city: input.address.city,
//     //     state: input.address.state,
//     //     zip: input.address.zip,
//     //     country: "US",
//     //     validate: true,
//     //   }),
//     // });
//     // if (!res.ok) {
//     //   throw new IntegrationError(
//     //     `Shippo verify failed: ${res.status}`,
//     //     `http_${res.status}`,
//     //     res.status === 429 || res.status >= 500,
//     //     "shippo",
//     //   );
//     // }
//     // const body = await res.json();
//     // const v = body.validation_results ?? {};
//     // return {
//     //   valid: Boolean(v.is_valid),
//     //   normalized: v.is_valid
//     //     ? {
//     //         street1: body.street1,
//     //         street2: body.street2,
//     //         city: body.city,
//     //         state: body.state,
//     //         zip: body.zip,
//     //       }
//     //     : undefined,
//     //   issues: v.is_valid
//     //     ? undefined
//     //     : (v.messages ?? []).map((m: any) => m.text ?? String(m)),
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };
//
// const createShipmentReal: IntegrationAction<typeof createShipmentInput, typeof createShipmentOutput> = {
//   name: "shippo_create_shipment",
//   description: createShipment.description,
//   input: createShipmentInput,
//   output: createShipmentOutput,
//   handler: async (input) => {
//     // Ship-from is our warehouse — pin it in env so ops can change without a deploy.
//     // const fromAddress = {
//     //   name: "Acme Health HR",
//     //   street1: process.env.SHIPPING_FROM_STREET1!,
//     //   city: process.env.SHIPPING_FROM_CITY!,
//     //   state: process.env.SHIPPING_FROM_STATE!,
//     //   zip: process.env.SHIPPING_FROM_ZIP!,
//     //   country: "US",
//     // };
//
//     // const res = await fetch(`${SHIPPO_BASE}/transactions/`, {
//     //   method: "POST",
//     //   headers: shippoHeaders(),
//     //   body: JSON.stringify({
//     //     shipment: {
//     //       address_from: fromAddress,
//     //       address_to: {
//     //         name: "New Hire",
//     //         street1: input.toAddress.street1,
//     //         street2: input.toAddress.street2,
//     //         city: input.toAddress.city,
//     //         state: input.toAddress.state,
//     //         zip: input.toAddress.zip,
//     //         country: "US",
//     //       },
//     //       // MacBook 14 box: ~15×12×3 in, ~8 lb with packaging.
//     //       parcels: [{
//     //         length: "15", width: "12", height: "3", distance_unit: "in",
//     //         weight: "8", mass_unit: "lb",
//     //       }],
//     //     },
//     //     carrier_account: process.env.SHIPPO_CARRIER_ACCOUNT,
//     //     servicelevel_token: process.env.SHIPPO_SERVICELEVEL ?? "usps_priority",
//     //     label_file_type: "PDF",
//     //     async: false,
//     //   }),
//     // });
//     // if (!res.ok) { ...retryable throw... }
//     // const t = await res.json();
//     //
//     // if (t.status !== "SUCCESS") {
//     //   // Hard failure — carrier refused the label. Escalate.
//     //   throw new IntegrationError(
//     //     `Shippo label purchase failed: ${(t.messages ?? []).map((m: any) => m.text).join("; ")}`,
//     //     "label_failed",
//     //     false,
//     //     "shippo",
//     //     t,
//     //   );
//     // }
//     //
//     // // Derive carrier from the rate object. Shippo returns lowercase codes.
//     // const carrierCode: string = (t.rate?.provider ?? "usps").toLowerCase();
//     // const carrier = (["ups", "fedex", "usps"].includes(carrierCode) ? carrierCode : "usps") as
//     //   "ups" | "fedex" | "usps";
//     //
//     // return {
//     //   shipmentId: t.object_id,
//     //   trackingNumber: t.tracking_number,
//     //   carrier,
//     //   estimatedDelivery: t.eta ?? new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10),
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };

export function createShippoIntegration(opts?: IntegrationOpts): Integration {
  const useMocks = shouldUseMocks(["SHIPPO_API_TOKEN"]);
  if (!useMocks) {
    // See REAL API IMPLEMENTATION block above. To enable:
    //   1. Uncomment verifyAddressReal + createShipmentReal.
    //   2. Set SHIPPING_FROM_* + SHIPPO_CARRIER_ACCOUNT in .env.local.
    //   3. Return { isMock: false, actions: { verify_address: verifyAddressReal, ... } }
    throw new Error(
      "Shippo real client is stubbed out — uncomment the REAL API IMPLEMENTATION block and wire it up.",
    );
  }

  const scenario = opts?.scenario ?? null;
  return {
    name: "shippo",
    isMock: true,
    actions: {
      verify_address: makeVerifyAddress(scenario),
      create_shipment: makeCreateShipment(scenario),
    },
  };
}
