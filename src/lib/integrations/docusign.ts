// ────────────────────────────────────────────────────────────────
// DocuSign integration — offer letter generation + signing.
//
// Actions:
//   send_offer    create + send an offer letter envelope
//   check_status  poll whether the candidate has signed yet
//
// Real API: DocuSign eSignature REST v2.1. For now this is all mocked —
// swap `createMockClient()` for `createRealClient()` when credentials land.
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
// Schemas — the source of truth for types *and* for the LLM tool spec.
// ────────────────────────────────────────────────────────────────

// Input for `send_offer` — what the agent provides to kick off an envelope.
const sendOfferInput = z.object({
  hireId: z.string().describe("Our internal hire id — used as external_id"),
  candidateName: z.string().min(1),
  candidateEmail: z.string().email(),
  role: z.string().min(1),
  startDate: z.string().describe("ISO date — used to populate the letter"),
  // Annual salary in whole dollars. Nurse offers are flat; no variable comp.
  salary: z.number().int().positive(),
});

// Output — what we get back from DocuSign (or the mock).
const sendOfferOutput = z.object({
  envelopeId: z.string().describe("DocuSign envelope id — persist for status checks"),
  status: z.enum(["sent", "delivered"]),
  sentAt: z.string().describe("ISO timestamp"),
});

const checkStatusInput = z.object({
  envelopeId: z.string(),
});

const checkStatusOutput = z.object({
  envelopeId: z.string(),
  // Real DocuSign returns more states; we collapse to what the orchestrator cares about.
  status: z.enum(["sent", "delivered", "completed", "declined", "voided"]),
  signedAt: z.string().optional(),
});

// ────────────────────────────────────────────────────────────────
// Mock client — pretends to be DocuSign.
//
// In-memory envelope store so `check_status` returns consistent results
// within a process lifetime. Two-stage simulation: first call returns
// "sent", subsequent calls probabilistically flip to "completed".
// ────────────────────────────────────────────────────────────────
interface MockEnvelope {
  envelopeId: string;
  status: "sent" | "delivered" | "completed" | "declined";
  sentAt: string;
  signedAt?: string;
  // Tick counter — each check_status call advances state toward completion.
  ticks: number;
}

const mockEnvelopes = new Map<string, MockEnvelope>();

// For tests — clear the in-memory store between runs.
export function __resetDocusignMock(): void {
  mockEnvelopes.clear();
}

// `send_offer` mock implementation.
const sendOfferMock: IntegrationAction<typeof sendOfferInput, typeof sendOfferOutput> = {
  name: "docusign_send_offer",
  description:
    "Generate an offer letter and send it to the candidate via DocuSign. Returns an envelopeId to poll for signature.",
  input: sendOfferInput,
  output: sendOfferOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "docusign",
      latencyMs: 120,
      jitterMs: 60,
      // DocuSign is pretty reliable in real life — keep failure rates low.
      transientFailureRate: 0.02,
      hardFailureRate: 0.01,
      result: () => {
        const envelopeId = generateId("env");
        const envelope: MockEnvelope = {
          envelopeId,
          status: "sent",
          sentAt: new Date().toISOString(),
          ticks: 0,
        };
        mockEnvelopes.set(envelopeId, envelope);
        return { envelopeId, status: "sent" as const, sentAt: envelope.sentAt };
      },
    });
  },
};

// `check_status` mock implementation.
const checkStatusMock: IntegrationAction<typeof checkStatusInput, typeof checkStatusOutput> = {
  name: "docusign_check_status",
  description:
    "Poll the signing status of a DocuSign envelope. Call this after send_offer until status is 'completed' or 'declined'.",
  input: checkStatusInput,
  output: checkStatusOutput,
  handler: async (input) => {
    return simulateApiCall({
      tool: "docusign",
      latencyMs: 60,
      jitterMs: 20,
      transientFailureRate: 0.01,
      hardFailureRate: 0,
      result: () => {
        const envelope = mockEnvelopes.get(input.envelopeId);
        if (!envelope) {
          throw new IntegrationError(
            `envelope ${input.envelopeId} not found`,
            "envelope_not_found",
            false, // caller passed a bogus id — no amount of retries will help
            "docusign",
          );
        }

        // Advance the mock state machine: after ~2 polls, candidate signs.
        envelope.ticks++;
        if (envelope.ticks >= 2 && envelope.status === "sent") {
          envelope.status = "completed";
          envelope.signedAt = new Date().toISOString();
        }

        return {
          envelopeId: envelope.envelopeId,
          status: envelope.status,
          signedAt: envelope.signedAt,
        };
      },
    });
  },
};

// ────────────────────────────────────────────────────────────────
// Integration factory — returns mock today, will return real client later.
// ────────────────────────────────────────────────────────────────
export function createDocusignIntegration(): Integration {
  // Required env vars for real mode — any missing → fall back to mocks.
  const useMocks = shouldUseMocks([
    "DOCUSIGN_INTEGRATION_KEY",
    "DOCUSIGN_USER_ID",
    "DOCUSIGN_ACCOUNT_ID",
    "DOCUSIGN_RSA_PRIVATE_KEY",
  ]);

  if (!useMocks) {
    // Phase 3 placeholder. When real credentials exist we build the real
    // HTTP client here. Until then, intentionally explode so we notice.
    throw new Error("DocuSign real client not implemented yet — see README Phase 3");
  }

  return {
    name: "docusign",
    isMock: true,
    actions: {
      send_offer: sendOfferMock,
      check_status: checkStatusMock,
    },
  };
}
