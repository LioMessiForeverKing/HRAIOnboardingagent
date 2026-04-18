// ────────────────────────────────────────────────────────────────
// Convex schema — the persistent data model for the HR onboarding agent.
//
// Why Convex: live queries give the operator dashboard real-time updates
// for free, and Convex mutations are the natural place to record every
// side-effect the agent takes so we have a tamper-evident audit trail.
//
// Schema intent:
//   hires         one row per new-hire onboarding workflow
//   steps         one row per orchestration step per hire (DocuSign, Checkr, …)
//   exceptions    items the agent couldn't resolve; appear in operator queue
//   audit_log     append-only log of every event, for compliance
//   reflections   RESERVED for Phase 6 (learning loop). Not read yet.
// ────────────────────────────────────────────────────────────────

// Import Convex schema helpers.
// `defineSchema` wraps the whole schema object.
// `defineTable` declares one table with a shape.
import { defineSchema, defineTable } from "convex/server";

// `v` is the validator namespace — every field type is declared here so
// Convex can validate writes at the edge (rejects bad payloads before they
// hit storage).
import { v } from "convex/values";

// Export the schema as the default export — Convex looks for `schema.ts`
// in the convex directory and expects a default-exported schema object.
export default defineSchema({
  // ───────────────────────────────────────────────────────────
  // hires — the top-level entity. Each hire flows through the graph once.
  // ───────────────────────────────────────────────────────────
  hires: defineTable({
    // Candidate's full legal name (as it will appear on offer letter + W-4)
    name: v.string(),
    // Email used for offer letter + login provisioning
    email: v.string(),
    // Role / title — currently nurse variants, but kept as a free-form string
    // so we can extend to other clinical roles without a migration.
    role: v.string(),
    // Two-letter US state code. Drives compliance branching (Phase 4).
    state: v.string(),
    // Home street address — used by Shippo to route the laptop.
    address: v.object({
      street1: v.string(),
      street2: v.optional(v.string()),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
    }),
    // Annual base salary in whole USD. Used by the DocuSign offer letter
    // and by Gusto payroll setup.
    salary: v.number(),
    // Planned first day at work. Used to calculate SLAs backwards from start.
    startDate: v.string(), // ISO 8601 date string — Convex has no native Date
    // Overall workflow status — a small enum kept in sync with the LangGraph state.
    status: v.union(
      v.literal("pending"),       // just created, agent hasn't picked it up
      v.literal("in_progress"),   // agent is actively working
      v.literal("awaiting_human"), // blocked on an exception
      v.literal("completed"),     // all steps done
      v.literal("failed")         // unrecoverable failure
    ),
    // Free-form cursor pointing at the currently-active step key (e.g. "checkr").
    // Cheap way to render the dashboard without joining `steps`.
    currentStep: v.optional(v.string()),
    // Creation + last-update timestamps (ms since epoch).
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Index by status so the dashboard can quickly pull "in flight" hires.
    .index("by_status", ["status"])
    // Index by email so we can detect duplicate hires.
    .index("by_email", ["email"]),

  // ───────────────────────────────────────────────────────────
  // steps — one row per (hire × tool-call). Immutable once `completed`/`failed`.
  //
  // This is the agent's memory of what it has already done. LangGraph also
  // has its own checkpointer, but this table is the human-readable projection
  // that the dashboard + audit log can query.
  // ───────────────────────────────────────────────────────────
  steps: defineTable({
    // Foreign key back to the hire this step belongs to.
    hireId: v.id("hires"),
    // Which tool / integration this step represents.
    // Kept as a literal union so typos in the orchestrator fail loudly.
    tool: v.union(
      v.literal("docusign"),
      v.literal("checkr"),
      v.literal("gusto"),
      v.literal("shippo"),
      v.literal("kandji")
    ),
    // Action within the tool (e.g. "send_offer", "enroll_ichra"). Free-form;
    // each integration defines its own action vocabulary.
    action: v.string(),
    // Current status of this step.
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("escalated") // surfaced as an exception for the operator
    ),
    // Input payload the agent supplied to the tool. Stored as JSON so we can
    // replay / inspect later without schema changes.
    input: v.any(),
    // Result payload from the tool (or error info if failed).
    output: v.optional(v.any()),
    // Retry counter — the graph bumps this before re-running on transient errors.
    attemptCount: v.number(),
    // Timestamps for SLA tracking.
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    // Dashboard needs "all steps for this hire, in order" frequently.
    .index("by_hire", ["hireId"])
    // Filter-by-status index so we can find all currently-running steps fast.
    .index("by_status", ["status"]),

  // ───────────────────────────────────────────────────────────
  // exceptions — the operator's inbox. One row per thing-that-needs-a-human.
  // ───────────────────────────────────────────────────────────
  exceptions: defineTable({
    // Which hire this exception belongs to.
    hireId: v.id("hires"),
    // Which step produced the exception (null if the agent escalated before
    // even starting a step — e.g. missing data on the hire record).
    stepId: v.optional(v.id("steps")),
    // Short machine-readable reason code: "checkr_adverse_action",
    // "address_unverifiable", "ambiguous_state_rules", etc.
    reason: v.string(),
    // Longer human-readable description the operator reads in Slack + UI.
    details: v.string(),
    // Agent's best guess at what the human should do next. Helpful but not
    // authoritative — operator can override.
    suggestedAction: v.optional(v.string()),
    // Exception severity — drives Slack channel routing + paging.
    severity: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high")
    ),
    // Resolution state — open until an operator clicks approve/override.
    resolution: v.union(
      v.literal("open"),
      v.literal("resolved"),
      v.literal("dismissed")
    ),
    // Who resolved it (operator's email or "system" if auto-resolved).
    resolvedBy: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    // Operator queue query: "show me all open exceptions, newest first".
    .index("by_resolution", ["resolution"])
    // Per-hire view on the detail page.
    .index("by_hire", ["hireId"]),

  // ───────────────────────────────────────────────────────────
  // audit_log — append-only. Every agent action, tool call, human decision.
  // Compliance-sensitive — never mutate or delete rows here.
  // ───────────────────────────────────────────────────────────
  audit_log: defineTable({
    // Which hire this event applies to. Null for system-wide events.
    hireId: v.optional(v.id("hires")),
    // Who did the thing. "agent" | "operator:<email>" | "system" | "integration:<tool>"
    actor: v.string(),
    // Short event code: "hire_created", "step_started", "exception_raised",
    // "exception_resolved", "step_completed", etc.
    event: v.string(),
    // Arbitrary JSON payload. Whatever context makes the event self-describing.
    payload: v.any(),
    // Timestamp (ms since epoch). Indexed for time-range queries.
    timestamp: v.number(),
  })
    // "show me the whole audit trail for this hire, in order"
    .index("by_hire", ["hireId"])
    // Global activity feed across all hires.
    .index("by_time", ["timestamp"]),

  // ───────────────────────────────────────────────────────────
  // reflections — RESERVED for Phase 6 learning loop.
  //
  // After each hire completes, an LLM pass summarizes what worked / what
  // broke and writes a "lesson" here. Future runs retrieve relevant
  // reflections before the decide step. Not read by current code — the
  // table just exists so we don't have to migrate when Phase 6 starts.
  // ───────────────────────────────────────────────────────────
  reflections: defineTable({
    // Hire that generated this lesson.
    hireId: v.id("hires"),
    // Short tag(s) for retrieval: ["state:CA", "tool:checkr", "failure"].
    tags: v.array(v.string()),
    // The lesson itself — human-readable prose the next run can inject into the prompt.
    lesson: v.string(),
    // Embedding vector for similarity search (not populated yet).
    embedding: v.optional(v.array(v.number())),
    createdAt: v.number(),
  })
    .index("by_hire", ["hireId"])
    .index("by_tags", ["tags"]),
});
