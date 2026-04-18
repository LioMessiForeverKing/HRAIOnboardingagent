# HR Onboarding Agent

An AI orchestrator that runs nurse onboarding end-to-end — offer letter to laptop enrollment — with minimal human involvement.

## The problem

Hiring a clinical nurse today means stitching together fragmented platforms by hand:

- **23.3%** first-year RN turnover
- **$150–250k** total cost per nurse hire
- **89 days** to fill a clinical role
- **20+ hrs** admin per hire, **14–21 days** from signed offer to full productivity
- Zero error tracking across tools, ops team bottlenecked

Each tool works, but none of them talk to each other — and compliance rules vary by state.

## The solution

A single orchestrator agent that accepts a new-hire decision and drives every downstream step itself, escalating to a human only for real exceptions.

**Target:** ~2 min of admin per hire, 3–5 days to full productivity.

## Architecture

```
┌────────────────┐
│ New Hire       │
│ Decision       │
└───────┬────────┘
        ▼
┌─────────────────────────────────────────────┐
│  AI Onboarding Orchestrator (LLM + tools)   │
│  Dependencies · State logic · Exceptions    │
└──┬────┬────┬────┬────┬──────────────────────┘
   ▼    ▼    ▼    ▼    ▼
 Docu  Chec  Gus  Ship  Kand
 Sign  kr    to   po    ji
 ────  ────  ───  ────  ────
 Offer Bg    Pay  Lap   MDM
 ltr   chk   +    top   enroll
             ICHRA ship
```

**Dependency order:** offer signed → background check kicks off → Gusto payroll + ICHRA enrollment in parallel → laptop ships to home address → MDM auto-enrolls on first boot → compliance review.

## What we need to build

### 1. LLM orchestration core
- OpenAI tool-calling loop that reads hire state, picks the next action, calls the right integration
- State machine / workflow layer that enforces dependency order and persists progress across retries
- Per-state compliance rules (focus: the ~5 US states that make up the bulk of hiring)

### 2. Integrations (API tools the agent can call)
| Tool | Purpose | API quality |
|------|---------|-------------|
| DocuSign | Offer letter generation + signing | Clean API |
| Checkr | Background check | Clean API |
| Gusto | Payroll + HR + **ICHRA benefits** | Clean API |
| Shippo | Laptop shipment to home address | Clean API |
| Kandji | MDM / device enrollment | Clean API |

**Fallback strategy** for integrations with bad or no API:
- Clean API → agent calls directly
- Partial/messy API → Playwright browser automation
- No API → queue a human task with structured instructions

### 3. Exception handling
- Retry with backoff on transient failures (API 5xx, rate limits, shipping delays)
- Escalate to operator only when the agent can't resolve it (truly ambiguous or human-judgment calls)
- Every exception carries context: what was tried, what failed, suggested next action

### 4. Operator experience
- **Dashboard** — every hire in flight, current step, which tool is running or blocked
- **Exception queue** — only tasks that actually need a human; one-click approve or flag
- **Slack notifications** — surface the decision alert with approve/flag buttons
- **Audit log** — full timestamped trail per hire, compliance-ready

The human role collapses to: one decision to hire, then respond only to exceptions. Every step is *visible* but does not require action.

## Tech stack

- **Next.js 16** (App Router) — web app + server actions
- **React 19** — UI
- **Convex** — database + server functions + real-time sync for the dashboard
- **OpenAI** (GPT-4 class) — orchestrator LLM
- **LangGraph** (`@langchain/langgraph`) — workflow engine: dependency graph, retries, **state persistence via checkpointers** so the agent survives restarts and knows which steps it's already completed
- **Zod** — schemas for tool inputs/outputs and state validation
- **Vitest** — unit + integration tests (every module ships with tests)
- **TypeScript** — everywhere
- **Tailwind CSS v4** — styling
- **Playwright** (later) — browser automation fallback for integrations without clean APIs

> ⚠️ Next.js 16 has breaking changes vs older versions. Read `node_modules/next/dist/docs/` before writing route/data-fetching code.

## Current build mode: mocks-only

Until real API keys are provisioned, **every external integration is a mock** that simulates realistic latency, success, and typed failure modes. The orchestrator, graph, and tests all run fully end-to-end against mocks. When a real key arrives, the migration is a one-line swap of the mock module for a real HTTP client — the orchestrator and schema don't change.

**Environment today:** `OPENAI_API_KEY` + Convex credentials only. Everything else is faked.

## Data model (Convex — planned)

```
hires              // one row per new hire
  name, email, role, state, startDate, status, currentStep

steps              // one row per orchestration step per hire
  hireId, tool, action, status, input, output, attemptCount, timestamps

exceptions         // items that need operator attention
  hireId, stepId, reason, suggestedAction, resolvedBy, resolvedAt

audit_log          // append-only, compliance record
  hireId, actor (agent|operator), event, payload, timestamp

state_rules        // per-state compliance config
  state, requiredDocs, ichraRules, workEligibilityChecks
```

## Build phases

- **Phase 0** — Scaffold: Convex schema, OpenAI client, mocked integration layer, LangGraph orchestrator skeleton, Vitest setup
- **Phase 1** — End-to-end orchestrator run against mocks — a hire walks through every step, exceptions escalate, audit log fills in
- **Phase 2** — Dashboard + exception queue + audit log UI wired to Convex live queries
- **Phase 3** — Swap mocks for real integrations one at a time (DocuSign → Checkr → Gusto → Shippo → Kandji)
- **Phase 4** — State compliance rules + Slack operator notifications
- **Phase 5** — Playwright fallback for any integration that turns out to have a messy API
- **Phase 6** — **Learning & memory loop** (see below)

## Future: learning & memory loop

The agent should get smarter the more hires it processes. Planned, not built yet:

- **Episodic memory** — every hire's full step history and outcomes stored in Convex; retrievable by embedding similarity so the agent can ask "have I seen this situation before?"
- **Post-hire reflection** — after each hire completes (or fails), an LLM pass summarizes what worked, what didn't, and what the agent should do differently next time. Output: structured "lessons" appended to a playbook.
- **Playbook consultation** — before the decide step, the agent retrieves relevant playbook entries (by state, by role, by which tool is next) and injects them into the prompt. This is the recursive part — past runs shape future runs.
- **Failure pattern detection** — when the same exception type hits N times for the same state/tool combo, auto-flag it for a human to turn into a hard rule.

Schema will reserve a `reflections` / `playbook` table from the start so we don't have to migrate later, but no graph nodes call it until Phase 6.

## Testing strategy

Every integration mock, every graph node, and every Convex function ships with Vitest tests. Because all externals are mocked, the test suite is the primary correctness signal until real keys arrive.

```bash
npm run test          # run once
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

## Getting started

### 1. Install dependencies
```bash
npm install
```

### 2. Fill in `.env.local`
Copy your keys into `.env.local` (already created). At minimum you need:
- `OPENAI_API_KEY`
- Convex URLs — populated automatically by the next step

### 3. Start Convex
```bash
npx convex dev
```
This creates a Convex project, writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` into `.env.local`, and watches `convex/` for changes.

### 4. Start Next.js
```bash
npm run dev
```
Open http://localhost:3000.

## Project layout (planned)

```
src/
  app/                         # Next.js routes
    page.tsx                   # Dashboard (hires in flight)
    hires/[id]/                # Hire detail + step timeline
    exceptions/                # Operator exception queue
    api/                       # Server routes (Slack webhooks, integration callbacks)
  components/                  # Shared React components
  lib/
    agent/
      graph.ts                 # LangGraph StateGraph definition
      state.ts                 # Typed shared state schema
      nodes/                   # One file per graph node (decide, execute, escalate, persist)
      tools.ts                 # Tool definitions the LLM can call (zod-validated)
      llm.ts                   # OpenAI client wrapper
    integrations/              # One module per external API
      types.ts                 # Shared Integration<Input, Output> interface
      docusign.ts + .test.ts   # Each integration has its sibling test file
      checkr.ts + .test.ts
      gusto.ts + .test.ts
      shippo.ts + .test.ts
      kandji.ts + .test.ts
      mock-utils.ts            # Latency + failure simulation helpers
    compliance/                # Per-state rules (Phase 4)
scripts/
  run-hire.ts                  # CLI: trigger an end-to-end hire against mocks
convex/
  schema.ts                    # Convex schema
  hires.ts, steps.ts           # Query + mutation functions
  exceptions.ts                # Exception queue
  audit.ts                     # Append-only audit log
```

## Status

Greenfield. Scaffolding in progress — see build phases above.
