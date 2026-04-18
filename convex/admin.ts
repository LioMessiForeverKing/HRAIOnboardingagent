// ────────────────────────────────────────────────────────────────
// Admin utilities — dev-only helpers.
//
// WARNING: these are destructive and public. They're convenient for
// resetting the dev deployment, but before going to production you
// should either delete this file or convert them to internalMutations.
// ────────────────────────────────────────────────────────────────

import { mutation } from "./_generated/server";
import { v } from "convex/values";

// All user-data tables the app writes to. We clear each one in the
// same order they'd appear in the schema — not that order matters, but
// it's easier to scan. Do NOT include system tables (`_storage`, etc).
const TABLES = [
  "hires",
  "steps",
  "exceptions",
  "audit_log",
  "reflections",
] as const;

// ────────────────────────────────────────────────────────────────
// clearAll — wipe every row from every app table.
//
// Implementation detail: Convex queries don't support `.delete()`, so
// we read a batch of ids with `.take(n)` and loop `ctx.db.delete(id)`.
// If the table has more rows than fit in one mutation's transaction
// limit, Convex will throw — at that point, re-run the command or split
// per-table. For dev volumes (tens of rows) this single call is plenty.
// ────────────────────────────────────────────────────────────────
export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    // Track counts per table for the return value — handy for the CLI
    // so you can see "deleted 7 hires, 14 steps, 0 exceptions, …".
    const deleted: Record<string, number> = {};

    for (const table of TABLES) {
      // `.take(10000)` is the convention from the Convex guidelines — use
      // an explicit bound rather than `.collect()`. If a real dev env
      // ever has >10k rows in one of these tables, we've got bigger issues.
      const rows = await ctx.db.query(table).take(10_000);
      for (const row of rows) {
        await ctx.db.delete(row._id);
      }
      deleted[table] = rows.length;
    }

    return deleted;
  },
});

// ────────────────────────────────────────────────────────────────
// clearTable — same idea but scoped to a single table. Useful when
// you want to wipe hires but keep the audit log for forensics.
// ────────────────────────────────────────────────────────────────
export const clearTable = mutation({
  args: {
    table: v.union(
      v.literal("hires"),
      v.literal("steps"),
      v.literal("exceptions"),
      v.literal("audit_log"),
      v.literal("reflections"),
    ),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query(args.table).take(10_000);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { table: args.table, deleted: rows.length };
  },
});
