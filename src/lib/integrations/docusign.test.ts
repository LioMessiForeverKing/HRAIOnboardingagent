// ────────────────────────────────────────────────────────────────
// Tests for the DocuSign mock integration.
// Goals:
//   1. send_offer returns a well-shaped envelope
//   2. check_status advances a pending envelope to completed after polls
//   3. check_status rejects unknown envelopes with a non-retryable error
// ────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from "vitest";
import { createDocusignIntegration } from "./docusign";
import { __resetDocusignMock } from "./docusign";
import { IntegrationError } from "./types";
import { setMockSeed } from "./mock-utils";

describe("docusign integration (mock)", () => {
  // Fresh mock state + deterministic RNG for every test.
  beforeEach(() => {
    __resetDocusignMock();
    setMockSeed(42);
  });

  it("send_offer returns a sent envelope", async () => {
    // Build the integration fresh — no real creds in test env so mocks apply.
    const docusign = createDocusignIntegration();

    // Call the handler directly with a valid input shape.
    const result = await docusign.actions.send_offer.handler({
      hireId: "hire_test_1",
      candidateName: "Test Nurse",
      candidateEmail: "nurse@example.com",
      role: "RN",
      startDate: "2026-05-01",
      salary: 95000,
    });

    // Sanity on the envelope id shape + status.
    expect(result.envelopeId).toMatch(/^env_/);
    expect(result.status).toBe("sent");
    expect(new Date(result.sentAt).toString()).not.toBe("Invalid Date");
  });

  it("check_status advances to completed after 2 polls", async () => {
    const docusign = createDocusignIntegration();

    // Create an envelope first so there's something to poll.
    const { envelopeId } = await docusign.actions.send_offer.handler({
      hireId: "hire_test_2",
      candidateName: "Poll Test",
      candidateEmail: "poll@example.com",
      role: "RN",
      startDate: "2026-05-01",
      salary: 92000,
    });

    // First poll — still "sent" (tick 1).
    const first = await docusign.actions.check_status.handler({ envelopeId });
    expect(first.status).toBe("sent");

    // Second poll — our mock flips to "completed" at tick 2.
    const second = await docusign.actions.check_status.handler({ envelopeId });
    expect(second.status).toBe("completed");
    expect(second.signedAt).toBeDefined();
  });

  it("check_status on unknown envelope throws a non-retryable IntegrationError", async () => {
    const docusign = createDocusignIntegration();

    await expect(
      docusign.actions.check_status.handler({ envelopeId: "env_does_not_exist" }),
    ).rejects.toMatchObject({
      // Error instance carries our custom code + retryable flag.
      code: "envelope_not_found",
      retryable: false,
    });
  });
});
