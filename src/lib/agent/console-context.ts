// ────────────────────────────────────────────────────────────────
// console-context — an in-memory ConvexContext for local CLI demos.
//
// Why it exists: the real Convex context requires `npx convex dev` to be
// running so the Convex client has a deployment URL. For a demo run
// (`npm run run-hire`) we don't want that dependency — we just want to
// watch the agent drive the graph end-to-end from the terminal.
//
// This implementation logs every lifecycle event to stdout and keeps
// the data in memory. Swap back to the real Convex context for production.
// ────────────────────────────────────────────────────────────────

import type { ConvexContext } from "./graph";

// ────────────────────────────────────────────────────────────────
// Lightweight ANSI helpers — keeps the terminal output readable without
// pulling in `chalk` as a dep.
// ────────────────────────────────────────────────────────────────
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

// ────────────────────────────────────────────────────────────────
// makeConsoleContext — returns a ConvexContext + the in-memory record
// of everything that happened during the run (useful for assertions
// or printing a summary at the end).
// ────────────────────────────────────────────────────────────────
export function makeConsoleContext(): ConvexContext & {
  // Debug accessor — inspect all events after a run.
  getTranscript(): ConsoleEvent[];
} {
  // Running log of everything that happened — exposed via getTranscript().
  const transcript: ConsoleEvent[] = [];

  // Monotonic counter for fake step ids.
  let stepSeq = 0;

  // Helper to push an event + print a formatted line.
  function log(event: ConsoleEvent) {
    transcript.push(event);
    console.log(format(event));
  }

  return {
    async createStep(args) {
      const stepId = `step_${++stepSeq}`;
      log({
        kind: "step_created",
        stepId,
        tool: args.tool,
        action: args.action,
        input: args.input,
      });
      return stepId;
    },

    async markStepRunning(args) {
      log({ kind: "step_running", stepId: args.stepId });
    },

    async completeStep(args) {
      log({ kind: "step_completed", stepId: args.stepId, output: args.output });
    },

    async failStep(args) {
      log({
        kind: "step_failed",
        stepId: args.stepId,
        escalate: args.escalate ?? false,
        error: args.error,
      });
    },

    async raiseException(args) {
      const exceptionId = `exc_${Date.now()}`;
      log({
        kind: "exception_raised",
        exceptionId,
        hireId: args.hireId,
        reason: args.reason,
        severity: args.severity,
        details: args.details,
      });
      return exceptionId;
    },

    async updateHireStatus(args) {
      log({
        kind: "hire_status",
        hireId: args.hireId,
        status: args.status,
        currentStep: args.currentStep,
      });
    },

    getTranscript() {
      return transcript;
    },
  };
}

// Discriminated union of everything we log. Each variant has just what
// makes sense to print, plus a `kind` tag for the formatter.
export type ConsoleEvent =
  | { kind: "step_created"; stepId: string; tool: string; action: string; input: unknown }
  | { kind: "step_running"; stepId: string }
  | { kind: "step_completed"; stepId: string; output: unknown }
  | { kind: "step_failed"; stepId: string; escalate: boolean; error: unknown }
  | {
      kind: "exception_raised";
      exceptionId: string;
      hireId: string;
      reason: string;
      severity: string;
      details: string;
    }
  | {
      kind: "hire_status";
      hireId: string;
      status: string;
      currentStep?: string;
    };

// ────────────────────────────────────────────────────────────────
// Format helper — produces a single colored line per event.
// ────────────────────────────────────────────────────────────────
function format(event: ConsoleEvent): string {
  switch (event.kind) {
    case "step_created":
      return `${c.dim("▸")} ${c.cyan(`${event.tool}.${event.action}`)} ${c.dim(`(${event.stepId})`)}`;
    case "step_running":
      return `${c.dim("  ⟳ running…")}`;
    case "step_completed":
      return `${c.green("  ✓ completed")} ${c.dim(JSON.stringify(event.output).slice(0, 140))}`;
    case "step_failed":
      return event.escalate
        ? `${c.red("  ✗ failed (escalating)")} ${c.dim(JSON.stringify(event.error).slice(0, 140))}`
        : `${c.yellow("  ⚠ failed (will retry)")} ${c.dim(JSON.stringify(event.error).slice(0, 140))}`;
    case "exception_raised":
      return `${c.red("!!!")} ${c.bold(`EXCEPTION RAISED`)} ${c.red(event.reason)} ${c.dim(`(${event.severity})`)}\n    ${event.details}`;
    case "hire_status":
      return `${c.dim("·")} ${c.bold("hire")} ${event.hireId} → ${c.cyan(event.status)}${event.currentStep ? c.dim(` (step: ${event.currentStep})`) : ""}`;
  }
}
