// ────────────────────────────────────────────────────────────────
// Shared types for every external integration the agent calls.
//
// Key design constraint: the orchestrator should not know or care whether
// it's talking to a real API or a mock. Both conform to the same
// `Integration<TAction, TInput, TOutput>` shape so swapping is a one-line
// change when real API keys arrive.
// ────────────────────────────────────────────────────────────────

// Re-export zod so every integration module can pull it from one place
// and version bumps land in a single file.
import { z } from "zod";
export { z };

// ────────────────────────────────────────────────────────────────
// IntegrationError — a typed error the graph knows how to interpret.
//
// `retryable: true`  → agent retries with backoff (e.g. 503, timeout)
// `retryable: false` → agent escalates to the operator queue
//
// We subclass Error so stack traces still work, but carry our own fields.
// ────────────────────────────────────────────────────────────────
export class IntegrationError extends Error {
  constructor(
    message: string,
    // Machine-readable code — exception queue uses this for routing.
    public readonly code: string,
    // Whether the orchestrator should retry or escalate.
    public readonly retryable: boolean,
    // Which tool produced the error (docusign, checkr, …). Filled in by base class.
    public readonly tool: string,
    // Optional additional payload from the underlying API (for audit log).
    public readonly details?: unknown,
  ) {
    // Preserve the JS Error contract.
    super(message);
    this.name = "IntegrationError";
  }
}

// ────────────────────────────────────────────────────────────────
// IntegrationAction<I, O>
//
// Describes one callable action on a tool. Each action carries:
//   - `input`  — a zod schema for validation (doubles as LLM tool schema)
//   - `output` — a zod schema for what the caller can trust back
//   - `handler` — the actual implementation (mock or real)
//
// By tying the types to the schema via `z.infer`, a single change to the
// zod schema updates the TS signature everywhere. This is the pattern that
// lets the LLM's function-calling stay in lockstep with our runtime types.
// ────────────────────────────────────────────────────────────────
export interface IntegrationAction<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  // Short identifier the LLM sees in the tool list, e.g. "send_offer".
  name: string;
  // Human-readable description — also exposed to the LLM.
  description: string;
  // Input validation schema.
  input: I;
  // Output validation schema.
  output: O;
  // Implementation. Agent invokes this after input validation passes.
  handler: (input: z.infer<I>) => Promise<z.infer<O>>;
}

// ────────────────────────────────────────────────────────────────
// Integration — a group of actions for a single external tool.
// Example: the DocuSign integration exposes { send_offer, check_status }.
// ────────────────────────────────────────────────────────────────
export interface Integration {
  // Short identifier used for routing + audit: "docusign", "checkr", etc.
  name: string;
  // True when running against a mock implementation (tests + dev).
  isMock: boolean;
  // Map of action-name → action definition.
  actions: Record<string, IntegrationAction>;
}

// ────────────────────────────────────────────────────────────────
// Scenario — deterministic mock-behavior selector.
//
// The mocks normally roll dice (10% adverse background, 5% bad address,
// etc.) so demo runs feel real. For testing every error path we need a
// way to *pin* a specific outcome. Each integration's mock checks the
// scenario before falling back to RNG.
//
// Add new scenarios here as we want new test paths.
// ────────────────────────────────────────────────────────────────
export type Scenario =
  // Force every random outcome to the happy result. No transients,
  // no hard fails, no flagged background, no invalid addresses.
  | "all_success"
  // Checkr returns "consider" — adverse findings, FCRA escalation.
  | "checkr_consider"
  // Checkr returns "suspended" — missing documents from candidate.
  | "checkr_suspended"
  // Shippo address validation fails — escalate before buying a label.
  | "address_invalid"
  // DocuSign envelope returns "declined" — candidate said no.
  | "docusign_declined"
  // First call to each polling tool returns a transient 5xx; the agent
  // retries within budget and the second call succeeds. Demonstrates
  // retry resilience.
  | "transient_retry"
  // Shippo create_shipment hard-fails (carrier rejected the label).
  | "shippo_label_failed";

// Convenient set of all valid values for runtime checks.
export const ALL_SCENARIOS: ReadonlyArray<Scenario> = [
  "all_success",
  "checkr_consider",
  "checkr_suspended",
  "address_invalid",
  "docusign_declined",
  "transient_retry",
  "shippo_label_failed",
];

// Options every `createXxxIntegration` factory accepts. Kept generic so
// adding fields later (e.g. per-tool latency overrides) doesn't ripple
// through every signature.
export interface IntegrationOpts {
  scenario?: Scenario | null;
}

// ────────────────────────────────────────────────────────────────
// Helper: decide at module-load whether to use mocks.
//
// Priority (highest first):
//   1. explicit USE_MOCKS env var ("true"/"false")
//   2. fall back to mocks whenever the relevant real key is missing
//
// Each integration file calls this with its required env var names.
// ────────────────────────────────────────────────────────────────
export function shouldUseMocks(requiredEnvVars: string[]): boolean {
  // Explicit flag wins — useful in tests or for forcing mock mode in prod demos.
  const explicit = process.env.USE_MOCKS;
  if (explicit === "true") return true;
  if (explicit === "false") return false;

  // Otherwise, use mocks whenever any required real-key is missing.
  // This lets us "graduate" tools to real mode by just filling in .env.local.
  return requiredEnvVars.some((name) => !process.env[name]);
}
