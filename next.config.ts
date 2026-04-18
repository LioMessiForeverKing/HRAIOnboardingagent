// ────────────────────────────────────────────────────────────────
// Next.js config.
//
// We pin `turbopack.root` because there's a stray `package-lock.json` in
// the parent directory (`/Users/ayenmonasha/`) that confuses Turbopack's
// automatic workspace-root detection. Pinning tells Turbopack
// "this folder is the root" — no inference, no warning.
// ────────────────────────────────────────────────────────────────

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `import.meta.dirname` is the ESM-native equivalent of `__dirname` —
  // supported in Node 20.11+ without any extra imports.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
