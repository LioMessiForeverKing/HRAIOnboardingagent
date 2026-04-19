// ────────────────────────────────────────────────────────────────
// LangGraph StateGraph definition.
//
// Topology:
//
//   START → decide ─┬─→ execute ─→ decide    (tool call loop)
//                   ├─→ escalate ─→ END       (exception raised)
//                   └─→ finish   ─→ END       (all steps done)
//
// The decide node is the LLM's turn: it looks at state, picks a next
// action (a tool call) or decides it's done, and returns. The execute node
// runs the tool. Escalate writes an exception to Convex and stops.
//
// Why LangGraph: we get the checkpointer for free — state is persisted
// after every node, so a crash mid-run resumes exactly where it left off.
// That's the "agent knows I did background check, I did checker" concern.
// ────────────────────────────────────────────────────────────────

import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";

import { OnboardingState, type OnboardingStateType, type StepRecord } from "./state";
import { chat, executeToolCall, toolsToOpenAIFormat, decodeToolName } from "./llm";
import { buildIntegrations, IntegrationError, type Scenario } from "../integrations";
import { resetTransientFailLog } from "../integrations/mock-utils";
import {
  describePlan,
  describeAct,
  describeObserve,
  describeRetry,
  describeEscalate,
  describeDone,
} from "./narrator";

// ────────────────────────────────────────────────────────────────
// System prompt — tells the LLM what it is and how to behave.
//
// Kept in this file (not a separate .md) so changes + version history
// live with the code that interprets them.
// ────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the HR Onboarding Orchestrator for a healthcare staffing company that hires nurses.

Your job is to drive a new hire's onboarding end-to-end by calling tools in the correct dependency order. You receive a hire's details and must sequence these steps:

DEPENDENCY ORDER (mandatory — do not skip or reorder without a reason):
  1. docusign.send_offer        — send the offer letter
  2. docusign.check_status      — poll until signed (may take multiple calls)
  3. checkr.order_check         — order background check once offer is signed
  4. checkr.get_result          — poll until result is clear/consider/suspended
  5. gusto.create_employee      — add to payroll after background check clears
  6. gusto.enroll_ichra         — enroll in benefits after employee is created
  7. shippo.verify_address      — verify the nurse's home address
  8. shippo.create_shipment     — buy the laptop shipping label
  9. kandji.create_enrollment   — pre-provision MDM for the shipped laptop
  10. kandji.get_enrollment     — poll until device enrolls (may take multiple calls)

RULES:
- Call exactly one tool at a time. Wait for each result before deciding the next move.
- If a polling tool returns "pending", call it again until it resolves.
- If a background check returns "consider" or "suspended", escalate to a human — do not proceed.
- If an address is invalid, escalate with the specific issue.
- When every step above has a successful terminal result, reply with the plain text "ALL_STEPS_COMPLETE" and no tool call.

You have access to the full history of tool calls you've already made — do not repeat a successful step.`;

// ────────────────────────────────────────────────────────────────
// Maximum retries per tool — applies to *retryable* errors only.
// After this many, the agent escalates even if the error was retryable.
// ────────────────────────────────────────────────────────────────
const MAX_RETRIES_PER_TOOL = 3;

// ────────────────────────────────────────────────────────────────
// detectBusinessEscalation
//
// Some tool calls succeed (no thrown error) but return a payload that
// represents a hard stop: a background check came back "consider", an
// address is unverifiable, an offer was declined. The system prompt
// tells the LLM to escalate in those cases, but the LLM tends to just
// stop calling tools instead — which previously caused the graph to
// route to `finish` and falsely mark the hire complete.
//
// This function inspects a successful tool output and, if it matches
// any "needs human review" pattern, returns the exception payload.
// The execute node uses it to short-circuit straight to `escalate`.
// ────────────────────────────────────────────────────────────────
function detectBusinessEscalation(
  toolKey: string,
  output: unknown,
): { reason: string; details: string; suggestedAction: string } | null {
  // Coerce to a generic record so we can read fields without per-tool casts.
  const o = output as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object") return null;

  switch (toolKey) {
    case "checkr.get_result": {
      if (o.status === "consider") {
        const adverse = Array.isArray(o.adverseActions)
          ? (o.adverseActions as string[]).join(", ")
          : "no specific reason returned";
        return {
          reason: "checkr_adverse_action",
          details: `Background check returned 'consider' — adverse findings: ${adverse}. FCRA requires human adjudication before any further action.`,
          suggestedAction:
            "Run pre-adverse-action notice + adjudication review in Checkr's dashboard.",
        };
      }
      if (o.status === "suspended") {
        return {
          reason: "checkr_suspended",
          details:
            "Background check was suspended — Checkr needs additional documents from the candidate.",
          suggestedAction: "Reach out to the candidate to resolve the document request.",
        };
      }
      return null;
    }
    case "shippo.verify_address": {
      if (o.valid === false) {
        const issues = Array.isArray(o.issues)
          ? (o.issues as string[]).join("; ")
          : "no specific issue returned";
        return {
          reason: "address_unverifiable",
          details: `Shippo couldn't verify the home address: ${issues}.`,
          suggestedAction: "Confirm the address with the candidate before retrying.",
        };
      }
      return null;
    }
    case "docusign.check_status": {
      if (o.status === "declined") {
        return {
          reason: "offer_declined",
          details: "Candidate declined to sign the offer letter.",
          suggestedAction:
            "Reach out to the candidate to understand the decline reason before re-issuing.",
        };
      }
      if (o.status === "voided") {
        return {
          reason: "offer_voided",
          details: "DocuSign envelope was voided before signing completed.",
          suggestedAction: "Investigate why the envelope was voided; reissue if intentional.",
        };
      }
      return null;
    }
    default:
      return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Convex context — injected at graph build time so nodes can persist.
//
// We treat Convex as an optional dependency: in tests we pass a fake
// implementation. In production the server action wires in real clients.
// ────────────────────────────────────────────────────────────────
export interface ConvexContext {
  // Called when a step starts — writes to `steps` table and returns an id.
  createStep: (args: {
    hireId: string;
    tool: "docusign" | "checkr" | "gusto" | "shippo" | "kandji";
    action: string;
    input: unknown;
  }) => Promise<string>;
  markStepRunning: (args: { stepId: string }) => Promise<void>;
  completeStep: (args: { stepId: string; output: unknown }) => Promise<void>;
  failStep: (args: { stepId: string; error: unknown; escalate?: boolean }) => Promise<void>;
  raiseException: (args: {
    hireId: string;
    stepId?: string;
    reason: string;
    details: string;
    suggestedAction?: string;
    severity: "low" | "medium" | "high";
  }) => Promise<string>;
  updateHireStatus: (args: {
    hireId: string;
    status: "pending" | "in_progress" | "awaiting_human" | "completed" | "failed";
    currentStep?: string;
  }) => Promise<void>;
  // Optional narration sink — the graph emits a thought per node turn so
  // the UI can render a live "agent thinking" stream. Implementations
  // that don't care about narration (e.g. unit tests) can omit this.
  writeThought?: (args: {
    hireId: string;
    turn: number;
    phase: "plan" | "decide" | "act" | "observe" | "retry" | "escalate" | "done";
    summary: string;
    detail?: string;
    tool?: string;
    toolArgs?: unknown;
    toolOutput?: unknown;
    stepId?: string;
  }) => Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// buildGraph — constructs the StateGraph with nodes + edges.
//
// Returns a compiled graph + a MemorySaver. The caller invokes
// `graph.invoke(initialState, { configurable: { thread_id: hireId } })`.
// The thread_id is how LangGraph keys checkpoints — one per hire.
// ────────────────────────────────────────────────────────────────
export function buildGraph(
  ctx: ConvexContext,
  opts?: { scenario?: Scenario | null },
) {
  // Build integrations once — this is the tool registry the LLM sees.
  // The scenario (if any) is forwarded to every mock so behavior is
  // deterministic for the duration of this graph build.
  const scenario = opts?.scenario ?? null;
  // Reset the per-tool "first call fails once" log so the next run
  // starts fresh — the transient_retry scenario depends on it.
  resetTransientFailLog();
  const { toolMap } = buildIntegrations({ scenario });
  const openaiTools = toolsToOpenAIFormat(toolMap);

  // ───────────────────────────────────────────────────────────
  // decide node — the LLM's turn.
  //
  // Inputs:  full state (history of tool calls, hire details, messages)
  // Output:  either a pending tool call (added to messages) or done=true
  // ───────────────────────────────────────────────────────────
  async function decide(state: OnboardingStateType) {
    const isFirstTurn = state.messages.length === 0;

    // Build the prompt on first turn. Subsequent turns already have history.
    const messages = isFirstTurn
      ? [
          { role: "system" as const, content: SYSTEM_PROMPT },
          {
            role: "user" as const,
            content: `New hire to onboard:
- Name: ${state.hire.name}
- Email: ${state.hire.email}
- Role: ${state.hire.role}
- State: ${state.hire.state}
- Start date: ${state.hire.startDate}
- Annual salary (USD): ${state.hire.salary}
- Home address: ${JSON.stringify(state.hire.address)}
- Our hire id (use this as hireId when calling tools): ${state.hireId}

Use the exact salary above when the tool requires one. Begin with the first step of the dependency order.`,
          },
        ]
      : state.messages;

    // On the very first turn, emit a "planning" thought so the UI has
    // something to render while the LLM is still formulating its response.
    // Without this, the operator stares at a blank stream for 1-2 seconds.
    const turnStart = state.turnCount + 1;
    if (isFirstTurn) {
      const plan = describePlan(state.hire);
      await ctx.writeThought?.({
        hireId: state.hireId,
        turn: turnStart,
        phase: "plan",
        summary: plan.summary,
        detail: plan.detail,
      });
    }

    // Ask the LLM what to do next.
    const response = await chat({
      messages,
      tools: openaiTools,
      // Keep decisions deterministic — we want low variance over the same hire.
      temperature: 0.1,
    });

    // Tool call requested → narrate the "act" (which the execute node runs).
    if (response.tool_calls?.length) {
      const call = response.tool_calls[0];
      if (call.type === "function") {
        const toolKey = decodeToolName(call.function.name);
        let parsedArgs: unknown = {};
        try {
          parsedArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          // If the LLM produced junk JSON the execute node will throw;
          // we still want to record what it tried to call.
        }
        const act = describeAct(toolKey, parsedArgs);
        await ctx.writeThought?.({
          hireId: state.hireId,
          turn: turnStart + (isFirstTurn ? 1 : 0),
          phase: "act",
          summary: act.summary,
          detail:
            typeof response.content === "string" && response.content.trim()
              ? `${act.detail}\n\nLLM said: ${response.content.trim()}`
              : act.detail,
          tool: toolKey,
          toolArgs: parsedArgs,
        });
      }

      return {
        messages: isFirstTurn ? [...messages, response] : [response],
        turnCount: turnStart + (isFirstTurn ? 1 : 0),
      };
    }

    // No tool call — either the LLM declared completion, or it stalled.
    const text = response.content ?? "";
    const textStr = typeof text === "string" ? text : "";
    const isComplete = /all[_\s-]*steps[_\s-]*complete/i.test(textStr);

    // If the LLM didn't say the magic phrase AND didn't request a tool,
    // it's giving up early. Surface that as an exception so the operator
    // can see why instead of the graph falsely marking the hire complete.
    const stallException =
      !isComplete
        ? {
            reason: "agent_stalled",
            details:
              `The agent stopped without completing every required step and without declaring "ALL_STEPS_COMPLETE". ` +
              `Last assistant text: ${textStr ? JSON.stringify(textStr.slice(0, 500)) : "(empty)"}`,
            severity: "high" as const,
            suggestedAction:
              "Review the agent transcript to see which step caused it to stop, then resume manually or rerun once the blocker is resolved.",
          }
        : null;

    return {
      messages: isFirstTurn ? [...messages, response] : [response],
      done: isComplete,
      turnCount: turnStart + (isFirstTurn ? 1 : 0),
      pendingException: stallException,
    };
  }

  // ───────────────────────────────────────────────────────────
  // execute node — run the tool the LLM asked for.
  // ───────────────────────────────────────────────────────────
  async function execute(state: OnboardingStateType) {
    // The last message in history must be the assistant turn with tool_calls.
    const last = state.messages[state.messages.length - 1];
    if (last.role !== "assistant" || !("tool_calls" in last) || !last.tool_calls?.length) {
      // Shouldn't happen — route logic prevents it. Defensive throw.
      throw new Error("execute node invoked without pending tool call");
    }

    // We call exactly one tool per turn (see system prompt rule).
    const call = last.tool_calls[0];
    // OpenAI SDK v6 widened this type to a union — narrow to the function
    // variant before we access `.function`. Our tool definitions are all
    // `type: "function"` so anything else is a bug upstream.
    if (call.type !== "function") {
      throw new Error(`Unexpected non-function tool call: ${call.type}`);
    }
    // Capture the function payload once — cleaner than repeating the
    // narrow below, and TypeScript type-narrowing doesn't always carry
    // through catch blocks reliably.
    const callFn = call.function;
    const toolKey = decodeToolName(callFn.name);
    const parsedArgs = JSON.parse(callFn.arguments || "{}");
    const [toolName, actionName] = toolKey.split(".") as [
      "docusign" | "checkr" | "gusto" | "shippo" | "kandji",
      string,
    ];

    // Persist "step queued" to Convex before we run anything.
    const stepId = await ctx.createStep({
      hireId: state.hireId,
      tool: toolName,
      action: actionName,
      input: parsedArgs,
    });
    await ctx.updateHireStatus({
      hireId: state.hireId,
      status: "in_progress",
      currentStep: toolKey,
    });
    await ctx.markStepRunning({ stepId });

    try {
      // Actually invoke the integration.
      const { output } = await executeToolCall(call, toolMap);

      // Persist success.
      await ctx.completeStep({ stepId, output });

      // Narrate the observation — what we learned from the tool result
      // and what we'll do next. This is what makes the stream feel alive.
      const obsTurn = state.turnCount + 1;
      const obs = describeObserve(toolKey, output);
      await ctx.writeThought?.({
        hireId: state.hireId,
        turn: obsTurn,
        phase: "observe",
        summary: obs.summary,
        detail: obs.detail,
        tool: toolKey,
        toolOutput: output,
        stepId,
      });

      const record: StepRecord = {
        tool: toolKey,
        input: parsedArgs,
        output,
        status: "completed",
        at: Date.now(),
      };

      // Some tool results are *successful* (no thrown error) but represent
      // business-rule outcomes the agent isn't allowed to auto-progress
      // past — Checkr "consider" / "suspended", Shippo invalid address,
      // DocuSign "declined" / "voided". Detect those here and route to
      // escalate, instead of trusting the LLM to remember the rule.
      // Without this guard the LLM would simply stop calling tools and the
      // graph would mis-route to `finish`, marking the hire "completed"
      // when it actually needs a human.
      const businessEscalation = detectBusinessEscalation(toolKey, output);
      if (businessEscalation) {
        return {
          completedSteps: [record],
          pendingException: {
            reason: businessEscalation.reason,
            details: businessEscalation.details,
            severity: "high" as const,
            suggestedAction: businessEscalation.suggestedAction,
            stepId,
          },
          turnCount: obsTurn,
        };
      }

      // Append a `tool` role message so the LLM sees the result on next decide.
      const toolMessage = {
        role: "tool" as const,
        tool_call_id: call.id,
        content: JSON.stringify(output),
      };

      return {
        messages: [toolMessage],
        completedSteps: [record],
        // Reset this tool's retry counter — a success clears past failures.
        retryCounts: { [toolKey]: 0 },
        turnCount: obsTurn,
      };
    } catch (err) {
      // Distinguish retryable from fatal.
      const integrationErr = err instanceof IntegrationError ? err : null;
      const retryable = integrationErr?.retryable ?? false;
      const currentRetries = state.retryCounts[toolKey] ?? 0;

      // If retryable and under budget, bump counter and let the LLM decide to retry.
      if (retryable && currentRetries < MAX_RETRIES_PER_TOOL) {
        await ctx.failStep({
          stepId,
          error: { code: integrationErr?.code, message: (err as Error).message },
          escalate: false,
        });

        // Narrate the retry — operator sees that the agent noticed the blip
        // and is working around it rather than silently stalling.
        const retryTurn = state.turnCount + 1;
        const retry = describeRetry(toolKey, currentRetries, (err as Error).message);
        await ctx.writeThought?.({
          hireId: state.hireId,
          turn: retryTurn,
          phase: "retry",
          summary: retry.summary,
          detail: retry.detail,
          tool: toolKey,
          stepId,
        });

        // Feed the error back to the LLM as a tool message so it can decide
        // to retry the same tool.
        const toolMessage = {
          role: "tool" as const,
          tool_call_id: call.id,
          content: JSON.stringify({
            error: (err as Error).message,
            code: integrationErr?.code ?? "unknown",
            retryable: true,
            attempt: currentRetries + 1,
            instructions: `Transient failure. Retry the same tool call.`,
          }),
        };

        return {
          messages: [toolMessage],
          retryCounts: { [toolKey]: currentRetries + 1 },
          turnCount: retryTurn,
        };
      }

      // Non-retryable or out of budget — escalate.
      await ctx.failStep({
        stepId,
        error: { code: integrationErr?.code, message: (err as Error).message },
        escalate: true,
      });

      const record: StepRecord = {
        tool: toolKey,
        input: parsedArgs,
        error: {
          code: integrationErr?.code ?? "unknown",
          message: (err as Error).message,
          retryable,
        },
        status: "escalated",
        at: Date.now(),
      };

      return {
        completedSteps: [record],
        pendingException: {
          reason: integrationErr?.code ?? "unknown_error",
          details: `${toolKey} failed: ${(err as Error).message}`,
          severity: "high" as const,
          suggestedAction: retryable
            ? `The agent retried ${MAX_RETRIES_PER_TOOL} times — please investigate why.`
            : `Non-retryable failure. Check ${toolName} logs.`,
          stepId,
        },
      };
    }
  }

  // ───────────────────────────────────────────────────────────
  // escalate node — persist exception + flip status.
  // ───────────────────────────────────────────────────────────
  async function escalate(state: OnboardingStateType) {
    const ex = state.pendingException;
    if (!ex) throw new Error("escalate invoked with no pendingException");

    await ctx.raiseException({
      hireId: state.hireId,
      stepId: ex.stepId,
      reason: ex.reason,
      details: ex.details,
      suggestedAction: ex.suggestedAction,
      severity: ex.severity,
    });

    // Narrate the hand-off — it's the last thing the agent does in the
    // exception path so the stream ends with a clear reason for stopping.
    const esTurn = state.turnCount + 1;
    const es = describeEscalate(ex.reason, ex.details);
    await ctx.writeThought?.({
      hireId: state.hireId,
      turn: esTurn,
      phase: "escalate",
      summary: es.summary,
      detail: ex.suggestedAction
        ? `${es.detail}\n\nSuggested action: ${ex.suggestedAction}`
        : es.detail,
      stepId: ex.stepId,
    });

    return { done: true, turnCount: esTurn };
  }

  // ───────────────────────────────────────────────────────────
  // finish node — all steps done, flip hire to completed.
  // ───────────────────────────────────────────────────────────
  async function finish(state: OnboardingStateType) {
    await ctx.updateHireStatus({
      hireId: state.hireId,
      status: "completed",
      currentStep: undefined,
    });

    // Final narration — a clean "we're done" line closes the stream.
    const finTurn = state.turnCount + 1;
    const d = describeDone(state.completedSteps.length);
    await ctx.writeThought?.({
      hireId: state.hireId,
      turn: finTurn,
      phase: "done",
      summary: d.summary,
      detail: d.detail,
    });

    return { done: true, turnCount: finTurn };
  }

  // ───────────────────────────────────────────────────────────
  // Router from decide — branch on whether there's a pending tool call,
  // a pending exception, or completion.
  // ───────────────────────────────────────────────────────────
  function routeFromDecide(state: OnboardingStateType): "execute" | "finish" | "escalate" {
    const last = state.messages[state.messages.length - 1];
    // Tool call requested → execute branch.
    if (last?.role === "assistant" && "tool_calls" in last && last.tool_calls?.length) {
      return "execute";
    }
    // No tool call. If the LLM explicitly declared completion (`done` flag
    // set in decide), graduate to finish. Otherwise the LLM stopped early
    // — that's a stall we should escalate, NOT silently mark complete.
    // (Without this, an LLM that gives up after seeing a "consider" result
    // would route to `finish` and the operator would think the hire was
    // fully onboarded when in fact half the chain never ran.)
    if (state.done) return "finish";
    return "escalate";
  }

  // Router from execute — if a tool raised an escalation, jump to escalate.
  function routeFromExecute(state: OnboardingStateType): "decide" | "escalate" {
    return state.pendingException ? "escalate" : "decide";
  }

  // ───────────────────────────────────────────────────────────
  // Build the graph. Each `.addNode` registers an async function.
  // `.addEdge` sets static transitions; `.addConditionalEdges` picks
  // the next node at runtime via our router functions.
  // ───────────────────────────────────────────────────────────
  const graph = new StateGraph(OnboardingState)
    .addNode("decide", decide)
    .addNode("execute", execute)
    .addNode("escalate", escalate)
    .addNode("finish", finish)
    .addEdge(START, "decide")
    .addConditionalEdges("decide", routeFromDecide, {
      execute: "execute",
      finish: "finish",
      escalate: "escalate",
    })
    .addConditionalEdges("execute", routeFromExecute, {
      decide: "decide",
      escalate: "escalate",
    })
    .addEdge("escalate", END)
    .addEdge("finish", END);

  // MemorySaver = in-process checkpointer. Every node write is persisted
  // under the thread_id key so `graph.invoke(..., { thread_id })` resumes.
  // For production, swap for a database-backed checkpointer (Postgres / Convex).
  const checkpointer = new MemorySaver();

  // Compile with a recursion limit so a pathological loop eventually terminates.
  return graph.compile({
    checkpointer,
    // Internal limit so an LLM that loops on the same tool hits the ceiling
    // after a reasonable number of steps — our MAX_RETRIES handles normal retry,
    // this is the safety net.
  });
}
