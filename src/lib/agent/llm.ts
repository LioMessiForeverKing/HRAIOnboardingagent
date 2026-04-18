// ────────────────────────────────────────────────────────────────
// LLM client — thin wrapper around the OpenAI SDK tailored for the agent.
//
// Responsibilities:
//   1. Expose a single `chat()` function the graph's decide-node calls.
//   2. Accept zod-defined tools and translate them to OpenAI's tool schema.
//   3. Validate LLM tool-call arguments against zod before invoking handlers.
//
// Why wrap instead of using OpenAI directly: this is where we plug in
// logging, token accounting, and retry policies without polluting graph code.
// ────────────────────────────────────────────────────────────────

import OpenAI from "openai";
import { z } from "zod";

import type { IntegrationAction } from "../integrations/types";

// ────────────────────────────────────────────────────────────────
// Module-level client — created lazily so importing this file in tests
// doesn't require OPENAI_API_KEY to be set.
// ────────────────────────────────────────────────────────────────
let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env.local (see README).",
    );
  }
  _client = new OpenAI({ apiKey, organization: process.env.OPENAI_ORG_ID });
  return _client;
}

// Default model — overridden by env var if operator wants to experiment.
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

// ────────────────────────────────────────────────────────────────
// toolsToOpenAIFormat
//
// OpenAI's tool-calling API wants an array of:
//   { type: "function", function: { name, description, parameters: JSONSchema } }
//
// We produce that from our registry's integration actions. The "name" the
// LLM sees is the flat dot-path key ("docusign.send_offer") — OpenAI allows
// [a-zA-Z0-9_-]{1,64} so we replace the dot with an underscore.
// ────────────────────────────────────────────────────────────────
export function toolsToOpenAIFormat(
  toolMap: Record<string, IntegrationAction & { tool: string }>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  // OpenAI tool names can't contain dots — map "." to "__" and reverse on the way back.
  return Object.entries(toolMap).map(([key, action]) => ({
    type: "function",
    function: {
      name: key.replace(".", "__"),
      description: action.description,
      // Zod v4 ships its own JSON Schema emitter — `z.toJSONSchema()`.
      // Cast to Record<string, unknown> to satisfy OpenAI's loose type.
      parameters: z.toJSONSchema(action.input) as Record<string, unknown>,
    },
  }));
}

// Convert an OpenAI tool name back to our dot-notation key.
export function decodeToolName(openaiName: string): string {
  return openaiName.replace("__", ".");
}

// ────────────────────────────────────────────────────────────────
// ChatMessage — the minimum shape the graph needs.
//
// Uses OpenAI's own type so we stay in lock-step with SDK updates.
// ────────────────────────────────────────────────────────────────
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ────────────────────────────────────────────────────────────────
// chat
//
// Calls the LLM with a conversation + tool list. Returns the raw
// assistant message (which may contain either text content, a tool call,
// or both). The graph interprets the response.
// ────────────────────────────────────────────────────────────────
export async function chat(opts: {
  messages: ChatMessage[];
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  // Temperature — low for deterministic decisions (0.1), higher for creative reasoning.
  temperature?: number;
  // Override model per-call (we rarely do).
  model?: string;
}): Promise<OpenAI.Chat.Completions.ChatCompletionMessage> {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: opts.model ?? DEFAULT_MODEL,
    messages: opts.messages,
    tools: opts.tools,
    // When tools exist, force the model to pick one or produce final text.
    // "auto" lets GPT decide — best for our "one orchestrator, many tools" setup.
    tool_choice: opts.tools ? "auto" : undefined,
    temperature: opts.temperature ?? 0.1,
  });

  return response.choices[0].message;
}

// ────────────────────────────────────────────────────────────────
// executeToolCall
//
// Given a tool call from the LLM's response, look up the matching
// IntegrationAction, validate arguments through zod, invoke the handler,
// and return the (validated) output.
//
// Errors thrown by the handler bubble up; the graph decides to retry or
// escalate based on whether it's an IntegrationError with retryable=true.
// ────────────────────────────────────────────────────────────────
export async function executeToolCall(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  toolMap: Record<string, IntegrationAction & { tool: string }>,
): Promise<{ toolKey: string; output: unknown }> {
  // Tool-calls from OpenAI are always functions in our setup. The SDK's
  // `ChatCompletionMessageToolCall` is a union — narrow here and capture
  // the function payload so it stays typed through the rest of the fn.
  if (call.type !== "function") {
    throw new Error(`Unexpected tool call type: ${call.type}`);
  }
  const callFn = call.function;

  // Translate the OpenAI-safe name back to our dot-notation key.
  const toolKey = decodeToolName(callFn.name);
  const action = toolMap[toolKey];

  if (!action) {
    throw new Error(`LLM called unknown tool: ${toolKey}`);
  }

  // Parse + validate arguments. The LLM sometimes produces extra whitespace
  // or slightly off JSON, so we JSON.parse first and let zod sanity-check.
  let parsed: unknown;
  try {
    parsed = JSON.parse(callFn.arguments);
  } catch (err) {
    throw new Error(`LLM produced invalid JSON for ${toolKey}: ${callFn.arguments}`);
  }

  // zod is strict by default — missing fields or wrong types throw.
  const validated = action.input.parse(parsed);

  // Run the handler. May throw IntegrationError (caller distinguishes).
  const output = await action.handler(validated);

  // Validate the output too — if the mock (or real API) ever returns a
  // shape we don't expect, we want to catch it here, not 3 steps later.
  const validatedOutput = action.output.parse(output);

  return { toolKey, output: validatedOutput };
}
