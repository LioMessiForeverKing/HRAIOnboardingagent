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
  IntegrationError,
  shouldUseMocks,
  z,
} from "./types";
import { simulateApiCall, generateId } from "./mock-utils";

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

const createEmployee: IntegrationAction<typeof createEmployeeInput, typeof createEmployeeOutput> = {
  name: "gusto_create_employee",
  description:
    "Create a new employee in Gusto for payroll + HR. Must be called before any benefits/ICHRA enrollment.",
  input: createEmployeeInput,
  output: createEmployeeOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "gusto",
      latencyMs: 200,
      jitterMs: 100,
      transientFailureRate: 0.03,
      hardFailureRate: 0,
      result: () => {
        const employeeId = generateId("emp");
        mockEmployees.set(employeeId, { employeeId, state: input.state });
        return { employeeId, status: "onboarding" as const };
      },
    });
  },
};

const enrollIchra: IntegrationAction<typeof enrollIchraInput, typeof enrollIchraOutput> = {
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
      transientFailureRate: 0.02,
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

export function createGustoIntegration(): Integration {
  const useMocks = shouldUseMocks(["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET"]);
  if (!useMocks) {
    throw new Error("Gusto real client not implemented yet — see README Phase 3");
  }

  return {
    name: "gusto",
    isMock: true,
    actions: { create_employee: createEmployee, enroll_ichra: enrollIchra },
  };
}
