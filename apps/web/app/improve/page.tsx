
import { Suspense } from "react";
import { Link, useSearchParams } from "@/lib/spaRouter";
import { useQuery } from "@fhara/runtime/react";
import { Check, Clock3, History, Sparkles, X } from "lucide-react";
import { api } from "@fhara/runtime/api";
import Sidebar from "@/components/Sidebar";
import { PageHeader } from "@/components/ui/page-header";
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
  const project = useQuery(api.projects.get, projectId ? { projectId } : "skip");
  const failed = useQuery(api.improve.listFailedRuns, scope);
  const suggestions = useQuery(api.improve.listSuggestions, scope);
  const waiting = (suggestions ?? []).filter((row) => row.status === "ready" || row.status === "running");
  const decided = (suggestions ?? []).filter((row) => row.status !== "ready" && row.status !== "running");
  const applied = decided.filter((row) => row.status === "applied").length;
  const dismissed = decided.filter((row) => row.status === "dismissed").length;
  const projectName = (project as { name?: string } | null | undefined)?.name;

  const stats = [
    {
      label: "Waiting",
      value: waiting.length,
      note: "for you",
      icon: <Clock3 size={13} />,
      tone: waiting.length > 0 ? "text-warn" : "",
      title: "Suggestions ready to review or still reading the run",
    },
    {
      label: "Failed runs",
      value: failed?.length ?? 0,
      note: "to learn from",
      icon: <Sparkles size={13} />,
      tone: "",
      title: "Failed runs available for a suggestion",
    },
    {
      label: "Applied",
      value: applied,
      note: "changes made",
      icon: <Check size={13} />,
      tone: "",
      title: "Suggestions you applied",
    },
    {
      label: "Dismissed",
      value: dismissed,
      note: "passed on",
      icon: <X size={13} />,
      tone: "",
      title: "Suggestions you dismissed",
    },
  ];

  return (
    <div className="flex h-screen overflow-hidden bg-transparent text-ink max-[979px]:h-auto max-[979px]:min-h-screen max-[979px]:flex-col">
      <Sidebar projectId={projectId} />
      <main className="min-w-0 flex-1 overflow-y-auto px-6 py-8 max-[979px]:px-4 max-[979px]:py-6">
        <div className="mx-auto max-w-[1280px]">
          <PageHeader
            eyebrow={projectName ?? "All projects"}
            title="Improve"
            leading={
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field border border-line bg-panel text-ink-2">
                <Sparkles size={17} />
              </span>
            }
            meta={
              <p className="text-[13.5px] text-ink-2">
                Learn from failed runs: one proposed change at a time, applied only when you say so.
              </p>
            }
          />

          {suggestions === undefined || failed === undefined ? (
            <div className="mt-6 space-y-4" aria-label="Loading improvements">
              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="p-5">
                    <div className="h-3 w-16 rounded bg-hover" />
                    <div className="mt-3 h-8 w-12 rounded bg-hover" />
                  </div>
                ))}
              </div>
              <div className="h-48 rounded-2xl border border-line bg-panel shadow-card" />
            </div>
          ) : (
            <section
              aria-label="Improvement metrics"
              className="mt-6 grid grid-cols-2 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card sm:divide-y-0 sm:divide-x lg:grid-cols-4"
            >
              {stats.map((metric) => (
                <div key={metric.label} className="p-4 sm:p-5" title={metric.title}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption">{metric.label}</span>
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-inset text-ink-3">{metric.icon}</span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className={`text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums ${metric.tone || "text-ink"}`}>
                      {metric.value}
                    </span>
                    <span className="truncate text-[12px] text-ink-3">{metric.note}</span>
                  </div>
                </div>
              ))}
            </section>
          )}

          {waiting.length > 0 && (
            <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-card" aria-label="Waiting suggestions">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-inset text-ink-3">
                    <Clock3 size={14} />
                  </span>
                  <div>
                    <h2 className="text-[13.5px] font-medium text-ink">Waiting for you</h2>
                    <p className="mt-0.5 text-[12px] text-ink-3">Review the diff; nothing applies until you click Apply.</p>
                  </div>
                </div>
                <span className="text-[12px] tabular-nums text-ink-3">{waiting.length} pending</span>
              </div>
              <ul className="divide-y divide-line">
                {waiting.map((row) => (
                  <li key={row._id} className="px-4">
                    <SuggestionItem suggestion={row} showTask />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-card" aria-label="Failed runs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-inset text-ink-3">
                  <Sparkles size={14} />
                </span>
                <div>
                  <h2 className="text-[13.5px] font-medium text-ink">Failed runs</h2>
                  <p className="mt-0.5 text-[12px] text-ink-3">Suggest one prompt, skill or role change that could prevent it.</p>
                </div>
              </div>
              <span className="text-[12px] tabular-nums text-ink-3">{failed?.length ?? 0} runs</span>
            </div>

            {failed === undefined ? (
              <div className="space-y-3 p-4" aria-label="Loading failed runs">
                {[0, 1].map((i) => (
                  <div key={i} className="h-14 rounded-field bg-hover" />
                ))}
              </div>
            ) : failed.length === 0 ? (
              <div className="flex flex-col items-center px-5 py-10 text-center">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-inset text-ink-3">
                  <Sparkles size={18} />
                </span>
                <p className="mt-4 text-[13.5px] text-ink-2">No failed runs to learn from.</p>
              </div>
            ) : (
              <>
                <div className="hidden items-center gap-3 border-b border-line px-4 py-2.5 text-caption sm:flex">
                  <span className="min-w-0 flex-1">Run</span>
                  <span className="w-16 shrink-0 text-right">When</span>
                  <span className="w-28 shrink-0 text-right">Action</span>
                </div>
                <ul className="divide-y divide-line">
                  {failed.map((task) => (
                    <li key={task._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-inset/60">
                      <Link
                        href={`/runs/${task._id}`}
                        className="flex min-w-0 flex-1 items-start gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ink/30 max-sm:basis-full"
                      >
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-inset text-ink-3">
                          <X size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-ink hover:underline">{task.title}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-ink-3">{task.error ?? "Run failed"}</span>
                        </span>
                      </Link>
                      <div className="flex shrink-0 items-center gap-3 max-sm:ml-9 max-sm:w-full max-sm:justify-between">
                        <span className="w-16 text-right text-[12px] tabular-nums text-ink-3">{relativeTime(task.completedAt)}</span>
                        <div className="w-28 text-right">
                          <SuggestFixButton taskId={task._id} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {decided.length > 0 && (
            <section className="mt-4 overflow-hidden rounded-2xl border border-line bg-panel shadow-card" aria-label="Suggestion history">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-inset text-ink-3">
                    <History size={14} />
                  </span>
                  <div>
                    <h2 className="text-[13.5px] font-medium text-ink">History</h2>
                    <p className="mt-0.5 text-[12px] text-ink-3">Applied and dismissed suggestions.</p>
                  </div>
                </div>
                <span className="text-[12px] tabular-nums text-ink-3">{decided.length} decisions</span>
              </div>
              <ul className="divide-y divide-line">
                {decided.map((row) => (
                  <li key={row._id} className="px-4">
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
