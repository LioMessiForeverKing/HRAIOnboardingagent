// ────────────────────────────────────────────────────────────────
// Convex functions for the `audit_log` table.
// Append-only. Writes come from *other* mutations (inline), so the only
// public function here is `logEvent` for system-level events that don't
// belong to any other mutation.
// ────────────────────────────────────────────────────────────────

import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

// ────────────────────────────────────────────────────────────────
// logEvent — internal. Used by the orchestrator for events that don't
// fit inside a hire/step/exception mutation (e.g. graph startup/shutdown).
// ────────────────────────────────────────────────────────────────
export const logEvent = internalMutation({
  args: {
    hireId: v.optional(v.id("hires")),
    actor: v.string(),
    event: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("audit_log", {
      hireId: args.hireId,
      actor: args.actor,
      event: args.event,
      payload: args.payload,
      timestamp: Date.now(),
    });
  },
});

// ────────────────────────────────────────────────────────────────
// listAuditForHire — compliance timeline for one hire.
// ────────────────────────────────────────────────────────────────
export const listAuditForHire = query({
  args: { hireId: v.id("hires") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("audit_log")
      .withIndex("by_hire", (q) => q.eq("hireId", args.hireId))
      .order("asc")
      .take(500);
  },
});

// ────────────────────────────────────────────────────────────────
// recentActivity — global live feed for the dashboard.
// ────────────────────────────────────────────────────────────────
export const recentActivity = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 50, 500);
    return await ctx.db
      .query("audit_log")
      .withIndex("by_time")
      .order("desc")
      .take(limit);
  },
});
