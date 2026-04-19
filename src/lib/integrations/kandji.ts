// ────────────────────────────────────────────────────────────────
// Kandji integration — MDM / device enrollment.
//
// Workflow: once the laptop is shipped (tracking number exists), pre-enroll
// the device so that when the nurse unboxes it and connects to Wi-Fi, it
// auto-provisions with the clinical role's policies + apps.
//
// Actions:
//   create_enrollment   pre-provision the device binding
//   get_enrollment      check whether the nurse completed Setup Assistant
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

const createEnrollmentInput = z.object({
  hireId: z.string(),
  candidateEmail: z.string().email(),
  // Which blueprint / policy bundle to apply. Nurses get the clinical bundle.
  blueprint: z.string().default("nurse-clinical-v2"),
});

const createEnrollmentOutput = z.object({
  enrollmentId: z.string(),
  status: z.enum(["pending"]),
});

const getEnrollmentInput = z.object({
  enrollmentId: z.string(),
});

const getEnrollmentOutput = z.object({
  enrollmentId: z.string(),
  // Real Kandji has more granular states; we collapse.
  status: z.enum(["pending", "enrolled", "failed"]),
  deviceSerial: z.string().optional(),
  enrolledAt: z.string().optional(),
});

// Mock enrollment store.
interface MockEnrollment {
  enrollmentId: string;
  status: "pending" | "enrolled" | "failed";
  deviceSerial?: string;
  enrolledAt?: string;
  ticks: number;
}
const mockEnrollments = new Map<string, MockEnrollment>();

export function __resetKandjiMock(): void {
  mockEnrollments.clear();
}

function makeCreateEnrollment(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof createEnrollmentInput, typeof createEnrollmentOutput> {
  return {
    name: "kandji_create_enrollment",
    description:
      "Pre-provision MDM enrollment so the device auto-configures when the nurse first boots it. Call after the laptop ships.",
    input: createEnrollmentInput,
    output: createEnrollmentOutput,
    handler: async (_input) => {
      if (scenario === "transient_retry" && shouldTransientFailOnce("kandji.create_enrollment")) {
        throw new IntegrationError(
          "Kandji transient 503 (mock — transient_retry scenario)",
          "transient_5xx",
          true,
          "kandji",
        );
      }
      return simulateApiCall({
        tool: "kandji",
        latencyMs: 140,
        jitterMs: 60,
        transientFailureRate: scenario === "all_success" ? 0 : 0.02,
        hardFailureRate: 0,
        result: () => {
          const enrollmentId = generateId("kdj");
          mockEnrollments.set(enrollmentId, {
            enrollmentId,
            status: "pending",
            ticks: 0,
          });
          return { enrollmentId, status: "pending" as const };
        },
      });
    },
  };
}

function makeGetEnrollment(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof getEnrollmentInput, typeof getEnrollmentOutput> {
  return {
    name: "kandji_get_enrollment",
    description:
      "Check whether the nurse has completed device Setup Assistant and enrolled in MDM.",
    input: getEnrollmentInput,
    output: getEnrollmentOutput,
    handler: async (input) => {
      return simulateApiCall({
        tool: "kandji",
        latencyMs: 60,
        jitterMs: 20,
        transientFailureRate: scenario === "all_success" ? 0 : 0.01,
        hardFailureRate: 0,
        result: () => {
          const enrollment = mockEnrollments.get(input.enrollmentId);
          if (!enrollment) {
            throw new IntegrationError(
              `enrollment ${input.enrollmentId} not found`,
              "enrollment_not_found",
              false,
              "kandji",
            );
          }

          // After 3 polls (simulating day-0 + nurse setup), enrollment completes.
          enrollment.ticks++;
          if (enrollment.ticks >= 3 && enrollment.status === "pending") {
            enrollment.status = "enrolled";
            enrollment.deviceSerial = generateId("sn").toUpperCase();
            enrollment.enrolledAt = new Date().toISOString();
          }

          return {
            enrollmentId: enrollment.enrollmentId,
            status: enrollment.status,
            deviceSerial: enrollment.deviceSerial,
            enrolledAt: enrollment.enrolledAt,
          };
        },
      });
    },
  };
}

// ════════════════════════════════════════════════════════════════
// REAL API IMPLEMENTATION (COMMENTED OUT — uncomment when creds land)
//
// Kandji API (api-docs.kandji.io).
//
// AUTH: Authorization: Bearer <KANDJI_API_TOKEN>
//   Generated in UI: Settings → Access → Add API Token. Fine-grained perms
//   per endpoint family; pick the smallest set you need.
//
// BASE URL (US):  https://<subdomain>.api.kandji.io
// BASE URL (EU):  https://<subdomain>.api.eu.kandji.io
// All endpoints prefixed /api/v1/...
//
// CRITICAL CONSTRAINT:
//   Kandji cannot create an enrollment record for a Mac until Apple Business
//   Manager (ABM) has reported that serial to Kandji via the ADE sync. You
//   CANNOT "pre-enroll by email" for an ADE device — you pre-assign a
//   Blueprint and the device auto-configures on first boot. For non-ADE
//   devices (BYOD / one-off shipments) the fallback is the self-service
//   Enrollment Portal — not a per-user API endpoint. Email the portal URL +
//   enrollment code from your own system.
//
// ENDPOINTS USED:
//   GET  /api/v1/blueprints
//        → { id, name, ... }[]
//   GET  /api/v1/devices?limit=300&offset=0&serial_number=<sn>
//        → paginated list of devices; filter by user.email or serial.
//   PATCH /api/v1/devices/{device_id}
//        Body: { blueprint_id, asset_tag?, user? }
//        → assigns the blueprint + user to a device.
//   GET  /api/v1/devices/{device_id}/details
//        → { mdm_enrollment: { status }, last_check_in, ... }
//
// Flow the orchestrator actually wants:
//   create_enrollment: NOT a single API call. Options:
//     a. If ABM has the serial: PATCH device to assign blueprint.
//     b. Otherwise: generate an Enrollment Portal link from the UI once,
//        and email it to the nurse (do it through your own email provider).
//   get_enrollment: GET /api/v1/devices/{id}/details and read mdm_enrollment.
//
// RATE LIMITS: 10,000 req/hour per tenant (~166/min). 429 on overrun; no
// documented Retry-After — use exponential backoff.
// ════════════════════════════════════════════════════════════════

// function kandjiBase(): string {
//   const subdomain = process.env.KANDJI_SUBDOMAIN!;
//   const eu = process.env.KANDJI_REGION === "eu";
//   return eu
//     ? `https://${subdomain}.api.eu.kandji.io`
//     : `https://${subdomain}.api.kandji.io`;
// }
//
// function kandjiHeaders(): HeadersInit {
//   return {
//     Authorization: `Bearer ${process.env.KANDJI_API_TOKEN}`,
//     "Content-Type": "application/json",
//   };
// }
//
// const createEnrollmentReal: IntegrationAction<typeof createEnrollmentInput, typeof createEnrollmentOutput> = {
//   name: "kandji_create_enrollment",
//   description: createEnrollment.description,
//   input: createEnrollmentInput,
//   output: createEnrollmentOutput,
//   handler: async (input) => {
//     // The "pre-provision" flow depends on whether the laptop is ADE.
//     // Assumption: our warehouse registers MacBooks in ABM before ship,
//     // so the serial should already be visible to Kandji by the time the
//     // tracking number goes out. We look the device up by any identifier
//     // we stored with the shipment (asset_tag or user.email).
//
//     // Step 1: find the blueprint id for "nurse-clinical-v2" (or whatever
//     // blueprint parameter the orchestrator passed in). In practice we'd
//     // cache this lookup — blueprint list changes rarely.
//     // const bpRes = await fetch(`${kandjiBase()}/api/v1/blueprints`, { headers: kandjiHeaders() });
//     // const blueprints = await bpRes.json();
//     // const bp = blueprints.find((b: any) => b.name === input.blueprint);
//     // if (!bp) {
//     //   throw new IntegrationError(
//     //     `blueprint '${input.blueprint}' not found in Kandji`,
//     //     "blueprint_not_found",
//     //     false,
//     //     "kandji",
//     //   );
//     // }
//
//     // Step 2: find the device we're provisioning. Our best link is the
//     // candidate's email — the warehouse pipeline tags the Mac before shipping.
//     // const devRes = await fetch(
//     //   `${kandjiBase()}/api/v1/devices?user.email=${encodeURIComponent(input.candidateEmail)}&limit=1`,
//     //   { headers: kandjiHeaders() },
//     // );
//     // const devs = await devRes.json();
//     // if (!devs?.length) {
//     //   // Device not in ABM yet. Two options:
//     //   //   a. Throw retryable — warehouse hasn't pushed yet, try later.
//     //   //   b. Fall back to Enrollment Portal flow (email nurse a self-enroll link).
//     //   throw new IntegrationError(
//     //     `no Kandji device found for ${input.candidateEmail}; ABM sync pending`,
//     //     "device_not_found",
//     //     true, // retryable — ABM sync usually lands within minutes
//     //     "kandji",
//     //   );
//     // }
//     // const device = devs[0];
//
//     // Step 3: assign the blueprint.
//     // const patchRes = await fetch(
//     //   `${kandjiBase()}/api/v1/devices/${device.device_id}`,
//     //   {
//     //     method: "PATCH",
//     //     headers: kandjiHeaders(),
//     //     body: JSON.stringify({
//     //       blueprint_id: bp.id,
//     //       // asset_tag could come from your inventory system.
//     //     }),
//     //   },
//     // );
//     // if (!patchRes.ok) { ...throw... }
//
//     // Step 4: use the device id as our `enrollmentId` for the poll step.
//     // return { enrollmentId: device.device_id, status: "pending" as const };
//     throw new Error("unreachable — real impl disabled");
//   },
// };
//
// const getEnrollmentReal: IntegrationAction<typeof getEnrollmentInput, typeof getEnrollmentOutput> = {
//   name: "kandji_get_enrollment",
//   description: getEnrollment.description,
//   input: getEnrollmentInput,
//   output: getEnrollmentOutput,
//   handler: async (input) => {
//     // const res = await fetch(
//     //   `${kandjiBase()}/api/v1/devices/${input.enrollmentId}/details`,
//     //   { headers: kandjiHeaders() },
//     // );
//     // if (res.status === 404) {
//     //   throw new IntegrationError(
//     //     `enrollment ${input.enrollmentId} not found`,
//     //     "enrollment_not_found",
//     //     false,
//     //     "kandji",
//     //   );
//     // }
//     // if (!res.ok) { ...retryable throw... }
//     // const d = await res.json();
//     //
//     // // Map Kandji's richer vocabulary to our narrow one.
//     // //   mdm_enrollment.status: "Enrolled" → "enrolled"
//     // //   otherwise → "pending" (we don't surface "failed" today)
//     // const raw = d.mdm_enrollment?.status;
//     // const status: "pending" | "enrolled" | "failed" =
//     //   raw === "Enrolled" ? "enrolled" : "pending";
//     //
//     // return {
//     //   enrollmentId: input.enrollmentId,
//     //   status,
//     //   deviceSerial: d.serial_number,
//     //   enrolledAt: d.mdm_enrollment?.enrolled_at,
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };

export function createKandjiIntegration(opts?: IntegrationOpts): Integration {
  const useMocks = shouldUseMocks(["KANDJI_API_TOKEN", "KANDJI_SUBDOMAIN"]);
  if (!useMocks) {
    // See REAL API IMPLEMENTATION block above. To enable:
    //   1. Uncomment createEnrollmentReal + getEnrollmentReal.
    //   2. Confirm warehouse pipeline registers serials in ABM before ship.
    //   3. Decide whether to fall back to Enrollment Portal for non-ADE.
    throw new Error(
      "Kandji real client is stubbed out — uncomment the REAL API IMPLEMENTATION block and wire it up.",
    );
  }

  const scenario = opts?.scenario ?? null;
  return {
    name: "kandji",
    isMock: true,
    actions: {
      create_enrollment: makeCreateEnrollment(scenario),
      get_enrollment: makeGetEnrollment(scenario),
    },
  };
}
