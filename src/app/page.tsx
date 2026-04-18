// ────────────────────────────────────────────────────────────────
// Dashboard home — list of hires with live status.
//
// Every `useQuery` here subscribes to a Convex live query. When the
// orchestrator writes to the DB (e.g. flipping a hire from "in_progress"
// to "completed"), the query result updates and React re-renders —
// zero polling required.
// ────────────────────────────────────────────────────────────────

"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";

// ────────────────────────────────────────────────────────────────
// Small visual helpers reused across pages.
// ────────────────────────────────────────────────────────────────

// Map a hire status to a color badge. One source of truth for color use.
function StatusBadge({ status }: { status: Doc<"hires">["status"] }) {
  const classes: Record<Doc<"hires">["status"], string> = {
    pending: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    awaiting_human:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status]}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

// Relative time formatter — "3m ago", "2h ago". Avoids bringing in date-fns.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ────────────────────────────────────────────────────────────────
// Dashboard page component.
// ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  // Live-subscribed list of all hires, newest first.
  // `undefined` while loading; `[]` when empty; array of docs when ready.
  const hires = useQuery(api.hires.listHires);
  const openExceptions = useQuery(api.exceptions.listOpenExceptions);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {/* Stats row — counts update live as the agent works. */}
      <section className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Total hires"
          value={hires?.length ?? "—"}
        />
        <StatCard
          label="In progress"
          value={
            hires?.filter((h) => h.status === "in_progress").length ?? "—"
          }
        />
        <StatCard
          label="Awaiting human"
          value={
            hires?.filter((h) => h.status === "awaiting_human").length ?? "—"
          }
          accent={
            (hires?.filter((h) => h.status === "awaiting_human").length ?? 0) > 0
              ? "amber"
              : undefined
          }
        />
        <StatCard
          label="Open exceptions"
          value={openExceptions?.length ?? "—"}
          accent={(openExceptions?.length ?? 0) > 0 ? "red" : undefined}
        />
      </section>

      {/* Hires list. */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Hires
          </h2>
          <Link
            href="/new"
            className="text-sm font-medium text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            + New
          </Link>
        </div>

        {/* Loading state — Convex queries resolve to `undefined` until data arrives. */}
        {hires === undefined && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Loading…
          </div>
        )}

        {/* Empty state — prompts the user to create the first hire. */}
        {hires && hires.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No hires yet. Create one to see the agent in action.
            </p>
            <Link
              href="/new"
              className="mt-4 inline-block rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-black"
            >
              Start a hire
            </Link>
          </div>
        )}

        {/* Populated state. */}
        {hires && hires.length > 0 && (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {hires.map((hire) => (
              <li key={hire._id}>
                <Link
                  href={`/hires/${hire._id}`}
                  className="block px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-black dark:text-zinc-50">
                          {hire.name}
                        </span>
                        <StatusBadge status={hire.status} />
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500">
                        <span>{hire.role}</span>
                        <span>·</span>
                        <span>{hire.state}</span>
                        {hire.currentStep && (
                          <>
                            <span>·</span>
                            <span className="font-mono">
                              on: {hire.currentStep}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right text-xs text-zinc-400">
                      {relativeTime(hire.updatedAt)}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Reusable stat card. `accent` tints the number when there's something
// worth the operator's attention (open exceptions, human-blocked hires).
function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: "amber" | "red";
}) {
  // Map accent to a text color class.
  const accentClass =
    accent === "amber"
      ? "text-amber-600 dark:text-amber-400"
      : accent === "red"
        ? "text-red-600 dark:text-red-400"
        : "text-black dark:text-zinc-50";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${accentClass}`}>{value}</p>
    </div>
  );
}
