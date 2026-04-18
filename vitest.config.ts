// ────────────────────────────────────────────────────────────────
// Vitest configuration.
//
// Tests run in the Node environment (not jsdom) because the orchestrator
// is server-side only. We exclude `.next/`, `convex/_generated/`, and
// `node_modules/` from test discovery.
// ────────────────────────────────────────────────────────────────

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node env — the agent + integrations are pure Node/server code.
    environment: "node",
    // Globs for test discovery. Sibling `.test.ts` files next to each module.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", ".next", "convex/_generated"],
    // Global setup — runs before every test file.
    setupFiles: ["./vitest.setup.ts"],
    // Print a concise summary plus per-test output on failure.
    reporters: "default",
    // Coverage when `test:coverage` is run.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: ["**/*.test.ts", "**/_generated/**"],
    },
  },
});
