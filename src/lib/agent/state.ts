// ────────────────────────────────────────────────────────────────
// LangGraph shared state — the typed object that flows between nodes.
//
// Every node receives this state, returns a partial update, and LangGraph
// merges the updates according to the per-field reducer we declare here.
//
// Why this design matters for the "agent that learns": the checkpointer
// persists this object on every step, so a crash mid-hire can resume from
// the exact same state on restart. Phase 6's learning loop reads the same
// object's `completedSteps` to know what happened.
// ────────────────────────────────────────────────────────────────

import { Annotation } from "@langchain/langgraph";
import type { ChatMessage } from "./llm";

// ────────────────────────────────────────────────────────────────
// StepRecord — a compact representation of one completed tool call.
// Stored in state so the decide-node can reason over what's already done.
// (The full record in Convex is richer — this is the agent's working memory.)
// ────────────────────────────────────────────────────────────────
export interface StepRecord {
  // Dot-notation tool key, e.g. "docusign.send_offer".
  tool: string;
  // Action input, preserved for debugging + learning-loop lookups.
  input: unknown;
  // Action output, if the call succeeded.
  output?: unknown;
  // Failure detail, if it didn't.
  error?: { code: string; message: string; retryable: boolean };
  // Whether this step is complete from the agent's POV.
  status: "completed" | "failed" | "escalated";
  // Wall-clock time for observability.
  at: number;
}

// ────────────────────────────────────────────────────────────────
// OnboardingState — the full graph state.
//
// The `Annotation.Root` builder lets us declare per-field reducers:
//   - default:  a factory that produces the initial value
//   - reducer:  how updates from nodes are combined with current state
//
// Without a reducer, every node write *replaces* the field. With one, we
// can append (e.g. completedSteps) or accumulate (e.g. messages).
// ────────────────────────────────────────────────────────────────
export const OnboardingState = Annotation.Root({
  // Primary key — the Convex `hires` id. Doesn't change during a run.
  hireId: Annotation<string>,

  // Snapshot of the hire record. Set once at start, treated as read-only.
  hire: Annotation<{
    name: string;
    email: string;
    role: string;
    state: string;
    startDate: string;
    // Annual base salary in whole USD.
    salary: number;
    address: {
      street1: string;
      street2?: string;
      city: string;
      state: string;
      zip: string;
    };
  }>,

  // Running LLM conversation — we keep the full turn history so the decide
  // node can reason over prior tool calls. Append-only.
  messages: Annotation<ChatMessage[]>({
    // Start empty.
    default: () => [],
    // When a node returns `{ messages: [...] }`, append rather than replace.
    reducer: (prev, next) => [...prev, ...next],
  }),

  // Accumulated record of steps the agent has taken so far.
  completedSteps: Annotation<StepRecord[]>({
    default: () => [],
    reducer: (prev, next) => [...prev, ...next],
  }),

  // Per-tool retry counter keyed by tool dot-name. Lets us cap retries so
  // the agent escalates instead of looping forever.
  retryCounts: Annotation<Record<string, number>>({
    default: () => ({}),
    // Merge by spreading — new counts overwrite old ones per key.
    reducer: (prev, next) => ({ ...prev, ...next }),
  }),

  // When the agent decides it's blocked, it fills this with an exception
  // payload. The escalate node picks it up and writes to Convex.
  pendingException: Annotation<
    | {
        reason: string;
        details: string;
        severity: "low" | "medium" | "high";
        suggestedAction?: string;
        stepId?: string;
      }
    | null
  >({
    default: () => null,
    // Plain replace — only one exception at a time.
    reducer: (_prev, next) => next,
  }),

  // Terminal flag — set by finish/escalate nodes so the graph exits cleanly.
  done: Annotation<boolean>({
    default: () => false,
    reducer: (_prev, next) => next,
  }),

  // Turn counter — bumped by each node that writes a narrated thought.
  // Used as a monotonic sort key in the UI stream so the operator sees
  // thoughts in the exact order they happened, not reordered by ts.
  // Reducer replaces — each node returns the next value explicitly.
  turnCount: Annotation<number>({
    default: () => 0,
    reducer: (_prev, next) => next,
  }),
});

// Type alias for the inferred state shape — used by node signatures.
export type OnboardingStateType = typeof OnboardingState.State;

// The update type — what a node is allowed to return.
export type OnboardingStateUpdate = typeof OnboardingState.Update;
