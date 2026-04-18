// ────────────────────────────────────────────────────────────────
// Tests for the Checkr mock integration.
// ────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { createCheckrIntegration, __resetCheckrMock } from "./checkr";
import { setMockSeed } from "./mock-utils";

describe("checkr integration (mock)", () => {
  beforeEach(() => {
    __resetCheckrMock();
    setMockSeed(7);
  });

  it("order_check returns a pending report id", async () => {
    const checkr = createCheckrIntegration();
    const result = await checkr.actions.order_check.handler({
      hireId: "hire_x",
      candidateName: "Test",
      candidateEmail: "test@example.com",
      dateOfBirth: "1990-01-01",
    });
    expect(result.reportId).toMatch(/^rep_/);
    expect(result.status).toBe("pending");
  });

  it("get_result resolves to 'clear' or 'consider' after polling", async () => {
    const checkr = createCheckrIntegration();

    const { reportId } = await checkr.actions.order_check.handler({
      hireId: "hire_y",
      candidateName: "Test",
      candidateEmail: "test@example.com",
      dateOfBirth: "1990-01-01",
    });

    // First call: still pending.
    const first = await checkr.actions.get_result.handler({ reportId });
    expect(first.status).toBe("pending");

    // Second call: the mock resolves to clear or consider (flag is RNG-based).
    const second = await checkr.actions.get_result.handler({ reportId });
    expect(["clear", "consider", "suspended"]).toContain(second.status);
    expect(second.completedAt).toBeDefined();
  });

  it("get_result on unknown id throws non-retryable IntegrationError", async () => {
    const checkr = createCheckrIntegration();
    await expect(
      checkr.actions.get_result.handler({ reportId: "rep_no" }),
    ).rejects.toMatchObject({
      code: "report_not_found",
      retryable: false,
    });
  });
});
