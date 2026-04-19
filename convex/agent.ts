// ────────────────────────────────────────────────────────────────
// Convex action — runs the LangGraph orchestrator for a single hire.
//
// Why an action (not a mutation): this calls the OpenAI API and the
// integration mocks, both of which are external I/O. Convex mutations
// are transactional and must be deterministic — only actions can make
// external calls.
//
// `"use node";` directive — required because LangGraph + @langchain/core
// pull in Node built-ins that aren't available in the default Convex
// V8 runtime. See `convex/_generated/ai/guidelines.md`.
// ────────────────────────────────────────────────────────────────

"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Local imports from the agent library. The library is framework-agnostic
// — it doesn't know it's running inside Convex.
import { buildGraph, type ConvexContext } from "../src/lib/agent/graph";

// ────────────────────────────────────────────────────────────────
// runOnboarding
//
// Takes a hireId and drives the full orchestration. Returns a status
// summary. The dashboard subscribes to the `hires` / `steps` tables and
// renders updates in real time while this action runs — the caller
// doesn't need to poll the action itself.
//
// Typical invocation:
//   1. User submits "New Hire" form → `api.hires.createHire` mutation returns a hireId
//   2. Client calls `api.agent.runOnboarding({ hireId })` to kick off
//   3. Dashboard live-queries `api.hires.listHires` + `api.steps.listStepsForHire`
// ────────────────────────────────────────────────────────────────
export const runOnboarding = action({
  args: {
    hireId: v.id("hires"),
  },
  handler: async (ctx, args) => {
    // Step 1: fetch the hire record we'll pass into the graph.
    // Actions can't use `ctx.db` directly — we go through a query.
    const hire = await ctx.runQuery(api.hires.getHire, { hireId: args.hireId });
    if (!hire) {
      throw new Error(`Hire ${args.hireId} not found`);
    }

    // Step 2: build a ConvexContext adapter. The graph library takes
    // a shape of plain async functions; here we wire each one to the
    // matching internal mutation via `ctx.runMutation`.
    const convexContext: ConvexContext = {
      createStep: async (input) => {
        const stepId = await ctx.runMutation(internal.steps.createStep, {
          hireId: input.hireId as Id<"hires">,
          tool: input.tool,
          action: input.action,
          input: input.input,
        });
        return stepId as string;
      },
      markStepRunning: async ({ stepId }) => {
        await ctx.runMutation(internal.steps.markStepRunning, {
          stepId: stepId as Id<"steps">,
        });
      },
      completeStep: async ({ stepId, output }) => {
        await ctx.runMutation(internal.steps.completeStep, {
          stepId: stepId as Id<"steps">,
          output,
        });
      },
      failStep: async ({ stepId, error, escalate }) => {
        await ctx.runMutation(internal.steps.failStep, {
          stepId: stepId as Id<"steps">,
          error,
          escalate,
        });
      },
      raiseException: async (input) => {
        const exceptionId = await ctx.runMutation(internal.exceptions.raiseException, {
          hireId: input.hireId as Id<"hires">,
          stepId: input.stepId as Id<"steps"> | undefined,
          reason: input.reason,
          details: input.details,
          suggestedAction: input.suggestedAction,
          severity: input.severity,
        });
        return exceptionId as string;
      },
      updateHireStatus: async ({ hireId, status, currentStep }) => {
        await ctx.runMutation(internal.hires.updateHireStatus, {
          hireId: hireId as Id<"hires">,
          status,
          currentStep,
        });
      },
      writeThought: async (input) => {
        await ctx.runMutation(internal.thoughts.writeThought, {
          hireId: input.hireId as Id<"hires">,
          turn: input.turn,
          phase: input.phase,
          summary: input.summary,
          detail: input.detail,
          tool: input.tool,
          toolArgs: input.toolArgs,
          toolOutput: input.toolOutput,
          stepId: input.stepId as Id<"steps"> | undefined,
        });
      },
    };

    // Step 3: build the graph and run it. The MemorySaver checkpointer
    // lives for the duration of this action call — plenty for a single
    // orchestration. (A persistent checkpointer is future work.)
    //
    // Forward the hire's scenario tag (if any) so every mock pins to the
    // matching deterministic outcome. No tag = probabilistic mocks.
    const graph = buildGraph(convexContext, { scenario: hire.scenario ?? null });

    // Shape the initial state to match what the graph expects.
    const initialState = {
      hireId: args.hireId as string,
      hire: {
        name: hire.name,
        email: hire.email,
        role: hire.role,
        state: hire.state,
        startDate: hire.startDate,
        salary: hire.salary,
        address: hire.address,
      },
    };

    const final = await graph.invoke(initialState, {
      configurable: { thread_id: args.hireId as string },
      // Long enough for the full dependency chain + polling retries.
      recursionLimit: 80,
    });

    // Return a compact summary — the heavy data is already in the DB
    // and visible on the dashboard via live queries.
    return {
      done: final.done,
      completedStepCount: final.completedSteps.length,
      exception: final.pendingException,
    };
  },
});
