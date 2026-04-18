// ────────────────────────────────────────────────────────────────
// Checkr integration — background check for new hires.
//
// Nurses require clean background + license verification. In real Checkr,
// the flow is: create candidate → order report → wait for webhook →
// interpret result. We compress that into two callable actions.
//
// Actions:
//   order_check     order a background report for a candidate
//   get_result      fetch the final outcome (clear | consider | suspended)
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

const orderCheckInput = z.object({
  hireId: z.string(),
  candidateName: z.string(),
  candidateEmail: z.string().email(),
  // Checkr needs DOB + SSN in real life. For the mock we accept a placeholder.
  dateOfBirth: z.string().describe("ISO date"),
  // Nursing license # — if present, Checkr also verifies active status.
  licenseNumber: z.string().optional(),
});

const orderCheckOutput = z.object({
  reportId: z.string(),
  status: z.enum(["pending"]),
});

const getResultInput = z.object({
  reportId: z.string(),
});

const getResultOutput = z.object({
  reportId: z.string(),
  // Checkr's three terminal states:
  //   clear      — no adverse info; agent proceeds
  //   consider   — adverse info; agent must escalate to operator
  //   suspended  — licensing issue; auto-escalate
  status: z.enum(["pending", "clear", "consider", "suspended"]),
  adverseActions: z.array(z.string()).optional(),
  completedAt: z.string().optional(),
});

// ────────────────────────────────────────────────────────────────
// Mock state — reports progress after a couple of polls.
// ────────────────────────────────────────────────────────────────
interface MockReport {
  reportId: string;
  status: "pending" | "clear" | "consider" | "suspended";
  adverseActions?: string[];
  completedAt?: string;
  ticks: number;
  // Whether this candidate was flagged for adverse action (simulated ~10%).
  flagged: boolean;
}

const mockReports = new Map<string, MockReport>();

export function __resetCheckrMock(): void {
  mockReports.clear();
}

// ────────────────────────────────────────────────────────────────
// Actions
// ────────────────────────────────────────────────────────────────

const orderCheck: IntegrationAction<typeof orderCheckInput, typeof orderCheckOutput> = {
  name: "checkr_order_check",
  description:
    "Order a Checkr background report for a candidate. Returns a reportId that must be polled via get_result until status != 'pending'.",
  input: orderCheckInput,
  output: orderCheckOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "checkr",
      latencyMs: 150,
      jitterMs: 80,
      transientFailureRate: 0.02,
      hardFailureRate: 0,
      result: () => {
        const reportId = generateId("rep");
        // Simulate a ~10% flag rate — nursing hires skew clean but not 100%.
        const flagged = Math.random() < 0.1;
        mockReports.set(reportId, {
          reportId,
          status: "pending",
          ticks: 0,
          flagged,
        });
        return { reportId, status: "pending" as const };
      },
    });
  },
};

const getResult: IntegrationAction<typeof getResultInput, typeof getResultOutput> = {
  name: "checkr_get_result",
  description:
    "Fetch the current state of a background report. Call repeatedly until status is one of: clear, consider, suspended.",
  input: getResultInput,
  output: getResultOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "checkr",
      latencyMs: 60,
      jitterMs: 30,
      transientFailureRate: 0.01,
      hardFailureRate: 0,
      result: () => {
        const report = mockReports.get(input.reportId);
        if (!report) {
          throw new IntegrationError(
            `report ${input.reportId} not found`,
            "report_not_found",
            false,
            "checkr",
          );
        }

        // After 2 polls, the mock resolves the report.
        report.ticks++;
        if (report.ticks >= 2 && report.status === "pending") {
          if (report.flagged) {
            report.status = "consider";
            report.adverseActions = ["misdemeanor_conviction_2021"];
          } else {
            report.status = "clear";
          }
          report.completedAt = new Date().toISOString();
        }

        return {
          reportId: report.reportId,
          status: report.status,
          adverseActions: report.adverseActions,
          completedAt: report.completedAt,
        };
      },
    });
  },
};

export function createCheckrIntegration(): Integration {
  const useMocks = shouldUseMocks(["CHECKR_API_KEY"]);
  if (!useMocks) {
    throw new Error("Checkr real client not implemented yet — see README Phase 3");
  }

  return {
    name: "checkr",
    isMock: true,
    actions: { order_check: orderCheck, get_result: getResult },
  };
}
