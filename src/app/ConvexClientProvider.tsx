// ────────────────────────────────────────────────────────────────
// ConvexClientProvider
//
// Wraps the app in a React context so child components can use hooks like
// `useQuery` (live-subscribed queries) and `useMutation`.
//
// Why this is a client component: ConvexReactClient + provider hooks
// require access to browser APIs (EventSource for live queries, etc.).
// ────────────────────────────────────────────────────────────────

"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";

// ────────────────────────────────────────────────────────────────
// Provider component.
// ────────────────────────────────────────────────────────────────
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // Instantiate the client once per browser session. `useMemo` with an
  // empty dep array ensures we don't thrash through clients on re-render.
  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      // Fail loudly rather than silently return nothing — missing URL
      // means live queries will never work.
      throw new Error(
        "NEXT_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` to initialize.",
      );
    }
    return new ConvexReactClient(url);
  }, []);

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
