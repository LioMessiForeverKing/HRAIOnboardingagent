// ────────────────────────────────────────────────────────────────
// New Hire form — kicks off an onboarding workflow.
//
// Flow:
//   1. Operator fills the form.
//   2. On submit, we call `api.hires.createHire` mutation → hireId.
//   3. We call `api.agent.runOnboarding` action with that hireId.
//   4. Redirect to the hire detail page where the live timeline renders.
// ────────────────────────────────────────────────────────────────

"use client";

import { useState } from "react";
import { useMutation, useAction } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../convex/_generated/api";

// Mirrors the Scenario union from src/lib/integrations/types.ts.
// Kept narrow so the createHire mutation accepts only valid values.
type ScenarioName =
  | "all_success"
  | "checkr_consider"
  | "checkr_suspended"
  | "address_invalid"
  | "docusign_declined"
  | "transient_retry"
  | "shippo_label_failed";

// Scenario catalog — drives the picker dropdown. One row per supported
// path so the operator can read what each one will do before running.
const SCENARIOS: Array<{ value: ScenarioName | ""; label: string; detail: string }> = [
  { value: "", label: "Default (random)", detail: "Mocks roll dice — ~10% adverse Checkr, ~5% bad address, occasional transient errors." },
  { value: "all_success", label: "All success", detail: "Every step clears, no retries. The full 10-tool happy path end to end." },
  { value: "checkr_consider", label: "Checkr: consider (FCRA escalation)", detail: "Background check returns adverse findings. Agent stops and escalates per FCRA." },
  { value: "checkr_suspended", label: "Checkr: suspended", detail: "Checkr needs more documents from the candidate — agent escalates." },
  { value: "address_invalid", label: "Shippo: invalid address", detail: "Verify_address returns valid=false. Agent escalates before buying a label." },
  { value: "docusign_declined", label: "DocuSign: candidate declined", detail: "Envelope status returns 'declined'. Agent escalates." },
  { value: "transient_retry", label: "Transient retries", detail: "First call to several tools throws a 503; agent retries and succeeds." },
  { value: "shippo_label_failed", label: "Shippo: label purchase failed", detail: "Carrier rejects the label (non-retryable). Agent escalates." },
];

export default function NewHirePage() {
  const router = useRouter();

  // Mutations + actions are client-side wrappers around Convex calls.
  const createHire = useMutation(api.hires.createHire);
  const runOnboarding = useAction(api.agent.runOnboarding);

  // Controlled form state. Defaults chosen to make "just click submit"
  // viable for quick demos.
  const [name, setName] = useState("Alex Demo");
  const [email, setEmail] = useState("alex.demo@example.com");
  const [role, setRole] = useState("Registered Nurse");
  const [state, setState] = useState("TX");
  const [startDate, setStartDate] = useState(
    // Default to 2 weeks out so SLA calculations have realistic headroom.
    new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
  );
  // Salary in whole USD. Nurse market rate middle of the pack as default.
  const [salary, setSalary] = useState(95000);
  const [street1, setStreet1] = useState("123 Test Ave");
  const [city, setCity] = useState("Austin");
  const [zip, setZip] = useState("78701");

  // Scenario — pins mock behavior so the operator can manually exercise
  // each path. Empty string = no override (probabilistic mocks).
  const [scenario, setScenario] = useState<string>("");

  // UI flags.
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      // Step 1: create the hire row. Returns the hireId synchronously
      // once the Convex mutation lands.
      const hireId = await createHire({
        name,
        email,
        role,
        state,
        startDate,
        salary,
        address: { street1, city, state, zip },
        // Only forward scenario when the operator actually picked one;
        // empty string means "let the mocks roll dice as usual".
        scenario: scenario ? (scenario as ScenarioName) : undefined,
      });

      // Step 2: kick off the orchestrator. We intentionally DO NOT await
      // the action's completion — it may take 30+ seconds to finish all
      // polls. Instead we fire-and-forget and navigate to the hire detail
      // page where the dashboard renders the live timeline.
      //
      // (If the action throws synchronously due to misconfiguration, the
      // catch below still fires. Runtime errors during the run land in
      // the exception queue.)
      void runOnboarding({ hireId });

      // Step 3: navigate to the detail page — the Convex live queries
      // there will show steps filling in as the agent works.
      router.push(`/hires/${hireId}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold">New hire</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Fill in the candidate's details. The orchestrator will start immediately
        and you can watch progress on the hire page.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {/* Identity fields. */}
        <Field label="Full name">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Email">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role">
            <input
              required
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="State (2-letter)">
            <input
              required
              maxLength={2}
              value={state}
              onChange={(e) => setState(e.target.value.toUpperCase())}
              className={`${inputClass} uppercase`}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start date">
            <input
              required
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Annual salary (USD)">
            <input
              required
              type="number"
              min={1}
              value={salary}
              onChange={(e) => setSalary(Number(e.target.value))}
              className={inputClass}
            />
          </Field>
        </div>

        {/* Scenario picker — controls which mock outcomes the agent will hit.
            Use this to manually exercise success vs. each failure path. */}
        <fieldset className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-xs uppercase tracking-wide text-zinc-500">
            Test scenario
          </legend>
          <div className="mt-2 space-y-3">
            <Field label="Pin agent behavior to a specific path">
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                className={inputClass}
              >
                {SCENARIOS.map((s) => (
                  <option key={s.value || "default"} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            {/* Live description of the chosen scenario so the operator
                knows exactly what the agent will do before they submit. */}
            <p className="text-xs leading-relaxed text-zinc-500">
              {SCENARIOS.find((s) => s.value === scenario)?.detail}
            </p>
          </div>
        </fieldset>

        {/* Address block — used by Shippo for the laptop shipment. */}
        <fieldset className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-xs uppercase tracking-wide text-zinc-500">
            Home address
          </legend>
          <div className="mt-2 space-y-3">
            <Field label="Street">
              <input
                required
                value={street1}
                onChange={(e) => setStreet1(e.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="City">
                <input
                  required
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Zip">
                <input
                  required
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>
          </div>
        </fieldset>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-200"
        >
          {submitting ? "Kicking off…" : "Start onboarding"}
        </button>
      </form>
    </div>
  );
}

// Tiny helpers to keep the form readable. No external dep needed.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-black dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-50";
