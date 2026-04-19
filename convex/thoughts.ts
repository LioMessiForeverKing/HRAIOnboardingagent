// ────────────────────────────────────────────────────────────────
// Convex functions for the `agent_thoughts` table.
//
// Thoughts are the human-readable narration of what the agent is doing
// right now — they're what makes the UI feel *agentic* rather than
// showing mute progress bars. Every decide/act/observe/retry/escalate
// turn in the graph appends one row here and the hire detail page
// subscribes via live query.
//
// Writes are internal-only: nobody except the orchestrator should ever
// be able to put words in the agent's mouth.
// ────────────────────────────────────────────────────────────────

import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

// Validator shared between the insert + read paths. Kept in lock-step
// with the `phase` union in schema.ts.
const phaseValidator = v.union(
  v.literal("plan"),
  v.literal("decide"),
  v.literal("act"),
  v.literal("observe"),
  v.literal("retry"),
  v.literal("escalate"),
  v.literal("done"),
);

// ────────────────────────────────────────────────────────────────
// writeThought — internal. Graph nodes call this through ConvexContext.
// One row per narrated moment; the UI orders by `turn` then `_creationTime`.
// ────────────────────────────────────────────────────────────────
export const writeThought = internalMutation({
  args: {
    hireId: v.id("hires"),
    turn: v.number(),
    phase: phaseValidator,
    summary: v.string(),
    detail: v.optional(v.string()),
    tool: v.optional(v.string()),
    toolArgs: v.optional(v.any()),
    toolOutput: v.optional(v.any()),
    stepId: v.optional(v.id("steps")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const thoughtId = await ctx.db.insert("agent_thoughts", {
      hireId: args.hireId,
      turn: args.turn,
      phase: args.phase,
      summary: args.summary,
      detail: args.detail,
      tool: args.tool,
      toolArgs: args.toolArgs,
      toolOutput: args.toolOutput,
      stepId: args.stepId,
      createdAt: now,
    });

    return thoughtId;
  },
});

// ────────────────────────────────────────────────────────────────
// listThoughtsForHire — public read. Hire detail page subscribes.
// Ordered by creation time ascending so the stream reads top-down.
// Bounded at 500 — a single hire shouldn't generate that many turns
// even with polling; if it does, we want the UI to truncate gracefully.
// ────────────────────────────────────────────────────────────────
export const listThoughtsForHire = query({
  args: { hireId: v.id("hires") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agent_thoughts")
      .withIndex("by_hire", (q) => q.eq("hireId", args.hireId))
      .order("asc")
      .take(500);
  },
});
