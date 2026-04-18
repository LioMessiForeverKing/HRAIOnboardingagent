// ────────────────────────────────────────────────────────────────
// Convex functions for the `hires` table.
//
// Split:
//   - `mutation` / `query` are public (called from client, the UI form, etc.)
//   - `internalMutation` is private (only the orchestrator action calls it)
//
// The guideline is strict: anything that only the agent needs must NOT be
// exposed to the public API surface.
// ────────────────────────────────────────────────────────────────

import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// ────────────────────────────────────────────────────────────────
// createHire — public mutation. Called from the "New Hire" form.
// Starts a workflow; the orchestrator picks it up immediately afterward.
// ────────────────────────────────────────────────────────────────
export const createHire = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    role: v.string(),
    state: v.string(),
    address: v.object({
      street1: v.string(),
      street2: v.optional(v.string()),
      city: v.string(),
      state: v.string(),
      zip: v.string(),
    }),
    salary: v.number(),
    startDate: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Insert the hire in "pending" state. The orchestrator flips it to
    // "in_progress" on first tick.
    const hireId = await ctx.db.insert("hires", {
      name: args.name,
      email: args.email,
      role: args.role,
      state: args.state,
      address: args.address,
      salary: args.salary,
      startDate: args.startDate,
      status: "pending",
      currentStep: undefined,
      createdAt: now,
      updatedAt: now,
    });

    // Inline audit — same transaction as the insert so either both land
    // or neither does.
    await ctx.db.insert("audit_log", {
      hireId,
      actor: "system",
      event: "hire_created",
      payload: { name: args.name, email: args.email, role: args.role, state: args.state },
      timestamp: now,
    });

    return hireId;
  },
});

// ────────────────────────────────────────────────────────────────
// updateHireStatus — INTERNAL. Only the orchestrator calls this.
// Keeping it private prevents a malicious client from forcing a hire to
// "completed" without going through the agent.
// ────────────────────────────────────────────────────────────────
export const updateHireStatus = internalMutation({
  args: {
    hireId: v.id("hires"),
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("awaiting_human"),
      v.literal("completed"),
      v.literal("failed")
    ),
    currentStep: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.hireId, {
      status: args.status,
      currentStep: args.currentStep,
      updatedAt: Date.now(),
    });

    await ctx.db.insert("audit_log", {
      hireId: args.hireId,
      actor: "agent",
      event: "hire_status_changed",
      payload: { status: args.status, currentStep: args.currentStep },
      timestamp: Date.now(),
    });
  },
});

// ────────────────────────────────────────────────────────────────
// listHires — public query. Used by the dashboard home page.
//
// `.take(100)` instead of `.collect()` — the Convex guidelines explicitly
// warn against unbounded collects. A real operator won't need more than
// the latest 100 hires on the main dashboard; pagination later.
// ────────────────────────────────────────────────────────────────
export const listHires = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("hires").order("desc").take(100);
  },
});

// ────────────────────────────────────────────────────────────────
// listHiresByStatus — useful for filtered dashboard views
// (e.g. "show only awaiting_human").
// ────────────────────────────────────────────────────────────────
export const listHiresByStatus = query({
  args: {
    status: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("awaiting_human"),
      v.literal("completed"),
      v.literal("failed")
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("hires")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(100);
  },
});

// ────────────────────────────────────────────────────────────────
// getHire — single hire by id. Hire detail page uses this.
// ────────────────────────────────────────────────────────────────
export const getHire = query({
  args: { hireId: v.id("hires") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.hireId);
  },
});
