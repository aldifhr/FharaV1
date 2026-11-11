"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { api } from "@/api/convex/_generated/api";
import Sidebar from "@/components/Sidebar";
import { SuggestFixButton, SuggestionItem } from "@/components/review/Improve";
import { relativeTime } from "@/lib/runFormat";

/**
 * Self-Improvement Lab: recent failed runs with "Suggest fix", and every
 * suggestion so far. A suggestion is a diff against the current text of a
 * prompt, skill or role config; it changes nothing until Apply.
 */
function ImprovePage() {
  const projectId = useSearchParams().get("project") ?? undefined;
  const scope = projectId ? { projectId: projectId as never } : {};
  const failed = useQuery(api.improve.listFailedRuns, scope);
  const suggestions = useQuery(api.improve.listSuggestions, scope);
  const waiting = (suggestions ?? []).filter((row) => row.status === "ready" || row.status === "running");
  const decided = (suggestions ?? []).filter((row) => row.status !== "ready" && row.status !== "running");

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-10 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-3xl">
          <header>
            <h1 className="text-[26px] font-semibold tracking-tight">Improve</h1>
            <p className="mt-1 text-[15px] text-ink-2">Learn from failed runs: one proposed change at a time, applied only when you say so.</p>
          </header>

          {waiting.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-1 text-[13px] font-medium text-ink-2">Waiting for you</h2>
              <ul className="divide-y divide-line">
                {waiting.map((row) => (
                  <li key={row._id}>
                    <SuggestionItem suggestion={row} showTask />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-10">
            <h2 className="mb-2 text-[13px] font-medium text-ink-2">Failed runs</h2>
            {failed === undefined ? (
              <div className="space-y-3" aria-label="Loading failed runs">
                {[0, 1].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-hover" />
                ))}
              </div>
            ) : failed.length === 0 ? (
              <div className="mt-6 flex flex-col items-center text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hover text-ink-3">
                  <Sparkles size={18} />
                </span>
                <p className="mt-4 text-[14px] text-ink-2">No failed runs to learn from.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                {failed.map((task) => (
                  <li key={task._id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Link href={`/runs/${task._id}`} className="block truncate text-[14px] hover:underline">
                        {task.title}
                      </Link>
                      <p className="truncate text-[12.5px] text-ink-3">{[task.error, relativeTime(task.completedAt)].filter(Boolean).join(" · ")}</p>
                    </div>
                    <SuggestFixButton taskId={task._id} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {decided.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-1 text-[13px] font-medium text-ink-2">History</h2>
              <ul className="divide-y divide-line">
                {decided.map((row) => (
                  <li key={row._id}>
                    <SuggestionItem suggestion={row} showTask />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

export default function ImprovePageWrapper() {
  return (
    <Suspense fallback={null}>
      <ImprovePage />
    </Suspense>
  );
}
