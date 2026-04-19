// ────────────────────────────────────────────────────────────────
// Info page — explains how the agent works + what each real API does.
//
// Audience: a non-engineer operator or a stakeholder who wants to
// understand "what is this thing actually doing under the hood." The
// page is static — no live queries, no Convex hooks. All the content
// comes from the real-API research baked into the integration files.
//
// We deliberately show the *real* request + response payloads (not the
// mock shapes) so the reader can see what the agent will be working with
// once credentials are wired in.
// ────────────────────────────────────────────────────────────────

import Link from "next/link";

// ────────────────────────────────────────────────────────────────
// Per-integration documentation. The shape is small and stable so a
// future contributor can add a new tool by appending one entry.
//
// `usage` is the most important field for a non-engineer reader: it
// describes, in plain English, which fields the agent reads and what
// decision it makes from them.
// ────────────────────────────────────────────────────────────────
interface ApiDoc {
  // Display name for the section header.
  name: string;
  // Short tagline that appears under the name.
  tagline: string;
  // Auth scheme description — kept short.
  auth: string;
  // Base URL string the agent talks to in production.
  baseUrl: string;
  // One block per call the agent makes.
  calls: Array<{
    label: string;
    method: string;
    path: string;
    requestExample: string;   // pretty-printed JSON or note
    responseExample: string;  // pretty-printed JSON
    // What the agent extracts and what decision it triggers.
    usage: string;
  }>;
  // Rate limit + retry guidance.
  rateLimits: string;
  // Whether webhooks are available + recommended.
  webhooks: string;
}

const APIS: ApiDoc[] = [
  {
    name: "DocuSign eSignature v2.1",
    tagline: "Sends the offer letter for e-signature and tracks completion.",
    auth: "JWT Grant (RS256). Build a JWT signed with your RSA private key, exchange it at /oauth/token for a 1-hour access_token, then send Authorization: Bearer <token> on every call. Cache the token until ~5 minutes before it expires.",
    baseUrl: "https://demo.docusign.net (demo) or https://<base_uri> from /oauth/userinfo (prod)",
    calls: [
      {
        label: "Send the offer letter",
        method: "POST",
        path: "/restapi/v2.1/accounts/{accountId}/envelopes",
        requestExample: `{
  "emailSubject": "Please sign your offer letter",
  "documents": [{
    "documentBase64": "JVBERi0xLjQK...",
    "name": "OfferLetter.pdf",
    "fileExtension": "pdf",
    "documentId": "1"
  }],
  "recipients": {
    "signers": [{
      "email": "jane.doe@example.com",
      "name": "Jane Doe",
      "recipientId": "1",
      "tabs": {
        "signHereTabs": [{
          "anchorString": "/sig1/",
          "anchorUnits": "pixels"
        }]
      }
    }]
  },
  "status": "sent"
}`,
        responseExample: `{
  "envelopeId": "44c846ef-9d10-4c2d-b9e8-...",
  "status": "sent",
  "statusDateTime": "2026-04-18T14:03:11Z"
}`,
        usage: "Agent persists the envelopeId so it can poll status. The 'sent' status means DocuSign emailed the candidate — no further action until polling shows progress.",
      },
      {
        label: "Poll envelope status",
        method: "GET",
        path: "/restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}",
        requestExample: "(no body)",
        responseExample: `{
  "envelopeId": "44c846ef-...",
  "status": "completed",
  "sentDateTime": "2026-04-18T14:03:11Z",
  "completedDateTime": "2026-04-18T14:21:02Z"
}`,
        usage: "Agent reads `status`. \"sent\" or \"delivered\" → poll again. \"completed\" → candidate signed; advance to background check. \"declined\" or \"voided\" → escalate to a human (hard stop).",
      },
    ],
    rateLimits: "3,000 calls/hour/account; burst 500/30s. Retry on 429, 500, 502, 503, 504 with exponential backoff. Do NOT retry 400, 401, 403, 404.",
    webhooks: "DocuSign Connect — attach an `eventNotification` block to the envelope when creating it. Subscribe to envelope-completed, envelope-declined, envelope-voided. Strongly preferred over polling in production.",
  },
  {
    name: "Checkr",
    tagline: "Background check + license verification for healthcare hires.",
    auth: "HTTP Basic with the secret key as username and an empty password: `Authorization: Basic base64(SECRET_KEY + \":\")`. Test keys hit staging, live keys hit prod.",
    baseUrl: "https://api.checkr.com/v1 (prod) or https://api.checkr-staging.com/v1 (staging)",
    calls: [
      {
        label: "Create candidate (PII)",
        method: "POST",
        path: "/v1/candidates",
        requestExample: `{
  "first_name": "Jane",
  "last_name": "Doe",
  "email": "jane.doe@example.com",
  "dob": "1990-05-14",
  "ssn": "111-11-2001",
  "zipcode": "94110",
  "no_middle_name": true
}`,
        responseExample: `{
  "id": "551564b7865af96a28b13f36",
  "object": "candidate",
  "first_name": "Jane",
  "ssn": "XXX-XX-2001",
  "created_at": "2026-04-18T14:08:18Z"
}`,
        usage: "Agent stores `id` (the candidate id). SSN comes back redacted in the response — Checkr handles the sensitive value. Required before ordering a report.",
      },
      {
        label: "Order background report",
        method: "POST",
        path: "/v1/reports",
        requestExample: `{
  "candidate_id": "551564b7865af96a28b13f36",
  "package": "tasker_standard"
}`,
        responseExample: `{
  "id": "a13f4827d8711ddc75abc56c",
  "status": "pending",
  "result": null,
  "package": "tasker_standard",
  "candidate_id": "551564b7865af96a28b13f36"
}`,
        usage: "Agent stores `id` (the report id) and starts polling. `status: pending` means Checkr is still running checks.",
      },
      {
        label: "Poll report result",
        method: "GET",
        path: "/v1/reports/{report_id}",
        requestExample: "(no body)",
        responseExample: `{
  "id": "a13f4827d8711ddc75abc56c",
  "status": "complete",
  "result": "consider",
  "adjudication": null,
  "completed_at": "2026-04-19T10:03:00Z"
}`,
        usage: "Agent reads `status` + `result`. \"pending\" → poll again. \"complete\" + \"clear\" → safe to proceed to payroll. \"complete\" + \"consider\" → adverse findings; FCRA requires human adjudication, agent escalates. \"suspended\" → Checkr needs more docs from the candidate; escalate.",
      },
    ],
    rateLimits: "1,200 req/min. Headers: X-Ratelimit-Remaining, X-Ratelimit-Reset (epoch). Retry on 429, 500, 502, 503, 504 with backoff. Send Idempotency-Key on POSTs so retries are safe.",
    webhooks: "Checkr Webhooks — events include report.completed, report.suspended, report.disputed. Verify with HMAC-SHA256 on X-Checkr-Signature. Strongly preferred — reports can take hours to days.",
  },
  {
    name: "Gusto Embedded Payroll",
    tagline: "Adds the new hire to payroll and (via partner) ICHRA benefits.",
    auth: "OAuth 2.0 Authorization Code grant. Exchange auth code at /oauth/token for an access_token (2h lifetime) and refresh_token (rotates on every refresh — always persist the new one). Header: Authorization: Bearer <token>, X-Gusto-API-Version: 2024-04-01.",
    baseUrl: "https://api.gusto.com (prod) or https://api.gusto-demo.com (demo)",
    calls: [
      {
        label: "Create employee",
        method: "POST",
        path: "/v1/companies/{company_uuid}/employees",
        requestExample: `{
  "first_name": "Alexander",
  "middle_initial": "A",
  "last_name": "Hamilton",
  "date_of_birth": "1979-06-01",
  "email": "a.h@example.com",
  "ssn": "123451776",
  "self_onboarding": true
}`,
        responseExample: `{
  "uuid": "8e63aa05-7d0e-4663-b9dc-...",
  "version": "414645000000abc",
  "first_name": "Alexander",
  "onboarded": false
}`,
        usage: "Agent stores `uuid` (employee id) and `version` (used for optimistic locking on subsequent PUTs). `self_onboarding: true` lets the employee fill remaining PII via Gusto-hosted UI; otherwise the agent has to POST home_addresses + jobs + compensations next.",
      },
      {
        label: "Enroll in ICHRA benefit",
        method: "POST",
        path: "/v1/employees/{employee_uuid}/employee_benefits",
        requestExample: `{
  "company_benefit_uuid": "f68abb42-431e-4392-bc3f-...",
  "active": true,
  "employee_deduction": "0.00",
  "contribution": { "type": "amount", "value": "400.00" }
}`,
        responseExample: `{
  "uuid": "11e30d62-8b3f-4c0a-8442-...",
  "active": true,
  "company_benefit_uuid": "f68abb42-..."
}`,
        usage: "Agent triggers payroll-side reimbursement enrollment. NOTE: Gusto does not natively administer ICHRA — it must be paired with a partner like Thatch or Take Command Health that handles the actual benefit. The agent's TODO is to also call the partner's API after this.",
      },
    ],
    rateLimits: "200 req/min per (application, company) pair, rolling 60s. On 429, respect Retry-After. Backoff: 1s, 2s, 4s, 8s capped.",
    webhooks: "Gusto webhook subscriptions cover events like employee.created and benefit.updated. Useful for keeping HRIS in sync; not strictly needed for agent-driven onboarding since the agent owns the timing.",
  },
  {
    name: "Shippo",
    tagline: "Verifies the home address and buys the laptop shipping label.",
    auth: "Single API token. Header: `Authorization: ShippoToken shippo_live_xxx` (or `shippo_test_xxx`). The token prefix picks live vs sandbox — no separate hostname.",
    baseUrl: "https://api.goshippo.com",
    calls: [
      {
        label: "Validate address",
        method: "POST",
        path: "/addresses/",
        requestExample: `{
  "name": "Jane Nurse",
  "street1": "215 Clayton St.",
  "city": "San Francisco",
  "state": "CA",
  "zip": "94117",
  "country": "US",
  "validate": true
}`,
        responseExample: `{
  "object_id": "67183b2e81e9421f894bfbcdc4236b16",
  "is_complete": true,
  "validation_results": { "is_valid": true, "messages": [] },
  "street1": "215 CLAYTON ST",
  "city": "SAN FRANCISCO",
  "state": "CA",
  "zip": "94117-1923"
}`,
        usage: "Agent reads `validation_results.is_valid`. true → safe to buy a label, and the response's normalized address is what gets used downstream. false → escalate with `validation_results.messages` so a human can correct the address before we waste a label.",
      },
      {
        label: "Buy label (instalabel — combined call)",
        method: "POST",
        path: "/transactions/",
        requestExample: `{
  "shipment": {
    "address_from": { "name": "Acme HR", "street1": "1 Market St", "city": "San Francisco", "state": "CA", "zip": "94105", "country": "US" },
    "address_to":   { "name": "Jane Nurse", "street1": "215 Clayton St.", "city": "San Francisco", "state": "CA", "zip": "94117", "country": "US" },
    "parcels": [{ "length": "15", "width": "12", "height": "3", "distance_unit": "in", "weight": "8", "mass_unit": "lb" }]
  },
  "carrier_account": "b741b99f95e841639b54272834bc478c",
  "servicelevel_token": "usps_priority",
  "label_file_type": "PDF",
  "async": false
}`,
        responseExample: `{
  "object_id": "9a1b...",
  "status": "SUCCESS",
  "tracking_number": "9405511899563312345671",
  "tracking_url_provider": "https://tools.usps.com/...",
  "label_url": "https://shippo-delivery.s3.amazonaws.com/.../label.pdf"
}`,
        usage: "Agent reads `status` (\"SUCCESS\" → keep the `tracking_number` and `label_url`) and persists both for the operator dashboard. \"ERROR\" status with carrier-rejected messages → escalate (we won't auto-retry a label the carrier said no to).",
      },
    ],
    rateLimits: "Live: 500 POST/min, 4,000 GET-single/min, 50 GET-list/min. 429 on overrun; no documented Retry-After header — back off and retry.",
    webhooks: "Tracking webhooks notify on shipment status changes (in transit, delivered, exception). Useful for keeping the dashboard live without polling Shippo.",
  },
  {
    name: "Kandji",
    tagline: "Pre-provisions the laptop's MDM enrollment so it auto-configures on first boot.",
    auth: "API token (Bearer). `Authorization: Bearer <KANDJI_API_TOKEN>`. Tokens are tenant-scoped with fine-grained per-endpoint permissions.",
    baseUrl: "https://<subdomain>.api.kandji.io (US) or https://<subdomain>.api.eu.kandji.io (EU). All paths prefixed /api/v1.",
    calls: [
      {
        label: "Find the device by candidate email",
        method: "GET",
        path: "/api/v1/devices?user.email=jane@example.com&limit=1",
        requestExample: "(query param only)",
        responseExample: `[{
  "device_id": "ab102b9d-8e9c-420d-a498-...",
  "serial_number": "C02XYZ123ABC",
  "user": { "email": "jane@example.com", "id": "9564" },
  "blueprint_id": null
}]`,
        usage: "Agent looks up the device that the warehouse already registered in Apple Business Manager (ABM) for this candidate. If no device comes back, the ABM sync hasn't landed yet → retryable error (try again in a minute).",
      },
      {
        label: "Assign blueprint (pre-provision)",
        method: "PATCH",
        path: "/api/v1/devices/{device_id}",
        requestExample: `{
  "blueprint_id": "ab102b9d-8e9c-420d-a498-f2a1123091c7",
  "asset_tag": "NURSE-042",
  "user": "9564"
}`,
        responseExample: `{
  "device_id": "ab102b9d-...",
  "blueprint_id": "ab102b9d-...",
  "asset_tag": "NURSE-042"
}`,
        usage: "Agent ties the nurse's clinical blueprint (apps, restrictions, profiles) to their device. When the nurse boots the laptop and signs into iCloud, Kandji auto-configures everything via DEP — no IT involvement needed.",
      },
      {
        label: "Poll enrollment status",
        method: "GET",
        path: "/api/v1/devices/{device_id}/details",
        requestExample: "(no body)",
        responseExample: `{
  "device_id": "ab102b9d-...",
  "mdm_enrollment": { "status": "Enrolled", "enrolled_at": "2026-04-22T15:31:08Z" },
  "last_check_in": "2026-04-22T15:32:11Z",
  "serial_number": "C02XYZ123ABC"
}`,
        usage: "Agent reads `mdm_enrollment.status`. \"Enrolled\" → onboarding fully complete. Anything else → keep polling (the nurse hasn't unboxed the laptop yet).",
      },
    ],
    rateLimits: "10,000 req/hour per tenant (~166/min). 429 on overrun; no documented Retry-After — exponential backoff.",
    webhooks: "Kandji webhooks fire on device enrollment + check-in events. Recommended over polling once you're past the demo phase.",
  },
];

// ────────────────────────────────────────────────────────────────
// Page component.
// ────────────────────────────────────────────────────────────────
export default function InfoPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      {/* Top: where am I + breadcrumb back. */}
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-black dark:hover:text-zinc-50"
      >
        ← Dashboard
      </Link>
      <h1 className="text-2xl font-semibold">How the agent works</h1>
      <p className="mt-2 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        This page explains the orchestration loop and shows the real
        request/response shapes the agent works with for each downstream
        system. The mocks under <code>src/lib/integrations/</code> emit the
        same shapes so the agent code is unchanged when real credentials
        land — flip the env vars and the same logic runs against
        production endpoints.
      </p>

      {/* The orchestration loop — a tiny conceptual diagram. */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold">The orchestration loop</h2>
        <p className="mt-2 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
          The agent is a LangGraph state machine with four nodes. Every turn
          flows through the same loop until it either finishes the chain or
          hands off to a human.
        </p>

        <ol className="mt-4 space-y-3">
          <LoopStep
            n={1}
            phase="plan / decide"
            body="The LLM looks at the hire's record, what it's already done, and the dependency rules in the system prompt. It picks exactly one tool to call next — or it declares the work complete."
          />
          <LoopStep
            n={2}
            phase="act"
            body="The execute node validates the tool arguments through Zod, persists a `step` row to Convex, then calls the integration. Mock or real — the agent's code path is identical."
          />
          <LoopStep
            n={3}
            phase="observe"
            body="On success, the agent inspects the response. If the response is a known business-rule escalation (Checkr 'consider', Shippo invalid address, DocuSign declined), the agent stops calling the LLM and routes straight to escalate — it doesn't trust the LLM to remember the rule."
          />
          <LoopStep
            n={4}
            phase="retry / escalate / finish"
            body="Transient errors (5xx, rate limits) bump a per-tool retry counter and the LLM is shown the failure so it can choose to retry. Hard failures, business escalations, and stalls all route to escalate, which writes an exception row + flips the hire to awaiting_human. Only a clean run reaches finish."
          />
        </ol>
      </section>

      {/* The tool list (rendered from the catalog above). */}
      <section className="mt-12">
        <h2 className="text-lg font-semibold">The tools the agent calls</h2>
        <p className="mt-2 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
          Each integration below is currently mocked. The auth/endpoint/payload
          notes describe what the agent <em>will</em> do once we plug in
          credentials — the commented-out real-API blocks in
          {" "}<code>src/lib/integrations/*.ts</code> already contain the
          fetch calls, so flipping each one on is mostly removing comment markers.
        </p>

        <div className="mt-6 space-y-10">
          {APIS.map((api) => (
            <ApiCard key={api.name} api={api} />
          ))}
        </div>
      </section>

      {/* Where to look in code. */}
      <section className="mt-12">
        <h2 className="text-lg font-semibold">Where this lives in code</h2>
        <ul className="mt-3 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
          <li>
            <code>src/lib/agent/graph.ts</code> — the LangGraph state machine
            (decide / execute / escalate / finish nodes + routing rules).
          </li>
          <li>
            <code>src/lib/agent/narrator.ts</code> — turns each agent event
            into the chat-style narration you see on the hire detail page.
          </li>
          <li>
            <code>src/lib/integrations/*.ts</code> — one file per external
            system. Each contains the mock used today and the (commented-out)
            real-API code for when credentials arrive.
          </li>
          <li>
            <code>convex/schema.ts</code> — the persistent data model:
            hires, steps, exceptions, audit_log, agent_thoughts.
          </li>
        </ul>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Sub-components — kept inline since they're used only by this page.
// ────────────────────────────────────────────────────────────────

function LoopStep({ n, phase, body }: { n: number; phase: string; body: string }) {
  return (
    <li className="flex items-start gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-mono font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{phase}</p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          {body}
        </p>
      </div>
    </li>
  );
}

function ApiCard({ api }: { api: ApiDoc }) {
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">{api.name}</h3>
        <span className="font-mono text-xs text-zinc-500">{api.baseUrl}</span>
      </header>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{api.tagline}</p>

      <dl className="mt-4 space-y-2 text-xs">
        <Meta label="Auth" body={api.auth} />
        <Meta label="Rate limits + retry" body={api.rateLimits} />
        <Meta label="Webhooks" body={api.webhooks} />
      </dl>

      <h4 className="mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Calls the agent makes
      </h4>
      <ol className="mt-2 space-y-4">
        {api.calls.map((c) => (
          <li
            key={c.label}
            className="rounded border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <p className="text-sm font-medium">{c.label}</p>
            <p className="mt-1 font-mono text-xs text-zinc-600 dark:text-zinc-400">
              <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase dark:bg-zinc-800">
                {c.method}
              </span>{" "}
              {c.path}
            </p>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  Request
                </p>
                <pre className="mt-1 max-h-72 overflow-auto rounded bg-white p-2 text-[11px] leading-snug text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                  {c.requestExample}
                </pre>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  Response
                </p>
                <pre className="mt-1 max-h-72 overflow-auto rounded bg-white p-2 text-[11px] leading-snug text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                  {c.responseExample}
                </pre>
              </div>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
              <span className="font-semibold">How the agent uses it: </span>
              {c.usage}
            </p>
          </li>
        ))}
      </ol>
    </article>
  );
}

function Meta({ label, body }: { label: string; body: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="text-zinc-700 dark:text-zinc-300">{body}</dd>
    </div>
  );
}
