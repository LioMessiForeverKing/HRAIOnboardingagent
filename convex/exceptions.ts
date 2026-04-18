// ────────────────────────────────────────────────────────────────
// Convex functions for the `exceptions` table.
//
// Split:
//   - raiseException   → internal (agent-only)
//   - resolveException → public (operator action from the UI)
//   - queries           → public (dashboard + detail pages)
// ────────────────────────────────────────────────────────────────

import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

const severityValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high")
);

// ────────────────────────────────────────────────────────────────
// raiseException — internal. Only the agent raises exceptions.
// Flips the parent hire to "awaiting_human" in the same transaction.
// ────────────────────────────────────────────────────────────────
export const raiseException = internalMutation({
  args: {
    hireId: v.id("hires"),
    stepId: v.optional(v.id("steps")),
    reason: v.string(),
    details: v.string(),
    suggestedAction: v.optional(v.string()),
    severity: severityValidator,
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const exceptionId = await ctx.db.insert("exceptions", {
      hireId: args.hireId,
      stepId: args.stepId,
      reason: args.reason,
      details: args.details,
      suggestedAction: args.suggestedAction,
      severity: args.severity,
      resolution: "open",
      createdAt: now,
    });

    // Flip hire status in the same transaction.
    await ctx.db.patch(args.hireId, {
      status: "awaiting_human",
      updatedAt: now,
    });

    await ctx.db.insert("audit_log", {
      hireId: args.hireId,
      actor: "agent",
      event: "exception_raised",
      payload: {
        exceptionId,
        reason: args.reason,
        severity: args.severity,
        suggestedAction: args.suggestedAction,
      },
      timestamp: now,
    });

    return exceptionId;
  },
});

// ────────────────────────────────────────────────────────────────
// resolveException — public. Operator clicks resolve/dismiss in the UI.
//
// Guidelines: don't use `.collect().length` to count. To decide whether
// to unblock the hire, use `.take(1)` on remaining-open exceptions —
// that's enough to know whether "any" still exist.
// ────────────────────────────────────────────────────────────────
export const resolveException = mutation({
  args: {
    exceptionId: v.id("exceptions"),
    resolution: v.union(v.literal("resolved"), v.literal("dismissed")),
    resolvedBy: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const exception = await ctx.db.get(args.exceptionId);
    if (!exception) throw new Error(`exception ${args.exceptionId} not found`);

    const now = Date.now();

    // Mark the exception resolved.
    await ctx.db.patch(args.exceptionId, {
      resolution: args.resolution,
      resolvedBy: args.resolvedBy,
      resolvedAt: now,
    });

    // Check if any OTHER open exceptions remain for this hire. `.take(1)`
    // is enough — we only need the first one to know we should stay blocked.
    const remainingOpen = await ctx.db
      .query("exceptions")
      .withIndex("by_hire", (q) => q.eq("hireId", exception.hireId))
      // Note: we must re-check the one we just resolved because the query
      // runs after the patch in the same transaction.
      .filter((q) => q.eq(q.field("resolution"), "open"))
      .take(1);

    if (remainingOpen.length === 0) {
      await ctx.db.patch(exception.hireId, {
        status: "in_progress",
        updatedAt: now,
      });
    }

    await ctx.db.insert("audit_log", {
      hireId: exception.hireId,
      actor: `operator:${args.resolvedBy}`,
      event: "exception_resolved",
      payload: {
        exceptionId: args.exceptionId,
        resolution: args.resolution,
        notes: args.notes,
      },
      timestamp: now,
    });
  },
});

// ────────────────────────────────────────────────────────────────
// listOpenExceptions — operator inbox query.
// Bounded at 100 — if there are more than 100 open, we have bigger problems.
// ────────────────────────────────────────────────────────────────
export const listOpenExceptions = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("exceptions")
      .withIndex("by_resolution", (q) => q.eq("resolution", "open"))
      .order("desc")
      .take(100);
  },
});

// ────────────────────────────────────────────────────────────────
// listExceptionsForHire — hire detail page.
// ────────────────────────────────────────────────────────────────
export const listExceptionsForHire = query({
  args: { hireId: v.id("hires") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("exceptions")
      .withIndex("by_hire", (q) => q.eq("hireId", args.hireId))
      .order("desc")
      .take(100);
  },
});
