// ────────────────────────────────────────────────────────────────
// Tests for the Kandji mock integration.
// ────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { createKandjiIntegration, __resetKandjiMock } from "./kandji";
import { setMockSeed } from "./mock-utils";

describe("kandji integration (mock)", () => {
  beforeEach(() => {
    __resetKandjiMock();
    setMockSeed(19);
  });

  it("create_enrollment returns a pending enrollmentId", async () => {
    const kandji = createKandjiIntegration();
    const result = await kandji.actions.create_enrollment.handler({
      hireId: "hire_k",
      candidateEmail: "k@example.com",
      blueprint: "nurse-clinical-v2",
    });
    expect(result.enrollmentId).toMatch(/^kdj_/);
    expect(result.status).toBe("pending");
  });

  it("get_enrollment resolves to enrolled after ~3 polls", async () => {
    const kandji = createKandjiIntegration();

    const { enrollmentId } = await kandji.actions.create_enrollment.handler({
      hireId: "hire_k2",
      candidateEmail: "k2@example.com",
      blueprint: "nurse-clinical-v2",
    });

    // First two polls: pending.
    await kandji.actions.get_enrollment.handler({ enrollmentId });
    await kandji.actions.get_enrollment.handler({ enrollmentId });

    // Third poll: enrolled.
    const third = await kandji.actions.get_enrollment.handler({ enrollmentId });
    expect(third.status).toBe("enrolled");
    expect(third.deviceSerial).toBeDefined();
    expect(third.enrolledAt).toBeDefined();
  });

  it("get_enrollment on unknown id throws non-retryable IntegrationError", async () => {
    const kandji = createKandjiIntegration();
    await expect(
      kandji.actions.get_enrollment.handler({ enrollmentId: "kdj_no" }),
    ).rejects.toMatchObject({
      code: "enrollment_not_found",
      retryable: false,
    });
  });
});
