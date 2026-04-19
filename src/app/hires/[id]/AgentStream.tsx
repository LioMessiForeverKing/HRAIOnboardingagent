// ────────────────────────────────────────────────────────────────
// AgentStream — the live "agent is thinking" panel.
//
// Subscribes to the `agent_thoughts` live query for one hire and renders
// every turn as a chat-style bubble. As the graph writes new thoughts to
// Convex, new bubbles animate in at the bottom — that's the "agentic
// feel" the operator wants to see.
//
// Design choices:
//   - Left gutter icon encodes the phase (plan/decide/act/observe/retry/
//     escalate/done) so you can scan the stream without reading.
//   - `act` bubbles expand to show the JSON args the agent chose — this
//     is what makes the tool-call reasoning legible, not opaque.
//   - `observe` bubbles expand to show the tool's response preview.
//   - The latest bubble auto-scrolls into view so live updates stay
//     visible without the operator having to chase them.
// ────────────────────────────────────────────────────────────────

"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";

// Subset of the thought doc we actually render — widens as we add fields.
type Thought = Doc<"agent_thoughts">;

// ────────────────────────────────────────────────────────────────
// Per-phase visual config — single source of truth so a new phase is
// a one-row diff here.
// ────────────────────────────────────────────────────────────────
const PHASE_CONFIG: Record<
  Thought["phase"],
  {
    label: string;
    // Left-gutter glyph — kept to ASCII so it reads across fonts.
    symbol: string;
    // Tailwind color for the glyph.
    symbolColor: string;
    // Background tint for the bubble body.
    bubbleClass: string;
  }
> = {
  plan: {
    label: "plan",
    symbol: "◇",
    symbolColor: "text-zinc-500",
    bubbleClass: "bg-zinc-50 dark:bg-zinc-900",
  },
  decide: {
    label: "decide",
    symbol: "?",
    symbolColor: "text-zinc-500",
    bubbleClass: "bg-zinc-50 dark:bg-zinc-900",
  },
  act: {
    label: "act",
    symbol: "▶",
    symbolColor: "text-blue-500",
    bubbleClass: "bg-blue-50/70 dark:bg-blue-950/30",
  },
  observe: {
    label: "observe",
    symbol: "◉",
    symbolColor: "text-emerald-500",
    bubbleClass: "bg-emerald-50/70 dark:bg-emerald-950/30",
  },
  retry: {
    symbol: "↻",
    label: "retry",
    symbolColor: "text-amber-500",
    bubbleClass: "bg-amber-50/70 dark:bg-amber-950/30",
  },
  escalate: {
    label: "escalate",
    symbol: "!",
    symbolColor: "text-red-500",
    bubbleClass: "bg-red-50/70 dark:bg-red-950/30",
  },
  done: {
    label: "done",
    symbol: "✓",
    symbolColor: "text-emerald-600",
    bubbleClass: "bg-emerald-50/70 dark:bg-emerald-950/30",
  },
};

export function AgentStream({
  hireId,
  hireStatus,
}: {
  hireId: Id<"hires">;
  // Needed so we can show a "thinking…" ghost bubble when the agent is
  // between turns instead of an empty stream.
  hireStatus: Doc<"hires">["status"];
}) {
  const thoughts = useQuery(api.thoughts.listThoughtsForHire, { hireId });

  // Auto-scroll to the newest thought — only when a new one actually
  // appears, so the operator can still scroll up to read older ones
  // without being yanked back.
  const endRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(0);
  useEffect(() => {
    if (!thoughts) return;
    if (thoughts.length > prevCountRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      prevCountRef.current = thoughts.length;
    }
  }, [thoughts]);

  // While the agent is actively working but hasn't written a new thought
  // yet (e.g. waiting on OpenAI or a tool call), show a pulsing cursor
  // so the UI never looks dead.
  const isActive = hireStatus === "in_progress" || hireStatus === "pending";

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header — gives the panel a name the operator recognizes. */}
      <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {isActive && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"></span>
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                isActive ? "bg-blue-500" : "bg-zinc-400"
              }`}
            />
          </span>
          <h2 className="text-sm font-semibold">Agent</h2>
          <span className="text-xs text-zinc-500">
            {isActive ? "thinking…" : "idle"}
          </span>
        </div>
        <span className="text-xs text-zinc-400">
          {thoughts ? `${thoughts.length} turns` : "…"}
        </span>
      </header>

      {/* Body — the actual stream. */}
      <div className="max-h-[620px] overflow-y-auto px-4 py-3">
        {thoughts === undefined && (
          <p className="py-6 text-center text-sm text-zinc-500">
            Loading agent transcript…
          </p>
        )}

        {thoughts && thoughts.length === 0 && (
          <p className="py-6 text-center text-sm text-zinc-500">
            {isActive ? "Agent is warming up…" : "No thoughts recorded."}
          </p>
        )}

        {thoughts && thoughts.length > 0 && (
          <ol className="space-y-3">
            {thoughts.map((t) => (
              <ThoughtBubble key={t._id} thought={t} />
            ))}
          </ol>
        )}

        {/* Pulsing "writing…" ghost row that appears between real turns.
            Only shows while the hire is actively in flight AND we have at
            least one thought already — avoids a double-skeleton state. */}
        {isActive && thoughts && thoughts.length > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            <span className="animate-pulse">agent is thinking…</span>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// ThoughtBubble — one row in the stream. Phase drives icon + color.
// ────────────────────────────────────────────────────────────────
function ThoughtBubble({ thought }: { thought: Thought }) {
  const cfg = PHASE_CONFIG[thought.phase];

  // Expand the details on click for act/observe/retry/escalate so the
  // default view stays scannable but the raw JSON is one click away.
  const [expanded, setExpanded] = useState(false);
  const hasJson =
    thought.toolArgs !== undefined || thought.toolOutput !== undefined;

  return (
    <li
      className={`relative flex gap-3 rounded-md border border-transparent p-3 ${cfg.bubbleClass}`}
    >
      {/* Left gutter: phase glyph + turn number. */}
      <div className="flex min-w-[42px] flex-col items-center">
        <span className={`text-lg leading-none ${cfg.symbolColor}`}>
          {cfg.symbol}
        </span>
        <span className="mt-1 text-[10px] font-mono text-zinc-400">
          t{thought.turn}
        </span>
      </div>

      {/* Body: phase tag, summary, detail, optional JSON expander. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide ${cfg.symbolColor}`}
          >
            {cfg.label}
          </span>
          {thought.tool && (
            <span className="font-mono text-xs text-zinc-500">
              {thought.tool}
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400">
            {new Date(thought.createdAt).toLocaleTimeString()}
          </span>
        </div>

        <p className="mt-1 text-sm text-black dark:text-zinc-50">
          {thought.summary}
        </p>

        {thought.detail && (
          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {thought.detail}
          </p>
        )}

        {hasJson && (
          <button
            type="button"
            onClick={() => setExpanded((s) => !s)}
            className="mt-2 text-[11px] font-medium text-zinc-500 underline-offset-2 hover:underline"
          >
            {expanded ? "Hide payload" : "Show payload"}
          </button>
        )}

        {expanded && hasJson && (
          <pre className="mt-2 max-h-60 overflow-auto rounded bg-white/60 p-2 text-[11px] text-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
            {JSON.stringify(
              thought.toolArgs !== undefined ? thought.toolArgs : thought.toolOutput,
              null,
              2,
            )}
          </pre>
        )}
      </div>
    </li>
  );
}
