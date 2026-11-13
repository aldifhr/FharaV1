import Link from "next/link";

/**
 * Unmatched URL or an explicit `notFound()` from a segment: the route exists in
 * the app but has nothing to show. Rendered inside the root layout, so it keeps
 * the app's theme and tokens. A missing page is not an error, so this offers no
 * retry — only a way back.
 */
export default function NotFound() {
  return (
    <div className="flex h-dvh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 text-center shadow-sm">
        <p className="font-mono text-xs text-ink-3">404</p>
        <h1 className="mt-2 text-base font-semibold text-ink">This page doesn&apos;t exist</h1>
        <p className="mt-2 text-sm text-ink-2">
          The link may be out of date, or the item was deleted.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Link
            href="/chats"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/50"
          >
            Back to chats
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/40"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
