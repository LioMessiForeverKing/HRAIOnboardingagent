// ────────────────────────────────────────────────────────────────
// Utilities for building realistic mocks.
//
// Goal: every mock should feel *enough* like a real API that the
// orchestrator's retry + escalation logic gets exercised during tests.
// That means we simulate:
//   • non-zero latency
//   • occasional transient failures (retryable)
//   • occasional hard failures (escalate)
//   • deterministic mode for unit tests
// ────────────────────────────────────────────────────────────────

import { IntegrationError } from "./types";

// ────────────────────────────────────────────────────────────────
// Global seed — when set, mocks become deterministic for tests.
// Vitest suites call `setMockSeed(123)` in `beforeEach` to get repeatable runs.
// ────────────────────────────────────────────────────────────────
let rngSeed: number | null = null;

export function setMockSeed(seed: number | null): void {
  rngSeed = seed;
}

// ────────────────────────────────────────────────────────────────
// Failure override — tests that want to verify the happy path don't want
// to fight the probabilistic failure injection. Setting this to "force_off"
// short-circuits `maybeFail` so no synthetic error is ever thrown.
//
// Graph + integration tests default to "force_off"; dev mode (no override)
// keeps the real probabilities so you can feel the retries in a live demo.
// Exception-path tests can set it to "force_on" to always fail.
// ────────────────────────────────────────────────────────────────
type FailureOverride = null | "force_off" | "force_on";
let failureOverride: FailureOverride = null;

export function setMockFailureOverride(mode: FailureOverride): void {
  failureOverride = mode;
}

// Simple seeded RNG (mulberry32). Not cryptographic — good enough for test jitter.
// When no seed is set, fall back to Math.random() for dev-time variability.
function rand(): number {
  if (rngSeed === null) return Math.random();
  let t = (rngSeed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ────────────────────────────────────────────────────────────────
// sleep — simulate network latency. `jitterMs` adds random noise so
// two concurrent calls don't resolve at the exact same tick in tests.
// ────────────────────────────────────────────────────────────────
export async function sleep(baseMs: number, jitterMs = 0): Promise<void> {
  // If we're in test mode with seed set, collapse latency to 0 so suites run fast.
  // Tests that specifically check timing can override by calling sleep directly.
  if (rngSeed !== null) return;

  const delay = baseMs + rand() * jitterMs;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

// ────────────────────────────────────────────────────────────────
// maybeFail — with probability `p`, throw the given error. Used inside
// mock handlers to simulate flaky APIs.
//
// Tests typically call `setMockFailureOverride("force_off")` in `beforeEach`
// to short-circuit this entirely. Without an override, we use the seeded
// RNG so failures are at least reproducible.
// ────────────────────────────────────────────────────────────────
export function maybeFail(p: number, err: IntegrationError): void {
  if (failureOverride === "force_off") return;
  if (failureOverride === "force_on") throw err;
  if (rand() < p) throw err;
}

// ────────────────────────────────────────────────────────────────
// One-shot transient fail helper for the "transient_retry" scenario.
//
// Each integration registers the tool keys that should fail their FIRST
// call only. After that first failure the same tool key is marked as
// "already failed once" and subsequent calls succeed normally — letting
// the agent's retry path resolve.
//
// Stored as a module-level Set so it's stable across handler invocations
// in a single graph run. Reset between demo runs via `resetTransientFailLog`.
// ────────────────────────────────────────────────────────────────
const _transientFailLog = new Set<string>();

export function shouldTransientFailOnce(toolKey: string): boolean {
  if (_transientFailLog.has(toolKey)) return false;
  _transientFailLog.add(toolKey);
  return true;
}

export function resetTransientFailLog(): void {
  _transientFailLog.clear();
}

// ────────────────────────────────────────────────────────────────
// generateId — lightweight id generator for fake entity ids ("doc_…").
// Not crypto-secure — it's for mock data.
// ────────────────────────────────────────────────────────────────
export function generateId(prefix: string): string {
  // 9 hex chars is plenty for mock uniqueness in a demo.
  const rand9 = Math.floor(rand() * 0xffffffff).toString(16).padStart(9, "0");
  return `${prefix}_${rand9}`;
}

// ────────────────────────────────────────────────────────────────
// simulateApiCall — wraps a mock handler with latency + optional failure.
// Most mocks can use this instead of hand-rolling the pattern.
// ────────────────────────────────────────────────────────────────
export async function simulateApiCall<T>(opts: {
  // Which tool this belongs to (for error tagging).
  tool: string;
  // Base latency in ms.
  latencyMs?: number;
  // Jitter on top of base latency.
  jitterMs?: number;
  // Probability [0,1] of a retryable 5xx-style failure.
  transientFailureRate?: number;
  // Probability [0,1] of a non-retryable business-rule failure.
  hardFailureRate?: number;
  // The "happy path" payload factory.
  result: () => T | Promise<T>;
}): Promise<T> {
  // Step 1: simulate the wire latency.
  await sleep(opts.latencyMs ?? 80, opts.jitterMs ?? 40);

  // Step 2: maybe fail with a transient error (retryable).
  maybeFail(
    opts.transientFailureRate ?? 0,
    new IntegrationError(
      `${opts.tool} transient failure (mock)`,
      "transient_5xx",
      true, // retryable
      opts.tool,
    ),
  );

  // Step 3: maybe fail with a hard error (escalate).
  maybeFail(
    opts.hardFailureRate ?? 0,
    new IntegrationError(
      `${opts.tool} hard failure (mock)`,
      "hard_failure",
      false, // not retryable
      opts.tool,
    ),
  );

  // Step 4: return the happy-path payload.
  return await opts.result();
}
