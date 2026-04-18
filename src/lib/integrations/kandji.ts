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
  IntegrationError,
  shouldUseMocks,
  z,
} from "./types";
import { simulateApiCall, generateId } from "./mock-utils";

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

const createEnrollment: IntegrationAction<typeof createEnrollmentInput, typeof createEnrollmentOutput> = {
  name: "kandji_create_enrollment",
  description:
    "Pre-provision MDM enrollment so the device auto-configures when the nurse first boots it. Call after the laptop ships.",
  input: createEnrollmentInput,
  output: createEnrollmentOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "kandji",
      latencyMs: 140,
      jitterMs: 60,
      transientFailureRate: 0.02,
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

const getEnrollment: IntegrationAction<typeof getEnrollmentInput, typeof getEnrollmentOutput> = {
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
      transientFailureRate: 0.01,
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

export function createKandjiIntegration(): Integration {
  const useMocks = shouldUseMocks(["KANDJI_API_TOKEN", "KANDJI_SUBDOMAIN"]);
  if (!useMocks) {
    throw new Error("Kandji real client not implemented yet — see README Phase 3");
  }

  return {
    name: "kandji",
    isMock: true,
    actions: { create_enrollment: createEnrollment, get_enrollment: getEnrollment },
  };
}
