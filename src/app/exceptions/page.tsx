// ────────────────────────────────────────────────────────────────
// Exceptions queue — the operator's inbox.
//
// Every exception that the agent can't handle lands here. Operator
// approves / dismisses with a single click; the hire auto-unblocks when
// all its open exceptions are resolved (see `resolveException`).
// ────────────────────────────────────────────────────────────────

"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { useState } from "react";

export default function ExceptionsPage() {
  // Live query: all open exceptions, newest first.
  const exceptions = useQuery(api.exceptions.listOpenExceptions);

  // The resolve mutation — we'll pass the current operator's identifier
  // from a tiny local-state field (pseudo-auth until we wire Clerk/Auth.js).
  const resolve = useMutation(api.exceptions.resolveException);

  // Operator identifier input. In production this comes from auth context.
  const [operator, setOperator] = useState("operator@company.test");

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Exception queue</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Items the agent couldn't resolve on its own. Approve or dismiss to
          unblock the hire.
        </p>
      </header>

      {/* Operator identifier — required before any resolve action. */}
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
        <label className="text-zinc-500">Resolving as:</label>
        <input
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          className="flex-1 bg-transparent font-mono text-xs outline-none"
          placeholder="your-email@company.com"
        />
      </div>

      {/* Loading + empty states. */}
      {exceptions === undefined && (
        <p className="text-sm text-zinc-500">Loading…</p>
      )}
      {exceptions && exceptions.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No open exceptions. Everything is humming along. 🌿
        </div>
      )}

      {/* Exception cards. */}
      {exceptions && exceptions.length > 0 && (
        <ul className="space-y-3">
          {exceptions.map((exc) => (
            <ExceptionCard
              key={exc._id}
              exception={exc}
              onResolve={async (resolution) => {
                await resolve({
                  exceptionId: exc._id,
                  resolution,
                  resolvedBy: operator,
                });
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExceptionCard({
  exception,
  onResolve,
}: {
  exception: Doc<"exceptions">;
  onResolve: (resolution: "resolved" | "dismissed") => Promise<void>;
}) {
  // Track in-flight state so operators don't double-click while we await.
  const [pending, setPending] = useState<"resolved" | "dismissed" | null>(null);

  // Severity → color tint. Keep the queue scannable at a glance.
  const borderTint =
    exception.severity === "high"
      ? "border-red-300 dark:border-red-900"
      : exception.severity === "medium"
        ? "border-amber-300 dark:border-amber-900"
        : "border-zinc-200 dark:border-zinc-800";

  const severityBadge =
    exception.severity === "high"
      ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
      : exception.severity === "medium"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
        : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

  async function handle(resolution: "resolved" | "dismissed") {
    // Prevent double-submit.
    if (pending) return;
    setPending(resolution);
    try {
      await onResolve(resolution);
    } finally {
      setPending(null);
    }
  }

  return (
    <li
      className={`rounded-lg border ${borderTint} bg-white p-4 dark:bg-zinc-950`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${severityBadge}`}>
              {exception.severity}
            </span>
            <span className="font-mono text-sm text-black dark:text-zinc-50">
              {exception.reason}
            </span>
          </div>
          <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
            {exception.details}
          </p>
          {exception.suggestedAction && (
            <p className="mt-2 text-xs italic text-zinc-500">
              Suggested: {exception.suggestedAction}
            </p>
          )}
          <Link
            href={`/hires/${exception.hireId}`}
            className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Open hire →
          </Link>
        </div>

        {/* Resolve / dismiss buttons. Both call the same mutation with
            different `resolution` values. */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!!pending}
            onClick={() => handle("resolved")}
            className="rounded-md bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-200"
          >
            {pending === "resolved" ? "Resolving…" : "Resolve"}
          </button>
          <button
            type="button"
            disabled={!!pending}
            onClick={() => handle("dismissed")}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            {pending === "dismissed" ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      </div>
    </li>
  );
}
