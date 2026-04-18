// ────────────────────────────────────────────────────────────────
// Root layout — wraps every page.
//
// New responsibilities in Phase 2:
//   • Mount the Convex provider so pages can use live queries.
//   • Add a simple global nav bar linking the main dashboard areas.
// ────────────────────────────────────────────────────────────────

import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";

// Geist fonts — inherited from the create-next-app template.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Page metadata for the browser tab + social previews.
export const metadata: Metadata = {
  title: "HR Onboarding Agent",
  description: "AI orchestrator for nurse onboarding — end-to-end hire automation",
};

// Root layout component. `children` is whichever `page.tsx` matched the URL.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black text-black dark:text-zinc-50">
        {/* Convex provider — must wrap every page that uses live queries. */}
        <ConvexClientProvider>
          {/* Global nav bar. Sticky so it's always accessible. */}
          <nav className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-black/80">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
              <Link href="/" className="text-sm font-semibold tracking-tight">
                HR Onboarding Agent
              </Link>
              <div className="flex items-center gap-6 text-sm">
                <Link
                  href="/"
                  className="text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                >
                  Dashboard
                </Link>
                <Link
                  href="/exceptions"
                  className="text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                >
                  Exceptions
                </Link>
                <Link
                  href="/new"
                  className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-200"
                >
                  New Hire
                </Link>
              </div>
            </div>
          </nav>

          <main className="flex-1">{children}</main>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
