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
  type IntegrationOpts,
  IntegrationError,
  shouldUseMocks,
  z,
} from "./types";
import { simulateApiCall, generateId, shouldTransientFailOnce } from "./mock-utils";

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

// Mock action factories. Each closes over the active scenario so it can
// flip its random/probabilistic behavior to a deterministic outcome.
function makeSendOffer(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof sendOfferInput, typeof sendOfferOutput> {
  return {
    name: "docusign_send_offer",
    description:
      "Generate an offer letter and send it to the candidate via DocuSign. Returns an envelopeId to poll for signature.",
    input: sendOfferInput,
    output: sendOfferOutput,
    handler: async (_input) => {
      // Scenario "transient_retry" forces the first attempt at this tool
      // to throw a retryable error, exercising the agent's retry loop.
      if (scenario === "transient_retry" && shouldTransientFailOnce("docusign.send_offer")) {
        throw new IntegrationError(
          "DocuSign transient 503 (mock — transient_retry scenario)",
          "transient_5xx",
          true,
          "docusign",
        );
      }
      return simulateApiCall({
        tool: "docusign",
        latencyMs: 120,
        jitterMs: 60,
        // Scenarios that force a clean run set both rates to 0; otherwise
        // keep the realistic baselines so dev runs feel real.
        transientFailureRate: scenario === "all_success" ? 0 : 0.02,
        hardFailureRate: scenario === "all_success" ? 0 : 0.01,
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
}

function makeCheckStatus(
  scenario: IntegrationOpts["scenario"],
): IntegrationAction<typeof checkStatusInput, typeof checkStatusOutput> {
  return {
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
        transientFailureRate: scenario === "all_success" ? 0 : 0.01,
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

          // Advance the mock state machine: after ~2 polls, the envelope
          // resolves. Scenario "docusign_declined" routes the second tick
          // to "declined" instead of "completed" so we exercise the
          // declined-offer escalation path.
          envelope.ticks++;
          if (envelope.ticks >= 2 && envelope.status === "sent") {
            if (scenario === "docusign_declined") {
              envelope.status = "declined";
            } else {
              envelope.status = "completed";
              envelope.signedAt = new Date().toISOString();
            }
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
}

// ════════════════════════════════════════════════════════════════
// REAL API IMPLEMENTATION (COMMENTED OUT — uncomment when creds land)
//
// DocuSign eSignature REST API v2.1.
//
// AUTH: JWT Grant (OAuth 2.0). Flow per turn of operation:
//   1. Build signed JWT (RS256) with claims {iss: integrationKey,
//      sub: userGuid, aud: "account-d.docusign.com" (no scheme!),
//      iat: now, exp: now+3600, scope: "signature impersonation"}.
//   2. POST https://account-d.docusign.com/oauth/token  (demo)
//      body: grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
//            &assertion=<signed JWT>
//      → { access_token, token_type: "Bearer", expires_in: 3600 }
//   3. GET  https://account-d.docusign.com/oauth/userinfo
//      header: Authorization: Bearer <access_token>
//      → { accounts: [{ account_id, base_uri: "https://demo.docusign.net" }] }
//   4. Cache token + base_uri per integration-key for ~55 minutes.
//   One-time manual consent grant required per user before first call:
//     https://account-d.docusign.com/oauth/auth
//       ?response_type=code&scope=signature%20impersonation
//       &client_id=<integrationKey>&redirect_uri=<yours>
//
// BASE URL (prod):  account.docusign.com  +  <base_uri>/restapi/v2.1
// BASE URL (demo):  account-d.docusign.com  +  https://demo.docusign.net/restapi/v2.1
//
// ENDPOINTS USED:
//   POST /accounts/{accountId}/envelopes
//        — creates + sends an envelope. Minimal body shown below.
//        Response: { envelopeId, status: "sent", uri, statusDateTime }
//   GET  /accounts/{accountId}/envelopes/{envelopeId}
//        — polls envelope status.
//        Response: { envelopeId, status, sentDateTime, completedDateTime,... }
//        Status vocabulary: created | sent | delivered | signed | completed
//                           | declined | voided
//        Treat "completed" as signed-success. "declined"/"voided" = escalate.
//
// RATE LIMITS: 3,000 calls/hour/account; burst 500/30s.
// RETRY:  429, 500, 502, 503, 504  (exponential backoff with jitter)
// DON'T:  400, 401, 403, 404
//
// WEBHOOKS (preferred over polling for prod): attach an `eventNotification`
// object to the create-envelope body. Subscribe to envelope-completed,
// envelope-declined, envelope-voided, recipient-completed. Retries up to
// 45 times over 7 days with exponential backoff. Saves rate-limit budget.
// ════════════════════════════════════════════════════════════════

// const DOCUSIGN_DEMO_AUTH_BASE = "https://account-d.docusign.com";
// const DOCUSIGN_PROD_AUTH_BASE = "https://account.docusign.com";
//
// interface DocusignAuthCache { accessToken: string; baseUri: string; expiresAt: number; }
// let _docusignAuth: DocusignAuthCache | null = null;
//
// async function getDocusignAuth(): Promise<{ accessToken: string; baseUri: string }> {
//   if (_docusignAuth && _docusignAuth.expiresAt > Date.now() + 60_000) {
//     return _docusignAuth;
//   }
//
//   // 1. Build + sign JWT. `jsonwebtoken` npm package is the conventional choice.
//   //    The aud claim MUST match the auth host WITHOUT the scheme:
//   //      demo: "account-d.docusign.com", prod: "account.docusign.com"
//   //
//   // import jwt from "jsonwebtoken";
//   // const assertion = jwt.sign(
//   //   {
//   //     iss: process.env.DOCUSIGN_INTEGRATION_KEY,
//   //     sub: process.env.DOCUSIGN_USER_ID,
//   //     aud: "account-d.docusign.com",
//   //     scope: "signature impersonation",
//   //     iat: Math.floor(Date.now() / 1000),
//   //     exp: Math.floor(Date.now() / 1000) + 3600,
//   //   },
//   //   process.env.DOCUSIGN_RSA_PRIVATE_KEY!.replace(/\\n/g, "\n"),
//   //   { algorithm: "RS256" },
//   // );
//
//   // 2. Exchange JWT for access token.
//   // const tokenRes = await fetch(`${DOCUSIGN_DEMO_AUTH_BASE}/oauth/token`, {
//   //   method: "POST",
//   //   headers: { "Content-Type": "application/x-www-form-urlencoded" },
//   //   body: new URLSearchParams({
//   //     grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
//   //     assertion,
//   //   }),
//   // });
//   // if (!tokenRes.ok) {
//   //   throw new IntegrationError(
//   //     `DocuSign token exchange failed: ${tokenRes.status}`,
//   //     "auth_failed",
//   //     tokenRes.status === 429 || tokenRes.status >= 500,
//   //     "docusign",
//   //   );
//   // }
//   // const { access_token, expires_in } = await tokenRes.json();
//
//   // 3. Resolve base_uri for this account (required — do NOT hardcode).
//   // const userInfoRes = await fetch(`${DOCUSIGN_DEMO_AUTH_BASE}/oauth/userinfo`, {
//   //   headers: { Authorization: `Bearer ${access_token}` },
//   // });
//   // const userInfo = await userInfoRes.json();
//   // const account = userInfo.accounts.find(
//   //   (a: any) => a.account_id === process.env.DOCUSIGN_ACCOUNT_ID,
//   // );
//   // if (!account) throw new IntegrationError("account not found", "auth_failed", false, "docusign");
//
//   // _docusignAuth = {
//   //   accessToken: access_token,
//   //   baseUri: account.base_uri,
//   //   expiresAt: Date.now() + expires_in * 1000,
//   // };
//   // return _docusignAuth;
//   throw new Error("unreachable — real auth disabled");
// }
//
// const sendOfferReal: IntegrationAction<typeof sendOfferInput, typeof sendOfferOutput> = {
//   name: "docusign_send_offer",
//   description: sendOfferMock.description,
//   input: sendOfferInput,
//   output: sendOfferOutput,
//   handler: async (input) => {
//     const { accessToken, baseUri } = await getDocusignAuth();
//     const accountId = process.env.DOCUSIGN_ACCOUNT_ID!;
//
//     // Generate offer letter PDF (use pdfkit or a pre-rendered template).
//     // The PDF must be base64-encoded. "anchorString" tabs let DocuSign
//     // place signature boxes wherever "/sig1/" appears in the PDF text.
//     // const offerPdfBase64 = await generateOfferPdf(input);
//
//     // const res = await fetch(
//     //   `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`,
//     //   {
//     //     method: "POST",
//     //     headers: {
//     //       Authorization: `Bearer ${accessToken}`,
//     //       "Content-Type": "application/json",
//     //     },
//     //     body: JSON.stringify({
//     //       emailSubject: `Offer letter — ${input.role}`,
//     //       documents: [{
//     //         documentBase64: offerPdfBase64,
//     //         name: "OfferLetter.pdf",
//     //         fileExtension: "pdf",
//     //         documentId: "1",
//     //       }],
//     //       recipients: {
//     //         signers: [{
//     //           email: input.candidateEmail,
//     //           name: input.candidateName,
//     //           recipientId: "1",
//     //           routingOrder: "1",
//     //           tabs: {
//     //             signHereTabs: [{
//     //               anchorString: "/sig1/",
//     //               anchorUnits: "pixels",
//     //               anchorXOffset: "0",
//     //               anchorYOffset: "0",
//     //             }],
//     //           },
//     //         }],
//     //       },
//     //       // Our hire id as external reference — useful when querying later.
//     //       customFields: {
//     //         textCustomFields: [{ name: "hireId", value: input.hireId, show: "false" }],
//     //       },
//     //       status: "sent",  // "created" = draft; "sent" = ship immediately
//     //     }),
//     //   },
//     // );
//
//     // if (!res.ok) {
//     //   const retryable = res.status === 429 || res.status >= 500;
//     //   throw new IntegrationError(
//     //     `DocuSign send failed: ${res.status}`,
//     //     `http_${res.status}`,
//     //     retryable,
//     //     "docusign",
//     //     await res.text(),
//     //   );
//     // }
//     // const body = await res.json();
//     // return {
//     //   envelopeId: body.envelopeId,
//     //   status: body.status as "sent" | "delivered",
//     //   sentAt: body.statusDateTime,
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };
//
// const checkStatusReal: IntegrationAction<typeof checkStatusInput, typeof checkStatusOutput> = {
//   name: "docusign_check_status",
//   description: checkStatusMock.description,
//   input: checkStatusInput,
//   output: checkStatusOutput,
//   handler: async (input) => {
//     const { accessToken, baseUri } = await getDocusignAuth();
//     const accountId = process.env.DOCUSIGN_ACCOUNT_ID!;
//
//     // const res = await fetch(
//     //   `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${input.envelopeId}`,
//     //   { headers: { Authorization: `Bearer ${accessToken}` } },
//     // );
//     // if (res.status === 404) {
//     //   throw new IntegrationError(
//     //     `envelope ${input.envelopeId} not found`,
//     //     "envelope_not_found",
//     //     false,
//     //     "docusign",
//     //   );
//     // }
//     // if (!res.ok) {
//     //   const retryable = res.status === 429 || res.status >= 500;
//     //   throw new IntegrationError(
//     //     `DocuSign status failed: ${res.status}`,
//     //     `http_${res.status}`,
//     //     retryable,
//     //     "docusign",
//     //   );
//     // }
//     // const body = await res.json();
//     // return {
//     //   envelopeId: body.envelopeId,
//     //   // Map DocuSign statuses to our narrower union.
//     //   status: (body.status === "created" ? "sent" : body.status) as
//     //     "sent" | "delivered" | "completed" | "declined" | "voided",
//     //   signedAt: body.completedDateTime,
//     // };
//     throw new Error("unreachable — real impl disabled");
//   },
// };

// ────────────────────────────────────────────────────────────────
// Integration factory — returns mock today, swaps to real when creds exist.
// ────────────────────────────────────────────────────────────────
export function createDocusignIntegration(opts?: IntegrationOpts): Integration {
  // Required env vars for real mode — any missing → fall back to mocks.
  const useMocks = shouldUseMocks([
    "DOCUSIGN_INTEGRATION_KEY",
    "DOCUSIGN_USER_ID",
    "DOCUSIGN_ACCOUNT_ID",
    "DOCUSIGN_RSA_PRIVATE_KEY",
  ]);

  if (!useMocks) {
    // When real credentials arrive:
    //   1. Uncomment getDocusignAuth + sendOfferReal + checkStatusReal above
    //   2. Replace this throw with:
    //        return { name: "docusign", isMock: false,
    //          actions: { send_offer: sendOfferReal, check_status: checkStatusReal } };
    //   3. `pnpm add jsonwebtoken && pnpm add -D @types/jsonwebtoken`
    throw new Error(
      "DocuSign real client is stubbed out — uncomment the REAL API IMPLEMENTATION block and wire it up.",
    );
  }

  const scenario = opts?.scenario ?? null;
  return {
    name: "docusign",
    isMock: true,
    actions: {
      send_offer: makeSendOffer(scenario),
      check_status: makeCheckStatus(scenario),
    },
  };
}
