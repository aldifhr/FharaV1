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
    <div className="flex h-dvh items-center justify-center bg-[#f7f7fb] p-6 dark:bg-[#06060b]">
      <div className="w-full max-w-sm rounded-xl border border-[#ebe9f0] bg-white p-6 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">
          {denied ? "You don't have access to this project" : "This project couldn't be opened"}
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {denied
            ? "It belongs to another account."
            : "It may have been deleted, or the link is out of date."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {retry && (
            <button
              type="button"
              onClick={() => retry()}
              className="rounded-lg border border-[#e5e3eb] px-4 py-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-ink/40 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Try again
            </button>
          )}
          <Link
            href="/chats"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-canvas outline-none hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/50 focus-visible:ring-offset-2"
          >
            Back to projects
          </Link>
        </div>
      </div>
    </div>
  );
}
