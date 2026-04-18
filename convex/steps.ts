// ────────────────────────────────────────────────────────────────
// Convex functions for the `steps` table.
//
// All step *writes* are internal — only the orchestrator should ever
// create/advance/complete a step row. The public surface is read-only.
// ────────────────────────────────────────────────────────────────

import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

const toolValidator = v.union(
  v.literal("docusign"),
  v.literal("checkr"),
  v.literal("gusto"),
  v.literal("shippo"),
  v.literal("kandji")
);

// ────────────────────────────────────────────────────────────────
// createStep — agent is about to start a tool call.
// Internal only: the LLM should never decide to create a step directly;
// it produces a tool call and the graph's execute node persists it.
// ────────────────────────────────────────────────────────────────
export const createStep = internalMutation({
  args: {
    hireId: v.id("hires"),
    tool: toolValidator,
    action: v.string(),
    input: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const stepId = await ctx.db.insert("steps", {
      hireId: args.hireId,
      tool: args.tool,
      action: args.action,
      status: "queued",
      input: args.input,
      attemptCount: 0,
      createdAt: now,
    });

    await ctx.db.insert("audit_log", {
      hireId: args.hireId,
      actor: "agent",
      event: "step_queued",
      payload: { stepId, tool: args.tool, action: args.action },
      timestamp: now,
    });

    return stepId;
  },
});

// ────────────────────────────────────────────────────────────────
// markStepRunning — queued → running. Internal.
// ────────────────────────────────────────────────────────────────
export const markStepRunning = internalMutation({
  args: { stepId: v.id("steps") },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step) throw new Error(`step ${args.stepId} not found`);

    await ctx.db.patch(args.stepId, {
      status: "running",
      startedAt: Date.now(),
      attemptCount: step.attemptCount + 1,
    });

    await ctx.db.insert("audit_log", {
      hireId: step.hireId,
      actor: "agent",
      event: "step_started",
      payload: { stepId: args.stepId, attempt: step.attemptCount + 1 },
      timestamp: Date.now(),
    });
  },
});

// ────────────────────────────────────────────────────────────────
// completeStep — success. Internal.
// ────────────────────────────────────────────────────────────────
export const completeStep = internalMutation({
  args: {
    stepId: v.id("steps"),
    output: v.any(),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step) throw new Error(`step ${args.stepId} not found`);

    const now = Date.now();

    await ctx.db.patch(args.stepId, {
      status: "completed",
      output: args.output,
      completedAt: now,
    });

    await ctx.db.insert("audit_log", {
      hireId: step.hireId,
      actor: "agent",
      event: "step_completed",
      payload: { stepId: args.stepId, tool: step.tool, action: step.action },
      timestamp: now,
    });
  },
});

// ────────────────────────────────────────────────────────────────
// failStep — terminal fail for this attempt. Internal.
// `escalate: true` marks the step as "escalated" so the UI can highlight it.
// ────────────────────────────────────────────────────────────────
export const failStep = internalMutation({
  args: {
    stepId: v.id("steps"),
    error: v.any(),
    escalate: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const step = await ctx.db.get(args.stepId);
    if (!step) throw new Error(`step ${args.stepId} not found`);

    const now = Date.now();
    const finalStatus = args.escalate ? "escalated" : "failed";

    await ctx.db.patch(args.stepId, {
      status: finalStatus,
      output: { error: args.error },
      completedAt: now,
    });

    await ctx.db.insert("audit_log", {
      hireId: step.hireId,
      actor: "agent",
      event: args.escalate ? "step_escalated" : "step_failed",
      payload: { stepId: args.stepId, tool: step.tool, error: args.error },
      timestamp: now,
    });
  },
});

// ────────────────────────────────────────────────────────────────
// listStepsForHire — public read. Hire detail page uses this.
//
// Chronological order — reading the step list top-down shows the
// workflow timeline. Bounded: a single hire has at most ~15 steps
// including retries, so `.take(200)` is overkill-safe.
// ────────────────────────────────────────────────────────────────
export const listStepsForHire = query({
  args: { hireId: v.id("hires") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("steps")
      .withIndex("by_hire", (q) => q.eq("hireId", args.hireId))
      .order("asc")
      .take(200);
  },
});
