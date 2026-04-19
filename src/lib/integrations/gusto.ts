// ────────────────────────────────────────────────────────────────
// Gusto integration — payroll + HR + ICHRA benefits.
//
// Note: this is a consolidated tool. Originally the architecture had
// PeopleKeep handling ICHRA, but Gusto Benefits already supports it so
// we route everything through Gusto.
//
// Actions:
//   create_employee   add the hire to payroll
//   enroll_ichra      enroll them in the ICHRA health-benefits plan
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

const createEmployeeInput = z.object({
  hireId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  startDate: z.string(),
  state: z.string().describe("Two-letter US state — drives withholding setup"),
  // Compensation details Gusto needs to run payroll.
  salary: z.number().int().positive(),
  // Pay schedule — nurses default to biweekly.
  payFrequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]).default("biweekly"),
});

const createEmployeeOutput = z.object({
  employeeId: z.string().describe("Gusto employee id"),
  status: z.enum(["active", "onboarding"]),
});

const enrollIchraInput = z.object({
  // The Gusto employee id from create_employee. We can't enroll before
  // the employee exists — the agent must sequence these.
  employeeId: z.string(),
  // ICHRA rules vary by state — pass it through so the mock can reject
  // combinations that wouldn't fly in real life.
  state: z.string(),
  // Monthly stipend in cents. Typical range: $400 – $1200 / month.
  monthlyAllowanceCents: z.number().int().positive(),
});

const enrollIchraOutput = z.object({
  enrollmentId: z.string(),
  effectiveDate: z.string(),
  status: z.enum(["active", "pending_state_review"]),
});

// ────────────────────────────────────────────────────────────────
// Mock state — track created employees so enroll_ichra can validate
// the employee actually exists first.
// ────────────────────────────────────────────────────────────────
const mockEmployees = new Map<string, { employeeId: string; state: string }>();
const mockEnrollments = new Map<string, { enrollmentId: string; employeeId: string }>();

export function __resetGustoMock(): void {
  mockEmployees.clear();
  mockEnrollments.clear();
}

// ────────────────────────────────────────────────────────────────
// Actions
// ────────────────────────────────────────────────────────────────

function makeCreateEmployee(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof createEmployeeInput, typeof createEmployeeOutput> {
  return {
    name: "gusto_create_employee",
    description:
      "Create a new employee in Gusto for payroll + HR. Must be called before any benefits/ICHRA enrollment.",
    input: createEmployeeInput,
    output: createEmployeeOutput,
    handler: async (input) => {
      if (scenario === "transient_retry" && shouldTransientFailOnce("gusto.create_employee")) {
        throw new IntegrationError(
          "Gusto transient 503 (mock — transient_retry scenario)",
          "transient_5xx",
          true,
          "gusto",
        );
      }
      return simulateApiCall({
        tool: "gusto",
        latencyMs: 200,
        jitterMs: 100,
        transientFailureRate: scenario === "all_success" ? 0 : 0.03,
        hardFailureRate: 0,
        result: () => {
          const employeeId = generateId("emp");
          mockEmployees.set(employeeId, { employeeId, state: input.state });
          return { employeeId, status: "onboarding" as const };
        },
      });
    },
  };
}

function makeEnrollIchra(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof enrollIchraInput, typeof enrollIchraOutput> {
  return {
    name: "gusto_enroll_ichra",
    description:
      "Enroll a Gusto employee in the company's ICHRA health benefits plan. Some states require manual review before going active.",
    input: enrollIchraInput,
    output: enrollIchraOutput,
    handler: async (input) => {
      return simulateApiCall({
        tool: "gusto",
        latencyMs: 180,
        jitterMs: 90,
        transientFailureRate: scenario === "all_success" ? 0 : 0.02,
        hardFailureRate: 0,
        result: () => {
          // Validate the employee exists — a realistic Gusto 404 scenario.
          const employee = mockEmployees.get(input.employeeId);
          if (!employee) {
            throw new IntegrationError(
              `employee ${input.employeeId} not found — must call create_employee first`,
              "employee_not_found",
              false,
              "gusto",
            );
          }

          // A few states require an extra compliance review before activation.
          // This is the kind of thing our state_rules table will formalize in Phase 4.
          const needsReview = ["CA", "NY", "WA"].includes(input.state);

          const enrollmentId = generateId("enr");
          mockEnrollments.set(enrollmentId, { enrollmentId, employeeId: input.employeeId });

          return {
            enrollmentId,
            effectiveDate: new Date().toISOString().slice(0, 10),
            status: needsReview
              ? ("pending_state_review" as const)
              : ("active" as const),
          };
        },
      });
    },
  };
}

// ════════════════════════════════════════════════════════════════
// REAL API IMPLEMENTATION (COMMENTED OUT — uncomment when creds land)
//
// Gusto Embedded Payroll (docs.gusto.com/embedded-payroll).
//
// AUTH: OAuth 2.0 Authorization Code grant.
//   Token exchange: POST /oauth/token
//     body (form-encoded):
//       client_id, client_secret, grant_type=authorization_code (or
//       refresh_token), redirect_uri, code
//     → { access_token, refresh_token, expires_in (2h), token_type }
//   Refresh tokens ROTATE on every refresh — always persist the new one.
//   On every request:
//     Authorization: Bearer <access_token>
//     Content-Type: application/json
//     X-Gusto-API-Version: 2024-04-01   ← pin a version
//
// BASE URL (demo): https://api.gusto-demo.com
// BASE URL (prod): https://api.gusto.com
//
// ENDPOINTS USED:
//   POST /v1/companies/{company_uuid}/employees
//     Body (minimum): { first_name, middle_initial?, last_name, email,
//                       date_of_birth, ssn, self_onboarding: true }
//     → { uuid, version, ... }  (uuid = employee id; version = for PUTs)
//   Follow-ups for a fully-provisioned employee:
//     POST /v1/employees/{uuid}/home_addresses
//         { street_1, city, state, zip, effective_date }
//     POST /v1/employees/{uuid}/work_addresses
//         { location_uuid, effective_date }
//     POST /v1/employees/{uuid}/jobs
//         { title, hire_date }   → { uuid (job_uuid), ... }
//     POST /v1/jobs/{job_uuid}/compensations
//         { rate, payment_unit: "Hour"|"Year"|..., flsa_status, effective_date }
//
//   For benefits / ICHRA (see note below):
//     GET  /v1/benefits                          — list benefit_type ids
//     POST /v1/companies/{uuid}/company_benefits — create company benefit
//         { benefit_type, description, active }  → { uuid (company_benefit_uuid) }
//     POST /v1/employees/{uuid}/employee_benefits
//         { company_benefit_uuid, active, employee_deduction,
//           contribution: { type: "amount", value: "<usd>.00" } }
//
// IMPORTANT NOTE ON ICHRA (2026):
//   Gusto does NOT natively administer ICHRA through its API. Current model:
//   ICHRA is offered via partner brokers — primarily **Thatch** (preferred
//   integration) and **Take Command Health**. The partner bills reimburse-
//   ments directly; Gusto's role is optional tax-free payroll reimbursement.
//   If you wire it via Gusto's generic benefits endpoints, keep a TODO for
//   the Thatch-side call — Gusto alone will not run ICHRA end-to-end.
//
// RATE LIMITS: 200 req/min per (application, user=company) pair, rolling 60s.
// Headers: X-RateLimit-Remaining, X-RateLimit-Reset. On 429 respect Retry-After.
// RETRY:  429, 500, 502, 503, 504 (exponential: 1s, 2s, 4s, 8s capped).
// ════════════════════════════════════════════════════════════════

// const GUSTO_BASE = process.env.GUSTO_BASE_URL ?? "https://api.gusto-demo.com";
// const GUSTO_API_VERSION = "2024-04-01";
//
// interface GustoTokenCache { accessToken: string; refreshToken: string; expiresAt: number; }
// let _gustoToken: GustoTokenCache | null = null;
//
// async function getGustoAccessToken(): Promise<string> {
//   if (_gustoToken && _gustoToken.expiresAt > Date.now() + 60_000) {
//     return _gustoToken.accessToken;
//   }
//   // Refresh flow — initial auth-code exchange happens during app install.
//   // const res = await fetch(`${GUSTO_BASE}/oauth/token`, {
//   //   method: "POST",
//   //   headers: { "Content-Type": "application/x-www-form-urlencoded" },
//   //   body: new URLSearchParams({
//   //     client_id: process.env.GUSTO_CLIENT_ID!,
//   //     client_secret: process.env.GUSTO_CLIENT_SECRET!,
//   //     grant_type: "refresh_token",
//   //     refresh_token: _gustoToken?.refreshToken ?? process.env.GUSTO_REFRESH_TOKEN!,
//   //   }),
//   // });
//   // if (!res.ok) throw new IntegrationError(...);
//   // const body = await res.json();
//   // _gustoToken = {
//   //   accessToken: body.access_token,
//   //   refreshToken: body.refresh_token,  // ROTATED — persist
//   //   expiresAt: Date.now() + body.expires_in * 1000,
//   // };
//   // // Persist body.refresh_token somewhere durable (Convex or env).
//   // return _gustoToken.accessToken;
//   throw new Error("unreachable — real auth disabled");
// }
//
// function gustoHeaders(token: string): HeadersInit {
//   return {
//     Authorization: `Bearer ${token}`,
//     "Content-Type": "application/json",
//     "X-Gusto-API-Version": GUSTO_API_VERSION,
//   };
// }
//
// const createEmployeeReal: IntegrationAction<typeof createEmployeeInput, typeof createEmployeeOutput> = {
//   name: "gusto_create_employee",
//   description: createEmployee.description,
//   input: createEmployeeInput,
//   output: createEmployeeOutput,
//   handler: async (input) => {
//     const token = await getGustoAccessToken();
//     const companyUuid = process.env.GUSTO_COMPANY_UUID!;
//
//     // Gusto needs SSN + DOB for a real create. Our schema doesn't carry them
//     // — before enabling, widen createEmployeeInput or route through Gusto's
//     // self_onboarding flow (employee fills PII themselves).
//     // const res = await fetch(
//     //   `${GUSTO_BASE}/v1/companies/${companyUuid}/employees`,
//     //   {
//     //     method: "POST",
//     //     headers: gustoHeaders(token),
//     //     body: JSON.stringify({
//     //       first_name: input.firstName,
//     //       last_name: input.lastName,
//     //       email: input.email,
//     //       // date_of_birth, ssn required — collect via onboarding link instead:
//     //       self_onboarding: true,
//     //     }),
//     //   },
//     // );
//     // if (!res.ok) throw new IntegrationError(
//     //   `Gusto create_employee failed: ${res.status}`,
//     //   `http_${res.status}`,
//     //   res.status === 429 || res.status >= 500,
//     //   "gusto",
//     //   await res.text(),
//     // );
//     // const employee = await res.json();
//     //
//     // // Compensation setup is its own chain. For demo we'd also do:
//     // //   POST /v1/employees/{uuid}/jobs  → jobUuid
//     // //   POST /v1/jobs/{jobUuid}/compensations { rate: input.salary, payment_unit: "Year" }
//     //
//     // return { employeeId: employee.uuid, status: "onboarding" as const };
//     throw new Error("unreachable — real impl disabled");
//   },
// };
//
// const enrollIchraReal: IntegrationAction<typeof enrollIchraInput, typeof enrollIchraOutput> = {
//   name: "gusto_enroll_ichra",
//   description: enrollIchra.description,
//   input: enrollIchraInput,
//   output: enrollIchraOutput,
//   handler: async (input) => {
//     const token = await getGustoAccessToken();
//     const companyUuid = process.env.GUSTO_COMPANY_UUID!;
//     // We assume a company_benefit row already exists for "ICHRA via Thatch".
//     // If not, create it once with POST /v1/companies/{uuid}/company_benefits.
//     const companyBenefitUuid = process.env.GUSTO_ICHRA_COMPANY_BENEFIT_UUID!;
//
//     // const res = await fetch(
//     //   `${GUSTO_BASE}/v1/employees/${input.employeeId}/employee_benefits`,
//     //   {
//     //     method: "POST",
//     //     headers: gustoHeaders(token),
//     //     body: JSON.stringify({
//     //       company_benefit_uuid: companyBenefitUuid,
//     //       active: true,
//     //       employee_deduction: "0.00",
//     //       contribution: {
//     //         type: "amount",
//     //         value: (input.monthlyAllowanceCents / 100).toFixed(2),
//     //       },
//     //     }),
//     //   },
//     // );
//     // if (!res.ok) throw new IntegrationError(...);
//     // const enrollment = await res.json();
//     //
//     // // TODO: also POST to Thatch's API to kick off their ICHRA admin —
//     // //   Gusto alone does NOT run ICHRA reimbursement end-to-end.
//     //
//     // return {
//     //   enrollmentId: enrollment.uuid,
//     //   effectiveDate: new Date().toISOString().slice(0, 10),
//     //   // Some states (CA, NY, WA) require manual compliance review;
//     //   // flag accordingly. We don't get this from Gusto — derive locally.
//     //   status: (["CA", "NY", "WA"].includes(input.state)
//     //     ? "pending_state_review"
//     //     : "active"),
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };

export function createGustoIntegration(opts?: IntegrationOpts): Integration {
  const useMocks = shouldUseMocks(["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"]);
  if (!useMocks) {
    // See REAL API IMPLEMENTATION block above. To enable:
    //   1. Uncomment getGustoAccessToken + createEmployeeReal + enrollIchraReal.
    //   2. Add GUSTO_COMPANY_UUID + GUSTO_REFRESH_TOKEN to .env.local.
    //   3. Wire a Thatch integration if you actually want ICHRA reimbursement.
    throw new Error(
      "Gusto real client is stubbed out — uncomment the REAL API IMPLEMENTATION block and wire it up.",
    );
  }

  const scenario = opts?.scenario ?? null;
  return {
    name: "gusto",
    isMock: true,
    actions: {
      create_employee: makeCreateEmployee(scenario),
      enroll_ichra: makeEnrollIchra(scenario),
    },
  };
}
