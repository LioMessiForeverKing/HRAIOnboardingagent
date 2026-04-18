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
import { buildIntegrations, IntegrationError } from "../integrations";

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
}

// ────────────────────────────────────────────────────────────────
// buildGraph — constructs the StateGraph with nodes + edges.
//
// Returns a compiled graph + a MemorySaver. The caller invokes
// `graph.invoke(initialState, { configurable: { thread_id: hireId } })`.
// The thread_id is how LangGraph keys checkpoints — one per hire.
// ────────────────────────────────────────────────────────────────
export function buildGraph(ctx: ConvexContext) {
  // Build integrations once — this is the tool registry the LLM sees.
  const { toolMap } = buildIntegrations();
  const openaiTools = toolsToOpenAIFormat(toolMap);

  // ───────────────────────────────────────────────────────────
  // decide node — the LLM's turn.
  //
  // Inputs:  full state (history of tool calls, hire details, messages)
  // Output:  either a pending tool call (added to messages) or done=true
  // ───────────────────────────────────────────────────────────
  async function decide(state: OnboardingStateType) {
    // Build the prompt on first turn. Subsequent turns already have history.
    const messages =
      state.messages.length === 0
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

    // Ask the LLM what to do next.
    const response = await chat({
      messages,
      tools: openaiTools,
      // Keep decisions deterministic — we want low variance over the same hire.
      temperature: 0.1,
    });

    // Check for the "ALL_STEPS_COMPLETE" sentinel that signals graceful finish.
    if (!response.tool_calls?.length) {
      const text = response.content ?? "";
      // Case-insensitive match — the LLM sometimes adds punctuation.
      const isComplete = /all[_\s-]*steps[_\s-]*complete/i.test(
        typeof text === "string" ? text : "",
      );
      return {
        // Always append the assistant message so future turns see the history.
        messages: state.messages.length === 0
          ? [...messages, response]
          : [response],
        // If the LLM declared completion, mark done. Otherwise it's confused
        // and we'll loop back — but track that for escalation heuristics.
        done: isComplete,
      };
    }

    // Tool call requested. Pass the assistant message forward; the execute
    // node will pick up the tool_calls array.
    return {
      messages: state.messages.length === 0
        ? [...messages, response]
        : [response],
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

      // Append a `tool` role message so the LLM sees the result on next decide.
      const toolMessage = {
        role: "tool" as const,
        tool_call_id: call.id,
        content: JSON.stringify(output),
      };

      const record: StepRecord = {
        tool: toolKey,
        input: parsedArgs,
        output,
        status: "completed",
        at: Date.now(),
      };

      return {
        messages: [toolMessage],
        completedSteps: [record],
        // Reset this tool's retry counter — a success clears past failures.
        retryCounts: { [toolKey]: 0 },
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

    return { done: true };
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
    return { done: true };
  }

  // ───────────────────────────────────────────────────────────
  // Router from decide — branch on whether there's a pending tool call,
  // a pending exception, or completion.
  // ───────────────────────────────────────────────────────────
  function routeFromDecide(state: OnboardingStateType): "execute" | "finish" {
    const last = state.messages[state.messages.length - 1];
    // Tool call requested → execute branch.
    if (last?.role === "assistant" && "tool_calls" in last && last.tool_calls?.length) {
      return "execute";
    }
    // Otherwise we're done (LLM declared completion).
    return "finish";
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
