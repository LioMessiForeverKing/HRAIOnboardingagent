// ────────────────────────────────────────────────────────────────
// CLI: run-hire
//
// Runs an end-to-end onboarding against mocked integrations and the real
// OpenAI API. Prints every lifecycle event to stdout so you can watch the
// agent reason through the graph.
//
// Usage:
//   npm run run-hire
//
// Requirements:
//   - OPENAI_API_KEY set in .env.local
//   - (Everything else is mocked — real integration keys not needed)
// ────────────────────────────────────────────────────────────────

// Load .env.local into process.env BEFORE anything that reads it.
// We use dotenv's `config` with an explicit path so this works regardless of cwd.
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(process.cwd(), ".env.local") });

// Now safe to import modules that reference process.env on construction.
import { buildGraph } from "../src/lib/agent/graph";
import { makeConsoleContext } from "../src/lib/agent/console-context";

// ────────────────────────────────────────────────────────────────
// Pretend hire — in a real app this would come from the dashboard form.
// ────────────────────────────────────────────────────────────────
const demoHire = {
  // The Convex hire id would normally be assigned by `createHire` — for the
  // console run, we just make one up.
  hireId: `hire_demo_${Date.now()}`,
  hire: {
    name: "Alex Demo",
    email: "alex.demo@example.com",
    role: "Registered Nurse",
    state: "TX",
    startDate: "2026-05-15",
    salary: 95000,
    address: {
      street1: "123 Test Ave",
      city: "Austin",
      state: "TX",
      zip: "78701",
    },
  },
};

async function main() {
  console.log("\n🩺  HR Onboarding Agent — demo run\n");
  console.log(`Hire: ${demoHire.hire.name} (${demoHire.hire.role}) in ${demoHire.hire.state}\n`);

  // Guardrail: without OPENAI_API_KEY, the real chat call will fail at
  // the first decide-node invocation. Fail fast with a helpful message.
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY is not set. Add it to .env.local and try again.\n" +
        "(The integrations are mocked, but the orchestrator LLM is real.)",
    );
    process.exit(1);
  }

  // In-memory context that just logs — no Convex required for this demo.
  const ctx = makeConsoleContext();

  // Build the graph. Integration mocks are wired in automatically because
  // no real API credentials are present.
  const graph = buildGraph(ctx);

  // `thread_id` is LangGraph's checkpointer key — one per hire. If this
  // script crashed halfway and we re-ran with the same thread_id, the
  // agent would resume from the last checkpoint. MemorySaver is in-process,
  // so that only works within a single run — production would use a
  // persistent checkpointer.
  const final = await graph.invoke(demoHire, {
    configurable: { thread_id: demoHire.hireId },
    // Safety net against runaway loops.
    recursionLimit: 80,
  });

  // Summary section.
  console.log("\n──────────────────────────────────────────────");
  console.log(`Hire ${demoHire.hireId} final state:`);
  console.log(`  done:             ${final.done}`);
  console.log(`  completed steps:  ${final.completedSteps.length}`);
  console.log(`  exception:        ${final.pendingException ? final.pendingException.reason : "(none)"}`);
  console.log("──────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
