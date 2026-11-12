"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";

export default function ProjectError({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const message = error instanceof Error ? error.message : "";
  const denied = /unauthori[sz]ed|access denied/i.test(message);

  return (
    <div className="flex h-dvh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 text-center shadow-sm">
        <h1 className="text-base font-semibold text-ink">
          {denied ? "You don't have access to this project" : "This project couldn't be opened"}
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          {denied
            ? "It belongs to another account."
            : "It may have been deleted, or the link is out of date."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {retry && (
            <button
              type="button"
              onClick={() => retry()}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/40"
            >
              Try again
            </button>
          )}
          <Link
            href="/chats"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/50"
          >
            Back to projects
          </Link>
        </div>
      </div>
    </div>
  );
}
