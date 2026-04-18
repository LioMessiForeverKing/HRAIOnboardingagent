// ────────────────────────────────────────────────────────────────
// Hire detail page — live timeline of steps + audit log for a single hire.
//
// Why this page is the "wow": as the orchestrator runs, steps pop in and
// flip from queued → running → completed in real time without any
// page refreshes — that's Convex live queries doing their thing.
// ────────────────────────────────────────────────────────────────

"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";

// Next.js 16: dynamic route params arrive as a Promise that must be
// unwrapped with `React.use()` in a client component.
type Params = Promise<{ id: string }>;

export default function HireDetailPage({ params }: { params: Params }) {
  const { id } = use(params);
  const hireId = id as Id<"hires">;

  // Three live queries — each one independently subscribes and re-renders
  // when its target rows change.
  const hire = useQuery(api.hires.getHire, { hireId });
  const steps = useQuery(api.steps.listStepsForHire, { hireId });
  const exceptions = useQuery(api.exceptions.listExceptionsForHire, { hireId });
  const auditLog = useQuery(api.audit.listAuditForHire, { hireId });

  // Loading skeleton — while any of the queries are still settling.
  if (hire === undefined) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10 text-sm text-zinc-500">Loading…</div>
    );
  }

  // Not-found state — hire id was valid shape but no document exists.
  if (hire === null) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <p className="text-sm text-zinc-500">Hire not found.</p>
        <Link href="/" className="text-sm underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {/* Breadcrumb back to the dashboard. */}
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-black dark:hover:text-zinc-50"
      >
        ← Dashboard
      </Link>

      {/* Header — hire identity + status + meta. */}
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">{hire.name}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-500">
          <span>{hire.role}</span>
          <span>·</span>
          <span>{hire.state}</span>
          <span>·</span>
          <span>Start: {hire.startDate}</span>
          <span>·</span>
          <span>
            <HireStatusLabel status={hire.status} />
          </span>
        </div>
      </header>

      {/* Open exceptions — surfaced at the top when present. */}
      {exceptions && exceptions.filter((e) => e.resolution === "open").length > 0 && (
        <section className="mb-8 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
          <h2 className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-300">
            Needs attention
          </h2>
          <ul className="space-y-2">
            {exceptions
              .filter((e) => e.resolution === "open")
              .map((exc) => (
                <li key={exc._id} className="text-sm">
                  <span className="font-mono text-amber-900 dark:text-amber-300">
                    {exc.reason}
                  </span>
                  <span className="ml-2 text-amber-800 dark:text-amber-400/80">
                    {exc.details}
                  </span>
                  {exc.suggestedAction && (
                    <div className="mt-1 text-xs italic text-amber-700 dark:text-amber-500">
                      Suggested: {exc.suggestedAction}
                    </div>
                  )}
                </li>
              ))}
          </ul>
          <Link
            href="/exceptions"
            className="mt-2 inline-block text-xs font-medium text-amber-900 underline dark:text-amber-300"
          >
            Resolve in exception queue →
          </Link>
        </section>
      )}

      <div className="grid gap-8 md:grid-cols-3">
        {/* Step timeline — left 2/3. */}
        <section className="md:col-span-2">
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Step timeline
          </h2>
          {steps === undefined && (
            <div className="text-sm text-zinc-500">Loading…</div>
          )}
          {steps && steps.length === 0 && (
            <div className="rounded-md border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
              Waiting for the orchestrator to start.
            </div>
          )}
          {steps && steps.length > 0 && (
            <ol className="space-y-3">
              {steps.map((step) => (
                <StepRow key={step._id} step={step} />
              ))}
            </ol>
          )}
        </section>

        {/* Audit log — right 1/3. */}
        <aside>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Audit log
          </h2>
          {auditLog === undefined && (
            <div className="text-sm text-zinc-500">Loading…</div>
          )}
          {auditLog && auditLog.length === 0 && (
            <div className="text-sm text-zinc-500">No events yet.</div>
          )}
          {auditLog && auditLog.length > 0 && (
            <ul className="space-y-2 text-xs">
              {auditLog.map((e) => (
                <li
                  key={e._id}
                  className="rounded border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-black dark:text-zinc-50">
                      {e.event}
                    </span>
                    <span className="text-zinc-400">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-zinc-500">{e.actor}</div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

// Row rendering for a single step — pick a color + icon based on status.
function StepRow({ step }: { step: Doc<"steps"> }) {
  const symbol: Record<Doc<"steps">["status"], string> = {
    queued: "○",
    running: "◐",
    completed: "●",
    failed: "✗",
    escalated: "!",
  };
  const color: Record<Doc<"steps">["status"], string> = {
    queued: "text-zinc-400",
    running: "text-blue-500 animate-pulse",
    completed: "text-emerald-500",
    failed: "text-red-500",
    escalated: "text-amber-500",
  };

  // How long the step took, if it's done.
  const durationMs =
    step.completedAt && step.startedAt ? step.completedAt - step.startedAt : null;

  return (
    <li className="flex items-start gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <span className={`text-lg leading-none ${color[step.status]}`}>
        {symbol[step.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono font-medium">
            {step.tool}.{step.action}
          </span>
          {step.attemptCount > 1 && (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              attempt {step.attemptCount}
            </span>
          )}
          {durationMs !== null && (
            <span className="text-xs text-zinc-400">{durationMs}ms</span>
          )}
        </div>
        {step.output !== undefined && step.status === "completed" && (
          <pre className="mt-1 overflow-x-auto rounded bg-zinc-50 p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {JSON.stringify(step.output, null, 2)}
          </pre>
        )}
        {step.status === "failed" || step.status === "escalated" ? (
          <pre className="mt-1 overflow-x-auto rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {JSON.stringify(step.output, null, 2)}
          </pre>
        ) : null}
      </div>
    </li>
  );
}

// Visual label for hire status — reused from the dashboard but inlined
// for the detail page header where we want a slightly different look.
function HireStatusLabel({ status }: { status: Doc<"hires">["status"] }) {
  const palette: Record<Doc<"hires">["status"], string> = {
    pending: "text-zinc-500",
    in_progress: "text-blue-600 dark:text-blue-400",
    awaiting_human: "text-amber-600 dark:text-amber-400",
    completed: "text-emerald-600 dark:text-emerald-400",
    failed: "text-red-600 dark:text-red-400",
  };
  return <span className={`font-medium ${palette[status]}`}>{status.replace("_", " ")}</span>;
}
