"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";

/**
 * Route-level error boundary for every page under the root layout (Next 16
 * `error.tsx`, `retry` prop). More specific boundaries win: a page segment that
 * ships its own `error.tsx` (e.g. `app/project/[projectId]/error.tsx`) handles
 * its own throws first, this one catches the rest — runs, library, memory,
 * audit, team, inbox — instead of the browser showing the built-in error page.
 *
 * `error` is `unknown` on purpose: a value thrown in a Client Component arrives
 * as-is and is not guaranteed to be an `Error` (Next docs, error.js props), so
 * every read is narrowed.
 */
export default function AppError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const message = error instanceof Error ? error.message : "";
  const digest =
    error && typeof error === "object" && "digest" in error
      ? String((error as { digest?: unknown }).digest ?? "")
      : "";
  // A server-side throw only reaches the browser as a digest plus a generic
  // message; do not present that as the cause.
  const cause = message && !/^An error occurred/i.test(message) ? message : "";

  return (
    <div className="flex h-dvh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-6 text-center shadow-sm">
        <h1 className="text-base font-semibold text-ink">This page couldn&apos;t be shown</h1>
        <p className="mt-2 text-sm text-ink-2">
          The view failed to render. Retrying is safe; nothing was lost.
        </p>
        {cause && (
          <p className="mt-3 max-h-24 overflow-auto rounded-lg bg-hover px-3 py-2 text-left font-mono text-xs text-ink-2">
            {cause}
          </p>
        )}
        {!cause && digest && (
          <p className="mt-3 font-mono text-xs text-ink-3">Reference: {digest}</p>
        )}
        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/40"
          >
            Try again
          </button>
          <Link
            href="/chats"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/50"
          >
            Back to chats
          </Link>
        </div>
      </div>
    </div>
  );
}
