// ────────────────────────────────────────────────────────────────
// narrator — turns agent events into human-readable thoughts.
//
// Why this exists: the graph's decide/execute nodes know what they're
// doing, but a tool name like "kandji.create_enrollment" isn't useful
// to a human watching. The narrator converts structured events into
// one-line summaries + longer "why" prose that the UI shows in a
// chat-style stream.
//
// Design: pure functions, no LLM calls. Fast, deterministic, free.
// If we ever want richer narration, the decide node already has the
// LLM's `content` — we pass that through as `detail` when present.
// ────────────────────────────────────────────────────────────────

// Short tool-key → plain-English verb. Keep synchronous with registry.
// If the agent ever calls a tool we haven't narrated, we fall back to
// "calling <tool.action>" — so adding a new tool doesn't break the UI.
const TOOL_VERBS: Record<string, string> = {
  "docusign.send_offer": "Sending the offer letter for e-signature",
  "docusign.check_status": "Checking whether the offer letter has been signed",
  "checkr.order_check": "Ordering a background check with Checkr",
  "checkr.get_result": "Fetching the background check result",
  "gusto.create_employee": "Adding the new hire to Gusto payroll",
  "gusto.enroll_ichra": "Enrolling them in ICHRA health benefits",
  "shippo.verify_address": "Validating the home address with Shippo",
  "shippo.create_shipment": "Buying a laptop shipping label",
  "kandji.create_enrollment": "Pre-provisioning the laptop in Kandji MDM",
  "kandji.get_enrollment": "Checking whether the nurse has enrolled the device",
};

// Why this tool right now — reasoning the agent uses to justify the choice.
// Shown as the "detail" line under the summary. Written in first person
// ("I'll …", "I need …") so the stream reads like listening to the agent.
const TOOL_REASONING: Record<string, string> = {
  "docusign.send_offer":
    "This is step 1 of the onboarding chain. Nothing downstream can start until the candidate has a signed offer in hand.",
  "docusign.check_status":
    "The envelope has been sent — I'm polling until the candidate signs so I can kick off the background check.",
  "checkr.order_check":
    "Offer is signed. Time to verify the nurse's background before anything touches payroll or equipment.",
  "checkr.get_result":
    "The background report is running. I'll poll until it resolves to clear/consider/suspended.",
  "gusto.create_employee":
    "Background check came back clean. Safe to create the employee record so payroll can start on day one.",
  "gusto.enroll_ichra":
    "Employee exists in Gusto. Enrolling them in ICHRA benefits so health coverage is effective on start date.",
  "shippo.verify_address":
    "Before I spend money on a shipping label, I need to confirm the nurse's home address is actually deliverable.",
  "shippo.create_shipment":
    "Address verified. Purchasing a laptop shipping label now so the MacBook arrives before their first shift.",
  "kandji.create_enrollment":
    "Laptop is in transit. Pre-provisioning the MDM enrollment so it auto-configures when the nurse boots it for the first time.",
  "kandji.get_enrollment":
    "Waiting for the nurse to complete Setup Assistant. Polling until the device checks in to Kandji.",
};

// ────────────────────────────────────────────────────────────────
// describePlan — first-turn thought, fired before any tool call.
// Lets the UI show "here's what I'm going to do" before the agent
// ever calls a tool, which makes the first couple seconds of the
// demo feel intentional instead of empty.
// ────────────────────────────────────────────────────────────────
export function describePlan(hire: { name: string; role: string; state: string }) {
  return {
    summary: `Planning onboarding for ${hire.name}`,
    detail: `New ${hire.role} in ${hire.state}. I need to run offer letter → background check → payroll → benefits → address verification → laptop shipment → MDM enrollment, in that order. Most steps are dependency-gated; some poll until their external system resolves.`,
  };
}

// ────────────────────────────────────────────────────────────────
// describeAct — the agent is about to execute a tool. Summary shows
// the human-readable verb; detail shows the "why".
// ────────────────────────────────────────────────────────────────
export function describeAct(toolKey: string, args: unknown): {
  summary: string;
  detail: string;
} {
  const verb = TOOL_VERBS[toolKey] ?? `Calling ${toolKey}`;

  // Pick out 2-3 semantically useful args to show inline in the summary
  // without dumping the whole blob. Falls back to "" if nothing obvious.
  const hint = argHint(args);
  const summary = hint ? `${verb} · ${hint}` : verb;

  const detail =
    TOOL_REASONING[toolKey] ?? "Invoking this tool as part of the dependency chain.";

  return { summary, detail };
}

// ────────────────────────────────────────────────────────────────
// describeObserve — agent got a result back. Translates the raw
// output shape into "here's what I learned and what I'll do next".
// ────────────────────────────────────────────────────────────────
export function describeObserve(toolKey: string, output: unknown): {
  summary: string;
  detail: string;
} {
  const out = output as Record<string, unknown>;

  // Tool-specific narration. Covers the happy path + the poll-again path.
  switch (toolKey) {
    case "docusign.send_offer":
      return {
        summary: `Offer letter sent · envelope ${short(out.envelopeId)}`,
        detail: "The candidate will get an email from DocuSign. I'll poll envelope status next.",
      };
    case "docusign.check_status": {
      const status = out.status as string | undefined;
      if (status === "completed") {
        return {
          summary: "Offer letter signed",
          detail: "Candidate has completed signing. Moving on to the background check.",
        };
      }
      if (status === "declined") {
        return {
          summary: "Candidate declined the offer",
          detail: "This is a hard stop — escalating so a human can follow up with the candidate.",
        };
      }
      if (status === "voided") {
        return {
          summary: "Envelope was voided",
          detail: "Something cancelled the envelope before signing — escalating to investigate.",
        };
      }
      return {
        summary: `Envelope status: ${status ?? "unknown"} · not signed yet`,
        detail: "The candidate hasn't finished signing. I'll poll again.",
      };
    }
    case "checkr.order_check":
      return {
        summary: `Background check ordered · report ${short(out.reportId)}`,
        detail: "Checkr is processing. I'll poll the report until it terminates.",
      };
    case "checkr.get_result": {
      const status = out.status as string | undefined;
      if (status === "clear") {
        return {
          summary: "Background check came back clear",
          detail: "No adverse information. Safe to proceed to payroll.",
        };
      }
      if (status === "consider") {
        return {
          summary: "Background check returned 'consider'",
          detail: "Adverse findings — this isn't safe for me to decide on. Escalating to a human reviewer.",
        };
      }
      if (status === "suspended") {
        return {
          summary: "Background check suspended",
          detail: "Likely a licensing issue. Escalating to a human.",
        };
      }
      return {
        summary: "Background check still running",
        detail: "Not resolved yet. I'll poll again.",
      };
    }
    case "gusto.create_employee":
      return {
        summary: `Employee created in Gusto · ${short(out.employeeId)}`,
        detail: "Payroll profile exists. Enrolling them in ICHRA benefits next.",
      };
    case "gusto.enroll_ichra": {
      const status = out.status as string | undefined;
      if (status === "pending_state_review") {
        return {
          summary: "Benefits enrollment pending state review",
          detail:
            "This state requires a manual compliance pass before activation. Logging it but proceeding with downstream steps — the benefits team will pick it up.",
        };
      }
      return {
        summary: "Benefits enrolled and active",
        detail: "ICHRA coverage effective from today. Moving on to laptop logistics.",
      };
    }
    case "shippo.verify_address": {
      const valid = out.valid as boolean | undefined;
      if (valid) {
        return {
          summary: "Home address verified as deliverable",
          detail: "Shippo normalized the address. Safe to purchase a label.",
        };
      }
      return {
        summary: "Address failed verification",
        detail: "Shippo couldn't resolve the address — escalating so a human can correct it before we waste a label.",
      };
    }
    case "shippo.create_shipment": {
      const carrier = (out.carrier as string | undefined)?.toUpperCase() ?? "carrier";
      return {
        summary: `Label purchased · ${carrier} tracking ${short(out.trackingNumber)}`,
        detail: `Estimated delivery ${out.estimatedDelivery}. Pre-provisioning MDM next so the device enrolls automatically.`,
      };
    }
    case "kandji.create_enrollment":
      return {
        summary: `MDM enrollment pre-provisioned · ${short(out.enrollmentId)}`,
        detail: "When the nurse boots the MacBook and signs in, it will auto-enroll. I'll poll until that happens.",
      };
    case "kandji.get_enrollment": {
      const status = out.status as string | undefined;
      if (status === "enrolled") {
        return {
          summary: "Device enrolled in Kandji MDM",
          detail: `Serial ${out.deviceSerial}. Onboarding complete — every downstream policy has already been bound to the blueprint.`,
        };
      }
      return {
        summary: "Device not yet enrolled",
        detail: "Nurse probably hasn't opened the laptop yet. I'll poll again.",
      };
    }
    default:
      return {
        summary: `Got result from ${toolKey}`,
        detail: "Processing response.",
      };
  }
}

// ────────────────────────────────────────────────────────────────
// describeRetry — we hit a transient failure and are backing off.
// ────────────────────────────────────────────────────────────────
export function describeRetry(
  toolKey: string,
  attempt: number,
  errorMessage: string,
): { summary: string; detail: string } {
  return {
    summary: `Retrying ${toolKey} (attempt ${attempt + 1})`,
    detail: `The last call failed transiently: "${errorMessage}". Retrying — the external service probably rate-limited me or had a blip.`,
  };
}

// ────────────────────────────────────────────────────────────────
// describeEscalate — agent can't proceed on its own.
// ────────────────────────────────────────────────────────────────
export function describeEscalate(reason: string, details: string): {
  summary: string;
  detail: string;
} {
  return {
    summary: `Escalating to a human · ${reason}`,
    detail: details,
  };
}

// ────────────────────────────────────────────────────────────────
// describeDone — last thought written when the agent finishes cleanly.
//
// We deliberately keep this generic — the agent runs the same flow for
// every hire but the operator can read the step timeline below the
// stream to see exactly which tools fired. Listing every downstream
// system here would be a lie if any of them got skipped.
// ────────────────────────────────────────────────────────────────
export function describeDone(stepCount: number) {
  return {
    summary: `Onboarding complete · ${stepCount} tool calls`,
    detail:
      "Every step in the dependency chain resolved successfully. See the step timeline below for the full sequence.",
  };
}

// ────────────────────────────────────────────────────────────────
// Private helpers
// ────────────────────────────────────────────────────────────────

// Pull out a short identifying hint from a tool's input args.
// Helps the stream show which thing we're working on without a JSON dump.
function argHint(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  // Prefer semantically meaningful ids if present.
  const id =
    a.envelopeId ??
    a.reportId ??
    a.employeeId ??
    a.enrollmentId ??
    a.shipmentId;
  if (typeof id === "string") return short(id);

  // Fall back to a name-ish field.
  if (typeof a.candidateName === "string") return a.candidateName;

  return "";
}

// Truncate long ids for readability in the stream.
function short(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= 16) return value;
  return `${value.slice(0, 10)}…`;
}
