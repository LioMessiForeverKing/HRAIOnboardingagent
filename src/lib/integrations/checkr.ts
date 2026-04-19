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
  type IntegrationOpts,
  IntegrationError,
  shouldUseMocks,
  z,
} from "./types";
import { simulateApiCall, generateId, shouldTransientFailOnce } from "./mock-utils";

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

function makeOrderCheck(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof orderCheckInput, typeof orderCheckOutput> {
  return {
    name: "checkr_order_check",
    description:
      "Order a Checkr background report for a candidate. Returns a reportId that must be polled via get_result until status != 'pending'.",
    input: orderCheckInput,
    output: orderCheckOutput,
    handler: async (_input) => {
      if (scenario === "transient_retry" && shouldTransientFailOnce("checkr.order_check")) {
        throw new IntegrationError(
          "Checkr transient 503 (mock — transient_retry scenario)",
          "transient_5xx",
          true,
          "checkr",
        );
      }
      return simulateApiCall({
        tool: "checkr",
        latencyMs: 150,
        jitterMs: 80,
        transientFailureRate: scenario === "all_success" ? 0 : 0.02,
        hardFailureRate: 0,
        result: () => {
          const reportId = generateId("rep");
          // Scenario flag overrides RNG. "checkr_consider" + "checkr_suspended"
          // pin the eventual outcome; "all_success" forces clean; otherwise
          // 10% of hires get flagged (realistic baseline for nursing).
          const forcedOutcome: MockReport["status"] | null =
            scenario === "checkr_consider"
              ? "consider"
              : scenario === "checkr_suspended"
                ? "suspended"
                : scenario === "all_success"
                  ? "clear"
                  : null;
          const flagged =
            forcedOutcome === "consider" || forcedOutcome === "suspended"
              ? true
              : forcedOutcome === "clear"
                ? false
                : Math.random() < 0.1;
          mockReports.set(reportId, {
            reportId,
            status: "pending",
            ticks: 0,
            flagged,
            // Carry the forced outcome so get_result resolves to it.
            // (extra field — using `as any` to keep schema unchanged)
            ...(forcedOutcome ? { __forcedOutcome: forcedOutcome } : {}),
          } as MockReport);
          return { reportId, status: "pending" as const };
        },
      });
    },
  };
}

function makeGetResult(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof getResultInput, typeof getResultOutput> {
  return {
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
        transientFailureRate: scenario === "all_success" ? 0 : 0.01,
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

          // After 2 polls, the mock resolves the report. If a forced
          // outcome was pinned at order time, honor it; else use the
          // flagged bit set during ordering.
          report.ticks++;
          if (report.ticks >= 2 && report.status === "pending") {
            const forced = (report as MockReport & { __forcedOutcome?: MockReport["status"] })
              .__forcedOutcome;
            if (forced === "consider") {
              report.status = "consider";
              report.adverseActions = ["misdemeanor_conviction_2021"];
            } else if (forced === "suspended") {
              report.status = "suspended";
            } else if (forced === "clear") {
              report.status = "clear";
            } else if (report.flagged) {
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
}

// ════════════════════════════════════════════════════════════════
// REAL API IMPLEMENTATION (COMMENTED OUT — uncomment when creds land)
//
// Checkr REST API.
//
// AUTH: HTTP Basic. Secret key as username, empty password:
//   Authorization: Basic base64(CHECKR_API_KEY + ":")
//
// BASE URL (prod):     https://api.checkr.com/v1
// BASE URL (staging):  https://api.checkr-staging.com/v1
//   (Whichever base you use is chosen by which key you hold.)
//
// ENDPOINTS USED:
//   POST /v1/candidates           — create candidate (PII).
//     Body: { first_name, last_name, email, dob, ssn, zipcode,
//             no_middle_name?, work_locations: [{country,state,city}] }
//     → { id, object: "candidate", uri, created_at, ... }
//
//   POST /v1/reports              — order a background report.
//     Body: { candidate_id, package: "tasker_standard" | ... }
//     → { id, status: "pending", result: null, adjudication: null, ... }
//
//   GET  /v1/reports/{report_id}  — poll report state.
//     → { id, status, result, adjudication, completed_at, ... }
//
//   status:       pending | complete | suspended | paused | disputed | canceled
//   result (only set when status=complete):
//                 null | clear | consider
//   adjudication (customer's FCRA hiring decision on a `consider` report):
//                 null | engaged | pre_adverse_action | post_adverse_action
//
// For this orchestrator: status=complete+result=clear → proceed;
// result=consider → escalate; status=suspended → escalate.
//
// ALTERNATIVE (self-serve): POST /v1/invitations with { candidate_id, package }
// emails the candidate to complete PII + consent themselves. Report auto-
// creates on submission. Preferred when you don't want to handle SSN.
//
// RATE LIMITS: 1,200 req/min. Headers: X-Ratelimit-Limit, X-Ratelimit-Remaining,
// X-Ratelimit-Reset (epoch). 429 on overrun.
// RETRY:  429, 500, 502, 503, 504.
// DON'T:  400, 401, 404, 422.
// IDEMPOTENCY: send `Idempotency-Key: <uuid>` on POSTs to make retries safe.
//
// WEBHOOKS (strongly preferred — report completion can take hours): subscribe
// via Dashboard. Events: report.created, report.updated, report.completed,
// report.suspended, report.disputed, report.engaged, report.pre_adverse_action,
// report.post_adverse_action, invitation.completed, candidate.created.
// Signature verify via X-Checkr-Signature header (HMAC-SHA256 with API key).
// ════════════════════════════════════════════════════════════════

// const CHECKR_BASE = process.env.CHECKR_BASE_URL ?? "https://api.checkr.com/v1";
//
// function checkrAuthHeader(): string {
//   const key = process.env.CHECKR_API_KEY!;
//   // Basic auth: base64("<key>:"). The colon with empty password is required.
//   return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
// }
//
// const orderCheckReal: IntegrationAction<typeof orderCheckInput, typeof orderCheckOutput> = {
//   name: "checkr_order_check",
//   description: orderCheck.description,
//   input: orderCheckInput,
//   output: orderCheckOutput,
//   handler: async (input) => {
//     // Step 1: create candidate.
//     // Assumes caller has collected DOB + SSN + zipcode OOB (the input schema
//     // would need widening — see note below the commented-out section).
//     // const candRes = await fetch(`${CHECKR_BASE}/candidates`, {
//     //   method: "POST",
//     //   headers: {
//     //     Authorization: checkrAuthHeader(),
//     //     "Content-Type": "application/json",
//     //     "Idempotency-Key": `cand_${input.hireId}`,
//     //   },
//     //   body: JSON.stringify({
//     //     first_name: input.candidateName.split(" ")[0],
//     //     last_name: input.candidateName.split(" ").slice(1).join(" "),
//     //     email: input.candidateEmail,
//     //     dob: input.dateOfBirth,
//     //     // SSN + zipcode are required for a criminal check. Collect via
//     //     // invitation flow if you don't want to handle them yourself.
//     //     ssn: process.env.CHECKR_TEST_SSN /* placeholder */,
//     //     zipcode: "00000",
//     //     no_middle_name: true,
//     //     work_locations: [{ country: "US", state: "TX" }],
//     //   }),
//     // });
//     // if (!candRes.ok) { ...throw IntegrationError similar to DocuSign... }
//     // const candidate = await candRes.json();
//
//     // Step 2: order the report.
//     // const reportRes = await fetch(`${CHECKR_BASE}/reports`, {
//     //   method: "POST",
//     //   headers: {
//     //     Authorization: checkrAuthHeader(),
//     //     "Content-Type": "application/json",
//     //     "Idempotency-Key": `rep_${input.hireId}`,
//     //   },
//     //   body: JSON.stringify({
//     //     candidate_id: candidate.id,
//     //     // "tasker_standard" is the common baseline for contractor-style hires.
//     //     // "driver_standard" / "healthcare_professional" have license checks.
//     //     package: process.env.CHECKR_DEFAULT_PACKAGE ?? "tasker_standard",
//     //   }),
//     // });
//     // if (!reportRes.ok) { ...throw... }
//     // const report = await reportRes.json();
//     // return { reportId: report.id, status: "pending" as const };
//     throw new Error("unreachable — real impl disabled");
//   },
// };
//
// const getResultReal: IntegrationAction<typeof getResultInput, typeof getResultOutput> = {
//   name: "checkr_get_result",
//   description: getResult.description,
//   input: getResultInput,
//   output: getResultOutput,
//   handler: async (input) => {
//     // const res = await fetch(`${CHECKR_BASE}/reports/${input.reportId}`, {
//     //   headers: { Authorization: checkrAuthHeader() },
//     // });
//     // if (res.status === 404) {
//     //   throw new IntegrationError(
//     //     `report ${input.reportId} not found`,
//     //     "report_not_found",
//     //     false,
//     //     "checkr",
//     //   );
//     // }
//     // if (!res.ok) { ...retryable throw... }
//     // const r = await res.json();
//     //
//     // // Map Checkr vocabulary to our narrower union:
//     // //   status=pending → "pending"
//     // //   status=complete + result=clear → "clear"
//     // //   status=complete + result=consider → "consider"
//     // //   status=suspended → "suspended"
//     // let mapped: "pending" | "clear" | "consider" | "suspended" = "pending";
//     // if (r.status === "suspended") mapped = "suspended";
//     // else if (r.status === "complete" && r.result === "clear") mapped = "clear";
//     // else if (r.status === "complete" && r.result === "consider") mapped = "consider";
//     //
//     // return {
//     //   reportId: r.id,
//     //   status: mapped,
//     //   adverseActions: r.result === "consider" ? r.adverse_actions ?? [] : undefined,
//     //   completedAt: r.completed_at ?? undefined,
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };
//
// NOTE: the current `orderCheckInput` schema lacks ssn + zipcode because the
// mock doesn't need them. Before enabling the real client, widen the schema
// to require those fields (or route to the invitation flow and let Checkr
// collect PII directly).

export function createCheckrIntegration(opts?: IntegrationOpts): Integration {
  const useMocks = shouldUseMocks(["CHECKR_API_KEY"]);
  if (!useMocks) {
    // See REAL API IMPLEMENTATION block above. To enable:
    //   1. Uncomment orderCheckReal + getResultReal.
    //   2. Widen orderCheckInput to include ssn + zipcode (or switch to
    //      invitation flow).
    //   3. Return { isMock: false, actions: { order_check: orderCheckReal, ... } }
    throw new Error(
      "Checkr real client is stubbed out — uncomment the REAL API IMPLEMENTATION block and wire it up.",
    );
  }

  const scenario = opts?.scenario ?? null;
  return {
    name: "checkr",
    isMock: true,
    actions: { order_check: makeOrderCheck(scenario), get_result: makeGetResult(scenario) },
  };
}
