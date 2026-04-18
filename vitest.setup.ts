// ────────────────────────────────────────────────────────────────
// Global Vitest setup.
//
// Applied to every test file. Disables probabilistic mock failures by
// default so happy-path tests don't flake. Individual tests can opt into
// the failure modes via `setMockFailureOverride("force_on")` inside a
// `beforeEach`/`it` block.
// ────────────────────────────────────────────────────────────────

import { beforeEach } from "vitest";
import { setMockFailureOverride } from "./src/lib/integrations/mock-utils";

// Reset before every test — so a test that flips to "force_on" doesn't leak.
beforeEach(() => {
  setMockFailureOverride("force_off");
});
