// ────────────────────────────────────────────────────────────────
// Tests for the Gusto mock integration.
//
// Key behaviors verified:
//   - enroll_ichra requires a pre-existing employee (order-of-operations)
//   - state-dependent rules: CA/NY/WA go into pending_state_review
// ────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { createGustoIntegration, __resetGustoMock } from "./gusto";
import { setMockSeed } from "./mock-utils";

describe("gusto integration (mock)", () => {
  beforeEach(() => {
    __resetGustoMock();
    setMockSeed(11);
  });

  it("create_employee returns an employeeId with onboarding status", async () => {
    const gusto = createGustoIntegration();
    const result = await gusto.actions.create_employee.handler({
      hireId: "hire_1",
      firstName: "Test",
      lastName: "Nurse",
      email: "test@example.com",
      startDate: "2026-05-01",
      state: "TX",
      salary: 90000,
      payFrequency: "biweekly",
    });
    expect(result.employeeId).toMatch(/^emp_/);
    expect(result.status).toBe("onboarding");
  });

  it("enroll_ichra in a review state returns pending_state_review", async () => {
    const gusto = createGustoIntegration();
    const { employeeId } = await gusto.actions.create_employee.handler({
      hireId: "hire_2",
      firstName: "Cali",
      lastName: "Nurse",
      email: "cali@example.com",
      startDate: "2026-05-01",
      state: "CA",
      salary: 95000,
      payFrequency: "biweekly",
    });

    const enrollment = await gusto.actions.enroll_ichra.handler({
      employeeId,
      state: "CA",
      monthlyAllowanceCents: 80000,
    });
    expect(enrollment.status).toBe("pending_state_review");
  });

  it("enroll_ichra in a non-review state activates immediately", async () => {
    const gusto = createGustoIntegration();
    const { employeeId } = await gusto.actions.create_employee.handler({
      hireId: "hire_3",
      firstName: "Tex",
      lastName: "Nurse",
      email: "tex@example.com",
      startDate: "2026-05-01",
      state: "TX",
      salary: 95000,
      payFrequency: "biweekly",
    });

    const enrollment = await gusto.actions.enroll_ichra.handler({
      employeeId,
      state: "TX",
      monthlyAllowanceCents: 80000,
    });
    expect(enrollment.status).toBe("active");
  });

  it("enroll_ichra without a pre-existing employee throws", async () => {
    const gusto = createGustoIntegration();
    await expect(
      gusto.actions.enroll_ichra.handler({
        employeeId: "emp_bogus",
        state: "TX",
        monthlyAllowanceCents: 80000,
      }),
    ).rejects.toMatchObject({
      code: "employee_not_found",
      retryable: false,
    });
  });
});
